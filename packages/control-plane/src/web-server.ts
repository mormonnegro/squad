import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { AGENT_NAME_PATTERN } from "@squad/agent-repo";
import { SCREEN_VIEW_PORT } from "@squad/screen";
import type { Dial } from "./control-client.ts";
import { Devices, nameFromAgent } from "./devices.ts";
import { Invites } from "./invites.ts";

/**
 * Where the browser knocks. Loopback only, for the same reason 8788 is.
 *
 * The port is fixed rather than chosen so that a link can be typed from memory and a tab left open
 * across a restart still lands somewhere.
 */
export const WEB_PORT = Number(process.env.SQUAD_WEB_PORT ?? "") || 8789;

export const WEB_TOKEN_FILE = "web.token";

/** The browsers that have been let in. A list, where there used to be only a secret. */
export const DEVICES_FILE = "devices.json";

/** The ways in that were handed out: for whom, until when, and whether they were used. */
export const INVITES_FILE = "invites.json";

/**
 * Where a link to a port an agent opened is clicked, which is not where it is answered.
 *
 * `/serve` writes down that a port should be reachable, and what made it so was the terminal
 * console: it bound the port on the machine it was running on and tunnelled each connection over
 * the control socket. Right when you are at that machine, and a lie everywhere else — a plane on a
 * server pointed the link at whatever laptop happened to be reading it.
 *
 * So the plane answers it, and this path is where it is asked: one hop off the console's own
 * address onto a name of the port's own. The link is still built where it is clicked — whatever
 * origin the console is read from is one that can be reached, by definition — and what it is built
 * into is a different origin, which is the whole of `#atHost` below.
 */
export const SERVED_PREFIX = "/at/";

/**
 * The names every port an agent opened is reached on, when the console is read on this machine.
 *
 * Every browser resolves a name under `.localhost` to loopback with nothing configured anywhere,
 * and macOS and systemd-resolved do it for everything else on the machine — so a plane published on
 * loopback has a name per port for free, and needs one: a page an agent wrote must never be read at
 * the address this console is read at.
 */
const LOOPBACK_DOMAIN = ".localhost";

/** The addresses that mean "the machine this browser is on", where the names above resolve to. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** What Caddy asks before it gets a certificate for a name it has just been offered. */
const TLS_ASK = "/tls/ask";

/**
 * Where the console asks what address a port of an agent's is read at.
 *
 * So that the link it draws is the address it opens, rather than a path that turns into one on the
 * way. A link has to say where it goes: it is hovered, copied, sent to a phone, and read before it
 * is clicked.
 *
 * Asked of this door rather than worked out by the page, because the page can almost do it and
 * almost is the wrong amount. The name comes from the address this door is reached at, which in
 * development is not the address the page is read at — the console is a dev server on another port
 * — so a page building the name out of its own address would point it at the dev server.
 */
const SERVED_WHERE = `${SERVED_PREFIX}where`;

/**
 * Where a trigger is posted to, under the same origin as the console.
 *
 * The same path the channel's own server answers on, so a plane reachable both ways answers the
 * same URL either way and nobody has to be told which port they were given.
 */
export const HOOKS_PREFIX = "/hooks/";

/** The cookie the browser carries once it has spent its token. */
const SESSION_COOKIE = "squad_web";

/** The token, for a caller that cannot be sent a cookie. Lowercase: node lowercases what arrives. */
const TOKEN_HEADER = "x-squad-token";

/** Which of this browser's connections a request belongs to. */
const SESSION_HEADER = "x-squad-session";

/**
 * The cookie a served page's own host carries, which is never this console's cookie.
 *
 * A cookie belongs to a host and not to a port, and the console's is written without a domain — so
 * it is `127.0.0.1`'s alone, and a page at `scout-3000.localhost` is handed nothing on its way in.
 * That is the point, and this is what it gets instead: a key for that host, good for reaching ports
 * through this door and for nothing else on it.
 */
const SERVED_COOKIE = "squad_at";

/** The key in a served link, spent for the cookie above the way `?t=` is spent at the front door. */
const SERVED_KEY = "k";

/** The paths that drive the plane, which only this console's own page may ask for. */
const CONTROL = ["/events", "/rpc", "/devices", "/invites"];

/**
 * How often nothing is said down an idle event stream.
 *
 * A stream that goes quiet for minutes is one something in the middle decides is dead — a proxy, a
 * laptop suspending, a browser reclaiming an idle connection. A comment line costs two bytes and is
 * ignored by `EventSource`, which is exactly what a heartbeat should be.
 */
const HEARTBEAT_MS = 25_000;

/** Whose port a path names, and what it was asking that port for. */
/** Where the console reads one of its agents' screens, which is a path here and not a name. */
const SCREEN_PREFIX = "/screen/";

function screening(pathname: string): { agentId: string; path: string } | undefined {
	if (!pathname.startsWith(SCREEN_PREFIX)) return undefined;
	const [agentId = "", ...rest] = pathname.slice(SCREEN_PREFIX.length).split("/");
	if (!AGENT_NAME_PATTERN.test(agentId)) return undefined;
	return { agentId, path: `/${rest.join("/")}` };
}

function servedAt(pathname: string): { agentId: string; port: number; path: string } | undefined {
	if (!pathname.startsWith(SERVED_PREFIX)) return undefined;
	const [agentId = "", said = "", ...rest] = pathname.slice(SERVED_PREFIX.length).split("/");
	const port = Number(said);
	if (agentId === "" || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return { agentId, port, path: `/${rest.join("/")}` };
}

/**
 * The one name a port answers on: whose it is and which port, in a single label.
 *
 * A single label and not two, because what stands in front of a plane on a domain is one wildcard
 * record and one certificate per name it actually sees — and `*.plane.tld` covers `scout-3000` and
 * not `3000.scout`. The number goes last so an agent named with dashes stays readable, and so the
 * two halves come apart again at the last one.
 */
export function servedLabel(agentId: string, port: number): string {
	return `${agentId}-${port}`;
}

/** Whose port a label names. The port is the last piece, so `dev-two-3000` is dev-two's 3000. */
export function fromLabel(label: string): { agentId: string; port: number } | undefined {
	const cut = label.lastIndexOf("-");
	if (cut <= 0) return undefined;
	const agentId = label.slice(0, cut);
	const said = label.slice(cut + 1);
	if (!/^[0-9]{1,5}$/.test(said) || !AGENT_NAME_PATTERN.test(agentId)) return undefined;
	const port = Number(said);
	return port >= 1 && port <= 65_535 ? { agentId, port } : undefined;
}

/** The name in a `Host`, without the port and without the brackets an address in v6 comes in. */
function hostnameOf(host: string | undefined): string {
	const said = (host ?? "").toLowerCase().trim();
	if (said.startsWith("[")) return said.slice(0, said.indexOf("]") + 1) || said;
	const colon = said.indexOf(":");
	return colon === -1 ? said : said.slice(0, colon);
}

/** The port in a `Host`, when it carries one. What the console is read at, a served name is too. */
function portOf(host: string | undefined): string {
	const said = (host ?? "").trim();
	const from = said.startsWith("[") ? said.indexOf("]") + 1 : 0;
	const colon = said.indexOf(":", from);
	return colon === -1 ? "" : said.slice(colon);
}

/**
 * Whether the browser is reading this over TLS, which only the thing in front of this door knows.
 *
 * This server speaks http and always will: what terminates TLS is Caddy, one network away, and the
 * only place the truth exists is the header it sets. Believed because the only thing that can reach
 * this port is that proxy or the operator's own loopback — and what it decides is whether a cookie
 * is written `Secure`, where believing a lie costs a cookie that a browser on https will not keep.
 */
function schemeOf(request: IncomingMessage): "http" | "https" {
	const said = request.headers["x-forwarded-proto"];
	const first = (Array.isArray(said) ? said[0] : said)?.split(",")[0]?.trim();
	return first === "https" ? "https" : "http";
}

/**
 * The cookies that are the page's own, with this door's taken out.
 *
 * What is on the other end of a forward is a server an agent wrote, and everything the browser sent
 * is about to be handed to it. The console's cookie in that pile is the operator's session posted
 * into the sandbox this whole system exists to be a fence around — it would not even have to be
 * stolen, only read off a request log.
 */
function withoutOurs(said: string | string[] | undefined): string | undefined {
	const header = Array.isArray(said) ? said.join("; ") : said;
	if (header === undefined) return undefined;
	const kept = header
		.split(";")
		.map((one) => one.trim())
		.filter((one) => {
			const name = one.split("=")[0]?.trim();
			return name !== SESSION_COOKIE && name !== SERVED_COOKIE;
		});
	return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * What a served page may set a cookie on, which is its own name and nothing above it.
 *
 * `scout-3000.localhost` asking for `Domain=localhost` is a page an agent wrote writing a cookie
 * into the host the console is read at — the same reach-across this whole change is about, coming
 * back the other way. The attribute is dropped rather than the cookie: a cookie for its own host is
 * an ordinary thing for an ordinary app to want, and that is what it gets.
 */
function hostOnly(said: readonly string[]): string[] {
	return said
		.filter((one) => {
			const name = one.split("=")[0]?.trim();
			return name !== SESSION_COOKIE && name !== SERVED_COOKIE;
		})
		.map((one) =>
			one
				.split(";")
				.filter((part) => !/^\s*domain\s*=/i.test(part))
				.join(";"),
		);
}

/** The first line written on a socket, and whatever arrived behind it. */
async function firstLine(socket: Duplex): Promise<Buffer> {
	return new Promise<Buffer>((settle, fail) => {
		let held = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			held = Buffer.concat([held, chunk]);
			if (held.indexOf(0x0a) === -1) return;
			stop();
			settle(held);
		};
		const onEnd = (): void => {
			stop();
			fail(new Error("the plane closed the connection"));
		};
		const stop = (): void => {
			socket.off("data", onData);
			socket.off("end", onEnd);
			socket.off("error", onError);
		};
		const onError = (error: Error): void => {
			stop();
			fail(error);
		};
		socket.on("data", onData);
		socket.once("end", onEnd);
		socket.once("error", onError);
	});
}

export function webTokenPath(stateDir: string): string {
	return join(stateDir, WEB_TOKEN_FILE);
}

const TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
};

export interface WebServerOptions {
	/** The way to the plane's control socket. One is walked per browser session. */
	readonly dial: Dial;
	readonly stateDir: string;
	/** The built web bundle. Absent or unbuilt, the server says so rather than serving nothing. */
	readonly root: string;
	readonly port?: number;
	/** Left out, every interface. See `listen` for why that is the right default here. */
	readonly host?: string;
	/**
	 * Origins other than this one that a browser may drive this plane from.
	 *
	 * Empty by default, which means the only page that can talk to this plane is the one it serves
	 * itself. A hosted console is a page on somebody else's domain reaching a plane on yours, and
	 * whether that is allowed is the operator's decision and nobody else's — so it is named here
	 * rather than assumed, and a plane nobody configured stays a plane only its own page can drive.
	 */
	readonly origins?: readonly string[];
	/**
	 * The domain the ports agents open are reached under, for a plane published at a name.
	 *
	 * A port of an agent's is served at `scout-3000.<this>`, which needs a wildcard record pointing
	 * here and a certificate for each name that is actually asked for — so it is named by the
	 * operator rather than guessed from the console's own address: a plane that invented these names
	 * would hand out links to somewhere the DNS has never heard of.
	 *
	 * Left out, a console read on loopback still has a name per port — every browser resolves
	 * `scout-3000.localhost` to the machine it is on — and a console read anywhere else says so
	 * rather than serving an agent's page at its own address.
	 */
	readonly servedDomain?: string;
	/**
	 * Where a trigger's delivery goes, when this server is running beside the plane that owns them.
	 *
	 * Passed in rather than reached for, because this server is a client of the control socket like
	 * any other console and may be running somewhere else entirely. Given one, a plane published at
	 * a domain has its triggers published at that same domain; without one, they are still answered
	 * on the hook port, which is where they were before this existed.
	 */
	readonly hooks?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

/**
 * The control socket, in front of a browser.
 *
 * Deliberately the thinnest thing that can work: a POST is one line written to the socket and the
 * event stream is every line that comes back. Nothing here knows what an agent is, what a command
 * means or which operations matter — the browser is the client, speaking the same protocol the
 * console speaks, and this is the wire it speaks it down. Anything smarter would be a second
 * implementation of the plane, drifting from the first one the day either changed.
 *
 * What it does own is the door. The control socket has no authentication because holding the file is
 * the authorisation, and a browser can hold no file — so the token below stands in for it, and this
 * class is the whole of what stops a page on some other origin from driving the plane.
 */
export class WebServer {
	readonly #options: WebServerOptions;
	readonly #server: Server;
	/** One live connection per session, opened by its event stream and closed with it. */
	readonly #sessions = new Map<string, Duplex>();
	readonly #devices: Devices;
	readonly #invites: Invites;
	#token = "";

	constructor(options: WebServerOptions) {
		this.#options = options;
		this.#devices = new Devices(join(options.stateDir, DEVICES_FILE));
		this.#invites = new Invites(join(options.stateDir, INVITES_FILE));
		this.#server = createServer((request, response) => {
			this.#route(request, response).catch((error: Error) => {
				this.#fail(response, 500, error.message);
			});
		});
		// A socket that stops being HTTP: a served port with a websocket in it, which is most dev
		// servers. Nothing else here upgrades, so anything that is not a served path is refused
		// rather than routed — this door has one kind of upgrade and no opinion about the rest.
		this.#server.on("upgrade", (request, socket, head) => {
			void this.#upgraded(request, socket as Duplex, head).catch(() => socket.destroy());
		});
	}

	get token(): string {
		return this.#token;
	}

	/** Where it actually landed, which is not what was asked for when what was asked for was 0. */
	get port(): number {
		const address = this.#server.address();
		return typeof address === "object" && address !== null
			? address.port
			: (this.#options.port ?? WEB_PORT);
	}

	/** The address to open, token and all. What `squad web` prints and hands to a browser. */
	get url(): string {
		return `http://127.0.0.1:${this.port}/?t=${this.#token}`;
	}

	async listen(): Promise<void> {
		this.#token = await this.#keepToken();
		await new Promise<void>((settle, fail) => {
			this.#server.once("error", fail);
			// Every interface, and the published port is what makes it loopback — the same shape the
			// webhook server and the OAuth callback already have. Binding 127.0.0.1 here would be
			// tighter on a host and unreachable in a container, which is where the plane actually
			// runs: a published port forwards to the container's address, never to its loopback.
			//
			// What protects this is the token, not the address. `deploy/compose.yaml` publishes it as
			// `127.0.0.1:8789:8789`, which is where the reasoning about who may knock belongs.
			this.#server.listen(this.#options.port ?? WEB_PORT, this.#options.host, () => {
				this.#server.removeListener("error", fail);
				settle();
			});
		});
	}

	async close(): Promise<void> {
		for (const socket of this.#sessions.values()) socket.destroy();
		this.#sessions.clear();
		await new Promise<void>((settle) => this.#server.close(() => settle()));
	}

	/**
	 * The token this plane answers to, made once and kept.
	 *
	 * Kept rather than made every start because the alternative is that restarting the plane logs the
	 * operator out of a tab they are looking at, for a restart that changed nothing they did.
	 */
	async #keepToken(): Promise<string> {
		const path = webTokenPath(this.#options.stateDir);
		const held = await readFile(path, "utf8").catch(() => undefined);
		const trimmed = held?.trim();
		if (trimmed !== undefined && trimmed.length >= 32) return trimmed;

		const made = randomBytes(32).toString("base64url");
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${made}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
		return made;
	}

	/** The origin this answer may be read by, if the operator named it. */
	#allowed(request: IncomingMessage): string | undefined {
		const origin = request.headers.origin;
		if (typeof origin !== "string") return undefined;
		return (this.#options.origins ?? []).includes(origin) ? origin : undefined;
	}

	async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const asked = new URL(request.url ?? "/", `http://127.0.0.1`);

		/*
		 * A port an agent opened, asked for at its own name — which is everything below and nothing
		 * above.
		 *
		 * First, and on its own, because that is the whole of the fix: a page an agent wrote is read
		 * at a host of its own, so the browser hands it no cookie of this console's, refuses it the
		 * answer to anything it asks this console, and keeps whatever it stores away from what the
		 * console stores. Everything under here — the stream, the wire, the list of browsers — is not
		 * on that host at all. There is nothing for a page from a sandbox to reach across to, rather
		 * than a rule saying it may not.
		 */
		const host = this.#servedFrom(request);
		if (host !== undefined) {
			await this.#atHost(request, response, host, asked);
			return;
		}

		/*
		 * Nothing frames this console and nothing sniffs a type out of it.
		 *
		 * The page that would want to frame it is exactly the one this door also serves — a page an
		 * agent wrote — and a frame is the last thing it can still do to a screen the operator is
		 * looking at: it cannot read this origin any more, but it could put it under a mouse and take
		 * the click. Caddy sets this for a plane behind a name; it belongs here, where every plane is.
		 */
		response.setHeader("x-frame-options", "DENY");
		response.setHeader("content-security-policy", "frame-ancestors 'none'");
		response.setHeader("x-content-type-options", "nosniff");

		// Set once and merged into whatever is written later, so no path can answer an allowed origin
		// without it and none has to remember to.
		const origin = this.#allowed(request);
		if (origin !== undefined) {
			response.setHeader("access-control-allow-origin", origin);
			response.setHeader("vary", "origin");
		}

		// Answered before the token is looked for, because a preflight carries no credentials — it is
		// the browser asking whether it may ask, and refusing it is refusing the question.
		//
		// The private-network header is what a page on the public internet needs to reach a plane on
		// loopback at all: without it Chrome holds the request open and nothing ever comes back, which
		// is the least debuggable failure this server could have.
		if (request.method === "OPTIONS") {
			if (origin === undefined) {
				this.#fail(response, 403, "This plane does not answer to that origin.");
				return;
			}
			response
				.writeHead(204, {
					"access-control-allow-methods": "GET, POST, OPTIONS",
					"access-control-allow-headers": `content-type, ${SESSION_HEADER}, ${TOKEN_HEADER}`,
					"access-control-allow-private-network": "true",
					"access-control-max-age": "600",
				})
				.end();
			return;
		}

		/*
		 * The triggers, before the door rather than behind it.
		 *
		 * A trigger is answered to a signature and not to this plane's key: the sender is Stripe or
		 * GitHub, it has never heard of the token, and it never will. Carried here so that a plane
		 * whose console is already published at a domain has its triggers published at that same
		 * domain — one address to expose, one certificate, one thing to remember.
		 */
		if (this.#options.hooks !== undefined && asked.pathname.startsWith(HOOKS_PREFIX)) {
			await this.#options.hooks(request, response);
			return;
		}

		/*
		 * Caddy, asking whether a name somebody has just offered it is one of ours.
		 *
		 * A certificate per served name is got the moment the name is first asked for, which is the
		 * only way to have one for `scout-3000.plane.tld` without a wildcard certificate and the DNS
		 * credentials that getting one needs. Caddy refuses to do that without something to ask, and
		 * it is right to: without this, anybody who points a name at this machine can make it go and
		 * get a certificate for it until the rate limit says no.
		 *
		 * Answered before the door because the thing asking is the proxy in front of the door and
		 * holds no key. What it learns is the shape of a name and nothing about who exists.
		 */
		if (asked.pathname === TLS_ASK) {
			const name = hostnameOf(asked.searchParams.get("domain") ?? "");
			const under = this.#servedDomain();
			const label =
				under !== undefined && name.endsWith(`.${under}`)
					? name.slice(0, -(under.length + 1))
					: undefined;
			const ours = label !== undefined && !label.includes(".") && fromLabel(label) !== undefined;
			response
				.writeHead(ours ? 200 : 403, {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				})
				.end(ours ? "a port this plane serves\n" : "not a name this plane serves\n");
			return;
		}

		/*
		 * A page on another origin, asking this plane to do something.
		 *
		 * The cookie is this host's alone and `SameSite=Strict` keeps it off anything a third site
		 * starts, so this is not the thing standing between a stranger and the plane. What it is for
		 * is the near miss: `scout-3000.plane.tld` is a different origin and the *same site*, so a
		 * browser does send this console's cookie from there to here. It could never read the answer
		 * — but a request whose damage is done by arriving does not need the answer read.
		 *
		 * A caller with no page at all sends neither header and is not a browser: the CLI, a script,
		 * `curl`. They are refused by the key or they are not, like always.
		 */
		//
		// The link to a served port is guarded the same way with one exception, which is the whole of
		// what it is for: a person clicking it. A bookmark, a message, a link in somebody's notes —
		// all of those are a top-level navigation and all of them are let through, and what they land
		// on is a page on another origin either way. A page quietly asking for one is not that: it is
		// a sandbox having a key minted into a browser that was never shown that port.
		const clicked =
			request.headers["sec-fetch-mode"] === "navigate" &&
			request.headers["sec-fetch-dest"] === "document";
		if (
			(CONTROL.some((one) => asked.pathname === one || asked.pathname.startsWith(`${one}/`)) ||
				(asked.pathname.startsWith(SERVED_PREFIX) && !clicked)) &&
			this.#elsewhere(request)
		) {
			this.#fail(
				response,
				403,
				"That came from a page on another origin, which cannot drive this plane.",
			);
			return;
		}

		// Three ways to carry the same secret, because three kinds of caller can carry it. A page this
		// plane serves gets a cookie; a page on another origin sends a header; and an `EventSource`
		// can send neither — it has no header API and no cookie of ours — so the stream takes it in
		// the query string, which is also the one place a person can paste it to begin with.
		const inUrl = asked.searchParams.get("t");
		const inHeader = request.headers[TOKEN_HEADER];
		const carried =
			inUrl ?? (typeof inHeader === "string" ? inHeader : cookie(request, SESSION_COOKIE));

		/*
		 * Who this browser already is, asked before anything is spent.
		 *
		 * A link with `?t=` on it gets bookmarked, and an invitation runs out — so the browser that
		 * used one and has held its own key ever since would otherwise be refused at the door by the
		 * address it came in on. Whoever is already in is already in, and the stale key in the URL is
		 * nothing: they are sent to the same page without it, like everybody else.
		 *
		 * Only when there is something in the address at all, because otherwise this is the same
		 * question the line below already asks about the same cookie.
		 */
		const already =
			inUrl === null ? undefined : await this.#devices.whose(cookie(request, SESSION_COOKIE));

		// The two things an address can carry: this plane's own token, which is on the machine, and an
		// invitation, which is what somebody is handed. Spent here because the answer decides both
		// whether this request is refused and, further down, which invitation a new browser came in on.
		const invited =
			inUrl !== null && !this.#isToken(inUrl) && already === undefined
				? await this.#invites.spend(inUrl)
				: undefined;
		if (inUrl !== null && !this.#isToken(inUrl) && invited === undefined && already === undefined) {
			// One sentence for three cases — not this plane's, already spent, ran out — because the
			// difference is only useful to somebody guessing, and whoever is holding a link that no
			// longer works has to ask for another either way.
			this.#fail(response, 403, "That key is not this plane's, or the invitation has run out.");
			return;
		}

		// Who this is, which is a different question from whether they may be here and is the one worth
		// being able to answer. A device is a line in a list with a name and a date; the bootstrap
		// token is not one of them and never becomes one — it is the thing that hands them out.
		// Falling back to the cookie, for the browser that arrived with a key in the address that has
		// since run out: what it is carrying in the URL is nothing, and what it is carrying in the
		// cookie is itself.
		const whose = this.#isToken(carried)
			? undefined
			: ((await this.#devices.whose(carried)) ?? already);
		if (!this.#isToken(carried) && whose === undefined && invited === undefined) {
			// Said plainly rather than with a login form, because there is no password to type: whoever
			// should be here already holds a file on that machine.
			//
			// Naming the file rather than only the command, because the command is a thing this door is
			// increasingly reached without — an operator who installed by pipe has the address in their
			// scrollback and nothing on their PATH, and being told to run something they do not have is
			// being told nothing. What this is, is said first: somebody arriving here by accident should
			// learn what they found, and somebody who belongs here should not have to guess which half
			// of their address went missing.
			this.#fail(
				response,
				401,
				"This is a squad control plane. The address that opens it ends in `?t=` and a key — " +
					"the installer printed the whole of it, `squad web` prints it again on that machine, " +
					"and it is the file web.token in the state directory.",
			);
			return;
		}

		// A page opened with the token in its address is sent back to the same page without it, holding
		// a cookie instead: an address is copied, pasted and left in a history, and a cookie is not.
		// The stream and the wire are not pages and have nowhere to be redirected to.
		//
		// What the cookie holds is no longer the token. Arriving with the token is how a browser is
		// let in, and what it leaves with is a secret of its own — one line in a list, with a name, a
		// date, and a way to be taken out that takes nobody else out with it. The token stays what it
		// was on the machine that holds it: the thing that admits browsers, not the thing they carry.
		if (inUrl !== null && asked.pathname !== "/events" && asked.pathname !== "/rpc") {
			// `already` is the cookie's own answer rather than the address's, because those are different
			// questions and only one of them is "has this browser been let in". Opening the address a
			// second time is the ordinary thing — a reload, `squad open` again, a link still in the bar
			// — and it was minting a device every time, so one laptop became a column of identical rows
			// and the list stopped being a list of who.
			const admitted =
				already === undefined && (this.#isToken(carried) || invited !== undefined)
					? await this.#devices.issue(nameFromAgent(request.headers["user-agent"]), invited?.id)
					: undefined;
			// Spent by the browser that used it, not by the one that opened the link twice: a reload
			// carries the cookie it already holds and admits nobody, so it takes nothing off the count.
			if (admitted !== undefined && invited !== undefined) {
				await this.#invites.spent(invited.id, admitted.device.id);
			}
			const head: Record<string, string> = { location: asked.pathname };
			// Only when there is a new one to hand over. A browser that already holds its key is sent
			// back to the page with the key it has.
			if (admitted !== undefined) {
				head["set-cookie"] =
					`${SESSION_COOKIE}=${admitted.secret}; HttpOnly; SameSite=Strict; Path=/`;
			} else if (already === undefined) {
				head["set-cookie"] = `${SESSION_COOKIE}=${carried}; HttpOnly; SameSite=Strict; Path=/`;
			}
			response.writeHead(302, head).end();
			return;
		}

		// The list, and the way out of it. Here rather than on the control protocol because a device is
		// a fact about this door and not about the plane: the console in a terminal reaches the same
		// plane over a socket and has no device, so an operation it could never answer has no business
		// on a protocol it speaks.
		if (asked.pathname === "/devices") {
			if (request.method === "GET") {
				this.#json(response, {
					devices: await this.#devices.all(),
					// Which of them is reading this, so a screen can say "this one" on the right row and
					// ask twice before somebody locks themselves out of the thing they are looking at.
					...(whose === undefined ? {} : { here: whose.id }),
				});
				return;
			}
			this.#fail(response, 405, "That is not something to do to the list.");
			return;
		}
		/*
		 * The invitations: what has been handed out, one more, and calling one off.
		 *
		 * Beside the devices and for the same reason they are: this is a fact about this door rather
		 * than about the plane. A console in a terminal reaches the same plane over a socket and is
		 * already trusted by holding a file on the machine — it has no browser to let in and nothing
		 * to be handed.
		 */
		if (asked.pathname === "/invites") {
			if (request.method === "GET") {
				await this.#invites.tidy();
				this.#json(response, { invites: await this.#invites.all() });
				return;
			}
			if (request.method === "POST") {
				const said = await read(request);
				const { label, lasts, uses } = JSON.parse(said || "{}") as {
					label?: unknown;
					lasts?: unknown;
					uses?: unknown;
				};
				if (typeof label !== "string" || label.trim().length === 0) {
					this.#fail(response, 400, "An invitation says who it is for.");
					return;
				}
				const made = await this.#invites.issue({
					label,
					...(lasts === "hour" || lasts === "day" || lasts === "week" ? { lasts } : {}),
					...(typeof uses === "number" ? { uses } : {}),
				});
				// The secret, once. It is never readable again from anywhere, which is why the screen
				// that asked for it has to put it in front of somebody before it puts it away.
				this.#json(response, { invite: made.invite, secret: made.secret });
				return;
			}
			this.#fail(response, 405, "That is not something to do to the list.");
			return;
		}
		if (asked.pathname.startsWith("/invites/")) {
			const id = asked.pathname.slice("/invites/".length);
			if (request.method === "DELETE") {
				this.#json(response, { gone: await this.#invites.revoke(id) });
				return;
			}
			this.#fail(response, 405, "That is not something to do to an invitation.");
			return;
		}
		if (asked.pathname.startsWith("/devices/")) {
			const id = asked.pathname.slice("/devices/".length);
			if (request.method === "DELETE") {
				this.#json(response, { gone: await this.#devices.revoke(id) });
				return;
			}
			if (request.method === "POST") {
				const named = await read(request);
				const name = (JSON.parse(named || "{}") as { name?: unknown }).name;
				if (typeof name !== "string" || name.trim().length === 0) {
					this.#fail(response, 400, "A device needs a name to be given one.");
					return;
				}
				this.#json(response, { renamed: await this.#devices.rename(id, name.trim().slice(0, 60)) });
				return;
			}
			this.#fail(response, 405, "That is not something to do to a device.");
			return;
		}

		if (asked.pathname === "/events") {
			await this.#stream(request, response);
			return;
		}
		if (asked.pathname === "/rpc") {
			await this.#relay(request, response);
			return;
		}

		/*
		 * A link to a port inside a sandbox, which this door answers by sending the browser somewhere
		 * else.
		 *
		 * The somewhere else is a name of that port's own, and the key on the end of it is what the
		 * browser spends there for a cookie that host can carry. Both halves are necessary: the name
		 * is what makes it another origin, and the key is what a browser has no way of being handed
		 * otherwise, because a cookie written here belongs to this host and is never sent to that one.
		 *
		 * The path is kept, so a deep link is still a deep link, and `/at/scout/3000/` typed from
		 * memory still lands where it always did.
		 */
		if (asked.pathname === SERVED_WHERE) {
			const agentId = asked.searchParams.get("agent") ?? "";
			const port = Number(asked.searchParams.get("port") ?? "");
			const to =
				AGENT_NAME_PATTERN.test(agentId) && Number.isInteger(port) && port >= 1 && port <= 65_535
					? this.#servedOrigin(request, agentId, port)
					: undefined;
			// Null rather than an absence, because "there is no name for this here" is an answer and the
			// screen has something to do with it: keep the path, which lands on the page that says why.
			this.#json(response, {
				url:
					to === undefined
						? null
						: `${to}/?${SERVED_KEY}=${encodeURIComponent(this.#pass(whose?.id, servedLabel(agentId, port)))}`,
			});
			return;
		}

		/*
		 * A screen, read at this console's own address rather than at a name of its own.
		 *
		 * Every other port an agent opens is answered at `scout-3000.localhost`, which keeps a page an
		 * agent wrote off the origin this console is read at. A screen is the one thing here that is
		 * not a page an agent wrote — what crosses is a JPEG, and the console draws the frame around
		 * it itself — so it is the one that can be answered here, and it has to be: the name has an
		 * IPv6 address that nothing answers on, because Docker Desktop publishes a loopback port on
		 * IPv4 alone and silently drops a `[::1]` publish. A browser survives that on a tab it can
		 * retry and not on a picture inside a page, which is a link that works when you paste it and
		 * not where it is used.
		 *
		 * What is served through here is pixels and four small JSON answers, to a console that has
		 * already proved who it is. No document from that container is ever read at this address.
		 */
		const screen = screening(asked.pathname);
		if (screen !== undefined) {
			// The picture, and the one response on this door that has to be sniffed.
			//
			// A stream of JPEGs is `multipart/x-mixed-replace`, which is how a picture that keeps
			// changing has been sent since before any of this — and it is not an `image/*` type, so a
			// browser told not to sniff refuses to draw it in an `<img>`. Silently: the element is
			// there, the request is a 200, and the space where the page should be stays empty.
			//
			// Dropped for this path and no other. What nosniff is for is a browser deciding that
			// something is script; what is on the other end of this is a JPEG, written by us, a
			// frame at a time.
			if (screen.path === "/frames") response.removeHeader("x-content-type-options");
			await this.#served(
				request,
				response,
				{ agentId: screen.agentId, port: SCREEN_VIEW_PORT },
				`${screen.path}${asked.search}`,
			);
			return;
		}

		const served = servedAt(asked.pathname);
		if (served !== undefined) {
			const to = this.#servedOrigin(request, served.agentId, served.port);
			if (to === undefined) {
				this.#nameless(request, response, served.agentId, served.port);
				return;
			}
			const target = new URL(`${served.path}${asked.search}`, to);
			target.searchParams.set(
				SERVED_KEY,
				this.#pass(whose?.id, servedLabel(served.agentId, served.port)),
			);
			response.writeHead(302, { location: target.href, "cache-control": "no-store" }).end();
			return;
		}

		await this.#file(asked.pathname, response);
	}

	/** The domain served ports hang off, when the operator has given this plane one. */
	#servedDomain(): string | undefined {
		const said = this.#options.servedDomain?.toLowerCase().replace(/^\.+/, "").trim();
		return said === undefined || said.length === 0 ? undefined : said;
	}

	/**
	 * Whose port this request arrived at, when it arrived at a port's name rather than the console's.
	 *
	 * Read off the `Host` and nothing else, because the name is the whole of what separates the two:
	 * one listener answers both, and which of them a request is for is decided here or nowhere.
	 */
	#servedFrom(request: IncomingMessage): { agentId: string; port: number } | undefined {
		const name = hostnameOf(request.headers.host);
		const under = this.#servedDomain();
		const label = name.endsWith(LOOPBACK_DOMAIN)
			? name.slice(0, -LOOPBACK_DOMAIN.length)
			: under !== undefined && name.endsWith(`.${under}`)
				? name.slice(0, -(under.length + 1))
				: undefined;
		// One label. Anything with a dot left in it is a name below a served one, which is nobody's.
		if (label === undefined || label.length === 0 || label.includes(".")) return undefined;
		return fromLabel(label);
	}

	/**
	 * Where a port of an agent's is read, built from where this console is being read.
	 *
	 * Two answers and a refusal. On loopback every browser resolves `scout-3000.localhost` to the
	 * machine the browser is on, which is where this plane's port is published — so a plane installed
	 * on a laptop has a name per port with nothing configured and nothing to look up. Behind a domain
	 * it is a name under that domain, which needs a wildcard record and a certificate per name, so it
	 * is the operator who says the word: `SQUAD_SERVED_DOMAIN`.
	 *
	 * And where neither is true — a console read at a bare address on a network — there is no name to
	 * be had, and this says so rather than handing back a link to somewhere that will not answer.
	 */
	#servedOrigin(request: IncomingMessage, agentId: string, port: number): string | undefined {
		const label = servedLabel(agentId, port);
		// What the DNS allows in one label. Past it there is no name, and a link that is not a name is
		// worse than being told plainly that this port cannot have one.
		if (label.length > 63) return undefined;
		const name = hostnameOf(request.headers.host);
		const said = portOf(request.headers.host);
		const scheme = schemeOf(request);
		if (LOOPBACK.has(name)) return `${scheme}://${label}${LOOPBACK_DOMAIN}${said}`;
		const under = this.#servedDomain();
		if (under !== undefined && (name === under || name.endsWith(`.${under}`))) {
			return `${scheme}://${label}.${under}${said}`;
		}
		return undefined;
	}

	/**
	 * Everything asked of a port's own name, which is the sandbox's and never this console's.
	 *
	 * No token, no device, no file of the bundle, no path of the plane's: this host is the agent's
	 * server and the whole of it. What stands at the front is a key — spent once for a cookie of this
	 * host's own, then taken back out of the address, so what the page is read at is the address a
	 * person would have typed.
	 */
	async #atHost(
		request: IncomingMessage,
		response: ServerResponse,
		to: { agentId: string; port: number },
		asked: URL,
	): Promise<void> {
		const label = servedLabel(to.agentId, to.port);
		const key = asked.searchParams.get(SERVED_KEY);

		if (key !== null) {
			if (!(await this.#passed(key, label))) {
				this.#stranger(response, to.agentId, to.port);
				return;
			}
			asked.searchParams.delete(SERVED_KEY);
			// `Lax` rather than `Strict`, and that is the difference between working and a door that
			// never opens: every arrival here is a click from the console, which is another site, and a
			// `Strict` cookie is not sent on one — including the hop right below, which would come back
			// with nothing and ask for a key again.
			response
				.writeHead(302, {
					"set-cookie": `${SERVED_COOKIE}=${key}; HttpOnly; SameSite=Lax; Path=/${
						schemeOf(request) === "https" ? "; Secure" : ""
					}`,
					location: `${asked.pathname}${asked.search}`,
					"cache-control": "no-store",
				})
				.end();
			return;
		}
		if (!(await this.#passed(cookie(request, SERVED_COOKIE), label))) {
			this.#stranger(response, to.agentId, to.port);
			return;
		}
		await this.#served(request, response, to);
	}

	/**
	 * The key that opens one port of one agent's, handed to a browser that is already in.
	 *
	 * Derived rather than written down: the plane restarts and the same browser's key is still its
	 * key, and there is no third list to be kept in step with the two that exist. What it is derived
	 * from is two things, and both matter. The device, so taking a browser out of that list takes
	 * its way into the sandboxes with it — a key that outlived a revoked device would be the quiet
	 * way back in. And the port's own name, so the link the console draws is a key to that one
	 * preview and not to everything every agent is serving: it is in a link, and a link gets copied
	 * and sent to a phone, which is most of what these are for.
	 */
	#pass(deviceId: string | undefined, label: string): string {
		const who = deviceId ?? "-";
		return `${who}.${createHmac("sha256", this.#token)
			.update(`${who}\n${label}`, "utf8")
			.digest("base64url")}`;
	}

	/** Whether a key, or the cookie made from one, is this door's, for this port, and still somebody's. */
	async #passed(offered: string | undefined, label: string): Promise<boolean> {
		if (offered === undefined || offered.length === 0) return false;
		const cut = offered.lastIndexOf(".");
		if (cut <= 0) return false;
		const who = offered.slice(0, cut);
		const mine = Buffer.from(this.#pass(who === "-" ? undefined : who, label), "utf8");
		const theirs = Buffer.from(offered, "utf8");
		if (mine.byteLength !== theirs.byteLength || !timingSafeEqual(mine, theirs)) return false;
		// The plane's own token is not a device and never becomes one — it is what hands them out, and
		// whoever holds it holds the file on the machine.
		if (who === "-") return true;
		return (await this.#devices.all()).some((device) => device.id === who);
	}

	/**
	 * Whether the page that made this request is one other than this console's own.
	 *
	 * The origin is asked for first because a browser puts it on anything with a side effect. What
	 * answers for the rest is `Sec-Fetch-Site`, which every browser has sent for years and which no
	 * page can set: `none` is somebody typing an address, `same-origin` is this console's own page,
	 * and everything else is somewhere else — a served port included, which is the whole point.
	 */
	#elsewhere(request: IncomingMessage): boolean {
		if (this.#allowed(request) !== undefined) return false;
		const origin = request.headers.origin;
		if (typeof origin === "string" && origin.length > 0) {
			if (origin === "null") return true;
			try {
				return (
					new URL(origin).host !== hostnameOf(request.headers.host) + portOf(request.headers.host)
				);
			} catch {
				return true;
			}
		}
		const site = request.headers["sec-fetch-site"];
		return typeof site === "string" && site !== "same-origin" && site !== "none";
	}

	/**
	 * A port that cannot be given a name, said where somebody clicked expecting a page.
	 *
	 * The console is being read at an address with no names under it — a machine's own address on a
	 * network, most likely — and a page an agent wrote is not going to be served at the address this
	 * console is read at. That is the one rule this door has, so the answer is the two ways to give
	 * it a name rather than the page.
	 */
	#nameless(
		request: IncomingMessage,
		response: ServerResponse,
		agentId: string,
		port: number,
	): void {
		const name = hostnameOf(request.headers.host);
		response
			.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
			.end(
				`<!doctype html><meta charset="utf-8"><title>${agentId}:${port} — no name to open it at</title>` +
					`<body style="background:#0b0c0e;color:#dedcd7;font:15px/1.7 ui-sans-serif,system-ui,sans-serif;padding:3rem;max-width:36rem">` +
					`<p style="font-size:1.05rem;margin:0 0 0.6rem">${agentId}'s ${port} needs a name of its own, and this console is being read at <code>${name}</code>, which has none under it.</p>` +
					`<p style="color:#9ba1a9;margin:0 0 0.6rem">A page an agent wrote is never served at the address this console is read at: same address, same cookie, and the page would be able to drive the plane as you. So it is served at <code>${servedLabel(agentId, port)}.…</code> instead, and this address cannot make one.</p>` +
					`<p style="color:#9ba1a9;margin:0">Read the console at <code>localhost</code> — an <code>ssh -L 8789:127.0.0.1:8789</code> to this machine is the whole of it — and every port gets a name with nothing else to do. Or give the plane a domain: a wildcard record <code>*.plane.example</code> at this machine, and <code>SQUAD_SERVED_DOMAIN=plane.example</code> in <code>deploy/.env</code>.</p>` +
					`<style>code{font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:#0e1013;` +
					`border:1px solid #22252a;border-radius:4px;padding:0.1em 0.35em}</style>`,
			);
	}

	/** Somebody at a served name with no key: not a way in, and the way in is one click elsewhere. */
	#stranger(response: ServerResponse, agentId: string, port: number): void {
		response
			.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
			.end(
				`<!doctype html><meta charset="utf-8"><title>${agentId}:${port}</title>` +
					`<body style="background:#0b0c0e;color:#dedcd7;font:15px/1.7 ui-sans-serif,system-ui,sans-serif;padding:3rem;max-width:34rem">` +
					`<p style="font-size:1.05rem;margin:0 0 0.6rem">This is ${agentId}'s ${port}, and this browser has not been let in.</p>` +
					`<p style="color:#9ba1a9;margin:0">The link beside ${agentId} in the console opens it, and hands this address the key as it goes. A key is per browser: one that was taken off the list of browsers stops opening this too.</p>`,
			);
	}

	/**
	 * One browser session's connection to the plane, as an event stream.
	 *
	 * The stream owns the socket: it is opened when the stream opens and destroyed when it closes.
	 * That makes a reload mean a fresh connection rather than a reattachment, which is the honest
	 * shape — a subscription that was not being read has no backlog to hand over, so pretending the
	 * session survived would be handing back a stream with a hole in it. The client asks again for
	 * what it missed, which it has to be able to do anyway for the day the plane restarts.
	 */
	async #stream(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const id = randomBytes(16).toString("hex");
		let socket: Duplex;
		try {
			socket = await this.#options.dial();
		} catch (error) {
			this.#fail(response, 502, `The plane did not answer: ${(error as Error).message}`);
			return;
		}

		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			// Nothing in front of this should hold it back a chunk at a time waiting for more.
			"x-accel-buffering": "no",
		});
		// The session id goes out first, so the client has something to name this connection in a POST
		// before it has seen a single event.
		response.write(`event: session\ndata: ${id}\n\n`);
		this.#sessions.set(id, socket);

		// Whole lines only. The protocol is newline-delimited and a chunk boundary lands wherever TCP
		// decides — half a line forwarded as an event is a JSON parse failure in the browser for a
		// message that was never malformed.
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.trim().length === 0) continue;
				response.write(`data: ${line}\n\n`);
			}
		});

		const beat = setInterval(() => response.write(": beat\n\n"), HEARTBEAT_MS);
		beat.unref();
		const done = (): void => {
			clearInterval(beat);
			this.#sessions.delete(id);
			socket.destroy();
			response.end();
		};
		socket.once("close", done);
		socket.once("error", done);
		request.once("close", done);
	}

	/** One request from the browser, written to that session's socket exactly as it arrived. */
	/**
	 * A websocket into a served port, which is a request that stops being one halfway through.
	 *
	 * Written out as bytes rather than spoken as HTTP, because after the handshake there is no HTTP
	 * left to speak: the upgrade line and its headers go down the tunnel as they arrived, and from
	 * the answer onwards the two sockets are the same conversation.
	 */
	async #upgraded(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		// Whose port this is, asked of the name it arrived at. An upgrade skips `#route`, so the key
		// is asked for here or it is a way in that asks nobody — and the key is the served host's own,
		// because that is the only one a browser sends to a served host.
		const to = this.#servedFrom(request);
		if (
			to === undefined ||
			!(await this.#passed(cookie(request, SERVED_COOKIE), servedLabel(to.agentId, to.port)))
		) {
			socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
			return;
		}

		const here = new URL(request.url ?? "/", "http://squad.invalid");
		const tunnel = await this.#forward(to.agentId, to.port);
		const lines = [`${request.method ?? "GET"} ${here.pathname}${here.search} HTTP/1.1`];
		for (const [name, value] of Object.entries(request.headers)) {
			if (value === undefined) continue;
			// The same two that are taken out of an ordinary request, for the same reason: what is on
			// the other end of this is a server an agent wrote.
			if (name === TOKEN_HEADER || name === SESSION_HEADER) continue;
			const said =
				name === "host" ? `127.0.0.1:${to.port}` : name === "cookie" ? withoutOurs(value) : value;
			if (said === undefined) continue;
			for (const one of Array.isArray(said) ? said : [said]) lines.push(`${name}: ${one}`);
		}
		tunnel.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head.byteLength > 0) tunnel.write(head);

		tunnel.pipe(socket);
		socket.pipe(tunnel);
		// Either end going is the end of both. A half-open one is a browser holding a connection to a
		// server that has gone, and a socket left open in a sandbox nobody is reading.
		socket.on("error", () => tunnel.destroy());
		tunnel.on("error", () => socket.destroy());
		socket.once("close", () => tunnel.destroy());
	}

	/**
	 * One request into a port an agent opened, and its answer back out.
	 *
	 * Spoken as HTTP over the tunnel rather than piped as bytes, because two things have to be taken
	 * out on the way in and one put back on the way out, and all three are headers: the keys this
	 * console holds do not go into a sandbox, and a cookie that comes back out of one belongs to the
	 * name it came from and to nothing above it.
	 *
	 * What used to be here as well was a `<base>` written into every page and a prefix put back onto
	 * every redirect, because the page was being served under a path that was not its own. It is
	 * served at its own name now, so a path in there is that path out here, and a page whose links
	 * all point at the root is a page whose links work.
	 */
	async #served(
		request: IncomingMessage,
		response: ServerResponse,
		to: { agentId: string; port: number },
		/** The path to ask that port for, when it is not the one this request arrived at. */
		instead?: string,
	): Promise<void> {
		let tunnel: Duplex;
		try {
			tunnel = await this.#forward(to.agentId, to.port);
		} catch (error) {
			this.#quiet(response, to.agentId, to.port, (error as Error).message);
			return;
		}

		const headers = { ...request.headers };
		// The port inside the sandbox is what that server thinks it is behind, and it is right: a dev
		// server that refuses a host it does not know refuses every name this door could invent. What
		// the outside actually looks like is said beside it, for a server that wants to know.
		headers["x-forwarded-host"] = request.headers.host ?? "";
		headers["x-forwarded-proto"] = schemeOf(request);
		headers.host = `127.0.0.1:${to.port}`;
		delete headers.connection;
		// Nothing of this door's goes through it. The session header is how a browser names its
		// connection to the plane and the cookie is the operator's own way in — both of them are keys
		// to the thing the sandbox is a fence around, and neither has any business being read by a
		// server an agent wrote.
		delete headers[TOKEN_HEADER];
		delete headers[SESSION_HEADER];
		const mine = withoutOurs(request.headers.cookie);
		if (mine === undefined) delete headers.cookie;
		else headers.cookie = mine;

		const here = new URL(instead ?? request.url ?? "/", "http://squad.invalid");
		const asked = httpRequest(
			{
				createConnection: () => tunnel as never,
				method: request.method ?? "GET",
				path: `${here.pathname}${here.search}`,
				headers,
			},
			(answer) => {
				const out = { ...answer.headers };
				// Node re-frames the body on the way out, so the framing that arrived is not the framing
				// that leaves. Everything else about it — the encoding, the length, the type — is the
				// sandbox's own answer and goes through untouched.
				delete out["transfer-encoding"];
				delete out.connection;
				const cookies = answer.headers["set-cookie"];
				if (cookies !== undefined) out["set-cookie"] = hostOnly(cookies);
				response.writeHead(answer.statusCode ?? 502, out);
				answer.pipe(response);
			},
		);

		asked.on("error", (error: Error) => {
			tunnel.destroy();
			// A tunnel that opened and then died is the relay giving up on a port nothing answered at.
			// "socket hang up" is what node calls that, and it is a sentence about a socket in front of
			// somebody who clicked a link.
			if (!response.headersSent) this.#quiet(response, to.agentId, to.port, error.message);
			else response.end();
		});
		response.once("close", () => tunnel.destroy());
		request.pipe(asked);
	}

	/**
	 * A stream to a port inside a sandbox, opened the way the console opens one.
	 *
	 * The control protocol turns a connection into a pipe: one request written, one answer read, and
	 * everything after it on that socket is the port. Written here rather than borrowed from the
	 * client because this end has a `dial` and not a client — the same four lines either way.
	 */
	async #forward(agentId: string, port: number): Promise<Duplex> {
		const socket = await this.#options.dial();
		socket.write(`${JSON.stringify({ id: "forward", op: "forward", agentId, port })}\n`);
		const answered = await firstLine(socket);
		const newline = answered.indexOf(0x0a);
		const said = JSON.parse(answered.subarray(0, newline).toString("utf8")) as {
			ok?: boolean;
			error?: string;
		};
		if (said.ok === false) {
			socket.destroy();
			throw new Error(said.error ?? "that port is not being served");
		}
		// Anything that arrived behind the answer is already the port talking.
		const rest = answered.subarray(newline + 1);
		if (rest.byteLength > 0) socket.unshift(rest);
		return socket;
	}

	async #relay(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const id = request.headers[SESSION_HEADER];
		const socket = typeof id === "string" ? this.#sessions.get(id) : undefined;
		if (socket === undefined) {
			// The stream is what holds the connection, so a POST without one is a client that has not
			// opened it yet or one whose stream has gone. Both are the same instruction: open it again.
			this.#fail(response, 409, "No open event stream for this session.");
			return;
		}

		const body = await read(request);
		// One line in, one line written. A body carrying a newline of its own would be two requests
		// where the client meant one, and the second would be whatever it managed to split.
		const line = body.replace(/[\r\n]+/g, " ").trim();
		if (line.length === 0) {
			this.#fail(response, 400, "Nothing to send.");
			return;
		}
		socket.write(`${line}\n`);
		response.writeHead(204).end();
	}

	async #file(pathname: string, response: ServerResponse): Promise<void> {
		const root = resolve(this.#options.root);
		// Anything that is not a file is the application's own address to resolve: it is one page with
		// its own routes, and a reload deep inside it has to land on the same HTML.
		const asked = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
		const target = resolve(root, asked);
		const inside = target === root || target.startsWith(root + sep);
		const file = inside && extname(target) !== "" ? target : join(root, "index.html");

		const found = await stat(file).catch(() => undefined);
		/*
		 * The bundle's own files, asked for from wherever the page happens to be standing.
		 *
		 * The addresses in the HTML are relative — `./assets/index-abc.js` — because the same bundle is
		 * served from here at the root and from a website under a path, and an absolute address is
		 * wrong in one of the two. What that costs is this: a page opened at `/agents/scout/files/x`
		 * asks for `/agents/scout/files/assets/index-abc.js`, which is not where anything is, and the
		 * failure is a blank screen with nothing in the console — a deep link that works while you
		 * click your way to it and never when somebody opens it.
		 *
		 * So an asset is found by its own directory rather than by the path it was asked from. One
		 * directory, named by the build, and everything in it is already inside the bundle — which is
		 * the same trick the served ports pull with the referer, for the same reason.
		 */
		if (found === undefined && inside) {
			const own = asked.lastIndexOf(`assets/`);
			if (own > 0) {
				const under = resolve(root, asked.slice(own));
				if (under.startsWith(root + sep)) {
					const also = await stat(under).catch(() => undefined);
					if (also?.isFile() === true) return this.#send(under, response);
				}
			}
		}
		if (found === undefined || !found.isFile()) {
			await this.#unbuilt(response);
			return;
		}
		this.#send(file, response);
	}

	/** One file of the bundle, out. */
	#send(file: string, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": TYPES[extname(file)] ?? "application/octet-stream",
			// The bundle's names carry its version; the page that names them must never be a stale copy.
			"cache-control": extname(file) === ".html" ? "no-store" : "public, max-age=604800",
		});
		createReadStream(file).pipe(response);
	}

	/**
	 * A port that was opened and is not answering.
	 *
	 * `/serve 3101` writes down that a port should be reachable; what makes it reachable is something
	 * listening on it inside the sandbox, and that is a process, and processes stop. The link stays —
	 * it is a standing arrangement rather than a handle on a running thing, and it starts working
	 * again the moment something binds that port in there.
	 *
	 * So the page says which of the two halves is missing, in those words. What was here was the
	 * error node gives a socket that closed, on a black page: true, and about the wrong subject.
	 */
	#quiet(response: ServerResponse, agentId: string, port: number, why: string): void {
		if (response.headersSent) {
			response.end();
			return;
		}
		const said = why.includes("not serving")
			? `${agentId} has no link open on ${port}.`
			: `Nothing is listening on ${port} inside ${agentId}'s sandbox.`;
		const next = why.includes("not serving")
			? `<code>/serve ${port}</code> in ${agentId}'s conversation opens one.`
			: `Whatever was serving it has stopped. Start it again in there — with <code>keep</code>, ` +
				`so it outlives the turn that starts it — and this link works again with nothing to type ` +
				`here. <code>/serve stop ${port}</code> takes the link down.`;
		response
			.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
			.end(
				`<!doctype html><meta charset="utf-8"><title>${port} — nothing there</title>` +
					`<body style="background:#0b0c0e;color:#dedcd7;font:15px/1.7 ui-sans-serif,system-ui,sans-serif;padding:3rem;max-width:34rem">` +
					`<p style="font-size:1.05rem;margin:0 0 0.6rem">${said}</p>` +
					`<p style="color:#9ba1a9;margin:0">${next}</p>` +
					`<style>code{font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:#0e1013;` +
					`border:1px solid #22252a;border-radius:4px;padding:0.1em 0.35em}</style>`,
			);
	}

	/**
	 * What to say when there is no bundle to serve.
	 *
	 * A blank page here would look like a broken plane rather than an unbuilt one, and the difference
	 * matters: the plane is fine, and the thing to do about it is one command long.
	 */
	async #unbuilt(response: ServerResponse): Promise<void> {
		response
			.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
			.end(
				`<!doctype html><meta charset="utf-8"><title>squad</title>` +
					`<body style="background:#0b0c0e;color:#dedcd7;font:16px/1.7 ui-monospace,monospace;padding:3rem">` +
					`<p>This plane is running, and the web console has not been built into it.</p>` +
					`<p style="color:#9ba1a9">pnpm --filter @squad/web build</p>`,
			);
	}

	#isToken(offered: string | undefined): boolean {
		if (offered === undefined || this.#token.length === 0) return false;
		const mine = Buffer.from(this.#token, "utf8");
		const theirs = Buffer.from(offered, "utf8");
		// Compared in constant time, and length-checked first because timingSafeEqual throws on a
		// mismatch — which would itself be the answer, told by how the request failed.
		return mine.byteLength === theirs.byteLength && timingSafeEqual(mine, theirs);
	}

	/** An answer a screen reads rather than a person. Never cached: this is a list that changes. */
	#json(response: ServerResponse, what: unknown): void {
		response
			.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
			})
			.end(`${JSON.stringify(what)}\n`);
	}

	#fail(response: ServerResponse, code: number, why: string): void {
		if (response.headersSent) {
			response.end();
			return;
		}
		response
			.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
			.end(`${why}\n`);
	}
}

export function cookie(request: IncomingMessage, name: string): string | undefined {
	const header = request.headers.cookie;
	if (header === undefined) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

/** The body, with a ceiling. Nothing this protocol sends is large, and nothing unbounded is safe. */
const MOST_BODY = 1024 * 1024;

function read(request: IncomingMessage): Promise<string> {
	return new Promise((settle, fail) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
			if (body.length > MOST_BODY) {
				fail(new Error("That request is too large."));
				request.destroy();
			}
		});
		request.once("end", () => settle(body));
		request.once("error", fail);
	});
}
