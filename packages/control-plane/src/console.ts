import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, type ReactElement, useCallback, useEffect, useState } from "react";
import type { ControlClient } from "./control-client.ts";
import type { AgentSummary } from "./control-plane.ts";
import { LogFeed } from "./feed.ts";
import { MarkdownStream } from "./markdown.ts";

/**
 * Written with `createElement` rather than JSX, which is not a style choice.
 *
 * Node runs this repository's TypeScript as it is, with no build step, and its type stripping does
 * not transform JSX — a `.tsx` file here is a syntax error at startup. Ink never needed JSX; it is
 * React, and this is what React looked like before it.
 */

/** How much of the feed is worth keeping. Older than this and it has scrolled out of anyone's day. */
const REMEMBERED_LINES = 2000;

const AGENTS_WIDTH = 18;

export interface Said {
	readonly from: "operator" | "agent";
	readonly text: string;
}

type Panel = "chat" | "logs";

export type Talk = ReadonlyMap<string, readonly Said[]>;

export function saidBy(talk: Talk, agentId: string): readonly Said[] {
	return talk.get(agentId) ?? [];
}

export function append(talk: Talk, agentId: string, said: Said): Talk {
	return new Map(talk).set(agentId, [...saidBy(talk, agentId), said]);
}

/** Adds to the last thing an agent was saying, which is how an answer arrives: in pieces. */
export function extend(talk: Talk, agentId: string, chunk: string): Talk {
	const history = saidBy(talk, agentId);
	const last = history[history.length - 1];
	if (last === undefined) return talk;
	return new Map(talk).set(agentId, [
		...history.slice(0, -1),
		{ from: last.from, text: last.text + chunk },
	]);
}

/**
 * A conversation as the lines it occupies, most recent last.
 *
 * The agent's own text is already rendered markdown carrying its ANSI, so it is passed through
 * untouched; only what the operator typed is marked, and it is marked here rather than stored that
 * way so the transcript stays the words and not the decoration.
 */
export function transcript(history: readonly Said[]): readonly string[] {
	const lines: string[] = [];
	for (const said of history) {
		const body = said.from === "operator" ? `\u001b[36m> ${said.text}\u001b[39m` : said.text;
		lines.push(...body.split("\n"));
		lines.push("");
	}
	return lines;
}

/**
 * The last lines that fit, because a terminal pane has a bottom and a conversation does not.
 *
 * Counted in lines as written rather than as displayed, so a paragraph wider than the pane takes
 * more room than it is given here and pushes an older line off the top. That is the cheap end of
 * the trade: the alternative is measuring wrapped width on every keystroke.
 */
export function tail(lines: readonly string[], rows: number): readonly string[] {
	return rows <= 0 ? [] : lines.slice(-rows);
}

export function Agents({
	agents,
	cursor,
	busy,
	rows,
}: {
	readonly agents: readonly AgentSummary[];
	readonly cursor: number;
	readonly busy: ReadonlySet<string>;
	readonly rows: number;
}): ReactElement {
	return h(
		Box,
		{
			flexDirection: "column",
			width: AGENTS_WIDTH,
			// A width is what a box asks for, not what it keeps: flex shrinks it below that when a
			// sibling's content will not fit. A long line of chat was enough, so the column narrowed
			// while an answer streamed and widened again when the next one was shorter.
			flexShrink: 0,
			borderStyle: "round",
			paddingX: 1,
		},
		h(Text, { dimColor: true, key: "title" }, "agents"),
		...agents.slice(0, rows).map((agent, index) =>
			h(
				Text,
				{ key: agent.id, inverse: index === cursor, wrap: "truncate" },
				// Thinking is worth a different mark from merely being up: with several agents on screen
				// it is the one thing you cannot find out by asking again in a second.
				`${busy.has(agent.id) ? "◐" : agent.running ? "●" : "○"} ${agent.id}`,
			),
		),
	);
}

export function Chat({
	history,
	draft,
	rows,
	thinking,
}: {
	readonly history: readonly Said[];
	readonly draft: string;
	readonly rows: number;
	readonly thinking: boolean;
}): ReactElement {
	// One line for the prompt, and one for the room the prompt needs above it.
	const lines = tail(transcript(history), rows - 1);
	return h(
		Box,
		{ flexDirection: "column", flexGrow: 1 },
		h(
			Box,
			{ flexDirection: "column", flexGrow: 1, key: "said" },
			...lines.map((line, index) => h(Text, { key: `${index}` }, line === "" ? " " : line)),
		),
		h(
			Text,
			{ key: "prompt" },
			thinking ? h(Text, { dimColor: true }, "… ") : h(Text, { color: "cyan" }, "> "),
			draft,
			h(Text, { inverse: true }, " "),
		),
	);
}

function Logs({
	lines,
	rows,
}: {
	readonly lines: readonly string[];
	readonly rows: number;
}): ReactElement {
	return h(
		Box,
		{ flexDirection: "column", flexGrow: 1 },
		...tail(lines, rows).map((line, index) =>
			h(Text, { key: `${index}`, wrap: "truncate" }, line === "" ? " " : line),
		),
	);
}

function App({
	client,
	initial,
}: {
	readonly client: ControlClient;
	readonly initial: readonly AgentSummary[];
}): ReactElement {
	const { exit } = useApp();
	const { rows, columns } = useWindowSize();
	const [agents, setAgents] = useState<readonly AgentSummary[]>(initial);
	const [cursor, setCursor] = useState(0);
	const [panel, setPanel] = useState<Panel>("chat");
	const [lines, setLines] = useState<readonly string[]>([]);
	const [talk, setTalk] = useState<Talk>(new Map());
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

	const selected = agents[Math.min(cursor, agents.length - 1)];

	// Once, for the life of the console: the plane streams until the socket closes, and asking twice
	// would double every line.
	useEffect(() => {
		const feed = new LogFeed((line) =>
			setLines((prev) => [...prev, line.replace(/\n$/, "")].slice(-REMEMBERED_LINES)),
		);
		client.logs((event) => feed.push(event));
	}, [client]);

	// An agent can be created, stop or be replaced by something other than this console — the plane
	// answers webhooks and schedules while nobody is watching — so the list is asked for, not derived.
	useEffect(() => {
		const timer = setInterval(() => {
			client
				.agents()
				.then(setAgents)
				.catch(() => {});
		}, 2000);
		return () => clearInterval(timer);
	}, [client]);

	const ask = useCallback(
		async (agentId: string, body: string): Promise<void> => {
			setTalk((prev) =>
				append(append(prev, agentId, { from: "operator", text: body }), agentId, {
					from: "agent",
					text: "",
				}),
			);
			setBusy((prev) => new Set(prev).add(agentId));

			let streamed = false;
			const out = new MarkdownStream({
				write: (chunk) => setTalk((prev) => extend(prev, agentId, chunk)),
				color: true,
			});
			try {
				const text = await client.wake(agentId, body, (delta) => {
					streamed = true;
					out.push(delta);
				});
				// A plane that answered without streaming still has an answer to show, and so does one
				// whose turn produced its text only at the end.
				if (!streamed && text.length > 0) out.push(text);
				if (!streamed && text.length === 0) out.push("_(nothing)_");
			} catch (error) {
				// A turn that failed is not a conversation that ended. The session is still there and the
				// next line is a new turn, so this is said in place and nothing is torn down.
				out.push(`\n\u001b[31m${(error as Error).message}\u001b[39m`);
			} finally {
				out.end();
				setBusy((prev) => {
					const next = new Set(prev);
					next.delete(agentId);
					return next;
				});
			}
		},
		[client],
	);

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			exit();
			return;
		}
		if (key.tab) {
			setPanel((prev) => (prev === "chat" ? "logs" : "chat"));
			return;
		}
		if (key.upArrow) {
			setCursor((prev) => Math.max(0, prev - 1));
			return;
		}
		if (key.downArrow) {
			setCursor((prev) => Math.min(agents.length - 1, prev + 1));
			return;
		}
		if (panel !== "chat" || selected === undefined) return;

		const send = (line: string): void => {
			const body = line.trim();
			setDraft("");
			// Deliberately not awaited: the turn runs while the console keeps taking keys, which is what
			// lets an agent be asked something and another one be watched while it thinks.
			if (body.length > 0) void ask(selected.id, body);
		};

		if (key.return) {
			send(draft);
			return;
		}
		if (key.backspace || key.delete) {
			setDraft((prev) => prev.slice(0, -1));
			return;
		}
		// Ctrl and meta chords are commands this does not have yet, not text. Without this an unhandled
		// one types its letter into the line.
		if (input.length === 0 || key.ctrl || key.meta) return;

		// A chunk can arrive carrying a whole line, from a paste or from a terminal that batched the
		// keystrokes. The return inside it is what ends the line then, and is never reported as the
		// key: without this, pasting a line types it and leaves it sitting there unsent.
		const [first = "", ...rest] = input.split(/\r|\n/);
		if (rest.length === 0) {
			setDraft((prev) => prev + first);
			return;
		}
		send(draft + first);
		setDraft(rest.join(" ").trim());
	});

	// Two borders, the title row and the footer are the rows the panel does not get.
	const body = Math.max(1, rows - 4);
	const title = selected === undefined ? "no agents" : selected.id;
	const hint = panel === "chat" ? "↑↓ agent   tab logs   ^C quit" : "↑↓ agent   tab chat   ^C quit";

	return h(
		Box,
		{ flexDirection: "column", width: columns, height: rows },
		h(
			Box,
			{ flexDirection: "row", flexGrow: 1, key: "panes" },
			h(Agents, { agents, cursor, busy, rows: body, key: "agents" }),
			h(
				Box,
				{ flexDirection: "column", flexGrow: 1, borderStyle: "round", paddingX: 1, key: "panel" },
				h(
					Box,
					{ flexDirection: "row", key: "tabs" },
					h(Text, { bold: true }, title),
					h(Text, { dimColor: true }, "   "),
					h(Text, { underline: panel === "chat", dimColor: panel !== "chat" }, "chat"),
					h(Text, { dimColor: true }, " · "),
					h(Text, { underline: panel === "logs", dimColor: panel !== "logs" }, "logs"),
				),
				panel === "chat"
					? h(Chat, {
							history: selected === undefined ? [] : saidBy(talk, selected.id),
							draft,
							rows: body - 1,
							thinking: selected !== undefined && busy.has(selected.id),
							key: "chat",
						})
					: h(Logs, { lines, rows: body - 1, key: "logs" }),
			),
		),
		h(Text, { dimColor: true, key: "hint" }, ` ${hint}`),
	);
}

/**
 * The console, which is what `agent` on its own opens.
 *
 * It holds the one connection for everything: the feed streams on it while turns are taken on it,
 * which the protocol already allows because every request carries an id. That matters more than it
 * looks — the socket is what carries operator trust, so one connection is also one thing to reason
 * about when asking who is allowed to say this.
 */
export async function openConsole(client: ControlClient): Promise<number> {
	const initial = await client.agents();
	const app = render(h(App, { client, initial }), { exitOnCtrlC: false });
	await app.waitUntilExit();
	return 0;
}
