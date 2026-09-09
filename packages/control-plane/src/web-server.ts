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
	readonly host?: string;
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
			// Loopback and nothing else. Not a default to be overridden by a flag: the plane runs as
			// root over a Docker socket, and the difference between this being reachable from the
			// network and not is the difference between a token and a machine.
			this.#server.listen(this.#options.port ?? WEB_PORT, this.#options.host ?? "127.0.0.1", () => {
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

	async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const asked = new URL(request.url ?? "/", `http://127.0.0.1`);

		// The token is spent here and nowhere else: it arrives in a query string, which is the one
		// place a person can paste it, and leaves as a cookie, which is the one place a query string
		// cannot be read back out of by whatever the page later links to.
		const offered = asked.searchParams.get("t");
		if (offered !== null) {
			if (!this.#isToken(offered)) {
				this.#fail(response, 403, "That token is not this plane's.");
				return;
			}
			response
				.writeHead(302, {
					location: "/",
					"set-cookie": `${SESSION_COOKIE}=${this.#token}; HttpOnly; SameSite=Strict; Path=/`,
				})
				.end();
			return;
		}

		if (!this.#isToken(cookie(request, SESSION_COOKIE))) {
			// Said plainly rather than with a login form, because there is no password to type: whoever
			// should be here has a file on this machine, and `squad web` is what reads it.
			this.#fail(response, 401, "Run `squad web` on the machine this plane runs on to get in.");
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
		const id = request.headers["x-squad-session"];
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
