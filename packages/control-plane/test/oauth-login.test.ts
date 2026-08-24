import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthLogins } from "@agent-dive/proxy";
import { afterEach, describe, expect, it } from "vitest";
import { LoginDesk } from "../src/oauth-login.ts";

interface FakeServer {
	readonly url: string;
	readonly issued: string[];
	readonly close: () => Promise<void>;
}

const running: FakeServer[] = [];
/** The callback port is one number for the whole plane, so a test that leaves it held breaks the next. */
const desks: Array<{ desk: LoginDesk; names: string[] }> = [];

afterEach(async () => {
	while (desks.length > 0) {
		const left = desks.pop();
		for (const name of left?.names ?? []) await left?.desk.cancel(name);
	}
	while (running.length > 0) await running.pop()?.close();
});

/** A server that publishes metadata, registers clients and mints one token. */
async function authorizationServer(options: { register?: boolean } = {}): Promise<FakeServer> {
	const issued: string[] = [];
	let origin = "";
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", origin);
			const answer = (status: number, body: unknown): void => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};

			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				answer(200, { authorization_servers: [origin] });
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				answer(200, {
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					...(options.register === false ? {} : { registration_endpoint: `${origin}/register` }),
				});
				return;
			}
			if (url.pathname === "/register") {
				answer(200, { client_id: "registered-client" });
				return;
			}
			if (url.pathname === "/token") {
				const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
				issued.push(form.get("code") ?? "");
				answer(200, { access_token: "at-live", refresh_token: "rt-live", expires_in: 3600 });
				return;
			}
			answer(404, { error: "no" });
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const fake: FakeServer = {
		url: origin,
		issued,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
	running.push(fake);
	return fake;
}

async function desk(): Promise<{ desk: LoginDesk; logins: OAuthLogins; opened: string[] }> {
	const path = join(await mkdtemp(join(tmpdir(), "agent-dive-login-")), "oauth.json");
	const logins = new OAuthLogins(path);
	const opened: string[] = [];
	const made = new LoginDesk(logins, (url) => opened.push(url));
	desks.push({ desk: made, names: ["notion"] });
	return { desk: made, logins, opened };
}

/** What the browser does: follow the redirect back to wherever it was told to go. */
async function comeBack(redirect: string, params: Record<string, string>): Promise<number> {
	const url = new URL(redirect);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const response = await fetch(url.toString());
	return response.status;
}

describe("logging in through a browser", () => {
	it("registers a client, opens the page, and holds the token when the browser comes back", async () => {
		const server = await authorizationServer();
		const { desk: door, logins, opened } = await desk();

		const started = await door.begin({
			name: "notion",
			url: `${server.url}/mcp`,
			host: "127.0.0.1",
		});
		expect(opened).toEqual([started.url]);
		expect(started.registered).toBe(true);
		expect(new URL(started.url).searchParams.get("client_id")).toBe("registered-client");

		const state = new URL(started.url).searchParams.get("state") ?? "";
		expect(await comeBack(started.redirectUri, { code: "the-code", state })).toBe(200);

		const login = await started.done;
		expect(login.accessToken).toBe("at-live");
		expect(server.issued).toEqual(["the-code"]);
		// And it is where the proxy will look for it, not merely in the promise.
		expect(await logins.token("notion")).toBe("at-live");
	});

	it("refuses an answer carrying somebody else's state", async () => {
		const server = await authorizationServer();
		const { desk: door, logins } = await desk();

		const started = await door.begin({
			name: "notion",
			url: `${server.url}/mcp`,
			host: "127.0.0.1",
		});
		expect(await comeBack(started.redirectUri, { code: "the-code", state: "not-ours" })).toBe(400);
		expect(await logins.token("notion")).toBeUndefined();
		expect(door.waiting("notion")).toBe(true);
	});

	it("takes the address bar pasted back, for a plane the browser cannot see", async () => {
		const server = await authorizationServer();
		const { desk: door, logins } = await desk();

		const started = await door.begin({
			name: "notion",
			url: `${server.url}/mcp`,
			host: "127.0.0.1",
		});
		const state = new URL(started.url).searchParams.get("state") ?? "";

		const login = await door.returned(
			"notion",
			`${started.redirectUri}?code=pasted&state=${state}`,
		);
		expect(login.accessToken).toBe("at-live");
		expect(server.issued).toEqual(["pasted"]);
		expect(await logins.token("notion")).toBe("at-live");
		// The listener is closed with it: a login finishes once.
		expect(door.waiting("notion")).toBe(false);
	});

	it("says so when the operator turned the consent screen down", async () => {
		const server = await authorizationServer();
		const { desk: door } = await desk();

		const started = await door.begin({
			name: "notion",
			url: `${server.url}/mcp`,
			host: "notion.so",
		});
		await expect(
			door.returned("notion", `${started.redirectUri}?error=access_denied`),
		).rejects.toThrow(/notion\.so refused: access_denied/);
		await expect(started.done).rejects.toThrow(/access_denied/);
	});

	it("asks for a client id when the server will not make one", async () => {
		const server = await authorizationServer({ register: false });
		const { desk: door } = await desk();

		await expect(
			door.begin({ name: "notion", url: `${server.url}/mcp`, host: "127.0.0.1" }),
		).rejects.toThrow(/does not register clients/);

		// With an id in hand it starts, on the port the operator can be told in advance.
		const started = await door.begin({
			name: "notion",
			url: `${server.url}/mcp`,
			host: "127.0.0.1",
			clientId: "mine",
		});
		expect(started.registered).toBe(false);
		expect(started.redirectUri).toBe("http://localhost:8788/callback");
		expect(new URL(started.url).searchParams.get("client_id")).toBe("mine");
	});

	it("has nothing to finish for a login nobody started", async () => {
		const { desk: door } = await desk();
		await expect(door.returned("notion", "http://localhost:1/callback?code=x")).rejects.toThrow(
			/Nothing is waiting/,
		);
	});

	it("lets go of the port when a second login replaces the first", async () => {
		const server = await authorizationServer();
		const { desk: door } = await desk();

		const first = await door.begin({ name: "notion", url: `${server.url}/mcp`, host: "127.0.0.1" });
		// The same door, which is the whole difficulty: starting again means the first one really let go.
		const second = await door.begin({
			name: "notion",
			url: `${server.url}/mcp`,
			host: "127.0.0.1",
		});
		expect(second.redirectUri).toBe(first.redirectUri);
		await expect(first.done).rejects.toThrow(/called off/);

		const state = new URL(second.url).searchParams.get("state") ?? "";
		expect(await comeBack(second.redirectUri, { code: "the-code", state })).toBe(200);
		await expect(second.done).resolves.toBeDefined();
	});
});
