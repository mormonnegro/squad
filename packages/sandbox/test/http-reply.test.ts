import { describe, expect, it } from "vitest";
import { readReply } from "../image/http-reply.ts";

/** curl writes headers with CRLF, and the difference is exactly what a naive split gets wrong. */
const raw = (...blocks: readonly string[]): string =>
	blocks.map((block) => block.replace(/\n/g, "\r\n")).join("");

const CONNECTED = "HTTP/1.1 200 Connection Established\n\n";

describe("readReply", () => {
	it("reads the plain answer of a server that was reached directly", () => {
		const reply = readReply(
			raw("HTTP/1.1 200 OK\ncontent-type: application/json\n\n", '{"ok":true}'),
		);

		expect(reply).toEqual({
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"ok":true}',
		});
	});

	/**
	 * The failure this was written for. Every request out of a sandbox is tunnelled, so curl prints
	 * the proxy's own 200 first — and taking the first block that was a 200 read the tunnel as the
	 * server, leaving the real response inside what was returned as its body. Every remote MCP server
	 * came back as "nothing that reads as a reply", the ones answering perfectly included.
	 */
	it("reads past the tunnel the proxy opened, to what the server actually said", () => {
		const reply = readReply(
			raw(
				CONNECTED,
				"HTTP/1.1 200 OK\ncontent-type: application/json\nmcp-session-id: 84d7b10a\n\n",
				'{"jsonrpc":"2.0","id":1,"result":{}}',
			),
		);

		expect(reply.status).toBe(200);
		expect(reply.body).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
		expect(reply.headers["mcp-session-id"]).toBe("84d7b10a");
	});

	// The status is what tells a server that refused from one that answered, and through a tunnel it
	// was always the tunnel's 200 — so a 401 was read as a success with unparseable content.
	it("keeps a refusal a refusal, rather than the tunnel's success", () => {
		const reply = readReply(raw(CONNECTED, "HTTP/1.1 401 Unauthorized\n\n", '{"error":"log in"}'));

		expect(reply.status).toBe(401);
		expect(reply.body).toBe('{"error":"log in"}');
	});

	it("reads past a 100 Continue for the same reason", () => {
		const reply = readReply(raw("HTTP/1.1 100 Continue\n\n", "HTTP/1.1 204 No Content\n\n", ""));

		expect(reply.status).toBe(204);
	});

	// Both blocks are there and both are the tunnel's, which is what a proxy that refuses looks like.
	it("gives the proxy's own refusal when the tunnel is what failed", () => {
		const reply = readReply(raw("HTTP/1.1 403 Forbidden\n\n", "no grant covers this host"));

		expect(reply).toMatchObject({ status: 403, body: "no grant covers this host" });
	});

	// curl killed mid-header, or something that was never a response. Nothing to report but the text.
	it("says nothing was read rather than inventing a status", () => {
		expect(readReply("")).toEqual({ status: 0, headers: {}, body: "" });
		expect(readReply("HTTP/1.1 200 OK\r\ncontent-type: application/json")).toMatchObject({
			status: 0,
		});
	});
});
