import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, type ReactElement, useCallback, useEffect, useState } from "react";
import wrapAnsi from "wrap-ansi";
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

/** The three rows the prompt occupies now that it is in a box: its two borders and its line. */
const PROMPT_ROWS = 3;

const ESC = "\u001b";

/** What one notch of a wheel moves. Three is what a terminal scrolls, so it is what a hand expects. */
const WHEEL_ROWS = 3;

/**
 * Asks the terminal to report the wheel, and to report it in the encoding that still works past the
 * 223rd column.
 *
 * This is the price of drawing a screen the terminal did not draw. Its own scrollback holds the
 * frames this printed, not the conversation, so a wheel it handles itself scrolls away from a live
 * console into pictures of an older one — and the keys that would have done it instead, shift with
 * the arrows and the page keys, are taken by the terminal for exactly that before they are ours.
 */
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";

/**
 * Braille, because it turns in place: every frame is one column wide, so the line beside it does
 * not move while it spins.
 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** What each mark means, said in colour as well as in shape, for whoever is scanning rather than reading. */
const MARKS = {
	busy: { glyph: "◐", color: "yellow" },
	running: { glyph: "●", color: "green" },
	stopped: { glyph: "○", color: "gray" },
} as const;

/** Where a turn has got to, and how long it has been getting there. */
export interface Thinking {
	readonly frame: string;
	readonly seconds: number;
}

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
		// Between turns rather than after each: a trailing blank costs the pane a row, and the row it
		// costs is the oldest line of the conversation, given up to hold a gap nobody is reading.
		if (lines.length > 0) lines.push("");
		const body = said.from === "operator" ? `\u001b[36m> ${said.text}\u001b[39m` : said.text;
		lines.push(...body.split("\n"));
	}
	return lines;
}

/**
 * A conversation as the rows it will actually occupy.
 *
 * This has to happen before anything is counted. A paragraph is one line as written and many as
 * drawn, and a pane that keeps the last twenty lines of a conversation is keeping far more than
 * twenty rows of screen — which it then draws past its own border, over the pane beside it and
 * off the bottom of the terminal.
 *
 * `hard` breaks a word with nowhere to break, which is a path or a URL. Untrimmed, because the
 * indentation of a bullet or a fenced block is what makes it read as one.
 */
function wrapped(lines: readonly string[], columns: number): readonly string[] {
	if (columns <= 0) return [];
	const rows: string[] = [];
	for (const line of lines) {
		if (line === "") rows.push("");
		else rows.push(...wrapAnsi(line, columns, { hard: true, trim: false }).split("\n"));
	}
	return rows;
}

/**
 * The rows a pane draws: the last ones that fit, or the ones from `top` once it has been scrolled
 * back. A pane has a bottom and a conversation does not, so something always has to be left out.
 *
 * Where it is scrolled to is a line, not a distance from the end, and that is the whole difference
 * between scrolling that works and scrolling that does not: a feed keeps arriving while it is being
 * read, and measured from the end the paragraph worth stopping on would slide up out of the pane at
 * exactly the rate that made it worth stopping on.
 */
export function visible(
	lines: readonly string[],
	rows: number,
	top: number | undefined,
): readonly string[] {
	if (rows <= 0) return [];
	// Never past the last page: scrolling down arrives at the end of the feed rather than below it.
	const last = Math.max(0, lines.length - rows);
	if (top === undefined) return lines.slice(last);
	const from = Math.min(Math.max(0, top), last);
	return lines.slice(from, from + rows);
}

/** The rows a chat pane of this height has for the conversation, once the prompt has taken its own. */
export function chatRows(rows: number): number {
	return Math.max(0, rows - (rows > PROMPT_ROWS ? PROMPT_ROWS : 1));
}

/**
 * Where a pane is scrolled to once it has been moved `by` rows, or nothing at all when that is its
 * end.
 *
 * Nothing rather than the number of the last row, because the two stop meaning the same thing one
 * line later: a pane at its end follows whatever arrives after it, and a pane parked on the row that
 * happens to be last right now stops dead as soon as there is a row after it.
 */
export function scrolled(
	top: number | undefined,
	by: number,
	pane: { readonly total: number; readonly height: number },
): number | undefined {
	const last = Math.max(0, pane.total - pane.height);
	// Held at the first row before it is compared with the last, so that a pane whose content fits is
	// at its end already and never reports having been scrolled away from it.
	const next = Math.max(0, (top ?? last) + by);
	return next >= last ? undefined : next;
}

/**
 * The rows a chunk of mouse reporting asks a pane to move, negative for back through what it has
 * already shown — and nothing at all if the chunk is not the mouse, which is how the caller knows
 * to hand it on.
 *
 * Reported as `ESC [ < button ; column ; row M`, where the wheel is buttons 64 and 65. A click is
 * every other button and asks for no movement, but it is still the mouse and still has to be
 * answered here: once the terminal has been asked to report it, a click nobody claims is an escape
 * sequence typed into the prompt. Movement is counted rather than switched on, because one flick of
 * a trackpad arrives as several reports in a single chunk.
 */
export function mouse(input: string): number | undefined {
	let reported = false;
	let by = 0;
	for (const piece of input.split(ESC)) {
		const button = /^\[<(\d+);\d+;\d+[Mm]/.exec(piece)?.[1];
		if (button === undefined) continue;
		reported = true;
		if (button === "64") by -= WHEEL_ROWS;
		else if (button === "65") by += WHEEL_ROWS;
	}
	return reported ? by : undefined;
}

export function Agents({
	agents,
	cursor,
	busy,
	rows,
}: {
	readonly agents: readonly AgentSummary[];
	readonly cursor: number;
	/** Each agent mid-turn, against when its turn started. The column only asks whether. */
	readonly busy: ReadonlyMap<string, number>;
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
			borderColor: "gray",
			paddingX: 1,
		},
		h(Text, { dimColor: true, key: "title" }, "agents"),
		...agents.slice(0, rows).map((agent, index) => {
			// Thinking is worth a different mark from merely being up: with several agents on screen it
			// is the one thing you cannot find out by asking again in a second.
			const mark = busy.has(agent.id) ? MARKS.busy : agent.running ? MARKS.running : MARKS.stopped;
			const here = index === cursor;
			return h(
				Text,
				{ key: agent.id, wrap: "truncate" },
				// A pointer rather than a reversed row: the marks are the colour in this column, and a
				// highlight behind them takes it away exactly where it is being read.
				h(Text, { color: "cyan", bold: true }, here ? "▸ " : "  "),
				h(Text, { color: mark.color }, mark.glyph),
				h(Text, { bold: here, dimColor: !here && !agent.running }, ` ${agent.id}`),
			);
		}),
	);
}

export function Chat({
	history,
	draft,
	rows,
	columns,
	thinking,
	top,
}: {
	readonly history: readonly Said[];
	readonly draft: string;
	readonly rows: number;
	readonly columns: number;
	readonly thinking: Thinking | undefined;
	/** The first row of conversation to show, or the end of it when nothing has been scrolled back to. */
	readonly top: number | undefined;
}): ReactElement {
	// The box around the prompt costs two rows. A pane with no room for them keeps the prompt and
	// gives up the border, because a border drawn where there is no room is the broken screen again.
	const boxed = rows > PROMPT_ROWS;
	const lines = visible(wrapped(transcript(history), columns), chatRows(rows), top);
	// A spinner alone says something is happening; the number rising beside it is what separates
	// slow from stuck, and twice now the thing that looked slow was a hang.
	const mark = thinking === undefined ? "> " : `${thinking.frame} ${thinking.seconds}s `;
	// The prompt is one row and stays one row: what is worth seeing of a line still being typed is
	// its end, where the cursor is. The box takes its border and padding out of the width first.
	const room = Math.max(0, columns - (boxed ? 4 : 0) - mark.length - 1);
	const hue = thinking === undefined ? "cyan" : "yellow";
	return h(
		Box,
		{ flexDirection: "column", flexGrow: 1 },
		h(
			Box,
			// Resting on the prompt rather than hanging from the top: an answer arrives where the next
			// question is being typed, instead of at the far end of a pane of blank rows.
			{ flexDirection: "column", flexGrow: 1, justifyContent: "flex-end", key: "said" },
			// Already the width of the pane, so Ink is told not to measure them again — a row it
			// decided to wrap is a row this one did not budget for.
			...lines.map((line, index) =>
				h(Text, { key: `${index}`, wrap: "truncate" }, line === "" ? " " : line),
			),
		),
		h(
			Box,
			boxed
				? { key: "prompt", borderStyle: "round", borderColor: hue, paddingX: 1 }
				: { key: "prompt" },
			h(
				Text,
				{ wrap: "truncate" },
				h(Text, { color: hue }, mark),
				draft.slice(Math.max(0, draft.length - room)),
				h(Text, { inverse: true }, " "),
			),
		),
	);
}

function Logs({
	lines,
	rows,
	top,
}: {
	readonly lines: readonly string[];
	readonly rows: number;
	readonly top: number | undefined;
}): ReactElement {
	return h(
		Box,
		// The newest line against the bottom edge, which is where a feed being watched is read.
		{ flexDirection: "column", flexGrow: 1, justifyContent: "flex-end" },
		...visible(lines, rows, top).map((line, index) =>
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
	// When each turn started, rather than merely that one did: the elapsed seconds come from here.
	const [busy, setBusy] = useState<ReadonlyMap<string, number>>(new Map());
	const [frame, setFrame] = useState(0);
	// The row the panel has been scrolled back to, or nothing at all while it is following the end.
	const [top, setTop] = useState<number | undefined>(undefined);

	const selected = agents[Math.min(cursor, agents.length - 1)];
	const said = selected === undefined ? [] : saidBy(talk, selected.id);

	// Two borders, the title row and the footer are the rows the panel does not get; its own border
	// and padding are the columns. What is left is what the chat has to wrap itself into, and it has
	// to know: nothing downstream can put a paragraph back once it has been drawn too wide.
	const body = Math.max(1, rows - 4);
	const width = Math.max(1, columns - AGENTS_WIDTH - 4);

	// Scrolled back is a place in one conversation or one feed, and it does not survive being pointed
	// at another: arriving in the middle of something nobody asked for is disorienting. Dropped during
	// the render that changes what is being shown rather than in an effect, which would draw the old
	// place once before correcting it.
	const showing = `${panel}:${selected?.id ?? ""}`;
	const [shown, setShown] = useState(showing);
	if (shown !== showing) {
		setShown(showing);
		setTop(undefined);
	}

	// Once, for the life of the console: the plane streams until the socket closes, and asking twice
	// would double every line.
	useEffect(() => {
		const feed = new LogFeed(
			(line) => setLines((prev) => [...prev, line.replace(/\n$/, "")].slice(-REMEMBERED_LINES)),
			{ color: true },
		);
		client.logs((event) => feed.push(event));
	}, [client]);

	// Only while something is thinking. A console redrawing ten times a second at rest is one that
	// keeps a laptop awake for nothing.
	useEffect(() => {
		if (busy.size === 0) return;
		const timer = setInterval(() => setFrame((n) => n + 1), 100);
		return () => clearInterval(timer);
	}, [busy.size]);

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
			setBusy((prev) => new Map(prev).set(agentId, Date.now()));

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
					const next = new Map(prev);
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
		// Measured on the keystroke rather than kept in state: the conversation is re-wrapped as it
		// arrives and the feed grows between one key and the next, so a page is only ever a page now.
		const scroll = (by: number, pages: number): void => {
			const height = panel === "logs" ? body - 1 : chatRows(body - 1);
			const total = panel === "logs" ? lines.length : wrapped(transcript(said), width).length;
			setTop((prev) => scrolled(prev, by + Math.round(pages * height), { total, height }));
		};

		// First, and before anything looks at the key: a mouse report is an escape sequence, and every
		// branch below this one would take it for either a keystroke or something to type.
		const rolled = mouse(input);
		if (rolled !== undefined) {
			if (rolled !== 0) scroll(rolled, 0);
			return;
		}
		// Half a pane at a time, from less and from vim. Chords, because every unmodified key that
		// would have meant this — shift with an arrow, the page keys — is one the terminal keeps for
		// scrolling its own scrollback and never delivers.
		if (key.ctrl && (input === "u" || input === "d")) {
			scroll(0, input === "u" ? -0.5 : 0.5);
			return;
		}
		if (key.pageUp) {
			scroll(0, -1);
			return;
		}
		if (key.pageDown) {
			scroll(0, 1);
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
			const text = line.trim();
			setDraft("");
			// Asking something is asking to see the answer, so a conversation being read back through
			// returns to its end rather than leaving the answer to arrive out of sight.
			setTop(undefined);
			// Deliberately not awaited: the turn runs while the console keeps taking keys, which is what
			// lets an agent be asked something and another one be watched while it thinks.
			if (text.length > 0) void ask(selected.id, text);
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

	const title = selected === undefined ? "no agents" : selected.id;
	const started = selected === undefined ? undefined : busy.get(selected.id);
	const thinking: Thinking | undefined =
		started === undefined
			? undefined
			: {
					frame: SPINNER[frame % SPINNER.length] ?? SPINNER[0],
					seconds: Math.floor((Date.now() - started) / 1000),
				};

	return h(
		Box,
		{ flexDirection: "column", width: columns, height: rows },
		h(
			Box,
			{ flexDirection: "row", flexGrow: 1, key: "panes" },
			h(Agents, { agents, cursor, busy, rows: body, key: "agents" }),
			h(
				Box,
				{
					flexDirection: "column",
					flexGrow: 1,
					borderStyle: "round",
					borderColor: "gray",
					paddingX: 1,
					key: "panel",
				},
				h(
					Box,
					{ flexDirection: "row", key: "tabs" },
					h(Text, { bold: true, color: "cyan" }, title),
					h(Text, null, "   "),
					h(Text, { bold: panel === "chat", dimColor: panel !== "chat" }, "chat"),
					h(Text, { dimColor: true }, " · "),
					h(Text, { bold: panel === "logs", dimColor: panel !== "logs" }, "logs"),
					// What a pane showing the end of things cannot say for itself: that this one is not.
					// Without it, an answer arriving out of sight looks like an agent that said nothing.
					top === undefined ? null : h(Text, { color: "yellow" }, "   ↑ scrolled"),
				),
				panel === "chat"
					? h(Chat, {
							history: said,
							draft,
							rows: body - 1,
							columns: width,
							thinking,
							top,
							key: "chat",
						})
					: h(Logs, { lines, rows: body - 1, top, key: "logs" }),
			),
		),
		h(
			Box,
			{ flexDirection: "row", key: "hint" },
			h(Text, null, " "),
			// The key stands out from what it does, because the key is the part being looked for.
			...[
				["↑↓", "agent"],
				["^U^D", "scroll"],
				["tab", panel === "chat" ? "logs" : "chat"],
				["^C", "quit"],
			].flatMap(([stroke, does], index) => [
				h(Text, { color: "cyan", key: `stroke${index}` }, stroke),
				h(Text, { dimColor: true, key: `does${index}` }, ` ${does}   `),
			]),
		),
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
	process.stdout.write(MOUSE_ON);
	try {
		const app = render(h(App, { client, initial }), { exitOnCtrlC: false });
		await app.waitUntilExit();
	} finally {
		// Whatever happened. A terminal left reporting its mouse prints an escape sequence at whoever
		// clicks in it next, and they will be at a shell prompt with no idea what did that to them.
		process.stdout.write(MOUSE_OFF);
	}
	return 0;
}
