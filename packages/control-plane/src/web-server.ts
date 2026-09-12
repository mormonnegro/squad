import { randomBytes, timingSafeEqual } from "node:crypto";
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
 * Where a port an agent opened is reached, through the door this console came in by.
 *
 * `/serve` writes down that a port should be reachable, and what made it so was the terminal
 * console: it bound the port on the machine it was running on and tunnelled each connection over
 * the control socket. Right when you are at that machine, and a lie everywhere else — a plane on a
 * server pointed the link at whatever laptop happened to be reading it.
 *
 * Here the plane serves it under its own address. Whatever origin the console is being read from is
 * one that can be reached, by definition, which is the whole idea: the link is built where it is
 * clicked rather than guessed where it is written.
 */
export const SERVED_PREFIX = "/at/";

/** The cookie the browser carries once it has spent its token. */
const SESSION_COOKIE = "squad_web";

/** The token, for a caller that cannot be sent a cookie. Lowercase: node lowercases what arrives. */
const TOKEN_HEADER = "x-squad-token";

/** Which of this browser's connections a request belongs to. */
const SESSION_HEADER = "x-squad-session";

/**
 * How often nothing is said down an idle event stream.
 *
 * A stream that goes quiet for minutes is one something in the middle decides is dead — a proxy, a
 * laptop suspending, a browser reclaiming an idle connection. A comment line costs two bytes and is
 * ignored by `EventSource`, which is exactly what a heartbeat should be.
 */
const HEARTBEAT_MS = 25_000;

/** How much HTML is held whole to put a `<base>` in it. Past this it is a download, not a page. */
const MOST_HTML = 2 * 1024 * 1024;

/** Whose port a path names, and what it was asking that port for. */
function servedAt(
	pathname: string,
): { agentId: string; port: number; path: string; prefix: string } | undefined {
	if (!pathname.startsWith(SERVED_PREFIX)) return undefined;
	const [agentId = "", said = "", ...rest] = pathname.slice(SERVED_PREFIX.length).split("/");
	const port = Number(said);
	if (agentId === "" || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return {
		agentId,
		port,
		path: `/${rest.join("/")}`,
		prefix: `${SERVED_PREFIX}${agentId}/${port}/`,
	};
}

/**
 * The port a page came from, for the things it asks for that do not come from it.
 *
 * A page served under a prefix and asking for `/assets/app.js` is asking this door for a file that
 * is not one of its own, and the only thing on the request that knows which sandbox it meant is
 * where it came from. Not a guess and not a fallback for everything: it is read only when the
 * referer is itself a served page, which is a thing nothing else on this door can be.
 */
function servedBy(
	referer: string | undefined,
	pathname: string,
): { agentId: string; port: number; path: string; prefix: string } | undefined {
	if (referer === undefined) return undefined;
	let from: URL;
	try {
		from = new URL(referer);
	} catch {
		return undefined;
	}
	const served = servedAt(from.pathname);
	if (served === undefined) return undefined;
	return { ...served, path: pathname };
}

/**
 * A page told where it is being read from.
 *
 * One `<base>`, as early as the head allows, so every relative address inside resolves under the
 * prefix this door serves it at. A page that already has one is left alone: it said where it wants
 * its links resolved and that is not this door's to overrule.
 */
function based(html: string, prefix: string): string {
	if (/<base\s/i.test(html)) return html;
	const tag = `<base href="${prefix}">`;
	const head = /<head[^>]*>/i.exec(html);
	if (head !== null) {
		const at = head.index + head[0].length;
		return html.slice(0, at) + tag + html.slice(at);
	}
	// No head at all is a fragment or a page written by hand, and the top of it is still earlier than
	// anything that could resolve against a base.
	return tag + html;
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
		 * A port inside a sandbox, and then the same port again for whatever that page asked for next.
		 *
		 * The second half is the `Referer`, and it is not a nicety: a page served under a prefix that
		 * asks for `/assets/app.js` is asking this door for a file, and the only thing that knows
		 * which sandbox it meant is the page it came from. A `<base>` is written into the HTML for
		 * everything relative; this is for everything that is not.
		 */
		const served = servedAt(asked.pathname) ?? servedBy(request.headers.referer, asked.pathname);
		if (served !== undefined) {
			await this.#served(request, response, served);
			return;
		}

		await this.#file(asked.pathname, response);
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
		const to = servedAt(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		// The same key the rest of this door wants. An upgrade skips `#route`, so it asks here or it
		// is a way in that asks nobody.
		const carried = cookie(request, SESSION_COOKIE);
		const whose = this.#isToken(carried) ? undefined : await this.#devices.whose(carried);
		if (to === undefined || (!this.#isToken(carried) && whose === undefined)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
			return;
		}

		const tunnel = await this.#forward(to.agentId, to.port);
		const lines = [
			`${request.method ?? "GET"} ${to.path}${new URL(request.url ?? "/", "http://127.0.0.1").search} HTTP/1.1`,
		];
		for (const [name, value] of Object.entries(request.headers)) {
			if (value === undefined) continue;
			const said = name === "host" ? `127.0.0.1:${to.port}` : value;
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
	 * Spoken as HTTP over the tunnel rather than piped as bytes, because two things have to be
	 * changed on the way through and both of them are in the headers: an HTML page gets a `<base>`
	 * so everything relative inside it resolves under this prefix, and a redirect to `/somewhere`
	 * gets the prefix put back on it. A byte pipe would be shorter and would serve pages whose links
	 * all point out of the door they came in by.
	 */
	async #served(
		request: IncomingMessage,
		response: ServerResponse,
		to: { agentId: string; port: number; path: string; prefix: string },
	): Promise<void> {
		let tunnel: Duplex;
		try {
			tunnel = await this.#forward(to.agentId, to.port);
		} catch (error) {
			this.#fail(response, 502, (error as Error).message);
			return;
		}

		const headers = { ...request.headers };
		// The port inside the sandbox is what that server thinks it is behind, and everything this
		// door knows about the outside is wrong there: its host, its protocol, its idea of the path.
		headers.host = `127.0.0.1:${to.port}`;
		delete headers["accept-encoding"];
		delete headers.connection;

		const asked = httpRequest(
			{
				createConnection: () => tunnel as never,
				method: request.method ?? "GET",
				path: to.path,
				headers,
			},
			(answer) => {
				const type = String(answer.headers["content-type"] ?? "");
				const out = { ...answer.headers };
				delete out["content-encoding"];
				delete out["transfer-encoding"];
				delete out.connection;
				// A redirect inside the sandbox is written from that sandbox's root, which is not this
				// one: `/login` there is `/at/scout/3000/login` here.
				const where = answer.headers.location;
				if (typeof where === "string" && where.startsWith("/")) {
					out.location = `${to.prefix}${where.slice(1)}`;
				}

				if (!type.includes("text/html")) {
					response.writeHead(answer.statusCode ?? 502, out);
					answer.pipe(response);
					return;
				}

				// Held whole, because a `<base>` has to go in before the first thing that resolves
				// against it. Capped, because a page that is not a page should not be a page this
				// console holds in memory — past the cap it goes through untouched, which is the right
				// failure: a large HTML body is a download, and a download needs no base.
				const parts: Buffer[] = [];
				let size = 0;
				let whole = true;
				answer.on("data", (chunk: Buffer) => {
					size += chunk.byteLength;
					if (!whole) return;
					if (size > MOST_HTML) {
						whole = false;
						response.writeHead(answer.statusCode ?? 502, out);
						for (const part of parts) response.write(part);
						response.write(chunk);
						answer.pipe(response);
						return;
					}
					parts.push(chunk);
				});
				answer.once("end", () => {
					if (!whole) return;
					const said = based(Buffer.concat(parts).toString("utf8"), to.prefix);
					delete out["content-length"];
					response.writeHead(answer.statusCode ?? 502, {
						...out,
						"content-length": String(Buffer.byteLength(said)),
					});
					response.end(said);
				});
			},
		);

		asked.on("error", (error: Error) => {
			tunnel.destroy();
			if (!response.headersSent) this.#fail(response, 502, error.message);
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
		if (found === undefined || !found.isFile()) {
			await this.#unbuilt(response);
			return;
		}
		response.writeHead(200, {
			"content-type": TYPES[extname(file)] ?? "application/octet-stream",
			// The bundle's names carry its version; the page that names them must never be a stale copy.
			"cache-control": extname(file) === ".html" ? "no-store" : "public, max-age=604800",
		});
		createReadStream(file).pipe(response);
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
