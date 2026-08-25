/**
 * Reading an HTTP response back out of `curl -i`, for the extensions that have to shell out to make
 * one.
 *
 * Its own file, and importing nothing, so it can be tested from outside the container. The rest of
 * an extension only runs with pi's API in front of it, which is why none of it is — and this is the
 * part where being wrong is silent: every failure it causes arrives as a server that answered
 * nothing rather than as an error naming a parser.
 */

export interface Reply {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/**
 * Splits curl's output into the headers and the body.
 *
 * The last header block is the answer, and taking any earlier one is how this went wrong: every
 * request from a sandbox goes out through the egress proxy, so the first block curl prints is the
 * proxy's own `200 Connection Established` — a 200, with the real response left sitting in what was
 * read as its body. Every remote MCP server came back as "nothing that reads as a reply", including
 * the ones answering perfectly. A 1xx is the same shape for a different reason, and taking the last
 * block handles it for free.
 */
export function readReply(raw: string): Reply {
	let rest = raw;
	let reply: Reply = { status: 0, headers: {}, body: raw };
	// A JSON-RPC body starts with a brace and an event stream with a field name, so a remainder that
	// begins `HTTP/` is another block rather than the answer having begun.
	while (rest.startsWith("HTTP/")) {
		const end = rest.search(/\r?\n\r?\n/);
		if (end < 0) break;
		const [line = "", ...fields] = rest.slice(0, end).split(/\r?\n/);
		rest = rest.slice(end).replace(/^\r?\n\r?\n/, "");
		const headers: Record<string, string> = {};
		for (const field of fields) {
			const colon = field.indexOf(":");
			if (colon > 0) {
				headers[field.slice(0, colon).trim().toLowerCase()] = field.slice(colon + 1).trim();
			}
		}
		reply = { status: Number(line.split(" ")[1]), headers, body: rest };
	}
	return reply;
}
