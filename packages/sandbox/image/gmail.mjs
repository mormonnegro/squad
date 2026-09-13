#!/usr/bin/env node
// An MCP server for a mailbox, spoken over Gmail's own API and with no credential of its own.
//
// This is the shape a plugin takes when the company has no MCP server: a process in the sandbox,
// talking HTTP to a host the proxy grants, with nothing in its hands. Every request here goes out
// bare — no token, no header, nothing — and the proxy writes the operator's onto it on the way, for
// as long as this agent holds the plugin and the account behind it is open. Take the plugin off the
// agent and the next request is a bare one at a host nothing grants, which is a 403 and not a leak.
//
// So the interesting part of this file is what is missing from it. There is no key to read, no file
// to hold one, and no way for anything that takes this agent over to find one: the credential is
// two processes away, in a plane the sandbox has no route to.
import { createInterface } from "node:readline";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** What a tool answers with when the thing it asked failed, said the way a model can act on. */
function refuse(why) {
	return { content: [{ type: "text", text: why }], isError: true };
}

function said(text) {
	return { content: [{ type: "text", text }] };
}

async function ask(path) {
	const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
	if (response.status === 401 || response.status === 403) {
		throw new Error(
			"Gmail refused this request. The account behind this plugin may need logging in again at the console.",
		);
	}
	if (!response.ok) throw new Error(`Gmail answered ${response.status}.`);
	return response.json();
}

/** One header off a message, by the name Gmail writes it under. */
function header(message, name) {
	const found = (message.payload?.headers ?? []).find(
		(one) => String(one.name).toLowerCase() === name,
	);
	return found?.value ?? "";
}

/**
 * The body as text, out of whichever part of the tree has it.
 *
 * A mail is a tree of parts and the useful one is rarely the first: a message with an attachment
 * puts the text two levels down, and one written in a mail client has the same words twice, once as
 * text and once as HTML. Plain text wins where there is any, and the HTML is stripped where there
 * is not — a model reading a wall of markup is a model reading the markup.
 */
function bodyOf(part) {
	if (part === undefined) return "";
	const data = part.body?.data;
	if (typeof data === "string" && data.length > 0) {
		const text = Buffer.from(data, "base64url").toString("utf8");
		return part.mimeType === "text/html" ? strip(text) : text;
	}
	const parts = part.parts ?? [];
	const plain = parts.find((one) => one.mimeType === "text/plain");
	if (plain !== undefined) return bodyOf(plain);
	const html = parts.find((one) => one.mimeType === "text/html");
	if (html !== undefined) return bodyOf(html);
	for (const one of parts) {
		const found = bodyOf(one);
		if (found.length > 0) return found;
	}
	return "";
}

function strip(html) {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** How much of one message comes back. Past this it is a file, and a file is not what was asked. */
const MOST_BODY = 16_000;

const TOOLS = [
	{
		name: "gmail_search",
		description:
			"Searches the mailbox and answers with one line per message: its id, who it is from, when, and its subject. Takes Gmail's own search syntax — from:, subject:, has:attachment, newer_than:7d, is:unread, in:anywhere.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Gmail search, e.g. from:nico newer_than:7d" },
				limit: { type: "number", description: "How many, at most 25. Ten by default." },
			},
			required: ["query"],
		},
	},
	{
		name: "gmail_read",
		description:
			"Reads one message whole: its headers and its text. Takes an id from gmail_search.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "The message id" } },
			required: ["id"],
		},
	},
];

async function search({ query, limit }) {
	const many = Math.min(Math.max(Number(limit) || 10, 1), 25);
	const found = await ask(
		`/messages?q=${encodeURIComponent(String(query ?? ""))}&maxResults=${many}`,
	);
	const messages = found.messages ?? [];
	if (messages.length === 0) return said(`Nothing in the mailbox matches ${query}.`);

	// One request per message, because the list gives ids and nothing else. Sequential on purpose:
	// twenty-five at once is a burst at somebody's quota to save a second nobody is counting.
	const lines = [];
	for (const one of messages) {
		const message = await ask(
			`/messages/${one.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
		);
		lines.push(
			[
				one.id,
				header(message, "date"),
				header(message, "from"),
				header(message, "subject") || "(no subject)",
			].join("  ·  "),
		);
	}
	return said(lines.join("\n"));
}

async function read({ id }) {
	const message = await ask(`/messages/${encodeURIComponent(String(id ?? ""))}?format=full`);
	const body = bodyOf(message.payload);
	return said(
		[
			`From: ${header(message, "from")}`,
			`To: ${header(message, "to")}`,
			`Date: ${header(message, "date")}`,
			`Subject: ${header(message, "subject")}`,
			"",
			body.length > MOST_BODY ? `${body.slice(0, MOST_BODY)}\n\n[…]` : body,
		].join("\n"),
	);
}

/** The protocol, which is three messages long for a server that only answers. */
async function answer(request) {
	if (request.method === "initialize") {
		return {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "gmail", version: "1.0.0" },
		};
	}
	if (request.method === "tools/list") return { tools: TOOLS };
	if (request.method === "tools/call") {
		const { name, arguments: args = {} } = request.params ?? {};
		try {
			if (name === "gmail_search") return await search(args);
			if (name === "gmail_read") return await read(args);
			return refuse(`There is no tool called ${name}.`);
		} catch (error) {
			return refuse(error.message);
		}
	}
	return undefined;
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	if (line.trim().length === 0) continue;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		continue;
	}
	const result = await answer(request);
	// A notification has no id and wants no answer; anything else gets one, even if it is a refusal.
	if (request.id === undefined || result === undefined) continue;
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
