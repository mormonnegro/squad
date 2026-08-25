import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi has no MCP of its own, deliberately: its README says to build an extension for it. This is that
 * extension, and it is a whole MCP client — the handshake, the three transports, and the tools that
 * come back registered as pi's own so the model cannot tell which of its tools live somewhere else.
 *
 * The servers are the plane's rather than the agent's, written here fresh before every turn. Nothing
 * in the file is a credential and there is nowhere to put one: a local server inherits a sandbox
 * whose only road out is the egress proxy, and a remote one is reached down that same road, so
 * whatever key either of them needs is one the proxy writes onto the request.
 */
const MCP_FILE = process.env.AGENT_DIVE_MCP_FILE ?? "/home/agent/.run/mcp.json";

/**
 * The handshake happens before pi has asked the model anything, so this is time the agent spends
 * sitting still. Long enough for a server that has to be downloaded first, short enough that one
 * which will never answer does not take the turn with it.
 */
const CONNECT_MS = 20_000;

/** A tool call is work somebody asked for, and some of it is slow on purpose. */
const CALL_MS = 120_000;

/** What we say we speak. A server that speaks something older says so, and we take its word. */
const PROTOCOL = "2025-06-18";

type Server =
	| { readonly transport: "stdio"; readonly command: string; readonly args: readonly string[] }
	| { readonly transport: "http" | "sse"; readonly url: string };

interface Named {
	readonly name: string;
	readonly server: Server;
}

interface Message {
	readonly id?: number | string;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

interface Connection {
	call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
	notify(method: string, params?: unknown): Promise<void>;
	close(): void;
}

interface Listed {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
}

type Part =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

interface Answered {
	readonly content?: readonly {
		readonly type: string;
		readonly text?: string;
		readonly data?: string;
		readonly mimeType?: string;
		readonly resource?: { readonly text?: string };
	}[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
}

/** Every process this extension started, killed when pi's is on its way out. */
const started = new Set<ChildProcess>();
process.once("exit", () => {
	for (const child of started) child.kill();
});

/**
 * How many answers we are waiting for, which decides whether a server we are holding open is a
 * reason for Node not to exit.
 *
 * Both halves of this have to be right or the turn dies. Left referenced, a local server outlives
 * the answer and pi can never exit — a turn that finished looks exactly like a hung one, and the
 * plane kills it ten minutes later. Left unreferenced, there is a moment during the handshake when
 * nothing at all is referenced and Node exits mid-turn, taking pi with it. So: held while we are
 * waiting on something, let go the instant we are not.
 */
let waiting = 0;

function watch(child: ChildProcess, on: boolean): void {
	if (on) child.ref();
	else child.unref();
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		const handle = stream as { ref?: () => void; unref?: () => void } | null;
		if (on) handle?.ref?.();
		else handle?.unref?.();
	}
}

async function holding<T>(work: () => Promise<T>): Promise<T> {
	waiting += 1;
	if (waiting === 1) for (const child of started) watch(child, true);
	try {
		return await work();
	} finally {
		waiting -= 1;
		if (waiting === 0) for (const child of started) watch(child, false);
	}
}

function timeout<T>(promise: Promise<T>, ms: number, why: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(why)), ms);
		timer.unref();
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/** The calls waiting on an answer, for the two transports where answers arrive out of band. */
class Pending {
	#last = 0;
	readonly #waiting = new Map<
		number,
		{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
	>();

	next(): number {
		this.#last += 1;
		return this.#last;
	}

	wait(id: number, timeoutMs: number): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiting.delete(id);
				reject(new Error(`No answer after ${Math.round(timeoutMs / 1000)}s.`));
			}, timeoutMs);
			timer.unref();
			this.#waiting.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	settle(message: Message): void {
		if (message.id === undefined) return;
		const id = Number(message.id);
		const waiting = this.#waiting.get(id);
		if (waiting === undefined) return;
		this.#waiting.delete(id);
		if (message.error !== undefined) {
			waiting.reject(new Error(`${message.error.message} (${message.error.code})`));
			return;
		}
		waiting.resolve(message.result);
	}

	/** A transport that has died has killed every call on it, not just whichever one noticed. */
	failAll(error: Error): void {
		for (const waiting of this.#waiting.values()) waiting.reject(error);
		this.#waiting.clear();
	}
}

interface Reply {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/**
 * curl rather than fetch, for the reason search.ts uses it: the sandbox has no DNS and no route out
 * except the egress proxy, and Node's fetch reads neither HTTPS_PROXY nor NODE_EXTRA_CA_CERTS. The
 * body goes over stdin so that nothing built from what a model wrote is ever an argument.
 */
function post(
	url: string,
	headers: Readonly<Record<string, string>>,
	body: string,
	timeoutMs: number,
): Promise<Reply> {
	const args = ["-sS", "-i", url, "--data-binary", "@-"];
	for (const [key, value] of Object.entries(headers)) args.push("-H", `${key}: ${value}`);
	return new Promise<Reply>((resolve, reject) => {
		const curl = execFile(
			"curl",
			args,
			{ timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
			(failure, stdout, stderr) => {
				if (failure !== null) {
					reject(new Error(stderr.trim().length > 0 ? stderr.trim() : failure.message));
					return;
				}
				resolve(readReply(stdout));
			},
		);
		curl.stdin?.end(body);
	});
}

/**
 * Splits curl's output into the headers and the body.
 *
 * The last header block is the answer, and taking any earlier one is how this went wrong: every
 * request here goes out through the egress proxy, so the first block curl prints is the proxy's own
 * `200 Connection Established` — a 200, with the real response left sitting in what was read as its
 * body. Every remote MCP server in this sandbox came back as "nothing that reads as a reply". A 1xx
 * is the same shape for a different reason, and this handles it for free.
 */
function readReply(raw: string): Reply {
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

function readFrame(block: string): { readonly event: string; readonly data: string } | undefined {
	let event = "message";
	const data: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	return data.length > 0 ? { event, data: data.join("\n") } : undefined;
}

function overStdio(command: string, args: readonly string[]): Connection {
	const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Pending();
	started.add(child);

	// Where an MCP server says why it would not start, and the only place it says it. Kept to a tail
	// so a chatty one cannot grow without bound over a long turn.
	let complaint = "";
	let rest = "";

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		rest += chunk;
		let cut = rest.indexOf("\n");
		while (cut >= 0) {
			const line = rest.slice(0, cut).trim();
			rest = rest.slice(cut + 1);
			if (line.length > 0) {
				try {
					pending.settle(JSON.parse(line) as Message);
				} catch {
					// Servers print to stdout that should not. Not a message is not a failure.
				}
			}
			cut = rest.indexOf("\n");
		}
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		complaint = `${complaint}${chunk}`.slice(-2000);
	});

	const died = (what: string): void => {
		const said = complaint.trim();
		pending.failAll(new Error(said.length > 0 ? `${what}: ${said}` : what));
	};
	child.on("error", (error: Error) => died(`Could not run "${command}" (${error.message})`));
	child.on("exit", (code) => died(`"${command}" exited ${code ?? "on a signal"}`));
	// A write to a server that has already gone is an error event, and an error event nobody is
	// listening for takes the whole process down with it.
	child.stdin?.on("error", () => {});

	const write = (message: object): void => {
		child.stdin?.write(`${JSON.stringify(message)}\n`);
	};

	return {
		call(method, params, timeoutMs = CALL_MS) {
			const id = pending.next();
			const waiting = pending.wait(id, timeoutMs);
			write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
			return waiting;
		},
		async notify(method, params) {
			write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
		},
		close() {
			started.delete(child);
			child.kill();
		},
	};
}

/** The current remote transport: one POST per message, and the answer in the same exchange. */
function overHttp(url: string): Connection {
	let last = 0;
	let session: string | undefined;
	let version = PROTOCOL;

	return {
		async call(method, params, timeoutMs = CALL_MS) {
			last += 1;
			const id = last;
			const reply = await post(
				url,
				{
					"Content-Type": "application/json",
					// Both, because a server may answer either way and the spec lets it choose.
					Accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": version,
					...(session !== undefined ? { "Mcp-Session-Id": session } : {}),
				},
				JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }),
				timeoutMs,
			);
			const given = reply.headers["mcp-session-id"];
			if (given !== undefined) session = given;
			if (reply.status >= 400) {
				throw new Error(`HTTP ${reply.status}: ${reply.body.trim().slice(0, 400)}`);
			}

			// A stream carries notifications as well as the answer, so the answer is the one with our id
			// on it rather than the first thing to arrive.
			const streamed = (reply.headers["content-type"] ?? "").includes("text/event-stream");
			const texts = streamed
				? reply.body
						.split(/\r?\n\r?\n/)
						.map((block) => readFrame(block)?.data)
						.filter((data): data is string => data !== undefined)
				: [reply.body];

			for (const text of texts) {
				let message: Message;
				try {
					message = JSON.parse(text) as Message;
				} catch {
					continue;
				}
				if (message.id === undefined || Number(message.id) !== id) continue;
				if (message.error !== undefined) {
					throw new Error(`${message.error.message} (${message.error.code})`);
				}
				if (method === "initialize") {
					const said = (message.result as { protocolVersion?: string } | null)?.protocolVersion;
					if (typeof said === "string") version = said;
				}
				return message.result;
			}
			throw new Error(`The server answered ${method} with nothing that reads as a reply.`);
		},
		async notify(method, params) {
			await post(
				url,
				{
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": version,
					...(session !== undefined ? { "Mcp-Session-Id": session } : {}),
				},
				JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }),
				CONNECT_MS,
			);
		},
		close() {},
	};
}

/**
 * The older remote transport, kept because plenty of servers are still only reachable this way: a
 * stream held open for the answers, and a second URL — which the stream itself names — to post to.
 */
function overSse(url: string): Connection {
	const pending = new Pending();
	const child = spawn("curl", ["-sS", "-N", "-H", "Accept: text/event-stream", url]);
	started.add(child);

	let arrive: (where: string) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const endpoint = new Promise<string>((resolve, reject) => {
		arrive = resolve;
		fail = reject;
	});
	const reached = timeout(endpoint, CONNECT_MS, "The server never said where to post to.");
	reached.catch(() => {});

	let rest = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		rest += chunk;
		let cut = rest.search(/\r?\n\r?\n/);
		while (cut >= 0) {
			const block = rest.slice(0, cut);
			rest = rest.slice(cut).replace(/^\r?\n\r?\n/, "");
			const frame = readFrame(block);
			if (frame !== undefined) {
				if (frame.event === "endpoint") arrive(new URL(frame.data.trim(), url).toString());
				else {
					try {
						pending.settle(JSON.parse(frame.data) as Message);
					} catch {
						// A comment or a keepalive. Not a message is not a failure.
					}
				}
			}
			cut = rest.search(/\r?\n\r?\n/);
		}
	});

	const died = (what: string): void => {
		fail(new Error(what));
		pending.failAll(new Error(what));
	};
	child.on("error", (error: Error) => died(`Could not reach ${url} (${error.message})`));
	child.on("exit", () => died(`The stream from ${url} closed.`));

	const send = async (message: object, timeoutMs: number): Promise<void> => {
		const where = await reached;
		const reply = await post(
			where,
			{ "Content-Type": "application/json" },
			JSON.stringify(message),
			timeoutMs,
		);
		if (reply.status >= 400) {
			throw new Error(`HTTP ${reply.status}: ${reply.body.trim().slice(0, 400)}`);
		}
	};

	return {
		async call(method, params, timeoutMs = CALL_MS) {
			const id = pending.next();
			const waiting = pending.wait(id, timeoutMs);
			await send(
				{ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) },
				timeoutMs,
			);
			return waiting;
		},
		async notify(method, params) {
			await send(
				{ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) },
				CONNECT_MS,
			);
		},
		close() {
			started.delete(child);
			child.kill();
		},
	};
}

function connect(server: Server): Connection {
	if (server.transport === "stdio") return overStdio(server.command, server.args);
	return server.transport === "sse" ? overSse(server.url) : overHttp(server.url);
}

/** The handshake, and then everything the server can do — in pages, because some of them page. */
function greet(connection: Connection): Promise<readonly Listed[]> {
	return holding(() => shakeHands(connection));
}

async function shakeHands(connection: Connection): Promise<readonly Listed[]> {
	await connection.call(
		"initialize",
		{
			protocolVersion: PROTOCOL,
			// Nothing offered, so nothing is asked of us mid-turn. An agent taking one turn at a time
			// has no way to answer a server that wants a model called on its behalf.
			capabilities: {},
			clientInfo: { name: "agent-dive", version: "1" },
		},
		CONNECT_MS,
	);
	await connection.notify("notifications/initialized");

	const tools: Listed[] = [];
	let cursor: string | undefined;
	do {
		const page = (await connection.call(
			"tools/list",
			cursor === undefined ? {} : { cursor },
			CONNECT_MS,
		)) as { tools?: readonly Listed[]; nextCursor?: string };
		tools.push(...(page.tools ?? []));
		cursor = page.nextCursor;
	} while (cursor !== undefined && tools.length < 500);
	return tools;
}

/**
 * Joined by the one character a server name may not contain, so the split back is never ambiguous,
 * and cut to what a provider will accept as a tool name.
 */
function named(server: string, tool: string): string {
	return `${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

/**
 * What the server says its tool takes, handed to pi as-is.
 *
 * pi types this as a TypeBox schema, but a TypeBox schema is a plain JSON Schema object once it is
 * running and this already is one — it goes to the provider either way. Only the two things a
 * provider will choke on are touched: the meta key, and a server that described an object without
 * saying so.
 */
function shapeOf(schema: Record<string, unknown> | undefined): Record<string, unknown> {
	const shape: Record<string, unknown> = { ...(schema ?? {}) };
	delete shape["$schema"];
	shape["type"] = "object";
	const properties = shape["properties"];
	if (typeof properties !== "object" || properties === null) shape["properties"] = {};
	return shape;
}

function carried(answered: Answered): Part[] {
	const content: Part[] = [];
	for (const part of answered.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") {
			content.push({ type: "text", text: part.text });
		} else if (part.type === "image" && typeof part.data === "string") {
			content.push({ type: "image", data: part.data, mimeType: part.mimeType ?? "image/png" });
		} else if (typeof part.resource?.text === "string") {
			content.push({ type: "text", text: part.resource.text });
		} else {
			content.push({ type: "text", text: `[${part.type}]` });
		}
	}
	if (content.length === 0 && answered.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(answered.structuredContent, null, 2) });
	}
	return content;
}

/** Registers one tool, and says whether it was this server's to register or another's already. */
function register(
	pi: ExtensionAPI,
	server: string,
	tool: Listed,
	connection: Connection,
	taken: Set<string>,
): boolean {
	const name = named(server, tool.name);
	if (taken.has(name)) return false;
	taken.add(name);

	const description = (tool.description ?? "").trim();
	pi.registerTool({
		name,
		label: `${server}: ${tool.name}`,
		description:
			description.length > 0
				? description
				: `The "${tool.name}" tool, from the ${server} MCP server.`,
		// No promptSnippet on purpose. That section of the system prompt is for the few things the
		// agent should know it can do before it looks; a server can bring forty tools, and their full
		// descriptions are in the request already.
		parameters: shapeOf(tool.inputSchema) as never,
		async execute(_toolCallId, params) {
			const answered = (await holding(() =>
				connection.call("tools/call", { name: tool.name, arguments: params ?? {} }),
			)) as Answered;
			const content = carried(answered);

			// Thrown rather than returned, because that is how a pi tool reports failure: a failure
			// returned as content is one the model reads as the answer and carries on from.
			if (answered.isError === true) {
				const why = content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("\n")
					.trim();
				throw new Error(why.length > 0 ? why : `${tool.name} failed and did not say why.`);
			}
			if (content.length === 0) {
				return { content: [{ type: "text", text: "(no output)" }], details: {} };
			}
			return { content, details: {} };
		},
	});
	return true;
}

function read(): readonly Named[] {
	let raw: string;
	try {
		raw = readFileSync(MCP_FILE, "utf8");
	} catch {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return (parsed as Named[]).filter(
			(each) => typeof each?.name === "string" && typeof each?.server === "object",
		);
	} catch {
		return [];
	}
}

/** What a server came to, once the handshake has either landed or not. */
type Standing =
	| { readonly name: string; readonly tools: number }
	| { readonly name: string; readonly trouble: string };

/**
 * The servers, written into the agent's own system prompt.
 *
 * Registering the tools is not the same as saying the server is there, and the difference is a whole
 * turn wasted. The console's answer to `/mcp login` goes to the operator, because the operator is the
 * one with the browser it ends in — so an agent that asked for a server is never told it got one. It
 * has only its tool list to infer from, and what it does instead is remember: the turn before this
 * one it said the login was pending, so this turn it says so again, while holding a hundred working
 * tools it will not touch.
 *
 * Said every turn rather than once, because the list is the operator's and moves between turns, and
 * the turn it moves on is exactly the one whose history says otherwise.
 */
function saying(standing: readonly Standing[]): string {
	const lines = standing.map((one) =>
		"tools" in one
			? `- \`${one.name}\` — connected. ${one.tools} ${one.tools === 1 ? "tool" : "tools"}, named \`${one.name}_*\`.`
			: `- \`${one.name}\` — did not answer: ${one.trouble}`,
	);
	return [
		"## The MCP servers you have",
		"",
		"Read at the start of this turn. The operator adds and removes these between turns, so this is",
		"the list that is true now — not whatever was said about them earlier in the conversation.",
		"",
		...lines,
		"",
		"A server listed as connected is connected: its tools are in your tool list already, there is",
		"nothing left to authorise and nobody to wait for. Use them. One that did not answer is one you",
		"do not have this turn — tell the operator what it said, rather than guessing what they must do.",
	].join("\n");
}

/**
 * Asynchronous, and pi waits: the tools have to exist before the first request is built, or the
 * model spends the turn it was given not knowing it had them.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	const wanted = read();
	if (wanted.length === 0) return;

	const taken = new Set<string>();
	const standing = new Map<string, Standing>();
	// All at once, so the wait is the slowest server rather than the sum of them.
	await Promise.all(
		wanted.map(async ({ name, server }) => {
			let connection: Connection;
			let tools: readonly Listed[];
			try {
				connection = connect(server);
				tools = await greet(connection);
			} catch (failure) {
				// Said and survived. A server that will not answer is a reason to have fewer tools, not a
				// reason for the agent to lose the turn — and stderr is where the plane already looks.
				const trouble = (failure as Error).message;
				console.error(`[mcp] ${name}: ${trouble}`);
				standing.set(name, { name, trouble });
				return;
			}
			if (tools.length === 0) {
				connection.close();
				standing.set(name, { name, trouble: "it offered no tools." });
				return;
			}
			let count = 0;
			for (const tool of tools) if (register(pi, name, tool, connection, taken)) count += 1;
			standing.set(name, { name, tools: count });
		}),
	);

	// Kept in the order the plane gave them rather than the order they answered in, so the paragraph
	// does not reshuffle itself every turn for a reason nobody could name.
	const listed = wanted
		.map(({ name }) => standing.get(name))
		.filter((one): one is Standing => one !== undefined);
	// Appended rather than replacing, and chained by pi with whatever another extension appended.
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${saying(listed)}`,
	}));
}
