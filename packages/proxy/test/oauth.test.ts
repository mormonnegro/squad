import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	beginAuthorization,
	discover,
	exchangeCode,
	type OAuthLogin,
	OAuthLogins,
	OAuthSecretStore,
	oauthRef,
	reachability,
	registerClient,
	resourceMetadataFrom,
} from "../src/oauth.ts";
import { MemorySecretStore } from "../src/secrets.ts";

interface Served {
	url: string;
	asked: { path: string; body: string }[];
	close: () => Promise<void>;
}

const running: Served[] = [];

afterEach(async () => {
	while (running.length > 0) await running.pop()?.close();
});

/** A server that answers a table of paths, and remembers what it was asked. */
async function serve(
	routes: Record<
		string,
		(body: string, url: URL) => { status?: number; headers?: Record<string, string>; body: unknown }
	>,
): Promise<Served> {
	const asked: { path: string; body: string }[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			asked.push({ path: url.pathname, body });
			const route = routes[url.pathname];
			if (route === undefined) {
				res.writeHead(404).end("no");
				return;
			}
			const answer = route(body, url);
			res.writeHead(answer.status ?? 200, {
				"content-type": "application/json",
				...(answer.headers ?? {}),
			});
			res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	const served: Served = {
		url: `http://127.0.0.1:${port}`,
		asked,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
	running.push(served);
	return served;
}

async function stateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "squad-oauth-"));
}

describe("reading a refusal", () => {
	it("takes the resource metadata URL out of a WWW-Authenticate header", () => {
		expect(
			resourceMetadataFrom(
				'Bearer error="invalid_token", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
			),
		).toBe("https://api.example.com/.well-known/oauth-protected-resource");
	});

	it("says nothing when the header is not there", () => {
		expect(resourceMetadataFrom(null)).toBeUndefined();
		expect(resourceMetadataFrom("Bearer")).toBeUndefined();
	});

	it("reads a 401 as an invitation to log in", async () => {
		const server = await serve({
			"/mcp": () => ({
				status: 401,
				headers: {
					"www-authenticate":
						'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
				},
				body: { error: "unauthorized" },
			}),
		});
		expect(await reachability(`${server.url}/mcp`)).toEqual({
			kind: "authorize",
			resourceMetadataUrl: "https://example.com/.well-known/oauth-protected-resource",
		});
	});

	it("reads an answer as a server that wants nothing", async () => {
		const server = await serve({ "/mcp": () => ({ body: { jsonrpc: "2.0", id: 1, result: {} } }) });
		expect(await reachability(`${server.url}/mcp`)).toEqual({ kind: "open" });
	});

	it("says why a server it cannot reach was not reached", async () => {
		const answer = await reachability("http://127.0.0.1:1/mcp");
		expect(answer.kind).toBe("unreachable");
	});
});

describe("discovery", () => {
	it("follows protected-resource metadata to the authorization server", async () => {
		const as = await serve({
			"/.well-known/oauth-authorization-server": () => ({
				body: {
					authorization_endpoint: "https://as.example.com/authorize",
					token_endpoint: "https://as.example.com/token",
					registration_endpoint: "https://as.example.com/register",
				},
			}),
		});
		const resource = await serve({
			"/.well-known/oauth-protected-resource/mcp": () => ({
				body: { authorization_servers: [as.url], scopes_supported: ["read", "write"] },
			}),
		});

		const endpoints = await discover(`${resource.url}/mcp`);
		expect(endpoints.authorizationUrl).toBe("https://as.example.com/authorize");
		expect(endpoints.tokenUrl).toBe("https://as.example.com/token");
		expect(endpoints.registrationUrl).toBe("https://as.example.com/register");
		expect(endpoints.scopesSupported).toEqual(["read", "write"]);
		// RFC 8707: what the token is to be spent on, which is the server and not merely its host.
		expect(endpoints.resource).toBe(`${resource.url}/mcp`);
	});

	it("falls back to the conventional paths when a server publishes nothing", async () => {
		const server = await serve({});
		const endpoints = await discover(`${server.url}/mcp`);
		expect(endpoints.authorizationUrl).toBe(`${server.url}/authorize`);
		expect(endpoints.tokenUrl).toBe(`${server.url}/token`);
	});

	it("asks the well-known path both ways round, because servers do both", async () => {
		// Only the OpenID-style suffix answers, which RFC 8414 does not specify but plenty of
		// servers implement.
		const server = await serve({
			"/tenant/.well-known/openid-configuration": () => ({
				body: {
					authorization_endpoint: "https://as.example.com/a",
					token_endpoint: "https://as.example.com/t",
				},
			}),
		});
		const endpoints = await discover(`${server.url}/tenant`);
		expect(endpoints.tokenUrl).toBe("https://as.example.com/t");
	});
});

describe("the flow", () => {
	it("registers a client, and asks for a code bound to a verifier it keeps", async () => {
		const server = await serve({
			"/register": (body) => {
				const asked = JSON.parse(body) as { redirect_uris: string[] };
				expect(asked.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
				return { body: { client_id: "client-abc" } };
			},
		});

		const client = await registerClient(`${server.url}/register`, "http://127.0.0.1:9999/callback");
		expect(client).toEqual({
			clientId: "client-abc",
			redirectUri: "http://127.0.0.1:9999/callback",
		});

		const started = beginAuthorization(
			{
				authorizationUrl: "https://as.example.com/authorize",
				tokenUrl: "https://as.example.com/token",
				resource: "https://api.example.com/mcp",
				scopesSupported: ["read"],
			},
			client,
		);
		const url = new URL(started.url);
		expect(url.searchParams.get("client_id")).toBe("client-abc");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("resource")).toBe("https://api.example.com/mcp");
		expect(url.searchParams.get("scope")).toBe("read");
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(started.verifier).digest("base64url"),
		);
	});

	it("trades the code for a token, sending the verifier and the resource", async () => {
		const server = await serve({
			"/token": (body) => {
				const form = new URLSearchParams(body);
				expect(form.get("grant_type")).toBe("authorization_code");
				expect(form.get("code")).toBe("the-code");
				expect(form.get("code_verifier")).toBe("the-verifier");
				expect(form.get("resource")).toBe("https://api.example.com/mcp");
				return { body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } };
			},
		});

		const granted = await exchangeCode(
			{
				authorizationUrl: `${server.url}/authorize`,
				tokenUrl: `${server.url}/token`,
				resource: "https://api.example.com/mcp",
			},
			{ clientId: "c", redirectUri: "http://127.0.0.1:9999/callback" },
			"the-code",
			"the-verifier",
		);
		expect(granted.accessToken).toBe("at-1");
		expect(granted.refreshToken).toBe("rt-1");
		expect(granted.expiresAt).toBeGreaterThan(Date.now());
	});

	it("says what the server said when the exchange is refused", async () => {
		const server = await serve({
			"/token": () => ({
				status: 400,
				body: { error: "invalid_grant", error_description: "code already used" },
			}),
		});
		await expect(
			exchangeCode(
				{
					authorizationUrl: `${server.url}/authorize`,
					tokenUrl: `${server.url}/token`,
					resource: "r",
				},
				{ clientId: "c", redirectUri: "http://127.0.0.1:9999/callback" },
				"code",
				"verifier",
			),
		).rejects.toThrow(/code already used/);
	});
});

describe("the logins the plane holds", () => {
	async function login(server: Served, overrides: Partial<OAuthLogin> = {}): Promise<OAuthLogin> {
		return {
			host: "api.example.com",
			endpoints: {
				authorizationUrl: `${server.url}/authorize`,
				tokenUrl: `${server.url}/token`,
				resource: "https://api.example.com/mcp",
			},
			client: { clientId: "c", redirectUri: "http://127.0.0.1:9999/callback" },
			accessToken: "at-1",
			refreshToken: "rt-1",
			expiresAt: Date.now() + 3600_000,
			at: new Date().toISOString(),
			...overrides,
		};
	}

	it("keeps a login across restarts, readable by nobody else", async () => {
		const path = join(await stateDir(), "oauth.json");
		const server = await serve({});
		await new OAuthLogins(path).save("notion", await login(server));

		const mode = (await stat(path)).mode & 0o777;
		expect(mode).toBe(0o600);

		const reopened = new OAuthLogins(path);
		expect(await reopened.token("notion")).toBe("at-1");
		expect((await reopened.status("notion"))?.host).toBe("api.example.com");
	});

	it("renews a token that has run out, and keeps the refresh token if none came back", async () => {
		const server = await serve({
			"/token": (body) => {
				const form = new URLSearchParams(body);
				expect(form.get("grant_type")).toBe("refresh_token");
				expect(form.get("refresh_token")).toBe("rt-1");
				return { body: { access_token: "at-2", expires_in: 3600 } };
			},
		});
		const logins = new OAuthLogins(join(await stateDir(), "oauth.json"));
		await logins.save("notion", await login(server, { expiresAt: Date.now() - 1000 }));

		expect(await logins.token("notion")).toBe("at-2");
		// Renewed once for two callers, not twice, and the refresh token survived a server that
		// did not rotate it.
		expect(await logins.token("notion")).toBe("at-2");
		expect(server.asked.filter((each) => each.path === "/token")).toHaveLength(1);
	});

	it("refreshes once when a burst of calls arrives at an expired token", async () => {
		const server = await serve({
			"/token": () => ({ body: { access_token: "at-2", expires_in: 3600 } }),
		});
		const logins = new OAuthLogins(join(await stateDir(), "oauth.json"));
		await logins.save("notion", await login(server, { expiresAt: Date.now() - 1000 }));

		const tokens = await Promise.all([
			logins.token("notion"),
			logins.token("notion"),
			logins.token("notion"),
		]);
		expect(tokens).toEqual(["at-2", "at-2", "at-2"]);
		expect(server.asked.filter((each) => each.path === "/token")).toHaveLength(1);
	});

	it("has nothing for a login it never had, and nothing for one it has forgotten", async () => {
		const path = join(await stateDir(), "oauth.json");
		const server = await serve({});
		const logins = new OAuthLogins(path);
		expect(await logins.token("notion")).toBeUndefined();

		await logins.save("notion", await login(server));
		expect(await logins.forget("notion")).toBe(true);
		expect(await logins.forget("notion")).toBe(false);
		expect(await logins.token("notion")).toBeUndefined();
	});

	it("cannot renew a login the server issued no refresh token for", async () => {
		const server = await serve({});
		const logins = new OAuthLogins(join(await stateDir(), "oauth.json"));
		const { refreshToken, ...never } = await login(server, { expiresAt: Date.now() - 1000 });
		await logins.save("notion", never);
		expect(refreshToken).toBeDefined();
		expect(await logins.token("notion")).toBeUndefined();
	});
});

describe("the store the proxy asks", () => {
	it("answers oauth refs from the logins and everything else from what was there before", async () => {
		const server = await serve({});
		const logins = new OAuthLogins(join(await stateDir(), "oauth.json"));
		await logins.save("notion", {
			host: "api.example.com",
			endpoints: {
				authorizationUrl: `${server.url}/authorize`,
				tokenUrl: `${server.url}/token`,
				resource: "https://api.example.com/mcp",
			},
			client: { clientId: "c", redirectUri: "http://127.0.0.1:9999/callback" },
			accessToken: "at-1",
			at: new Date().toISOString(),
		});

		const store = new OAuthSecretStore(logins, new MemorySecretStore({ GITHUB_TOKEN: "ghp_x" }));
		expect(await store.resolve(oauthRef("notion"))).toBe("at-1");
		expect(await store.resolve({ ref: "GITHUB_TOKEN" })).toBe("ghp_x");
		expect(await store.resolve(oauthRef("nobody"))).toBeUndefined();
	});
});
