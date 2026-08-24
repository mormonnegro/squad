import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	beginAuthorization,
	discover,
	exchangeCode,
	type OAuthClient,
	type OAuthEndpoints,
	OAuthError,
	type OAuthLogin,
	type OAuthLogins,
	registerClient,
} from "@agent-dive/proxy";

/**
 * The half of OAuth that needs a human, which is the half the plane cannot do on its own.
 *
 * Everything else about a login is machinery. This part is a person reading a consent screen with a
 * host name on it and deciding, and that is exactly why a login may make a grant when nothing else
 * an agent can reach may: the authorization did not come from the config file, but it did come from
 * the operator, out of band, on a page the plane never drew.
 */

/** How long an unfinished login is worth holding a port open for. */
const ABANDONED_MS = 10 * 60 * 1000;

/**
 * Where the browser comes back to when the client was registered by hand.
 *
 * A registration made on the spot is told whichever port we happened to get, but one made in a
 * developer portal a week ago was told something the operator had to type in — so that case gets a
 * fixed number they can be told in advance, rather than one they would have to guess.
 */
const FIXED_CALLBACK_PORT = 8788;

const CALLBACK_PATH = "/callback";

/** What the browser is left looking at, since it is a real page a real person ends up on. */
function page(title: string, detail: string): string {
	return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:3rem;max-width:32rem"><h1 style="font-size:1.2rem">${title}</h1><p>${detail}</p></body>`;
}

async function listen(server: Server, port: number): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return (server.address() as AddressInfo).port;
}

/**
 * Asks the desktop to open the page, and does not care whether it could.
 *
 * The URL is printed either way. A plane on a VPS has no browser to open and no way to know that,
 * so a failure here is not a failure of the login — the operator opens it themselves and the flow
 * carries on identically.
 */
export function openInBrowser(url: string): void {
	// The address came from a server's own metadata, and it is about to be an argument. A scheme this
	// narrow is not a URL that can be read as a flag by whatever opens it.
	if (!/^https?:\/\//i.test(url)) return;
	const opener =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		const child = execFile(opener, [url], () => {});
		child.unref();
	} catch {
		// Nothing to do and nothing worth saying: the URL is in the conversation.
	}
}

interface Pending {
	readonly name: string;
	readonly host: string;
	readonly endpoints: OAuthEndpoints;
	readonly client: OAuthClient;
	readonly verifier: string;
	readonly state: string;
	readonly settle: (login: OAuthLogin) => void;
	readonly fail: (error: Error) => void;
	readonly close: () => void;
}

export interface StartedLogin {
	/** The page to open. Printed as well as opened, because opening it may do nothing. */
	readonly url: string;
	readonly redirectUri: string;
	/** Whether a client was registered for this login, or an id had to be supplied. */
	readonly registered: boolean;
	/** Settles when the operator comes back through the browser, or is abandoned. */
	readonly done: Promise<OAuthLogin>;
}

export interface BeginLogin {
	readonly name: string;
	readonly url: string;
	readonly host: string;
	/** For a server that will not register a client, the id of one the operator made themselves. */
	readonly clientId?: string;
	readonly resourceMetadataUrl?: string;
}

/**
 * The logins in flight, and the one door they come back through.
 *
 * Kept as state rather than as a promise nobody holds, so the two ways back are the same login: the
 * browser returning to the loopback listener, and the operator pasting the URL it was sent to when
 * the plane is not on the machine their browser is.
 */
export class LoginDesk {
	readonly #logins: OAuthLogins;
	readonly #open: (url: string) => void;
	readonly #pending = new Map<string, Pending>();

	/** The opener is a seam for the tests, which must not put a browser on somebody's screen. */
	constructor(logins: OAuthLogins, open: (url: string) => void = openInBrowser) {
		this.#logins = logins;
		this.#open = open;
	}

	waiting(name: string): boolean {
		return this.#pending.has(name);
	}

	cancel(name: string): void {
		const pending = this.#pending.get(name);
		if (pending === undefined) return;
		this.#pending.delete(name);
		pending.close();
		pending.fail(new OAuthError("The login was called off."));
	}

	async begin(options: BeginLogin): Promise<StartedLogin> {
		this.cancel(options.name);

		let settle: (login: OAuthLogin) => void = () => {};
		let fail: (error: Error) => void = () => {};
		const done = new Promise<OAuthLogin>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// Nothing may be waiting on this yet — the command answers before the browser does — and an
		// unhandled rejection would take the plane down with it.
		done.catch(() => {});

		const server = createServer((request, response) => {
			const asked = new URL(request.url ?? "/", `http://127.0.0.1`);
			if (asked.pathname !== CALLBACK_PATH) {
				response.writeHead(404).end();
				return;
			}
			const finished = this.#returned(options.name, asked);
			finished.then(
				() => {
					response
						.writeHead(200, { "content-type": "text/html; charset=utf-8" })
						.end(page("Logged in.", `${options.host} is reachable now. You can close this tab.`));
				},
				(error: Error) => {
					response
						.writeHead(400, { "content-type": "text/html; charset=utf-8" })
						.end(page("That did not work.", error.message));
				},
			);
		});

		// The port has to exist before the client is registered, because the redirect URI is part of
		// the registration and cannot be changed afterwards.
		const wanted = options.clientId === undefined ? 0 : FIXED_CALLBACK_PORT;
		const port = await listen(server, wanted).catch((error: Error) => {
			throw new OAuthError(
				`Nothing can listen for the browser coming back${wanted === 0 ? "" : ` on port ${wanted}`}: ${error.message}`,
			);
		});
		const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

		const abandon = setTimeout(() => {
			this.cancel(options.name);
		}, ABANDONED_MS);
		abandon.unref();
		const close = (): void => {
			clearTimeout(abandon);
			server.close();
		};

		let endpoints: OAuthEndpoints;
		let client: OAuthClient;
		try {
			endpoints = await discover(options.url, options.resourceMetadataUrl);
			client =
				options.clientId === undefined
					? await this.#register(endpoints, redirectUri)
					: { clientId: options.clientId, redirectUri };
		} catch (error) {
			close();
			throw error;
		}

		const started = beginAuthorization(endpoints, client);
		this.#pending.set(options.name, {
			name: options.name,
			host: options.host,
			endpoints,
			client,
			verifier: started.verifier,
			state: started.state,
			settle,
			fail,
			close,
		});

		this.#open(started.url);
		return {
			url: started.url,
			redirectUri,
			registered: options.clientId === undefined,
			done,
		};
	}

	async #register(endpoints: OAuthEndpoints, redirectUri: string): Promise<OAuthClient> {
		if (endpoints.registrationUrl === undefined) {
			throw new OAuthError(
				`This server does not register clients. Make one, with ${redirectUri} as its redirect, and say /mcp login <name> <client-id>.`,
			);
		}
		return registerClient(endpoints.registrationUrl, redirectUri);
	}

	/**
	 * Finishes a login from the URL the browser was sent to, however that URL got here.
	 *
	 * Public because the loopback listener is not always reachable: a plane on a server has no
	 * browser, and the operator's browser cannot see its localhost. Pasting the address bar is the
	 * whole of the difference, and the state check is what makes it as safe as the other way.
	 */
	async returned(name: string, redirected: string): Promise<OAuthLogin> {
		let asked: URL;
		try {
			asked = new URL(redirected);
		} catch {
			throw new OAuthError(`"${redirected}" is not the URL the browser was sent to.`);
		}
		return this.#returned(name, asked);
	}

	async #returned(name: string, asked: URL): Promise<OAuthLogin> {
		const pending = this.#pending.get(name);
		if (pending === undefined) throw new OAuthError(`Nothing is waiting to log "${name}" in.`);

		const refused = asked.searchParams.get("error");
		if (refused !== null) {
			const detail = asked.searchParams.get("error_description");
			this.#pending.delete(name);
			pending.close();
			const why = new OAuthError(`${pending.host} refused: ${detail ?? refused}`);
			pending.fail(why);
			throw why;
		}

		const code = asked.searchParams.get("code");
		const state = asked.searchParams.get("state");
		if (code === null) throw new OAuthError("That address carries no authorization code.");
		// Not merely hygiene: without it, a code from somewhere else entirely could be redeemed under
		// this name, and the login the operator ends up holding would be to an account nobody chose.
		if (state !== pending.state) throw new OAuthError("That answer belongs to a different login.");

		this.#pending.delete(name);
		pending.close();

		try {
			const granted = await exchangeCode(pending.endpoints, pending.client, code, pending.verifier);
			const login: OAuthLogin = {
				host: pending.host,
				endpoints: pending.endpoints,
				client: pending.client,
				...granted,
				at: new Date().toISOString(),
			};
			await this.#logins.save(name, login);
			pending.settle(login);
			return login;
		} catch (error) {
			pending.fail(error as Error);
			throw error;
		}
	}
}
