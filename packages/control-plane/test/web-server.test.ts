import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
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

	/*
	 * The four things node's http client calls on a socket it is handed.
	 *
	 * A forward turns this connection into one an HTTP request is spoken over, and `createConnection`
	 * hands it whatever it is given — which in the plane is a real socket and here is this. Without
	 * these the client throws inside itself and the request neither answers nor fails, which is a
	 * test that hangs rather than one that says anything.
	 */
	setNoDelay(): this {
		return this;
	}
	setKeepAlive(): this {
		return this;
	}
	setTimeout(): this {
		return this;
	}
	override ref(): this {
		return this;
	}
	override unref(): this {
		return this;
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
		expect(cookie).toContain("squad_web=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
	});

	// The token admits a browser; it is not what the browser then carries. That is the whole of the
	// difference between a secret everybody shares and a list somebody can be taken off.
	it("hands out a secret of its own rather than the token it was opened with", async () => {
		const response = await fetch(at(`/?t=${web.token}`), { redirect: "manual" });
		const cookie = response.headers.get("set-cookie") ?? "";
		expect(cookie).not.toContain(web.token);
		const carried = /squad_web=([^;]+)/.exec(cookie)?.[1] ?? "";
		expect(carried.length).toBeGreaterThan(20);
		// And it opens the door on its own, which is the point of having been given it.
		const again = await fetch(at("/"), { headers: { cookie: `squad_web=${carried}` } });
		expect(again.status).toBe(200);
	});

	it("puts the browser it let in on a list, with a name and a way out", async () => {
		const first = await fetch(at(`/?t=${web.token}`), {
			redirect: "manual",
			headers: {
				"user-agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
			},
		});
		const carried = /squad_web=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1] ?? "";

		const listed = (await (
			await fetch(at("/devices"), { headers: { cookie: `squad_web=${carried}` } })
		).json()) as { devices: { id: string; name: string }[]; here?: string };
		expect(listed.devices).toHaveLength(1);
		expect(listed.devices[0]?.name).toBe("Chrome on a Mac");
		// Which row is the one reading this, so a screen can ask twice before it locks itself out.
		expect(listed.here).toBe(listed.devices[0]?.id);

		const out = await fetch(at(`/devices/${listed.devices[0]?.id}`), {
			method: "DELETE",
			headers: { cookie: `squad_web=${carried}` },
		});
		expect(((await out.json()) as { gone: boolean }).gone).toBe(true);
		// And it is out: the cookie that was working a line ago is now nobody's.
		const after = await fetch(at("/"), { headers: { cookie: `squad_web=${carried}` } });
		expect(after.status).toBe(401);
	});

	// Two browsers, and taking one out leaves the other exactly where it was. This is the thing a
	// single secret could not do and the reason any of this exists.
	it("takes one out without taking the rest out", async () => {
		const one = /squad_web=([^;]+)/.exec(
			(await fetch(at(`/?t=${web.token}`), { redirect: "manual" })).headers.get("set-cookie") ?? "",
		)?.[1] as string;
		const other = /squad_web=([^;]+)/.exec(
			(await fetch(at(`/?t=${web.token}`), { redirect: "manual" })).headers.get("set-cookie") ?? "",
		)?.[1] as string;
		expect(one).not.toBe(other);

		const listed = (await (
			await fetch(at("/devices"), { headers: { cookie: `squad_web=${one}` } })
		).json()) as { devices: { id: string }[]; here: string };
		await fetch(at(`/devices/${listed.here}`), {
			method: "DELETE",
			headers: { cookie: `squad_web=${one}` },
		});

		expect((await fetch(at("/"), { headers: { cookie: `squad_web=${one}` } })).status).toBe(401);
		expect((await fetch(at("/"), { headers: { cookie: `squad_web=${other}` } })).status).toBe(200);
	});

	/**
	 * The door an invitation opens, which is the same door and a different key.
	 *
	 * Before these, letting somebody in meant handing over the plane's own token: it never expires,
	 * it is the same string for everybody, and taking that person out again was impossible — the
	 * device list could remove their browser and they would walk back in with the token they still
	 * had. An invitation is for one person, it runs out, and it is called off on its own.
	 */
	describe("an invitation", () => {
		const invite = async (
			label = "for Nico",
			uses = 1,
		): Promise<{ id: string; secret: string }> => {
			const made = await fetch(at("/invites"), {
				method: "POST",
				headers: { "content-type": "application/json", cookie: `squad_web=${web.token}` },
				body: JSON.stringify({ label, lasts: "day", uses }),
			});
			const said = (await made.json()) as { invite: { id: string }; secret: string };
			return { id: said.invite.id, secret: said.secret };
		};

		it("lets a browser in and gives it a key of its own", async () => {
			const { secret } = await invite();

			const response = await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" });

			expect(response.status).toBe(302);
			const cookie = response.headers.get("set-cookie") ?? "";
			expect(cookie).toContain("squad_web=");
			expect(cookie).not.toContain(secret);
			expect(cookie).not.toContain(web.token);
		});

		// Which is the question a list of browsers could never answer by itself.
		it("puts what it let in on the device list, saying which invitation let it in", async () => {
			const { id, secret } = await invite();
			await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" });

			const listed = await fetch(at("/devices"), { headers: { cookie: `squad_web=${web.token}` } });
			const { devices } = (await listed.json()) as { devices: { from?: string }[] };

			expect(devices).toHaveLength(1);
			expect(devices[0]?.from).toBe(id);
		});

		it("stops working the moment it has been used", async () => {
			const { secret } = await invite();
			await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" });

			const again = await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" });

			expect(again.status).toBe(403);
		});

		// A reload carries the cookie it already holds, so it admits nobody and takes nothing off the
		// count — otherwise opening the link twice would burn an invitation on one person.
		it("is not spent again by the browser that already used it", async () => {
			const { secret } = await invite();
			const first = await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" });
			const carried = /squad_web=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1] ?? "";

			const again = await fetch(at(`/?t=${encodeURIComponent(secret)}`), {
				redirect: "manual",
				headers: { cookie: `squad_web=${carried}` },
			});

			expect(again.status).toBe(302);
			const listed = await fetch(at("/devices"), { headers: { cookie: `squad_web=${web.token}` } });
			expect(((await listed.json()) as { devices: unknown[] }).devices).toHaveLength(1);
		});

		it("lets several in when it was made for several", async () => {
			const { secret } = await invite("the team", 2);

			expect(
				(await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" })).status,
			).toBe(302);
			expect(
				(await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" })).status,
			).toBe(302);
			expect(
				(await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" })).status,
			).toBe(403);
		});

		it("is called off without touching the browser it already let in", async () => {
			const { id, secret } = await invite("the team", 5);
			await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" });

			const gone = await fetch(at(`/invites/${id}`), {
				method: "DELETE",
				headers: { cookie: `squad_web=${web.token}` },
			});
			expect(((await gone.json()) as { gone: boolean }).gone).toBe(true);

			expect(
				(await fetch(at(`/?t=${encodeURIComponent(secret)}`), { redirect: "manual" })).status,
			).toBe(403);
			const listed = await fetch(at("/devices"), { headers: { cookie: `squad_web=${web.token}` } });
			expect(((await listed.json()) as { devices: unknown[] }).devices).toHaveLength(1);
		});

		it("says who it is for, and refuses one that says nothing", async () => {
			const { id } = await invite("for Nico");
			const listed = await fetch(at("/invites"), { headers: { cookie: `squad_web=${web.token}` } });
			const { invites } = (await listed.json()) as { invites: { id: string; label: string }[] };
			expect(invites.find((one) => one.id === id)?.label).toBe("for Nico");

			const refused = await fetch(at("/invites"), {
				method: "POST",
				headers: { "content-type": "application/json", cookie: `squad_web=${web.token}` },
				body: JSON.stringify({ label: "  " }),
			});
			expect(refused.status).toBe(400);
		});
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

	/*
	 * The addresses in the HTML are relative, so a page opened deep inside the application asks for
	 * its own script from wherever it is standing. Without this, a link to a conversation or a folder
	 * works while you click your way to it and is a blank screen when somebody opens it.
	 */
	it("finds the bundle's own files from an address deep inside the application", async () => {
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(join(root, "assets", "index-abc.js"), "export const here = true;\n");

		const response = await fetch(at("/agents/scout/files/workspace/assets/index-abc.js"), {
			headers: { cookie: `squad_web=${web.token}` },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/javascript");
		expect(await response.text()).toContain("here");
	});

	it("does not serve its way out of the bundle", async () => {
		const response = await fetch(at("/../../../etc/passwd"), {
			headers: { cookie: `squad_web=${web.token}` },
		});
		expect(await response.text()).not.toContain("root:");
	});
});

describe("a console on another domain", () => {
	const PAGE = "https://squad.example";

	beforeEach(async () => {
		await web.close();
		web = new WebServer({
			stateDir: dir,
			root,
			port: 0,
			origins: [PAGE],
			dial: async () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
		});
		await web.listen();
	});

	// Without this header Chrome holds a request from a public page to a loopback plane open and
	// nothing ever comes back — the least debuggable failure this server could have.
	it("answers the preflight a private-network request needs", async () => {
		const response = await fetch(at("/"), {
			method: "OPTIONS",
			headers: {
				origin: PAGE,
				"access-control-request-method": "GET",
				"access-control-request-private-network": "true",
			},
		});
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-private-network")).toBe("true");
		expect(response.headers.get("access-control-allow-origin")).toBe(PAGE);
	});

	// A preflight carries no credentials. Asking it for a token would be refusing the question.
	it("answers the preflight without a token", async () => {
		const response = await fetch(at("/rpc"), {
			method: "OPTIONS",
			headers: { origin: PAGE, "access-control-request-method": "POST" },
		});
		expect(response.status).toBe(204);
	});

	it("refuses an origin the operator did not name", async () => {
		const response = await fetch(at("/"), {
			method: "OPTIONS",
			headers: { origin: "https://somewhere.else", "access-control-request-method": "GET" },
		});
		expect(response.status).toBe(403);
	});

	// Cross-origin cookies need SameSite=None and a secure origin and are fragile on both counts.
	it("takes the token in a header when there can be no cookie", async () => {
		const response = await fetch(at("/events"), {
			headers: { origin: PAGE, "x-squad-token": web.token },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe(PAGE);
		await response.body?.cancel();
	});

	it("refuses a token in that header that is not this plane's", async () => {
		const response = await fetch(at("/"), {
			headers: { origin: PAGE, "x-squad-token": "not-it" },
		});
		expect(response.status).toBe(401);
	});
});

describe("the three ways in", () => {
	// An EventSource has no header API and carries no cookie of ours, so a console on another origin
	// can only put the token in the address of the stream. It is not a page and has nowhere to be
	// redirected to, so it is answered rather than sent away.
	it("opens the stream for a token in the address, without redirecting it", async () => {
		const response = await fetch(at(`/events?t=${web.token}`));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		await response.body?.cancel();
	});

	// An address is copied, pasted and left in a history; a cookie is not. So a page opened with the
	// token in it is sent back to the same page holding one instead.
	it("sends a page back to itself holding a cookie", async () => {
		const response = await fetch(at(`/agents/scout?t=${web.token}`), { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/agents/scout");
		expect(response.headers.get("set-cookie")).toContain("squad_web=");
	});

	it("refuses a wrong token in the address before anything else", async () => {
		const response = await fetch(at("/events?t=nope"));
		expect(response.status).toBe(403);
	});
});

describe("letting the same browser in twice", () => {
	// Opening the address again is the ordinary thing — a reload, `squad open` a second time, a link
	// still in the bar. It was minting a device every time, so one laptop became a column of
	// identical rows and the list stopped being a list of who.
	it("keeps the device it already gave that browser", async () => {
		const first = await fetch(at(`/?t=${web.token}`), { redirect: "manual" });
		const carried = /squad_web=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1] as string;

		const again = await fetch(at(`/?t=${web.token}`), {
			redirect: "manual",
			headers: { cookie: `squad_web=${carried}` },
		});
		expect(again.status).toBe(302);
		// Nothing new handed over, because it already holds one.
		expect(again.headers.get("set-cookie")).toBeNull();

		const listed = (await (
			await fetch(at("/devices"), { headers: { cookie: `squad_web=${carried}` } })
		).json()) as { devices: unknown[] };
		expect(listed.devices).toHaveLength(1);
	});

	// And a browser that has none still gets one, which is the whole point of the address.
	it("still lets a browser in that has never been here", async () => {
		await fetch(at(`/?t=${web.token}`), { redirect: "manual" });
		const other = await fetch(at(`/?t=${web.token}`), { redirect: "manual" });
		expect(other.headers.get("set-cookie")).toContain("squad_web=");
		const carried = /squad_web=([^;]+)/.exec(other.headers.get("set-cookie") ?? "")?.[1] as string;
		const listed = (await (
			await fetch(at("/devices"), { headers: { cookie: `squad_web=${carried}` } })
		).json()) as { devices: unknown[] };
		expect(listed.devices).toHaveLength(2);
	});
});

/** The socket the door opened for a forward, once it has written its request down it. */
async function forwarding(): Promise<FakeSocket> {
	for (let tried = 0; tried < 200; tried++) {
		const socket = sockets.at(-1);
		if (socket?.written.includes('"op":"forward"') === true) return socket;
		await new Promise((wake) => setTimeout(wake, 10));
	}
	throw new Error("the door never asked the plane to forward anything");
}

/** One request to this door at whatever name the test wants it to have arrived at. */
function askAt(
	host: string,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
	return new Promise((settle, fail) => {
		const asked = httpRequest(
			{ host: "127.0.0.1", port: web.port, path, headers: { host, ...headers } },
			(answer) => {
				let body = "";
				answer.on("data", (chunk: Buffer) => {
					body += chunk.toString("utf8");
				});
				answer.once("end", () =>
					settle({ status: answer.statusCode ?? 0, headers: answer.headers, body }),
				);
			},
		);
		asked.once("error", fail);
		asked.end();
	});
}

/** The name scout's 3101 is read at, when the console is read on loopback. */
function port3101(): string {
	return `scout-3101.localhost:${web.port}`;
}

/** The link as the console hands it out: the name of the port, and the key to open it with. */
async function linkTo(path = "/"): Promise<URL> {
	const answer = await fetch(at(`/at/scout/3101${path}`), {
		headers: { cookie: `squad_web=${web.token}` },
		redirect: "manual",
	});
	expect(answer.status).toBe(302);
	return new URL(answer.headers.get("location") ?? "");
}

/** A browser that has clicked the link and holds what that left it with. */
async function letIn(): Promise<string> {
	const link = await linkTo();
	const answer = await askAt(link.host, `${link.pathname}${link.search}`);
	expect(answer.status).toBe(302);
	return /squad_at=([^;]+)/.exec(String(answer.headers["set-cookie"] ?? ""))?.[1] as string;
}

/*
 * A page an agent wrote, on a name of its own.
 *
 * This is the whole of why any of it is shaped this way. Under the old prefix that page was read at
 * the console's own address, which meant the browser handed it the operator's cookie, let it read
 * `/events`, and let it post to `/rpc` — an agent that got you to click a link drove the plane as
 * you, approved its own reach, and read every conversation. Nothing on the same origin can prevent
 * that, so nothing tries: the page is somewhere else now.
 */
describe("a port an agent opened, on an origin that is not this console's", () => {
	it("sends the link to a name of the port's own, with a key on the end of it", async () => {
		const link = await linkTo("/thing?x=1");

		expect(link.hostname).toBe("scout-3101.localhost");
		expect(link.port).toBe(String(web.port));
		expect(link.pathname).toBe("/thing");
		expect(link.searchParams.get("x")).toBe("1");
		expect(link.searchParams.get("k")).toBeTruthy();
	});

	it("gives a key that opens that port and no other", async () => {
		const key = await letIn();
		// The same browser, the same plane, a different agent's port: the key it was handed for one
		// is not a key to the rest. What it is in is a link, and a link gets sent to somebody.
		const elsewhere = await askAt(`scribe-3000.localhost:${web.port}`, "/", {
			cookie: `squad_at=${key}`,
		});

		expect(elsewhere.status).toBe(401);
		expect(elsewhere.body).toContain("scribe");
	});

	it("refuses a browser that arrives at that name holding no key", async () => {
		const answer = await askAt(port3101(), "/");

		expect(answer.status).toBe(401);
		expect(answer.body).toContain("has not been let in");
	});

	it("spends the key for a cookie of that name's own, and takes it back out of the address", async () => {
		const link = await linkTo("/thing");
		const answer = await askAt(link.host, `${link.pathname}${link.search}`);

		const carried = String(answer.headers["set-cookie"] ?? "");
		expect(answer.status).toBe(302);
		expect(answer.headers.location).toBe("/thing");
		expect(carried).toContain("squad_at=");
		expect(carried).toContain("SameSite=Lax");
		// Never this console's. That cookie belongs to the host the console is read at, and the whole
		// point of this name is that nothing of the console's is carried to it.
		expect(carried).not.toContain("squad_web");
	});

	it("does not hand the sandbox this console's keys", async () => {
		const key = await letIn();
		const answer = askAt(port3101(), "/", {
			cookie: `squad_at=${key}; squad_web=${web.token}; theirs=1`,
			"x-squad-session": "whatever",
		});
		const socket = await forwarding();
		socket.say('{"id":"forward","ok":true}\r\n');
		await new Promise((wake) => setTimeout(wake, 50));
		const written = socket.written;
		socket.say("HTTP/1.1 204 No Content\r\n\r\n");
		await answer;

		expect(written).toContain("theirs=1");
		expect(written).not.toContain("squad_web");
		expect(written).not.toContain("squad_at");
		expect(written).not.toContain("x-squad-session");
	});

	it("keeps a cookie the sandbox sets on the name it came from", async () => {
		const key = await letIn();
		const answer = askAt(port3101(), "/", { cookie: `squad_at=${key}` });
		const socket = await forwarding();
		socket.say('{"id":"forward","ok":true}\r\n');
		await new Promise((wake) => setTimeout(wake, 50));
		socket.say(
			"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 2\r\n" +
				// What a page an agent wrote would try if it wanted the console's host: a cookie written
				// one name up reaches every name under it, this console's included.
				"set-cookie: mine=1; Domain=localhost; Path=/\r\n" +
				"set-cookie: squad_web=forged; Path=/\r\n\r\nhi",
		);

		const said = String((await answer).headers["set-cookie"] ?? "");
		expect(said).toContain("mine=1");
		expect(said).not.toContain("Domain=localhost");
		expect(said).not.toContain("squad_web");
	});

	it("refuses a request to the plane that came from one of those names", async () => {
		const drive = await askAt(`127.0.0.1:${web.port}`, "/events", {
			cookie: `squad_web=${web.token}`,
			origin: `http://${port3101()}`,
		});
		const read = await askAt(`127.0.0.1:${web.port}`, "/devices", {
			cookie: `squad_web=${web.token}`,
			"sec-fetch-site": "same-site",
		});

		expect(drive.status).toBe(403);
		expect(read.status).toBe(403);
	});

	it("mints a key for a click and not for a page asking quietly", async () => {
		const clicked = await askAt(`127.0.0.1:${web.port}`, "/at/scout/3101/", {
			cookie: `squad_web=${web.token}`,
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "navigate",
			"sec-fetch-dest": "document",
		});
		const quiet = await askAt(`127.0.0.1:${web.port}`, "/at/scout/3101/", {
			cookie: `squad_web=${web.token}`,
			origin: `http://${port3101()}`,
		});

		// A link in a message, in a bookmark, in somebody's notes: clicked, and it lands on a page
		// that is not this origin either way.
		expect(clicked.status).toBe(302);
		expect(quiet.status).toBe(403);
	});

	it("says where a port is read, so the console can draw the link rather than the path", async () => {
		const answer = await askAt(`127.0.0.1:${web.port}`, "/at/where?agent=scout&port=3101", {
			cookie: `squad_web=${web.token}`,
		});
		const nobody = await askAt(`127.0.0.1:${web.port}`, "/at/where?agent=scout&port=nope", {
			cookie: `squad_web=${web.token}`,
		});

		const { url } = JSON.parse(answer.body) as { url: string };
		const link = new URL(url);

		expect(link.host).toBe(`scout-3101.localhost:${web.port}`);
		expect(link.pathname).toBe("/");
		// With the key on it, because a link the console draws has to work on the first click — the
		// browser holds nothing for that name until it has been there once.
		expect(link.searchParams.get("k")).toBeTruthy();
		expect(JSON.parse(nobody.body)).toEqual({ url: null });
	});

	it("still answers its own page, which is what all of that is for", async () => {
		const answer = await askAt(`127.0.0.1:${web.port}`, "/devices", {
			cookie: `squad_web=${web.token}`,
			"sec-fetch-site": "same-origin",
		});

		expect(answer.status).toBe(200);
		expect(answer.headers["x-frame-options"]).toBe("DENY");
	});

	// Caddy asks this before it goes and gets a certificate for a name somebody has just offered it.
	it("says which names are ports of this plane's and which are nobody's", async () => {
		const web2 = new WebServer({
			stateDir: dir,
			root,
			port: 0,
			servedDomain: "plane.example",
			dial: async () => new FakeSocket(),
		});
		await web2.listen();
		const askedAbout = async (name: string): Promise<number> =>
			(
				await fetch(`http://127.0.0.1:${web2.port}/tls/ask?domain=${name}`, {
					redirect: "manual",
				})
			).status;

		expect(await askedAbout("scout-3000.plane.example")).toBe(200);
		expect(await askedAbout("anything.else.example")).toBe(403);
		expect(await askedAbout("scout.plane.example")).toBe(403);
		await web2.close();
	});
});

/*
 * A port that was opened and is not answering.
 *
 * The link is a standing arrangement rather than a handle on a running thing, so it outlives the
 * process that was behind it — and what the browser used to get for that was "socket hang up" on a
 * black page, which is true and about the wrong subject.
 */
describe("a port with nothing behind it", () => {
	it("says nothing is listening, rather than what node calls a socket that closed", async () => {
		const key = await letIn();
		const asked = askAt(port3101(), "/", { cookie: `squad_at=${key}` });
		const socket = await forwarding();
		// What the relay says when it has waited out its three seconds for something to bind that
		// port. The same page is what the browser gets when the tunnel opens and dies instead, which
		// is the other shape of the same fact.
		socket.say(
			'{"id":"forward","ok":false,"error":"relay: connect ECONNREFUSED 127.0.0.1:3101"}\n',
		);

		const answer = await asked;

		expect(answer.status).toBe(502);
		expect(answer.headers["content-type"]).toContain("text/html");
		expect(answer.body).toContain("Nothing is listening on 3101");
		expect(answer.body).toContain("keep");
		expect(answer.body).toContain("/serve stop 3101");
		expect(answer.body).not.toContain("ECONNREFUSED");
	});

	it("says the link is not open at all, when that is the half that is missing", async () => {
		const key = await letIn();
		const asked = askAt(port3101(), "/", { cookie: `squad_at=${key}` });
		const socket = await forwarding();
		socket.say(
			'{"id":"forward","ok":false,"error":"scout is not serving 3101. /serve 3101 opens it."}\n',
		);

		const answer = await asked;

		expect(answer.body).toContain("no link open on 3101");
		expect(answer.body).toContain("/serve 3101");
	});
});
