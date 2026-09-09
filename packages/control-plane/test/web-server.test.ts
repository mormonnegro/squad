import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebServer, webTokenPath } from "../src/web-server.ts";

/** The control socket, as something a test can watch both ends of. */
class FakeSocket extends Duplex {
	written = "";
	override _read(): void {}
	override _write(chunk: Buffer, _encoding: string, done: () => void): void {
		this.written += chunk.toString("utf8");
		done();
	}
	/** What the plane would have said, in whatever pieces the test wants to say it in. */
	say(bytes: string): void {
		this.push(bytes);
	}
}

let dir = "";
let web: WebServer;
let sockets: FakeSocket[] = [];
let root = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "web-"));
	root = join(dir, "dist");
	sockets = [];
	web = new WebServer({
		stateDir: dir,
		root,
		port: 0,
		dial: async () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
	});
	await web.listen();
});

afterEach(async () => {
	await web.close();
	await rm(dir, { recursive: true, force: true });
});

function at(path: string): string {
	return `http://127.0.0.1:${web.port}${path}`;
}

/** Opens the event stream and reads until the session id arrives, which is the first thing said. */
async function open(): Promise<{
	session: string;
	next: () => Promise<string>;
	stop: () => void;
}> {
	const controller = new AbortController();
	const response = await fetch(at("/events"), {
		headers: { cookie: `squad_web=${web.token}` },
		signal: controller.signal,
	});
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	// One SSE frame at a time, skipping the comment lines a heartbeat is made of.
	const next = async (): Promise<string> => {
		for (;;) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (frame.startsWith(":")) continue;
				return frame;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error("the stream ended");
			buffer += decoder.decode(value, { stream: true });
		}
	};

	const first = await next();
	const session = first.slice(first.indexOf("data: ") + 6);
	return { session, next, stop: () => controller.abort() };
}

describe("the door", () => {
	// The control socket has no authentication because holding the file is the authorisation. A
	// browser holds no file, so this token is the whole of what stands in for that.
	it("refuses a request carrying neither token nor cookie", async () => {
		const response = await fetch(at("/"));
		expect(response.status).toBe(401);
	});

	it("refuses a token that is not this plane's", async () => {
		const response = await fetch(at("/?t=not-the-token"), { redirect: "manual" });
		expect(response.status).toBe(403);
	});

	// Spent in the query string, kept as a cookie: the one place a person can paste it, and the one
	// place whatever the page later links to cannot read it back out of.
	it("takes a token in the query string and answers with a cookie", async () => {
		const response = await fetch(at(`/?t=${web.token}`), { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/");
		const cookie = response.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`squad_web=${web.token}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
	});

	it("writes the token where only its owner can read it", async () => {
		const path = webTokenPath(dir);
		expect((await readFile(path, "utf8")).trim()).toBe(web.token);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	// Restarting the plane changed nothing the operator did, and logging them out of the tab they are
	// looking at would be the restart's only visible effect.
	it("keeps the same token across a restart", async () => {
		const first = web.token;
		await web.close();
		web = new WebServer({ stateDir: dir, root, port: 0, dial: async () => new FakeSocket() });
		await web.listen();
		expect(web.token).toBe(first);
	});
});

describe("the wire", () => {
	it("writes what the browser posts to the socket, and nothing else", async () => {
		const stream = await open();
		const response = await fetch(at("/rpc"), {
			method: "POST",
			headers: { cookie: `squad_web=${web.token}`, "x-squad-session": stream.session },
			body: '{"id":"1","op":"agents"}',
		});
		expect(response.status).toBe(204);
		expect(sockets[0]?.written).toBe('{"id":"1","op":"agents"}\n');
		stream.stop();
	});

	it("sends a line from the plane back as one event", async () => {
		const stream = await open();
		sockets[0]?.say('{"id":"1","ok":true,"agents":[]}\n');
		expect(await stream.next()).toBe('data: {"id":"1","ok":true,"agents":[]}');
		stream.stop();
	});

	// A chunk boundary lands wherever TCP decides. Half a line forwarded as an event is a parse
	// failure in the browser for a message that was never malformed.
	it("holds back half a line until the rest of it arrives", async () => {
		const stream = await open();
		sockets[0]?.say('{"id":"1","ok":tr');
		sockets[0]?.say('ue,"text":"done"}\n{"id":"2","ok":true,"text":"next"}\n');
		expect(await stream.next()).toBe('data: {"id":"1","ok":true,"text":"done"}');
		expect(await stream.next()).toBe('data: {"id":"2","ok":true,"text":"next"}');
		stream.stop();
	});

	// A body carrying a newline would be two requests where the client meant one, and the second
	// would be whatever it managed to split.
	it("cannot be made to write two lines with one post", async () => {
		const stream = await open();
		await fetch(at("/rpc"), {
			method: "POST",
			headers: { cookie: `squad_web=${web.token}`, "x-squad-session": stream.session },
			body: '{"id":"1","op":"agents"}\n{"id":"2","op":"shell","agentId":"scout","line":"rm -rf /"}',
		});
		expect(sockets[0]?.written.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
		stream.stop();
	});

	// The stream is what holds the connection, so a post without one has nowhere to land. Both the
	// client that has not opened it yet and the one whose stream has gone get the same instruction.
	it("refuses a post from a session with no open stream", async () => {
		const response = await fetch(at("/rpc"), {
			method: "POST",
			headers: { cookie: `squad_web=${web.token}`, "x-squad-session": "nobody" },
			body: '{"id":"1","op":"agents"}',
		});
		expect(response.status).toBe(409);
	});

	it("gives each session its own connection to the plane", async () => {
		const one = await open();
		const other = await open();
		expect(one.session).not.toBe(other.session);
		expect(sockets).toHaveLength(2);
		one.stop();
		other.stop();
	});
});

describe("the files", () => {
	// One page with its own routes: a reload deep inside it has to land on the same HTML rather than
	// on a 404 for a path that was never a file.
	it("answers an application address with the page", async () => {
		const response = await fetch(at("/rooms/general"), {
			headers: { cookie: `squad_web=${web.token}` },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
	});

	it("says the bundle is missing rather than serving a blank page", async () => {
		const response = await fetch(at("/"), { headers: { cookie: `squad_web=${web.token}` } });
		expect(await response.text()).toContain("has not been built");
	});

	it("does not serve its way out of the bundle", async () => {
		const response = await fetch(at("/../../../etc/passwd"), {
			headers: { cookie: `squad_web=${web.token}` },
		});
		expect(await response.text()).not.toContain("root:");
	});
});
