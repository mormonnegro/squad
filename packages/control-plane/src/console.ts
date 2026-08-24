import { dirname } from "node:path";
import { SANDBOX_REPO_PATH } from "@agent-dive/agent-repo";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, type ReactElement, useCallback, useEffect, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { type Command, completions, isCommand, isShell, money } from "./commands.ts";
import type { ControlClient } from "./control-client.ts";
import type { AgentSummary } from "./control-plane.ts";
import { LogFeed } from "./feed.ts";
import { MarkdownStream } from "./markdown.ts";
import { openInBrowser } from "./oauth-login.ts";
import type { AgentStep } from "./pi-output.ts";
import type { Utterance } from "./transcript.ts";

/**
 * Written with `createElement` rather than JSX, which is not a style choice.
 *
 * Node runs this repository's TypeScript as it is, with no build step, and its type stripping does
 * not transform JSX — a `.tsx` file here is a syntax error at startup. Ink never needed JSX; it is
 * React, and this is what React looked like before it.
 */

/** How much of the feed is worth keeping. Older than this and it has scrolled out of anyone's day. */
const REMEMBERED_LINES = 2000;

/**
 * Wide enough for a name and what the name is costing.
 *
 * Four columns of it are the border and the padding, four more the pointer and the mark, so at 18
 * a name of any length at all left no room for the money and `support-emma` was itself cut short.
 */
const AGENTS_WIDTH = 22;

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
	/** The last thing the agent did, for the one line beside the clock. */
	readonly step?: string;
}

/** The least a prompt may be narrowed to before what is beside it starts giving way instead. */
const DRAFT_ROOM = 20;

/**
 * A step as the one line beside the clock says it: what it is, and what it is on.
 *
 * Only the first line, because a step's detail is a whole shell command or a diff and the prompt row
 * is one row. The rest of it is in the feed, which is where a thing is read after it has happened.
 */
export function doing(step: AgentStep): string {
	const first = step.detail.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
	return first === "" ? step.action : `${step.action} ${first}`;
}

/** Cut to fit, with a mark to say it was cut. Nothing at all when there is no room to say anything. */
function clipped(text: string, room: number): string {
	if (room < 2) return "";
	return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

export interface Said {
	readonly from: Utterance["from"];
	/** Ready to draw: an agent's markdown has already become whatever the terminal shows of it. */
	readonly text: string;
	readonly tone?: Utterance["tone"];
	readonly via?: string;
}

/** Markdown as the terminal will have it, for a line that arrives whole rather than in pieces. */
export function painted(text: string): string {
	let out = "";
	const stream = new MarkdownStream({
		write: (chunk) => {
			out += chunk;
		},
		color: true,
	});
	stream.push(text);
	stream.end();
	return out;
}

/**
 * A line of the transcript as this console will draw it.
 *
 * Rendered on the way in rather than on the way out, because the way out happens on every keystroke
 * and every frame of a spinner, and a conversation is re-wrapped whole each time.
 */
export function shown(said: Utterance): Said {
	return {
		from: said.from,
		text: said.from === "agent" ? painted(said.text) : said.text,
		...(said.tone !== undefined ? { tone: said.tone } : {}),
		...(said.via !== undefined ? { via: said.via } : {}),
	};
}

type Panel = "chat" | "logs";

export type Talk = ReadonlyMap<string, readonly Said[]>;

export function saidBy(talk: Talk, agentId: string): readonly Said[] {
	return talk.get(agentId) ?? [];
}

export function append(talk: Talk, agentId: string, said: Said): Talk {
	return new Map(talk).set(agentId, [...saidBy(talk, agentId), said]);
}

function without<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
	const next = new Map(map);
	next.delete(key);
	return next;
}

/**
 * One line of conversation, marked for whoever is saying it.
 *
 * Everything that is neither the operator nor the agent answering is named for where it came from,
 * and that naming is the point: a webhook body and the person at the keyboard both arrive as text
 * addressed to the agent, and a pane that drew them alike is one you cannot read back through to
 * find out who asked for what. The agent's own text is already ANSI by here, so it passes through.
 */
function spoken(said: Said): string {
	// The operator's line, but not one addressed to the agent: it keeps the mark it was typed under,
	// the bang it starts with, in the colour the prompt had while it was typed. Read back later, a
	// `> !ls` looks like the agent was asked to run something, and the agent was never told at all.
	// The bang sits off the command the way `> ` sits off a message, so both marks are a mark.
	if (said.from === "operator" && isShell(said.text)) {
		return `${ESC}[35m! ${said.text.slice(1).trimStart()}${ESC}[39m`;
	}
	// Red was the plane's whole voice, and the plane mostly answers questions: a list of MCP servers,
	// an account, what a command just did. A screen of red says everything is on fire, which is how
	// nothing on it gets read as being on fire — so red is kept for bad news, green says a thing
	// worked, and an answer is left the colour of the terminal the question was typed into.
	if (said.from === "plane") {
		if (said.tone === undefined) return said.text;
		return `${ESC}[${said.tone === "good" ? 32 : 31}m${said.text}${ESC}[39m`;
	}
	if (said.via !== undefined) return `\u001b[2m‹${said.via}›\u001b[22m ${said.text}`;
	if (said.from === "operator") return `\u001b[36m> ${said.text}\u001b[39m`;
	return said.text;
}

/** The agent's home, which is the directory its repository sits in. */
const HOME = dirname(SANDBOX_REPO_PATH);

/**
 * A directory as a prompt says it: short enough to leave room for the line being typed.
 *
 * The home becomes `~` and the front of a long path is what goes, because the end of it is where
 * you are and the front is the part you already know.
 */
export function here(cwd: string, room = 24): string {
	const short = cwd === HOME || cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd;
	return short.length <= room ? short : `…${short.slice(short.length - room + 1)}`;
}

/**
 * A conversation as the lines it occupies, most recent last.
 *
 * Marked here rather than stored marked, so the transcript stays the words and not the decoration.
 */
export function transcript(history: readonly Said[]): readonly string[] {
	const lines: string[] = [];
	for (const [index, said] of history.entries()) {
		// What a command printed is not a turn of its own: it belongs to the bang above it the way it
		// does in a terminal, and a blank between them reads as two things that happened separately.
		const printed = said.from === "shell" && history[index - 1]?.from === "operator";
		// Between turns rather than after each: a trailing blank costs the pane a row, and the row it
		// costs is the oldest line of the conversation, given up to hold a gap nobody is reading.
		if (lines.length > 0 && !printed) lines.push("");
		lines.push(...spoken(said).split("\n"));
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
 * `hard` breaks a word with nowhere to break, which is a path or a URL. A conversation is left
 * untrimmed, because the indentation of a bullet or a fenced block is what makes it read as one —
 * and prose is trimmed, because there the space a line was broken at starts the next one instead.
 */
function wrapped(lines: readonly string[], columns: number, trim = false): readonly string[] {
	if (columns <= 0) return [];
	const rows: string[] = [];
	for (const line of lines) {
		if (line === "") rows.push("");
		else rows.push(...wrapAnsi(line, columns, { hard: true, trim }).split("\n"));
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

/**
 * How long until an instant, in the coarsest unit that still says it.
 *
 * A wakeup an hour out is not more useful for being told to the second, and the column it goes in is
 * fourteen characters wide once the border, the pointer and the name have taken theirs.
 */
export function until(iso: string, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * What the title row says about the selected agent besides its name, in the room the tabs left it.
 *
 * Widest first, and dropped from the left as the terminal narrows: the money is what an operator
 * comes back to the screen for, and the model is what explains it, so the model is what goes when
 * only one of them fits. Nothing is truncated to a stump — a `deepseek-v4-fl…` is a fact half said,
 * and a row that says less is easier to read than a row that says everything badly.
 */
export function standing(
	agent: AgentSummary,
	room: number,
): { readonly model: string; readonly spend: string } {
	const spent = money(agent.spentUsd);
	const spend = agent.limitUsd === undefined ? spent : `${spent} / ${money(agent.limitUsd)}`;
	const model = agent.model ?? "";
	if (model !== "" && model.length + 3 + spend.length <= room) return { model, spend };
	if (spend.length <= room) return { model: "", spend };
	// The ceiling is the first thing to go: what was spent is a fact, and what it was allowed to be
	// is a second fact about the first one, worth less than half of the room it takes to say both.
	return { model: "", spend: spent.length <= room ? spent : "" };
}

/**
 * How much of what an agent has spent it is allowed to, as a number to colour by.
 *
 * `undefined` where there is no ceiling, which is not the same as nothing spent: an agent spending
 * against no limit is the one this cannot warn about, and painting it green would be a lie.
 */
function against(agent: AgentSummary): number | undefined {
	if (agent.limitUsd === undefined || agent.limitUsd <= 0) return undefined;
	return agent.spentUsd / agent.limitUsd;
}

/**
 * How a spend is painted, which is only ever a warning about the ceiling it is walking into.
 *
 * Dim until it is worth reading, because a number that is always coloured is a number nobody looks
 * at. An agent with no ceiling is never painted: there is nothing for it to be near.
 */
function burning(agent: AgentSummary): { color?: string; dimColor: boolean } {
	const share = against(agent) ?? 0;
	if (share >= 1) return { color: "red", dimColor: false };
	return share >= 0.8 ? { color: "yellow", dimColor: false } : { dimColor: true };
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
	// The row under the last agent, which the cursor reaches with the same arrow as any other.
	const making = cursor >= agents.length;
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
		...agents.slice(0, Math.max(0, rows - 1)).map((agent, index) => {
			// Thinking is worth a different mark from merely being up: with several agents on screen it
			// is the one thing you cannot find out by asking again in a second.
			const mark = busy.has(agent.id) ? MARKS.busy : agent.running ? MARKS.running : MARKS.stopped;
			const here = index === cursor;
			// What the column has left once its borders, its padding, the pointer, the mark and the name
			// have been paid for. A long enough name leaves none of it, and is itself truncated.
			const room = AGENTS_WIDTH - 4 - (4 + agent.id.length);
			// An agent that booked its own next turn is going to act while nobody is watching. The wait
			// is the only warning of that there is, so it is on the row rather than behind a command,
			// and it is first: the money beside it is ambient, and a column that dropped the warning to
			// keep the ambient thing would be worse than one that said neither.
			const waking = agent.wakeAt !== undefined ? ` ${until(agent.wakeAt)}` : "";
			const wake = waking.length <= room ? waking : "";
			// Nothing spent is drawn as nothing, not as `$0.00`: a fleet of ceros is a column of noise
			// to read past, and what is being looked for here is the row that is not like the others.
			const spending = agent.spentUsd > 0 ? ` ${money(agent.spentUsd)}` : "";
			const spent = spending.length <= room - wake.length ? spending : "";
			return h(
				Text,
				{ key: agent.id, wrap: "truncate" },
				// A pointer rather than a reversed row: the marks are the colour in this column, and a
				// highlight behind them takes it away exactly where it is being read.
				h(Text, { color: "cyan", bold: true }, here ? "▸ " : "  "),
				h(Text, { color: mark.color }, mark.glyph),
				h(Text, { bold: here, dimColor: !here && !agent.running }, ` ${agent.id}`),
				wake === "" ? undefined : h(Text, { color: "yellow", dimColor: true }, wake),
				spent === "" ? undefined : h(Text, burning(agent), spent),
			);
		}),
		// Last, and never given up to make room: making an agent is a row in the list of agents because
		// that is where somebody with none of them is already looking, and where somebody who wants
		// another one looks too. Behind a command it would be a thing only whoever wrote it can find.
		rows <= 0
			? undefined
			: h(
					Text,
					{ key: "+", wrap: "truncate" },
					h(Text, { color: "cyan", bold: true }, making ? "▸ " : "  "),
					// In the column the marks are in, so it reads as one more state a row can be in rather
					// than as a caption that wandered under the list.
					h(Text, { color: "green" }, "+"),
					h(Text, { bold: making, dimColor: !making }, " new agent"),
				),
	);
}

/**
 * What a name is about to buy, said where the name is being typed.
 *
 * The first half is the part worth saying at all: a name is the whole of what a keyboard decides
 * here. What the agent behind it may reach and may spend is the operator's file, and no amount of
 * typing in this box moves it.
 *
 * The rule for the name itself is last because the pane keeps its final lines, the way the chat
 * pane does — so in a short terminal what survives is the sentence the prompt underneath needs.
 */
const MAKING = [
	"A container, a repository of its own and nothing in its memory. What it may reach is this plane's defaults and no more: a keyboard names an agent here, it never grants one.",
	"",
	"A name it will answer to: lowercase, digits and dashes.",
];

/** The pane behind the last row of the column: a name, and what the plane said about the last one. */
export function New({
	draft,
	rows,
	columns,
	making,
	refused,
}: {
	readonly draft: string;
	readonly rows: number;
	readonly columns: number;
	/** The name the plane is building, for as long as it is building it. */
	readonly making:
		| { readonly name: string; readonly frame: string; readonly seconds: number }
		| undefined;
	/** Why the last name was not taken, in the plane's words. */
	readonly refused: string | undefined;
}): ReactElement {
	const boxed = rows > PROMPT_ROWS;
	const said = [
		...MAKING.map((line) => (line === "" ? "" : `${ESC}[2m${line}${ESC}[22m`)),
		...(refused === undefined ? [] : ["", `${ESC}[31m${refused}${ESC}[39m`]),
	];
	const width = columns - (boxed ? 4 : 0);
	const mark = making === undefined ? "+ " : `${making.frame} `;
	// The name is on this row while it is typed and again while it is built. Between the two the
	// prompt it was typed at is gone, and a wait with no name on it cannot be told from the last one.
	const line = making === undefined ? draft : `creating ${making.name}  ${making.seconds}s`;
	const room = Math.max(0, width - mark.length - 1);
	const hue = making === undefined ? "green" : "yellow";
	return h(
		Box,
		{ flexDirection: "column", flexGrow: 1 },
		h(
			Box,
			{ flexDirection: "column", flexGrow: 1, justifyContent: "flex-end", key: "said" },
			...visible(wrapped(said, columns, true), chatRows(rows), undefined).map((row, index) =>
				h(Text, { key: `${index}`, wrap: "truncate" }, row === "" ? " " : row),
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
				line.slice(Math.max(0, line.length - room)),
				// No cursor while the plane is working: there is nothing to type into, and one blinking
				// under a spinner says the box is still taking keys when it is not.
				making === undefined ? h(Text, { inverse: true }, " ") : null,
			),
		),
	);
}

export function Chat({
	history,
	draft,
	rows,
	columns,
	thinking,
	top,
	shell,
	menu,
	pick,
}: {
	readonly history: readonly Said[];
	readonly draft: string;
	readonly rows: number;
	readonly columns: number;
	readonly thinking: Thinking | undefined;
	/** The first row of conversation to show, or the end of it when nothing has been scrolled back to. */
	readonly top: number | undefined;
	/** The directory the next `!` runs in, or nothing at all while the prompt is the agent's. */
	readonly shell: string | undefined;
	/** What the line being typed could still turn out to be, which is empty unless it began with a slash. */
	readonly menu: readonly Command[];
	readonly pick: number;
}): ReactElement {
	// The box around the prompt costs two rows. A pane with no room for them keeps the prompt and
	// gives up the border, because a border drawn where there is no room is the broken screen again.
	const boxed = rows > PROMPT_ROWS;
	// The menu is taken out of the conversation rather than laid over it, and never takes the last
	// row: a pane being dragged to nothing must still be a pane, not a list with nowhere to type.
	const listed = menu.slice(0, Math.max(0, chatRows(rows) - 1));
	const named = listed.map((command) => `${command.name} ${command.takes}`.trimEnd());
	const widest = Math.max(0, ...named.map((name) => name.length));
	const lines = visible(wrapped(transcript(history), columns), chatRows(rows) - listed.length, top);
	// A spinner alone says something is happening; the number rising beside it is what separates slow
	// from stuck, and twice now the thing that looked slow was a hang. The shell prompt is drawn over
	// it rather than under it, because a mode has to be visible while it is on: `!` reaches the box
	// whether or not the agent is thinking, and a line typed at what looked like the agent's prompt
	// would run in the sandbox instead. What is lost is only the spinner — the column on the left
	// says the same thing with `◐`.
	const mark =
		shell !== undefined
			? `! ${here(shell)} `
			: thinking !== undefined
				? `${thinking.frame} ${thinking.seconds}s `
				: "> ";
	// The box takes its border and padding out of the width before anything else is measured.
	const width = columns - (boxed ? 4 : 0);
	// Beside the clock rather than in the conversation: what a turn is doing right now is worth a
	// glance while it is happening and nothing at all afterwards, and the feed already keeps the
	// record. `27s` alone was the difference between slow and stuck; this is the difference between
	// stuck on the model and stuck on a test suite. It gives way to the line being typed rather than
	// the other way round, because the prompt is what a hand is on.
	const doing =
		shell === undefined && thinking?.step !== undefined
			? clipped(thinking.step, width - mark.length - DRAFT_ROOM)
			: "";
	// The prompt is one row and stays one row: what is worth seeing of a line still being typed is
	// its end, where the cursor is.
	const room = Math.max(0, width - mark.length - (doing === "" ? 0 : doing.length + 1) - 1);
	const hue = shell !== undefined ? "magenta" : thinking !== undefined ? "yellow" : "cyan";
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
		// Outside the prompt's box and resting on it, the way the list of what a word could become
		// sits above the word in every other box that completes. Inside it, the box would grow and
		// shrink under the hand as the list filtered, which is the one thing a prompt must not do.
		...listed.map((command, index) =>
			h(
				Text,
				{ key: command.name, wrap: "truncate" },
				h(Text, { color: "cyan", bold: true }, index === pick ? " ▸ " : "   "),
				// Padded to the widest of the ones being shown rather than to a number written down
				// here, which the day a longer command is added becomes a name touching its own
				// description. Two columns of gap at the least, so they are never one word.
				h(Text, { bold: index === pick }, named[index]?.padEnd(widest + 2) ?? ""),
				h(Text, { dimColor: true }, command.does),
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
				doing === "" ? null : h(Text, { dimColor: true }, `${doing} `),
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

/**
 * The console itself: the column, the panel and every key either of them answers to.
 *
 * Exported for the tests that press keys at it. The panes can be drawn on their own and are, but
 * which pane a key reaches and what it does when it gets there is only true here.
 */
export function App({
	client,
	initial,
	conversations,
}: {
	readonly client: ControlClient;
	readonly initial: readonly AgentSummary[];
	readonly conversations: Talk;
}): ReactElement {
	const { exit } = useApp();
	const { rows, columns } = useWindowSize();
	const [agents, setAgents] = useState<readonly AgentSummary[]>(initial);
	const [cursor, setCursor] = useState(0);
	const [panel, setPanel] = useState<Panel>("chat");
	const [lines, setLines] = useState<readonly string[]>([]);
	const [talk, setTalk] = useState<Talk>(conversations);
	// An answer being written, which is not in the transcript yet because it is not finished. Kept
	// apart from the conversation so that when it is finished it replaces itself rather than repeats.
	const [live, setLive] = useState<ReadonlyMap<string, string>>(new Map());
	const [draft, setDraft] = useState("");
	// Whether the prompt is the sandbox's. A mode rather than a prefix, because looking around inside
	// a box is a handful of commands in a row and not one: `!ls`, `!cd`, `!ls` again.
	const [shell, setShell] = useState(false);
	// Where each agent's shell is standing, as the plane last answered. Per agent, because they are
	// different boxes, and the prompt has to say which directory the next command will run in.
	const [cwd, setCwd] = useState<ReadonlyMap<string, string>>(new Map());
	// Which of the offered commands the arrows are on. Clamped rather than corrected when the line
	// being typed narrows the list under it, so nothing has to be reset from inside a keystroke.
	const [pick, setPick] = useState(0);
	// When each turn started, rather than merely that one did: the elapsed seconds come from here.
	const [busy, setBusy] = useState<ReadonlyMap<string, number>>(new Map());
	// The last thing each agent did, kept only for as long as it is still doing something.
	const [step, setStep] = useState<ReadonlyMap<string, string>>(new Map());
	const [frame, setFrame] = useState(0);
	// The row the panel has been scrolled back to, or nothing at all while it is following the end.
	const [top, setTop] = useState<number | undefined>(undefined);
	// The name the plane is making, and when it was asked for. Making one is a minute of pulling an
	// image and scaffolding a repository, which is long enough that it has to be visible.
	const [making, setMaking] = useState<{ name: string; at: number } | undefined>(undefined);
	// Why the last name was not taken. Kept until the next attempt, because the name that earned it
	// is still in the prompt being edited.
	const [refused, setRefused] = useState<string | undefined>(undefined);

	// Undefined on the row under the agents, which is not an agent but the way to make one.
	const selected = agents[Math.min(cursor, agents.length)];
	// A command nobody can name is a command nobody has. Not offered over the shell, where a slash is
	// the start of a path, not over the log feed, which has no prompt for a command to go into, and
	// not over a name, which is not addressed to an agent that exists yet.
	const menu = panel === "chat" && !shell && selected !== undefined ? completions(draft) : [];
	const at = Math.min(pick, menu.length - 1);
	const chosen = menu[at];
	const writing = selected === undefined ? undefined : live.get(selected.id);
	const said =
		selected === undefined
			? []
			: writing === undefined
				? saidBy(talk, selected.id)
				: [...saidBy(talk, selected.id), { from: "agent" as const, text: writing }];

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
	const [drawn, setDrawn] = useState(showing);
	if (drawn !== showing) {
		setDrawn(showing);
		setTop(undefined);
	}

	// Once, for the life of the console: the plane streams until the socket closes, and asking twice
	// would double every line.
	//
	// The same stream feeds both panes, and that is what makes the chat a conversation rather than a
	// record of this console's own questions: a turn a schedule or a webhook started arrives here
	// exactly like one typed in, because nothing about it went through the prompt.
	useEffect(() => {
		const feed = new LogFeed(
			(line) => setLines((prev) => [...prev, line.replace(/\n$/, "")].slice(-REMEMBERED_LINES)),
			{ color: true },
		);
		// One per agent, held open for the length of an answer: markdown cannot be rendered a delta at
		// a time without somewhere to keep the half-finished line.
		const writers = new Map<string, MarkdownStream>();
		const finished = (agentId: string): void => {
			writers.delete(agentId);
			setLive((prev) => without(prev, agentId));
			setBusy((prev) => without(prev, agentId));
			setStep((prev) => without(prev, agentId));
		};

		client.logs((event) => {
			feed.push(event);
			if (event.kind === "said") {
				setTalk((prev) => append(prev, event.agentId, shown(event.said)));
			} else if (event.kind === "thinking") {
				// The only notice the console gets of a turn it did not ask for, and the only thing that
				// separates an agent working from an agent that was spoken to and has not started yet.
				setBusy((prev) => new Map(prev).set(event.agentId, Date.now()));
				setStep((prev) => without(prev, event.agentId));
			} else if (event.kind === "step") {
				// Only the latest is kept. There is one line for this, and what a turn did four tools ago
				// is what the feed is for.
				setStep((prev) => new Map(prev).set(event.agentId, doing(event.step)));
			} else if (event.kind === "say") {
				const writer =
					writers.get(event.agentId) ??
					new MarkdownStream({
						write: (chunk) =>
							setLive((prev) =>
								new Map(prev).set(event.agentId, (prev.get(event.agentId) ?? "") + chunk),
							),
						color: true,
					});
				writers.set(event.agentId, writer);
				writer.push(event.text);
			} else if (event.kind === "turn") {
				// The finished answer is already on its way as a `said`, so what is being written is
				// dropped rather than kept: they are the same words, and both would be both.
				finished(event.agentId);
			} else if (event.kind === "error") {
				// Named by agent for a turn that failed, and by something else for everything else. A
				// context that is not an agent clears nothing, which is what it should do.
				finished(event.context);
			} else if (event.kind === "open") {
				// Opened here rather than at the plane, because this is the machine the person is at: a
				// plane in a container has no desktop, and a consent screen is no use where nobody can
				// see it. Only ever a URL the operator's own plane produced, and only http or https.
				openInBrowser(event.url);
			}
		});
	}, [client]);

	// Only while something is thinking, or while an agent is being built. A console redrawing ten
	// times a second at rest is one that keeps a laptop awake for nothing.
	useEffect(() => {
		if (busy.size === 0 && making === undefined) return;
		const timer = setInterval(() => setFrame((n) => n + 1), 100);
		return () => clearInterval(timer);
	}, [busy.size, making]);

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

	/**
	 * Says something to an agent, and shows none of it.
	 *
	 * Nothing is written here, on purpose. The line typed and the answer to it both come back on the
	 * feed, from the plane that wrote them down, and that is what makes reopening the console pick a
	 * conversation up rather than start one. Writing them here as well would show each of them twice.
	 * A turn that fails arrives the same way: as the plane saying why there was no answer.
	 */
	const ask = useCallback(
		async (agentId: string, body: string, mode: "say" | "shell"): Promise<void> => {
			// Not addressed to the agent at all: it runs in the box the agent lives in, and the agent is
			// not told it happened. Looking around inside is not the same as saying something. The mode
			// is checked first, so a `/` typed at a shell prompt is a path and not a command.
			if (mode === "shell" || isShell(body)) {
				const ran = await client
					.shell(agentId, mode === "shell" ? body : body.slice(1))
					.catch(() => undefined);
				// Where it left off, so the prompt says where the next one will run before it is typed.
				if (ran !== undefined) setCwd((prev) => new Map(prev).set(agentId, ran.cwd));
				return;
			}
			// A command is about the agent rather than to it, and is answered by the plane without
			// waking anything. Both halves come back on the feed like everything else here.
			if (isCommand(body)) {
				await client.command(agentId, body).catch(() => {});
				return;
			}
			await client.wake(agentId, body).catch(() => {});
		},
		[client],
	);

	/**
	 * Makes an agent, and leaves the cursor standing on it.
	 *
	 * Nothing has to be moved for that: the plane appends what it makes, so the row the `+` was on
	 * becomes the row the new agent is on, and the cursor was already there. It is added here as well
	 * as polled for, because two seconds of a list that does not yet have it reads as a create that
	 * did not happen.
	 */
	const make = useCallback(
		async (name: string): Promise<void> => {
			setRefused(undefined);
			setMaking({ name, at: Date.now() });
			try {
				const agent = await client.create(name);
				setAgents((prev) => (prev.some((one) => one.id === agent.id) ? prev : [...prev, agent]));
				setDraft("");
			} catch (error) {
				// Shown in the pane rather than dropped: every refusal here is about the name that was just
				// typed — it is taken, or it is not a name — and that name is still in the prompt.
				setRefused((error as Error).message);
			} finally {
				setMaking(undefined);
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
		// After the mouse guard, so a wheel report is never read as this, and before the panes, so it
		// reaches the agent being watched from whichever one is open. Only while it is thinking: escape
		// on an agent with nothing to stop is a key pressed at the wrong moment, not a command.
		if (key.escape) {
			if (selected !== undefined && busy.has(selected.id)) {
				void client.stop(selected.id).catch(() => {});
			}
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
		// While the menu is up these three keys belong to it, which is what they do in every other box
		// that completes. Swapping the panel or the agent out from under a half-typed command loses the
		// command, and the arrows are the only way to reach the entry that is not the first.
		if (key.tab) {
			if (chosen !== undefined) {
				setDraft(`${chosen.name} `);
				setPick(0);
				return;
			}
			setPanel((prev) => (prev === "chat" ? "logs" : "chat"));
			return;
		}
		if (key.upArrow) {
			if (menu.length > 0) setPick(Math.max(0, at - 1));
			else setCursor((prev) => Math.max(0, prev - 1));
			return;
		}
		if (key.downArrow) {
			if (menu.length > 0) setPick(Math.min(menu.length - 1, at + 1));
			// One past the last agent, which is the row that makes one.
			else setCursor((prev) => Math.min(agents.length, prev + 1));
			return;
		}
		if (panel !== "chat") return;

		// The row under the agents, where what is typed is a name and not a message. Nothing else this
		// prompt does elsewhere happens here: a slash is not a command and a bang is not a shell,
		// because there is no agent yet for either of them to be about.
		if (selected === undefined) {
			// Keys pressed while the plane is building are dropped rather than queued: the one thing
			// they could do is start a second create over the top of the first.
			if (making !== undefined) return;
			if (key.return) {
				const name = draft.trim();
				if (name.length > 0) void make(name);
				return;
			}
			if (key.backspace || key.delete) {
				setDraft((prev) => prev.slice(0, -1));
				return;
			}
			if (input.length === 0 || key.ctrl || key.meta) return;
			const [first = "", ...rest] = input.split(/\r|\n/);
			setDraft((prev) => prev + first);
			// A name pasted with the newline still on it is a name that was entered, the way it is in
			// every other box that takes one.
			if (rest.length > 0) {
				const name = (draft + first).trim();
				if (name.length > 0) void make(name);
			}
			return;
		}

		const send = (line: string): void => {
			const text = line.trim();
			setDraft("");
			// Asking something is asking to see the answer, so a conversation being read back through
			// returns to its end rather than leaving the answer to arrive out of sight.
			setTop(undefined);
			// Deliberately not awaited: the turn runs while the console keeps taking keys, which is what
			// lets an agent be asked something and another one be watched while it thinks.
			if (text.length > 0) void ask(selected.id, text, shell ? "shell" : "say");
		};

		if (key.return) {
			// The first return takes the command off the menu, the second sends it. Every command here
			// can be given an argument, so a return that sent the moment a name was highlighted would
			// make `/limit 5` the one thing the menu could not be used to type. A name already typed in
			// full is not completed onto itself — at that point the menu is agreeing, not offering.
			if (chosen !== undefined && chosen.name !== draft) {
				setDraft(`${chosen.name} `);
				setPick(0);
				return;
			}
			// The mode outlives the command, because that is what a mode is for: nobody looks around a
			// box one command at a time, and pressing `!` again before each of them is the prefix back.
			send(draft);
			return;
		}
		if (key.backspace || key.delete) {
			// Backspacing off the end of an empty line is the way out, which is where the bang went in.
			if (draft === "") setShell(false);
			else setDraft((prev) => prev.slice(0, -1));
			setPick(0);
			return;
		}
		// Ctrl and meta chords are commands this does not have yet, not text. Without this an unhandled
		// one types its letter into the line.
		if (input.length === 0 || key.ctrl || key.meta) return;

		// The bang is the mode rather than a character, and only where a mode can begin: with nothing
		// typed yet. Anywhere else in a line it is what it looks like, since `!` is punctuation in the
		// language this box is typed in.
		if (!shell && draft === "" && input === "!") {
			setShell(true);
			return;
		}

		// A chunk can arrive carrying a whole line, from a paste or from a terminal that batched the
		// keystrokes. The return inside it is what ends the line then, and is never reported as the
		// key: without this, pasting a line types it and leaves it sitting there unsent.
		const [first = "", ...rest] = input.split(/\r|\n/);
		if (rest.length === 0) {
			setDraft((prev) => prev + first);
			// Back to the top of whatever the line now offers: a letter typed under a highlight moves
			// the list out from under it, and the entry it lands on is not the one that was chosen.
			setPick(0);
			return;
		}
		send(draft + first);
		setDraft(rest.join(" ").trim());
	});

	const title = selected === undefined ? "new agent" : selected.id;
	// What the left of the title row has already spent, so that what goes at the right end knows how
	// much of the row is left for it. Three columns of gap, so the two halves never touch.
	const tabs = `${title}   chat · logs${top === undefined ? "" : "   ↑ scrolled"}   `;
	const state =
		selected === undefined ? { model: "", spend: "" } : standing(selected, width - tabs.length);
	const heat = selected === undefined ? { dimColor: true } : burning(selected);
	const started = selected === undefined ? undefined : busy.get(selected.id);
	const latest = selected === undefined ? undefined : step.get(selected.id);
	const thinking: Thinking | undefined =
		started === undefined
			? undefined
			: {
					frame: SPINNER[frame % SPINNER.length] ?? SPINNER[0],
					seconds: Math.floor((Date.now() - started) / 1000),
					...(latest !== undefined ? { step: latest } : {}),
				};
	const building =
		making === undefined
			? undefined
			: {
					name: making.name,
					frame: SPINNER[frame % SPINNER.length] ?? SPINNER[0],
					seconds: Math.floor((Date.now() - making.at) / 1000),
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
					// Pushed to the far end rather than set after the tabs, so that the tabs do not move
					// sideways as a number under them grows: they are pressed at, and a target that
					// wanders while you reach for it is worse than one that says less.
					h(Box, { flexGrow: 1, key: "gap" }),
					state.model === "" ? null : h(Text, { dimColor: true }, `${state.model}   `),
					state.spend === "" ? null : h(Text, heat, state.spend),
				),
				panel !== "chat"
					? h(Logs, { lines, rows: body - 1, top, key: "logs" })
					: selected === undefined
						? h(New, {
								draft,
								rows: body - 1,
								columns: width,
								making: building,
								refused,
								key: "new",
							})
						: h(Chat, {
								history: said,
								draft,
								rows: body - 1,
								columns: width,
								thinking,
								top,
								// Standing at the door until a command says otherwise, which is where the plane
								// starts an agent's shell and what it goes back to when the sandbox is replaced.
								shell:
									shell && selected !== undefined
										? (cwd.get(selected.id) ?? SANDBOX_REPO_PATH)
										: undefined,
								menu,
								pick: at,
								key: "chat",
							}),
			),
		),
		h(
			Box,
			{ flexDirection: "row", key: "hint" },
			h(Text, null, " "),
			// The key stands out from what it does, because the key is the part being looked for.
			...(menu.length > 0
				? // The keys have been taken by the menu, so the row says what they do now instead of
					// what they did a keystroke ago. A hint left standing for a key the menu has taken is
					// the same lie as a hint for a key that does nothing.
					[
						["↑↓", "command"],
						["⏎", "choose"],
						["^C", "quit"],
					]
				: selected === undefined
					? // Nothing else the row usually offers is true here: there is no conversation to
						// scroll, no shell to open and no commands, until the name has been given.
						[
							["↑↓", "agent"],
							["⏎", "create"],
							["^C", "quit"],
						]
					: [
							["↑↓", "agent"],
							["^U^D", "scroll"],
							["tab", panel === "chat" ? "logs" : "chat"],
							// A key nobody guesses is pressable. The rest of this row is what to press to move
							// around; this one is what to press to be told what else there is. In the shell the
							// two of them say nothing true, and the way back out is worth saying instead.
							...(shell
								? [["⌫", "chat"]]
								: [
										["/", "commands"],
										["!", "shell"],
									]),
							["^C", "quit"],
							// Last, so that the rest of the row does not move as it comes and goes, and shown
							// only while there is something to stop: the key does nothing at any other time,
							// and offering it then is how a hint becomes a thing that lies.
							...(busy.size > 0 ? [["esc", "stop"]] : []),
						]
			).flatMap(([stroke, does], index) => [
				h(Text, { color: "cyan", key: `stroke${index}` }, stroke),
				h(Text, { dimColor: true, key: `does${index}` }, ` ${does}   `),
			]),
		),
	);
}

/** The conversations the plane kept, as the console draws them. */
export function resume(kept: Record<string, readonly Utterance[]>): Talk {
	return new Map(Object.entries(kept).map(([agentId, history]) => [agentId, history.map(shown)]));
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
	// Fetched before anything is subscribed to, and that order is the whole of it: a conversation
	// asked for while the feed was already arriving would show the lines that landed in between twice.
	const conversations = resume(await client.transcripts().catch(() => ({})));
	process.stdout.write(MOUSE_ON);
	try {
		const app = render(h(App, { client, initial, conversations }), { exitOnCtrlC: false });
		await app.waitUntilExit();
	} finally {
		// Whatever happened. A terminal left reporting its mouse prints an escape sequence at whoever
		// clicks in it next, and they will be at a shell prompt with no idea what did that to them.
		process.stdout.write(MOUSE_OFF);
	}
	return 0;
}
