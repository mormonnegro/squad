import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretRef } from "./grants.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * The half of OAuth that has to happen where the secrets are, which is here and not in the sandbox.
 *
 * A remote MCP server almost never wants a token you can paste. It wants the one at the end of an
 * authorization code flow: discovered endpoints, a client registered on the spot, a consent screen,
 * and an access token that expires in an hour. None of that fits in the config file, which is meant
 * to be committed, and none of it may reach the agent, which is the whole point of the proxy.
 *
 * So the flow is driven by the plane, the tokens live in this store, and what the grant carries is a
 * reference — `oauth:<name>` — that resolves to whatever access token is current at the moment the
 * request goes out. The agent asks for a tool, the proxy writes the header, and the token is a thing
 * the agent has never been able to name.
 */

/** How the store's refs are spelled, so a grant can point at a login without holding one. */
const REF_PREFIX = "oauth:";

/**
 * How long before expiry a token counts as expired.
 *
 * A token that is good for another two seconds is one that will have expired by the time it reaches
 * a server on the other side of the Atlantic, and the failure it comes back as — a 401 in the middle
 * of a tool call — reads to the agent as the tool being broken.
 */
const EXPIRY_SKEW_MS = 60_000;

/** Discovery and token calls are quick or they are wrong. The operator is waiting at a prompt. */
const REACH_MS = 15_000;

const CLIENT_NAME = "agent-dive";

export interface OAuthEndpoints {
	readonly authorizationUrl: string;
	readonly tokenUrl: string;
	/** Where a client can be registered on the spot, for the servers that allow it (RFC 7591). */
	readonly registrationUrl?: string;
	readonly scopesSupported?: readonly string[];
	/**
	 * What the token is asked to be good for (RFC 8707), which MCP requires and which is the reason a
	 * token minted for one server cannot be spent at another.
	 */
	readonly resource: string;
}

export interface OAuthClient {
	readonly clientId: string;
	readonly clientSecret?: string;
	/** Where the browser is sent back to. Registered with the client, so it cannot change after. */
	readonly redirectUri: string;
}

/** A login that succeeded, as it is kept between turns and between restarts. */
export interface OAuthLogin {
	readonly host: string;
	readonly endpoints: OAuthEndpoints;
	readonly client: OAuthClient;
	readonly accessToken: string;
	readonly refreshToken?: string;
	/** Epoch milliseconds, absent for a token the server did not put a clock on. */
	readonly expiresAt?: number;
	readonly scope?: string;
	readonly at: string;
}

export function oauthRef(name: string): SecretRef {
	return { ref: `${REF_PREFIX}${name}` };
}

export class OAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthError";
	}
}

async function reach(url: string, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(REACH_MS) });
	} catch (error) {
		throw new OAuthError(`Could not reach ${url}: ${(error as Error).message}`);
	}
}

/** A JSON document if there is one there, and nothing if there is not. Discovery guesses a lot. */
async function json(url: string): Promise<Record<string, unknown> | undefined> {
	let response: Response;
	try {
		response = await reach(url, { headers: { Accept: "application/json" } });
	} catch {
		return undefined;
	}
	if (!response.ok) return undefined;
	try {
		const parsed: unknown = await response.json();
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Where a `.well-known` document for a URL might be, in the order worth trying.
 *
 * RFC 8414 puts the path of the issuer *after* the well-known segment, which is the opposite of
 * where everyone's intuition puts it and the opposite of what OpenID Connect did first. Servers in
 * the wild do both, so both are asked for, and a server with no path at all only ever answers the
 * last one.
 */
function wellKnown(base: URL, name: string): string[] {
	const path = base.pathname.replace(/\/$/, "");
	const root = base.origin;
	if (path === "") return [`${root}/.well-known/${name}`];
	return [
		`${root}/.well-known/${name}${path}`,
		`${root}${path}/.well-known/${name}`,
		`${root}/.well-known/${name}`,
	];
}

/** What a 401 said about where to go and ask, if it said anything (RFC 9728). */
export function resourceMetadataFrom(header: string | null): string | undefined {
	if (header === null) return undefined;
	return /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)?.[1];
}

export type Reachability =
	| { readonly kind: "open" }
	| { readonly kind: "authorize"; readonly resourceMetadataUrl?: string }
	| { readonly kind: "unreachable"; readonly why: string };

/**
 * Asks a server whether it wants to be logged into, by trying the handshake and reading the refusal.
 *
 * Cheaper than it looks and better than asking the operator: `initialize` is the first thing any
 * client sends, so a server that would refuse the agent refuses this identically, and the answer is
 * the difference between "add a token to your config" and "click here" — which is not a thing an
 * operator should have to work out from a README.
 */
export async function reachability(url: string): Promise<Reachability> {
	let response: Response;
	try {
		response = await reach(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2025-06-18",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: CLIENT_NAME, version: "1" },
				},
			}),
		});
	} catch (error) {
		return { kind: "unreachable", why: (error as Error).message };
	}

	if (response.status === 401 || response.status === 403) {
		const found = resourceMetadataFrom(response.headers.get("www-authenticate"));
		return found === undefined
			? { kind: "authorize" }
			: { kind: "authorize", resourceMetadataUrl: found };
	}
	return { kind: "open" };
}

/**
 * Everything needed to start a flow, assembled from whatever the server is willing to say.
 *
 * Every step of this is allowed to be missing. A server may publish protected-resource metadata, or
 * only authorization-server metadata, or neither and simply expect the conventional paths — and the
 * last of those is common enough that failing there would mean refusing servers that work fine.
 */
export async function discover(url: string, resourceMetadataUrl?: string): Promise<OAuthEndpoints> {
	const server = new URL(url);
	const resource = `${server.origin}${server.pathname.replace(/\/$/, "")}`;

	const resourceCandidates =
		resourceMetadataUrl === undefined
			? wellKnown(server, "oauth-protected-resource")
			: [resourceMetadataUrl];

	// The server itself until something names an issuer, path and all: a server reached at /tenant/mcp
	// that publishes no resource metadata usually still publishes its own, under that same path.
	let issuer = new URL(url);
	let scopesSupported: readonly string[] | undefined;
	for (const candidate of resourceCandidates) {
		const document = await json(candidate);
		if (document === undefined) continue;
		const servers = document["authorization_servers"];
		const first = Array.isArray(servers) ? text(servers[0]) : undefined;
		if (first !== undefined) issuer = new URL(first);
		const scopes = document["scopes_supported"];
		if (Array.isArray(scopes))
			scopesSupported = scopes.filter((scope) => typeof scope === "string");
		break;
	}

	for (const name of ["oauth-authorization-server", "openid-configuration"]) {
		for (const candidate of wellKnown(issuer, name)) {
			const document = await json(candidate);
			const authorizationUrl = text(document?.["authorization_endpoint"]);
			const tokenUrl = text(document?.["token_endpoint"]);
			if (authorizationUrl === undefined || tokenUrl === undefined) continue;
			const registrationUrl = text(document?.["registration_endpoint"]);
			return {
				authorizationUrl,
				tokenUrl,
				...(registrationUrl !== undefined ? { registrationUrl } : {}),
				...(scopesSupported !== undefined ? { scopesSupported } : {}),
				resource,
			};
		}
	}

	// Nothing published, so the conventional paths under the issuer. A server that does not answer
	// them will say so at the first request, which is a better error than one invented here.
	return {
		authorizationUrl: `${issuer.origin}/authorize`,
		tokenUrl: `${issuer.origin}/token`,
		registrationUrl: `${issuer.origin}/register`,
		...(scopesSupported !== undefined ? { scopesSupported } : {}),
		resource,
	};
}

/**
 * Registers a client with the server, there and then.
 *
 * The alternative is the operator going to a developer portal, making an app, and pasting an id
 * back — for every server, before anything works. Dynamic registration is what makes `/mcp login`
 * a single command, and the servers that do not support it are the ones that get asked for an id.
 */
export async function registerClient(
	registrationUrl: string,
	redirectUri: string,
): Promise<OAuthClient> {
	const response = await reach(registrationUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_name: CLIENT_NAME,
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// Public client: the secret would sit on the plane's disk earning nothing, since PKCE is
			// what actually binds the code to this flow.
			token_endpoint_auth_method: "none",
		}),
	});
	if (!response.ok) {
		throw new OAuthError(
			`${registrationUrl} would not register a client (HTTP ${response.status}). Register one yourself and pass its id.`,
		);
	}
	const document = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	const clientId = text(document["client_id"]);
	if (clientId === undefined) throw new OAuthError("The server registered a client with no id.");
	const clientSecret = text(document["client_secret"]);
	return { clientId, ...(clientSecret !== undefined ? { clientSecret } : {}), redirectUri };
}

export interface Authorization {
	readonly url: string;
	readonly verifier: string;
	readonly state: string;
}

/** The URL to open, and the two secrets that prove the answer came back to whoever asked. */
export function beginAuthorization(
	endpoints: OAuthEndpoints,
	client: OAuthClient,
	scope?: string,
): Authorization {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(16).toString("base64url");

	const url = new URL(endpoints.authorizationUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", client.clientId);
	url.searchParams.set("redirect_uri", client.redirectUri);
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("resource", endpoints.resource);
	const wanted = scope ?? endpoints.scopesSupported?.join(" ");
	if (wanted !== undefined && wanted.length > 0) url.searchParams.set("scope", wanted);

	return { url: url.toString(), verifier, state };
}

interface Granted {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: number;
	readonly scope?: string;
}

async function redeem(
	endpoints: OAuthEndpoints,
	client: OAuthClient,
	form: Record<string, string>,
): Promise<Granted> {
	const body = new URLSearchParams({
		...form,
		client_id: client.clientId,
		resource: endpoints.resource,
	});
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	if (client.clientSecret !== undefined) {
		const credential = `${client.clientId}:${client.clientSecret}`;
		headers.Authorization = `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;
	}

	const response = await reach(endpoints.tokenUrl, {
		method: "POST",
		headers,
		body: body.toString(),
	});
	const document = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const said = text(document["error_description"]) ?? text(document["error"]);
		throw new OAuthError(
			`${endpoints.tokenUrl} refused (HTTP ${response.status})${said === undefined ? "" : `: ${said}`}`,
		);
	}

	const accessToken = text(document["access_token"]);
	if (accessToken === undefined) throw new OAuthError("The server answered with no access token.");
	const refreshToken = text(document["refresh_token"]);
	const lifetime = document["expires_in"];
	const scope = text(document["scope"]);
	return {
		accessToken,
		...(refreshToken !== undefined ? { refreshToken } : {}),
		...(typeof lifetime === "number" && Number.isFinite(lifetime)
			? { expiresAt: Date.now() + lifetime * 1000 }
			: {}),
		...(scope !== undefined ? { scope } : {}),
	};
}

export async function exchangeCode(
	endpoints: OAuthEndpoints,
	client: OAuthClient,
	code: string,
	verifier: string,
): Promise<Granted> {
	return redeem(endpoints, client, {
		grant_type: "authorization_code",
		code,
		redirect_uri: client.redirectUri,
		code_verifier: verifier,
	});
}

/**
 * Trades a refresh token for a live one, keeping the old refresh token if none came back.
 *
 * Servers differ on rotation, and dropping a refresh token that was still good would log the
 * operator out an hour after they logged in — the failure they would report as "it stopped working".
 */
export async function refreshLogin(login: OAuthLogin): Promise<OAuthLogin> {
	if (login.refreshToken === undefined) {
		throw new OAuthError("This login cannot be renewed: the server issued no refresh token.");
	}
	const granted = await redeem(login.endpoints, login.client, {
		grant_type: "refresh_token",
		refresh_token: login.refreshToken,
	});
	return {
		...login,
		...granted,
		refreshToken: granted.refreshToken ?? login.refreshToken,
		at: new Date().toISOString(),
	};
}

/** A login as it reads to somebody deciding whether to log in again. Never the token itself. */
export interface LoginStatus {
	readonly host: string;
	readonly at: string;
	readonly expiresAt: number | undefined;
	readonly renewable: boolean;
}

/**
 * The logins the plane holds, and the only thing in this system that writes a live credential to
 * disk.
 *
 * That is a real cost and it is taken deliberately: a refresh token is the whole of what "logged in"
 * means, and holding it only in memory would mean every restart of the plane logs every agent out of
 * everything, with a browser round trip to get back. Written 0600, under the state directory, next
 * to the CA private key which is at least as valuable.
 */
export class OAuthLogins {
	readonly #path: string;
	#cache: Record<string, OAuthLogin> | undefined;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async get(name: string): Promise<OAuthLogin | undefined> {
		return (await this.#serialize(() => this.#read()))[name];
	}

	async status(name: string): Promise<LoginStatus | undefined> {
		const login = await this.get(name);
		if (login === undefined) return undefined;
		return {
			host: login.host,
			at: login.at,
			expiresAt: login.expiresAt,
			renewable: login.refreshToken !== undefined,
		};
	}

	async save(name: string, login: OAuthLogin): Promise<void> {
		await this.#serialize(async () => {
			const logins = await this.#read();
			logins[name] = login;
			await this.#write(logins);
		});
	}

	async forget(name: string): Promise<boolean> {
		return this.#serialize(async () => {
			const logins = await this.#read();
			if (logins[name] === undefined) return false;
			delete logins[name];
			await this.#write(logins);
			return true;
		});
	}

	/**
	 * A token good right now, renewed on the way out if it was not.
	 *
	 * Serialized with the rest of the store, so a burst of tool calls against one server refreshes
	 * once rather than racing: the second caller waits for the first and then reads what it wrote.
	 */
	async token(name: string): Promise<string | undefined> {
		return this.#serialize(async () => {
			const logins = await this.#read();
			const login = logins[name];
			if (login === undefined) return undefined;
			if (login.expiresAt === undefined || login.expiresAt - Date.now() > EXPIRY_SKEW_MS) {
				return login.accessToken;
			}
			if (login.refreshToken === undefined) return undefined;
			const renewed = await refreshLogin(login);
			logins[name] = renewed;
			await this.#write(logins);
			return renewed.accessToken;
		});
	}

	async #read(): Promise<Record<string, OAuthLogin>> {
		if (this.#cache !== undefined) return this.#cache;
		let logins: Record<string, OAuthLogin> = {};
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				logins = parsed as Record<string, OAuthLogin>;
			}
		} catch {
			logins = {};
		}
		this.#cache = logins;
		return logins;
	}

	async #write(logins: Record<string, OAuthLogin>): Promise<void> {
		this.#cache = logins;
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(logins, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, this.#path);
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}

/**
 * Resolves `oauth:<name>` against the logins, and everything else against whatever was there before.
 *
 * Layered rather than replacing the environment store, because both kinds of credential are real:
 * the model key an operator exports is not going to become an OAuth flow, and the OAuth flow is
 * never going to be an environment variable.
 */
export class OAuthSecretStore implements SecretStore {
	readonly #logins: OAuthLogins;
	readonly #fallback: SecretStore;

	constructor(logins: OAuthLogins, fallback: SecretStore) {
		this.#logins = logins;
		this.#fallback = fallback;
	}

	async resolve(ref: SecretRef): Promise<string | undefined> {
		if (!ref.ref.startsWith(REF_PREFIX)) return this.#fallback.resolve(ref);
		return this.#logins.token(ref.ref.slice(REF_PREFIX.length));
	}
}
