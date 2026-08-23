import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuditEntry, EgressBroker } from "../src/broker.ts";
import { createCertificateAuthority } from "../src/ca.ts";
import { StaticAgentDirectory } from "../src/directory.ts";
import type { Grant } from "../src/grants.ts";
import { MemorySecretStore } from "../src/secrets.ts";

const SECRET = "ghp_this_must_never_reach_the_agent";
const PROXY_TOKEN = "proxy-token-for-agent-1";
const AGENT_ID = "agent-1";

interface UpstreamEcho {
	url: string;
	headers: Record<string, string | string[] | undefined>;
}

interface ConnectResult {
	status: number;
	socket: net.Socket;
}

async function openTunnel(
	proxyPort: number,
	authority: string,
	credentials: string,
): Promise<ConnectResult> {
	const socket = net.connect(proxyPort, "127.0.0.1");
	await once(socket, "connect");
	const auth = Buffer.from(credentials, "utf8").toString("base64");
	socket.write(
		`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
	);

	let buffer = Buffer.alloc(0);
	while (!buffer.includes("\r\n\r\n")) {
		const [chunk] = (await once(socket, "data")) as [Buffer];
		buffer = Buffer.concat([buffer, chunk]);
	}
	const statusLine = buffer.toString("utf8").split("\r\n")[0] ?? "";
	const status = Number(statusLine.split(" ")[1] ?? 0);
	return { status, socket };
}

async function requestThroughTunnel(options: {
	proxyPort: number;
	authority: string;
	credentials: string;
	caCertPem: string;
	path: string;
	method?: string;
	headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
	const { status, socket } = await openTunnel(
		options.proxyPort,
		options.authority,
		options.credentials,
	);
	if (status !== 200) {
		socket.destroy();
		return { status, body: "" };
	}

	const servername = options.authority.split(":")[0] ?? "localhost";
	const tlsSocket = tls.connect({ socket, servername, ca: options.caCertPem });
	await once(tlsSocket, "secureConnect");

	const request = http.request({
		createConnection: () => tlsSocket as unknown as net.Socket,
		method: options.method ?? "GET",
		path: options.path,
		headers: { host: options.authority, ...options.headers },
	});
	request.end();

	const [response] = (await once(request, "response")) as [http.IncomingMessage];
	const chunks: Buffer[] = [];
	for await (const chunk of response) chunks.push(chunk as Buffer);
	tlsSocket.destroy();
	return {
		status: response.statusCode ?? 0,
		body: Buffer.concat(chunks).toString("utf8"),
	};
}

describe("EgressBroker", () => {
	const upstreamCa = createCertificateAuthority();
	const brokerCa = createCertificateAuthority();
	const audit: AuditEntry[] = [];

	let upstream: https.Server;
	let upstreamPort: number;
	let broker: EgressBroker;
	let proxyPort: number;
	let lastUpstreamEcho: UpstreamEcho | undefined;

	const grants: Grant[] = [
		{
			id: "gh-repos",
			host: "localhost",
			pathPrefix: "/repos",
			methods: ["GET"],
			injection: { kind: "bearer", token: { ref: "GH" } },
		},
		{
			id: "gh-search-query",
			host: "localhost",
			pathPrefix: "/search",
			injection: { kind: "query", name: "api_key", value: { ref: "GH" } },
		},
	];

	beforeAll(async () => {
		const leaf = upstreamCa.issue("localhost");
		upstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
			lastUpstreamEcho = { url: req.url ?? "", headers: req.headers };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(lastUpstreamEcho));
		});
		upstream.listen(0, "127.0.0.1");
		await once(upstream, "listening");
		upstreamPort = (upstream.address() as AddressInfo).port;

		broker = new EgressBroker({
			ca: brokerCa,
			secrets: new MemorySecretStore({ GH: SECRET }),
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

	it("injects the credential upstream without the agent ever sending it", async () => {
		const response = await requestThroughTunnel({
			proxyPort,
			authority: `localhost:${upstreamPort}`,
			credentials: `${AGENT_ID}:${PROXY_TOKEN}`,
			caCertPem: brokerCa.caCertPem,
			path: "/repos/acme/widgets",
		});

		expect(response.status).toBe(200);
		expect(lastUpstreamEcho?.headers.authorization).toBe(`Bearer ${SECRET}`);
	});

	it("does not let the agent shadow the injected header", async () => {
		await requestThroughTunnel({
			proxyPort,
			authority: `localhost:${upstreamPort}`,
			credentials: `${AGENT_ID}:${PROXY_TOKEN}`,
			caCertPem: brokerCa.caCertPem,
			path: "/repos/acme/widgets",
			headers: { authorization: "Bearer attacker-controlled" },
		});

		expect(lastUpstreamEcho?.headers.authorization).toBe(`Bearer ${SECRET}`);
	});

	it("injects query credentials", async () => {
		await requestThroughTunnel({
			proxyPort,
			authority: `localhost:${upstreamPort}`,
			credentials: `${AGENT_ID}:${PROXY_TOKEN}`,
			caCertPem: brokerCa.caCertPem,
			path: "/search?q=hello",
		});

		expect(lastUpstreamEcho?.url).toContain(`api_key=${encodeURIComponent(SECRET)}`);
		expect(lastUpstreamEcho?.url).toContain("q=hello");
	});

	it("denies a path outside the grant", async () => {
		const response = await requestThroughTunnel({
			proxyPort,
			authority: `localhost:${upstreamPort}`,
			credentials: `${AGENT_ID}:${PROXY_TOKEN}`,
			caCertPem: brokerCa.caCertPem,
			path: "/user/keys",
		});

		expect(response.status).toBe(403);
		expect(JSON.parse(response.body)).toMatchObject({ error: "egress_denied" });
	});

	it("denies an ungranted method", async () => {
		const response = await requestThroughTunnel({
			proxyPort,
			authority: `localhost:${upstreamPort}`,
			credentials: `${AGENT_ID}:${PROXY_TOKEN}`,
			caCertPem: brokerCa.caCertPem,
			path: "/repos/acme/widgets",
			method: "DELETE",
		});

		expect(response.status).toBe(403);
		expect(JSON.parse(response.body)).toMatchObject({
			reason: "method_not_granted",
		});
	});

	it("refuses to tunnel to an ungranted host", async () => {
		const { status, socket } = await openTunnel(
			proxyPort,
			"evil.example.com:443",
			`${AGENT_ID}:${PROXY_TOKEN}`,
		);
		socket.destroy();
		expect(status).toBe(403);
	});

	it("rejects a bad proxy token", async () => {
		const { status, socket } = await openTunnel(
			proxyPort,
			`localhost:${upstreamPort}`,
			`${AGENT_ID}:wrong-token`,
		);
		socket.destroy();
		expect(status).toBe(407);
	});

	it("never writes the secret to the audit log", () => {
		expect(audit.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit)).not.toContain(SECRET);
	});

	it("records allow and deny outcomes", () => {
		expect(audit.some((entry) => entry.outcome === "allowed" && entry.grantId === "gh-repos")).toBe(
			true,
		);
		expect(
			audit.some((entry) => entry.outcome === "denied" && entry.reason === "path_not_granted"),
		).toBe(true);
		expect(audit.some((entry) => entry.reason === "unauthenticated")).toBe(true);
	});
});
