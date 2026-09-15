import { mkdtemp, rm } from "node:fs/promises";
import {
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type Server,
} from "node:http";
import { connect, type Server as Listener, createServer as listen, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebServer } from "../src/web-server.ts";

/*
 * A port an agent opened, end to end: a real server behind a real socket, reached the way a browser
 * reaches it.
 *
 * What this covers that the door's own tests cannot is the shape of what comes back. The page used
 * to be served under a path that was not its own, which meant a `<base>` written into every page and
 * a prefix put back onto every redirect — and an address like `/assets/app.js`, which most
 * frameworks write, went through neither and was found by its referer. At a name of its own all
 * three of those stop being problems rather than being solved, and that is the thing worth a test.
 */
let web: WebServer;
let app: Server;
let plane: Listener;
let dir = "";
let sandbox = 0;
const asked: string[] = [];

/** The name scout's port is read at. Sent as a header rather than resolved, because whether this
 * machine's resolver knows about `.localhost` is a fact about the machine and not about the door. */
function nameOf(): string {
	return `scout-${sandbox}.localhost:${web.port}`;
}

function ask(
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
	return new Promise((settle, fail) => {
		const sent = httpRequest(
			{ host: "127.0.0.1", port: web.port, path, headers: { host: nameOf(), ...headers } },
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
		sent.once("error", fail);
		sent.end();
	});
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "served-"));
	// The agent's own server: a page whose asset is an absolute address, a redirect written from the
	// sandbox's root, and a cookie it would like to set one name above its own.
	app = createServer((request, response) => {
		asked.push(`${request.method} ${request.url} cookie=${request.headers.cookie ?? ""}`);
		if (request.url === "/assets/app.js") {
			response.writeHead(200, { "content-type": "text/javascript" }).end("console.log(1)");
			return;
		}
		if (request.url === "/login") {
			response
				.writeHead(302, { location: "/home", "set-cookie": "mine=1; Domain=localhost" })
				.end();
			return;
		}
		response
			.writeHead(200, { "content-type": "text/html" })
			.end(`<html><head><script src="/assets/app.js"></script></head><body>hi</body></html>`);
	});
	await new Promise<void>((go) => app.listen(0, "127.0.0.1", go));
	sandbox = (app.address() as { port: number }).port;

	// The plane, as far as this door is concerned: one line asking for a forward, then the port.
	plane = listen((socket) => {
		socket.once("data", () => {
			socket.write('{"id":"forward","ok":true}\n');
			const to = connect(sandbox, "127.0.0.1", () => {
				socket.pipe(to);
				to.pipe(socket);
			});
		});
	});
	await new Promise<void>((go) => plane.listen(0, "127.0.0.1", go));
	const relay = (plane.address() as { port: number }).port;

	web = new WebServer({
		stateDir: dir,
		root: join(dir, "dist"),
		port: 0,
		dial: async () =>
			await new Promise<Socket>((go) => {
				const socket = connect(relay, "127.0.0.1", () => go(socket));
			}),
	});
	await web.listen();
});

afterAll(async () => {
	await web.close();
	await new Promise<void>((go) => app.close(() => go()));
	await new Promise<void>((go) => plane.close(() => go()));
	await rm(dir, { recursive: true, force: true });
});

it("carries a whole page, its absolute asset and its redirect, at a name of its own", async () => {
	const jump = await fetch(`http://127.0.0.1:${web.port}/at/scout/${sandbox}/`, {
		headers: { cookie: `squad_web=${web.token}` },
		redirect: "manual",
	});
	const link = new URL(jump.headers.get("location") ?? "");
	expect(link.host).toBe(nameOf());

	const opened = await ask(`/${link.search}`);
	const key = /squad_at=([^;]+)/.exec(String(opened.headers["set-cookie"] ?? ""))?.[1] ?? "";
	expect(opened.status).toBe(302);
	expect(opened.headers.location).toBe("/");

	const carried = { cookie: `squad_at=${key}` };
	const page = await ask("/", carried);
	const asset = await ask("/assets/app.js", carried);
	const redirected = await ask("/login", carried);

	expect(page.body).toContain("<body>hi</body>");
	// No `<base>` written into it any more: the page is at the root of its own name, so the absolute
	// address inside it is the address it meant.
	expect(page.body).not.toContain("<base");
	expect(asset.body).toBe("console.log(1)");
	// A redirect from inside the sandbox is that redirect out here, with nothing put back onto it.
	expect(redirected.headers.location).toBe("/home");
	// And the cookie it tried to set one name up — which would be the console's host — is its own.
	expect(String(redirected.headers["set-cookie"])).toBe("mine=1");
	// Nothing of this console's went in with any of it.
	expect(asked.join("\n")).not.toContain("squad_web");
	expect(asked.join("\n")).not.toContain("squad_at");
});
