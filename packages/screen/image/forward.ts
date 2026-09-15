import http from "node:http";
import net from "node:net";

/**
 * The browser's way out, which exists because Chromium will not carry a proxy password.
 *
 * Everything else in this deployment is pointed at the egress proxy with the agent's credential in
 * the URL, and every runtime that matters reads it from there. Chromium reads the address and drops
 * the rest: told `http://scout:token@egress:8080`, it connects to the proxy anonymously, gets the
 * 407 it has coming, and asks a person for the password. In a headless browser there is no person,
 * so the request hangs and then fails, and what that looks like from the agent's side is a web that
 * is down for it and up for everybody else.
 *
 * So this sits on loopback, takes the browser's unauthenticated requests, and writes the header on.
 * It is not a second boundary and does not pretend to be one: the credential is the agent's, the
 * grants it unlocks are the agent's, and what the browser can reach is exactly what the agent can.
 * The only thing that happens here is a header being added to requests that already had to come
 * this way.
 */

export interface Egress {
	readonly host: string;
	readonly port: number;
	readonly authorization: string;
}

/**
 * Splits the proxy URL into somewhere to dial and a header to write.
 *
 * The credential is decoded before it is re-encoded because it arrived percent-encoded: agent names
 * and tokens go into a URL through `encodeURIComponent`, and basic auth wants the bytes back.
 */
export function readEgress(raw: string | undefined): Egress | undefined {
	if (raw === undefined || raw === "") return undefined;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return undefined;
	}
	const user = decodeURIComponent(parsed.username);
	const password = decodeURIComponent(parsed.password);
	return {
		host: parsed.hostname,
		port: Number(parsed.port || 8080),
		authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
	};
}

export function startForwarder(port: number, egress: Egress): http.Server {
	const server = http.createServer((request, response) => {
		// An ordinary proxied request: the URL is absolute and the headers are the browser's, plus one.
		const upstream = http.request(
			{
				host: egress.host,
				port: egress.port,
				method: request.method,
				path: request.url,
				headers: { ...request.headers, "proxy-authorization": egress.authorization },
			},
			(answer) => {
				response.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(response);
			},
		);
		upstream.on("error", () => {
			response.writeHead(502, { "content-type": "text/plain" }).end("the way out refused\n");
		});
		request.pipe(upstream);
	});

	/*
	 * Everything the browser does over TLS, which is almost everything it does.
	 *
	 * The tunnel is opened here rather than passed through because the header goes on the CONNECT
	 * itself: the proxy decides whether this agent may reach that host before a byte of TLS is
	 * spoken, and after the 200 there is nothing left to add a header to.
	 */
	server.on("connect", (request, socket, head) => {
		const upstream = net.connect(egress.port, egress.host, () => {
			upstream.write(
				`CONNECT ${request.url} HTTP/1.1\r\nHost: ${request.url}\r\nProxy-Authorization: ${egress.authorization}\r\n\r\n`,
			);
		});

		let greeting = Buffer.alloc(0);
		const opened = (chunk: Buffer): void => {
			greeting = Buffer.concat([greeting, chunk]);
			const end = greeting.indexOf("\r\n\r\n");
			if (end === -1) return;
			upstream.removeListener("data", opened);
			const status = greeting.subarray(0, greeting.indexOf("\r\n")).toString("latin1");
			if (!status.includes(" 200")) {
				// Passed on as it arrived. A refusal from the proxy is the one error here worth reading
				// literally: it names the host and says it was not granted, which is the answer.
				socket.end(`HTTP/1.1 ${status.split(" ").slice(1).join(" ") || "502 Bad Gateway"}\r\n\r\n`);
				upstream.destroy();
				return;
			}
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			const rest = greeting.subarray(end + 4);
			if (rest.byteLength > 0) socket.write(rest);
			if (head.byteLength > 0) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		};

		upstream.on("data", opened);
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});

	server.listen(port, "127.0.0.1");
	return server;
}
