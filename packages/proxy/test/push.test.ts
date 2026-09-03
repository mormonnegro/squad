import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import tls from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AuditEntry, EgressBroker } from "../src/broker.ts";
import { createCertificateAuthority } from "../src/ca.ts";
import { StaticAgentDirectory } from "../src/directory.ts";
import type { Grant } from "../src/grants.ts";
import { MemorySecretStore } from "../src/secrets.ts";

const TOKEN = "github_pat_never_seen_by_the_agent";
const PROXY_TOKEN = "proxy-token-for-scout";
const AGENT_ID = "scout";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const ZERO = "0".repeat(40);

function pkt(payload: string): Buffer {
	const body = Buffer.from(payload, "utf8");
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

const FLUSH = Buffer.from("0000");
const PACKFILE = Buffer.concat([Buffer.from("PACK"), Buffer.alloc(4096, 9)]);

function commands(refs: readonly string[], capabilities = "report-status side-band-64k"): Buffer {
	const [first = "", ...rest] = refs;
	return Buffer.concat([
		pkt(`${OLD} ${NEW} ${first}\0${capabilities}`),
		...rest.map((ref) => pkt(`${OLD} ${NEW} ${ref}`)),
		FLUSH,
	]);
}

interface Seen {
	url: string;
	method: string;
	authorization: string | undefined;
	body: Buffer;
}

async function tunnel(proxyPort: number, authority: string): Promise<net.Socket> {
	const socket = net.connect(proxyPort, "127.0.0.1");
	await once(socket, "connect");
	const auth = Buffer.from(`${AGENT_ID}:${PROXY_TOKEN}`, "utf8").toString("base64");
	socket.write(
		`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
	);
	let buffer = Buffer.alloc(0);
	while (!buffer.includes("\r\n\r\n")) {
		const [chunk] = (await once(socket, "data")) as [Buffer];
		buffer = Buffer.concat([buffer, chunk]);
	}
	const status = Number((buffer.toString("utf8").split("\r\n")[0] ?? "").split(" ")[1] ?? 0);
	if (status !== 200) throw new Error(`CONNECT answered ${status}`);
	return socket;
}

/** A request the way git makes one: through the tunnel, with a body that may arrive in pieces. */
async function send(options: {
	proxyPort: number;
	authority: string;
	caCertPem: string;
	method: string;
	path: string;
	headers?: Record<string, string>;
	/** Each piece is written after a pause, so the proxy meets the body the way a socket delivers it. */
	body?: readonly Buffer[];
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	const socket = await tunnel(options.proxyPort, options.authority);
	const servername = options.authority.split(":")[0] ?? "localhost";
	const tlsSocket = tls.connect({ socket, servername, ca: options.caCertPem });
	await once(tlsSocket, "secureConnect");
	const request = http.request({
		createConnection: () => tlsSocket as unknown as net.Socket,
		method: options.method,
		path: options.path,
		headers: { host: options.authority, ...options.headers },
	});
	const responded = once(request, "response") as Promise<[http.IncomingMessage]>;
	const pieces = options.body ?? [];
	for (const [index, piece] of pieces.entries()) {
		if (index > 0) await sleep(20);
		request.write(piece);
	}
	request.end();
	const [response] = await responded;
	const chunks: Buffer[] = [];
	for await (const chunk of response) chunks.push(chunk as Buffer);
	tlsSocket.destroy();
	return {
		status: response.statusCode ?? 0,
		headers: response.headers,
		body: Buffer.concat(chunks),
	};
}

describe("a grant with a git scope", () => {
	const upstreamCa = createCertificateAuthority();
	const brokerCa = createCertificateAuthority();
	const audit: AuditEntry[] = [];
	const seen: Seen[] = [];

	let upstream: https.Server;
	let authority: string;
	let broker: EgressBroker;
	let proxyPort: number;

	const grants: Grant[] = [
		{
			id: "repo:acme/website",
			host: "localhost",
			pathPrefix: "/acme/website",
			injection: {
				kind: "basic",
				username: { ref: "GIT_USER" },
				password: { ref: "GITHUB_TOKEN" },
			},
			git: { push: ["scout/*"] },
		},
		{
			id: "plain",
			host: "localhost",
			pathPrefix: "/plain/repo",
			injection: { kind: "none" },
		},
	];

	beforeAll(async () => {
		const leaf = upstreamCa.issue("localhost");
		upstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				seen.push({
					url: req.url ?? "",
					method: req.method ?? "",
					authorization: req.headers.authorization,
					body: Buffer.concat(chunks),
				});
				res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
				res.end("upstream saw it");
			});
		});
		upstream.listen(0, "127.0.0.1");
		await once(upstream, "listening");
		authority = `localhost:${(upstream.address() as AddressInfo).port}`;

		broker = new EgressBroker({
			ca: brokerCa,
			secrets: new MemorySecretStore({ GIT_USER: "x-access-token", GITHUB_TOKEN: TOKEN }),
			directory: new StaticAgentDirectory([{ agentId: AGENT_ID, proxyToken: PROXY_TOKEN, grants }]),
			onAudit: (entry) => audit.push(entry),
			upstreamAgent: new https.Agent({ ca: upstreamCa.caCertPem }),
		});
		proxyPort = (await broker.listen(0)).port;
	});

	afterAll(async () => {
		await broker.close();
		upstream.close();
	});

	beforeEach(() => {
		audit.length = 0;
		seen.length = 0;
	});

	const post = (path: string, body: readonly Buffer[], headers?: Record<string, string>) =>
		send({
			proxyPort,
			authority,
			caCertPem: brokerCa.caCertPem,
			method: "POST",
			path,
			headers: { "content-type": "application/x-git-receive-pack-request", ...headers },
			body,
		});

	it("answers under the repository's name with .git on the end as well as without", async () => {
		for (const path of ["/acme/website/info/refs", "/acme/website.git/info/refs"]) {
			const response = await send({
				proxyPort,
				authority,
				caCertPem: brokerCa.caCertPem,
				method: "GET",
				path: `${path}?service=git-receive-pack`,
			});
			expect(response.status).toBe(200);
		}
		expect(seen.map((one) => one.url)).toEqual([
			"/acme/website/info/refs?service=git-receive-pack",
			"/acme/website.git/info/refs?service=git-receive-pack",
		]);
		const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
		expect(seen.every((one) => one.authorization === expected)).toBe(true);
		// And not under a name that merely starts the same way.
		const other = await send({
			proxyPort,
			authority,
			caCertPem: brokerCa.caCertPem,
			method: "GET",
			path: "/acme/websites/info/refs",
		});
		expect(other.status).toBe(403);
	});

	it("passes a push to a granted branch whole, packfile and all, with the credential on it", async () => {
		const head = commands(["refs/heads/scout/fix-header"]);
		const response = await post("/acme/website.git/git-receive-pack", [
			head,
			PACKFILE.subarray(0, 1000),
			PACKFILE.subarray(1000),
		]);
		expect(response.status).toBe(200);
		expect(response.body.toString()).toBe("upstream saw it");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.body.equals(Buffer.concat([head, PACKFILE]))).toBe(true);
		expect(seen[0]?.authorization).toContain("Basic ");
		expect(audit.at(-1)).toMatchObject({
			outcome: "allowed",
			grantId: "repo:acme/website",
			refs: ["refs/heads/scout/fix-header"],
		});
	});

	it("passes a push whose commands and packfile arrive in one piece", async () => {
		const head = commands(["refs/heads/scout/one", "refs/heads/scout/two"]);
		const response = await post("/acme/website/git-receive-pack", [
			Buffer.concat([head, PACKFILE]),
		]);
		expect(response.status).toBe(200);
		expect(seen[0]?.body.equals(Buffer.concat([head, PACKFILE]))).toBe(true);
	});

	it("passes a delete of its own branch, which has no packfile to wait for", async () => {
		const head = Buffer.concat([
			pkt(`${OLD} ${ZERO} refs/heads/scout/stale\0report-status`),
			FLUSH,
		]);
		const response = await post("/acme/website/git-receive-pack", [head]);
		expect(response.status).toBe(200);
		expect(seen[0]?.body.equals(head)).toBe(true);
	});

	it("turns a push to main down in git's own words, without opening the upstream", async () => {
		const response = await post("/acme/website/git-receive-pack", [
			commands(["refs/heads/main"], "report-status"),
			PACKFILE,
		]);
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe("application/x-git-receive-pack-result");
		const report = response.body.toString("utf8");
		expect(report).toContain("unpack ok");
		expect(report).toContain("ng refs/heads/main not granted: push scout/* here");
		expect(seen).toHaveLength(0);
		expect(audit.at(-1)).toMatchObject({
			outcome: "denied",
			reason: "ref_not_granted",
			grantId: "repo:acme/website",
			refs: ["refs/heads/main"],
		});
	});

	it("holds back the granted branch pushed alongside a refused one", async () => {
		const response = await post("/acme/website/git-receive-pack", [
			commands(["refs/heads/scout/ok", "refs/heads/main"], "report-status"),
			PACKFILE,
		]);
		const report = response.body.toString("utf8");
		expect(report).toContain("ng refs/heads/main not granted");
		expect(report).toContain("ng refs/heads/scout/ok held back with main");
		expect(seen).toHaveLength(0);
	});

	it("speaks the sideband back when the client asked for it", async () => {
		const response = await post("/acme/website/git-receive-pack", [
			commands(["refs/heads/main"]),
			PACKFILE,
		]);
		expect(response.body[4]).toBe(2);
		expect(response.body.toString("utf8")).toContain(
			"squad: main is not granted to this agent; push scout/* here",
		);
	});

	it("refuses a push it cannot read, and says why", async () => {
		const garbage = await post("/acme/website/git-receive-pack", [Buffer.from("PACKnothing")]);
		expect(garbage.status).toBe(403);
		expect(JSON.parse(garbage.body.toString())).toMatchObject({ reason: "push_unreadable" });

		const encoded = await post(
			"/acme/website/git-receive-pack",
			[commands(["refs/heads/scout/fix"]), PACKFILE],
			{ "content-encoding": "gzip" },
		);
		expect(encoded.status).toBe(403);
		expect(JSON.parse(encoded.body.toString())).toMatchObject({
			reason: "push_unreadable",
			why: expect.stringContaining("gzip"),
		});
		expect(seen).toHaveLength(0);
		expect(audit.filter((entry) => entry.reason === "push_unreadable")).toHaveLength(2);
	});

	it("leaves a push through a grant with no git scope as it always was", async () => {
		const body = Buffer.concat([commands(["refs/heads/main"]), PACKFILE]);
		const response = await post("/plain/repo/git-receive-pack", [body]);
		expect(response.status).toBe(200);
		expect(response.body.toString()).toBe("upstream saw it");
		expect(seen[0]?.body.equals(body)).toBe(true);
		expect(audit.at(-1)?.refs).toBeUndefined();
	});

	it("does not read a fetch, which is the other POST under the repository", async () => {
		const body = Buffer.from("0032want aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n00000009done\n");
		const response = await post("/acme/website/git-upload-pack", [body]);
		expect(response.status).toBe(200);
		expect(seen[0]?.body.equals(body)).toBe(true);
	});
});
