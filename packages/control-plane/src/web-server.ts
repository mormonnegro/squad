import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { Dial } from "./control-client.ts";

/**
 * Where the browser knocks. Loopback only, for the same reason 8788 is.
 *
 * The port is fixed rather than chosen so that a link can be typed from memory and a tab left open
 * across a restart still lands somewhere.
 */
export const WEB_PORT = 8789;

export const WEB_TOKEN_FILE = "web.token";

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
	#token = "";

	constructor(options: WebServerOptions) {
		this.#options = options;
		this.#server = createServer((request, response) => {
			this.#route(request, response).catch((error: Error) => {
				this.#fail(response, 500, error.message);
			});
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

		if (inUrl !== null && !this.#isToken(inUrl)) {
			this.#fail(response, 403, "That token is not this plane's.");
			return;
		}
		if (!this.#isToken(carried)) {
			// Said plainly rather than with a login form, because there is no password to type: whoever
			// should be here has a file on this machine, and `squad web` is what reads it.
			this.#fail(response, 401, "Run `squad web` on the machine this plane runs on to get in.");
			return;
		}

		// A page opened with the token in its address is sent back to the same page without it, holding
		// a cookie instead: an address is copied, pasted and left in a history, and a cookie is not.
		// The stream and the wire are not pages and have nowhere to be redirected to.
		if (inUrl !== null && asked.pathname !== "/events" && asked.pathname !== "/rpc") {
			response
				.writeHead(302, {
					location: asked.pathname,
					"set-cookie": `${SESSION_COOKIE}=${this.#token}; HttpOnly; SameSite=Strict; Path=/`,
				})
				.end();
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
