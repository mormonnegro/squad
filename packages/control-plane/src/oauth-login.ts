import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
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
} from "@squad/proxy";

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
 * The one door the browser comes back through, and always the same number.
 *
 * A port picked per login cannot be reached in the deployment this is written for: the plane is a
 * container and the browser is on the host, so the door has to be one the operator published in
 * advance. It also gives a client registered by hand in a developer portal a redirect that can be
 * typed in before any of this runs. The cost is that logins are one at a time — a second collides
 * on the port and is told so — which is what a person doing this does anyway.
 */
const CALLBACK_PORT = 8788;

const CALLBACK_PATH = "/callback";

/** What the browser is left looking at, since it is a real page a real person ends up on. */
function page(title: string, detail: string): string {
	return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:3rem;max-width:32rem"><h1 style="font-size:1.2rem">${title}</h1><p>${detail}</p></body>`;
}

/**
 * Every interface rather than loopback, because a port published out of a container is forwarded to
 * the container's address and a listener on its loopback is not on the other end of that.
 *
 * What is left open is a page that answers 404 to everything but the callback and refuses any answer
 * whose `state` is not the one it just issued. An authorization code delivered here by somebody else
 * buys nothing: redeeming it also takes the PKCE verifier, which stays in this process.
 */
async function listen(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(CALLBACK_PORT, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
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
	readonly close: () => Promise<void>;
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

	/** Awaited, because there is one door and whoever cancelled is often about to want it back. */
	async cancel(name: string): Promise<void> {
		const pending = this.#pending.get(name);
		if (pending === undefined) return;
		this.#pending.delete(name);
		pending.fail(new OAuthError("The login was called off."));
		await pending.close();
	}

	async begin(options: BeginLogin): Promise<StartedLogin> {
		await this.cancel(options.name);

		let settle: (login: OAuthLogin) => void = () => {};
		let fail: (error: Error) => void = () => {};
		const done = new Promise<OAuthLogin>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// Nothing may be waiting on this yet — the command answers before the browser does — and an
		// unhandled rejection would take the plane down with it.
		done.catch(() => {});

		// Every answer hangs up. A server that has stopped listening still serves the connections it
		// already had, so a browser that kept one alive would be answered by the login it finished ten
		// minutes ago rather than by the one waiting on the same port now.
		const said = { "content-type": "text/html; charset=utf-8", connection: "close" };
		const server = createServer((request, response) => {
			const asked = new URL(request.url ?? "/", `http://127.0.0.1`);
			if (asked.pathname !== CALLBACK_PATH) {
				response.writeHead(404, { connection: "close" }).end();
				return;
			}
			const finished = this.#returned(options.name, asked);
			finished.then(
				() => {
					response
						.writeHead(200, said)
						.end(page("Logged in.", `${options.host} is reachable now. You can close this tab.`));
				},
				(error: Error) => {
					response.writeHead(400, said).end(page("That did not work.", error.message));
				},
			);
		});

		// Before the client is registered, because the redirect URI is part of the registration and
		// cannot be changed afterwards — and because a login nothing can come back to is not one to start.
		await listen(server).catch((error: Error) => {
			throw new OAuthError(
				`Nothing can listen for the browser coming back on port ${CALLBACK_PORT}: ${error.message}. Another login may still be waiting.`,
			);
		});
		const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

		const abandon = setTimeout(() => {
			void this.cancel(options.name);
		}, ABANDONED_MS);
		abandon.unref();
		const close = async (): Promise<void> => {
			clearTimeout(abandon);
			const closed = once(server, "close");
			server.close();
			// A closed server waits for every connection still open on it, and the browser being told
			// how the login went is one of them. Only the idle ones are hung up on: an abandoned tab
			// keeping a socket alive would otherwise hold the one door shut behind it.
			server.closeIdleConnections();
			await closed;
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
			await close();
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
			// Not awaited here or below: the browser asking is itself a connection the close waits for,
			// and it is still waiting to be told how this went.
			void pending.close();
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
		void pending.close();

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
