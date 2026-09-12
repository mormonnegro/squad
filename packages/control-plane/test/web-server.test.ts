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
