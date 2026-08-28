import { dirname } from "node:path";
import { SANDBOX_REPO_PATH } from "@squad/agent-repo";
import { CARRIERS } from "@squad/channels";
import {
	Box,
	type DOMElement,
	measureElement,
	render,
	Text,
	useApp,
	useInput,
	useWindowSize,
} from "ink";
import {
	createElement as h,
	type ReactElement,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import wrapAnsi from "wrap-ansi";
import { copied, osc52 } from "./clipboard.ts";
import {
	CONFIG_SECTIONS,
	type Command,
	completions,
	isCommand,
	isShell,
	money,
} from "./commands.ts";
import type { ControlClient } from "./control-client.ts";
import type { AgentSummary } from "./control-plane.ts";
import { LocalDoors, wanted } from "./doors.ts";
import { LogFeed } from "./feed.ts";
import type { GrantOrigin, GrantStanding } from "./grants.ts";
import type { MailStanding } from "./mailbox.ts";
import { MarkdownStream } from "./markdown.ts";
import { readName, readServer, type ServerStanding, written } from "./mcp.ts";
import type { ModelOffer, ModelStanding, ProviderStanding } from "./models.ts";
import { openInBrowser } from "./oauth-login.ts";
import type { AgentStep } from "./pi-output.ts";
import { SEARCH_PROVIDERS, type SearchSpec, type SearchStanding } from "./search.ts";
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
 * Wide enough for a name, what it is spending and when it wakes, on the one row they share.
 *
 * Four columns of it are the border and the padding, two more the mark. At 20 the sixteen left over
 * could not hold all three, and the money was what went — so the agent with a turn booked, the one
 * about to spend again while nobody is watching, was the one agent whose spending went unsaid. The
 * four extra columns come out of a chat pane that wraps its text anyway.
 */
const AGENTS_WIDTH = 24;

/**
 * The two reach marks and the space before them, which every agent row spends whatever it has on it.
 *
 * Two columns each, because they are emoji and a terminal draws those double-wide. That is what they
 * cost over a glyph from the same alphabet as the mark beside them, and what is bought is a picture
 * of a postbox instead of a shape somebody has to be told the meaning of once and remember after.
 */
const REACH_ROOM = 5;

/**
 * What a row has left for the name and its numbers, once the border, the padding, the mark that says
 * whether it is up and the two that say who can reach it are paid.
 *
 * The reach marks are taken off every row rather than dropped from the tight ones, because a column
 * is scanned down: marks that appear on the rows with short names and go missing on the rest are
 * not a column at all, and the question they answer — which of these has a bot — is asked of the
 * whole list at once.
 */
const ROW_ROOM = AGENTS_WIDTH - 6 - REACH_ROOM;

/**
 * What the chat has to fit into: the terminal, less the agents column and the pane's own border.
 *
 * Wanted in two places that are far apart — the render, and the transcript that is painted before the
 * first render happens — and a table drawn to the wrong one of them is a table with a fold in it.
 */
export function chatWidth(columns: number): number {
	return Math.max(1, columns - AGENTS_WIDTH - 4);
}

/** The three rows the prompt occupies now that it is in a box: its two borders and its line. */
const PROMPT_ROWS = 3;

const ESC = "\u001b";

/** What one notch of a wheel moves. Three is what a terminal scrolls, so it is what a hand expects. */
const WHEEL_ROWS = 3;

/**
 * Asks the terminal to report the mouse: the buttons, the dragging, and all of it in the encoding
 * that still works past the 223rd column.
 *
 * Being told about the wheel is the only way to scroll a screen the terminal did not draw, and it
 * cannot be asked for on its own — a terminal reporting the wheel reports the clicks too, and one
 * reporting clicks has stopped selecting text for whoever is reading. So the dragging is asked for
 * as well and the selection is drawn here instead. That trade is the whole reason this line is
 * allowed to exist, and it is void the moment a drag stops putting the words on the clipboard.
 */
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`;

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

/** A mark as a row draws it: a glyph, and the colour that is the other half of what it says. */
export interface Mark {
	readonly glyph: string;
	readonly color: string;
	readonly dimColor: boolean;
}

/**
 * The mark for a way in an agent has not been given: the room one takes, and nothing in it.
 *
 * Blank rather than a dot standing in for it. With glyphs a column wide a dot was what made the
 * marks read as a column at all; at two columns each the emoji are their own alignment, and a row
 * of placeholders for the things an agent has not got is a row of noise to look past.
 */
const UNREACHED: Mark = { glyph: "  ", color: "gray", dimColor: true };

/**
 * How an agent can be spoken to, in the columns beside the mark that says whether it is up.
 *
 * The state is in the drawing rather than in the colour, which is what changed when these became
 * emoji: a terminal paints a glyph that brings its own colours in those, and a yellow that never
 * arrives is a warning nobody gets. So the half-connected have a glyph of their own — the link for
 * a bot whose token was pasted and whose link nobody ever tapped, and the closed box for a mailbox
 * that takes an agent's mail and leaves it no way to answer. Both of those look exactly like
 * working from every other screen in this console, and both are somebody's afternoon.
 *
 * The colour is still carried, for the title row: there the piece is a username and an address,
 * which are words, and words take a colour the way these no longer can.
 */
export function reached(agent: AgentSummary): readonly [Mark, Mark] {
	return [
		agent.bot === undefined
			? UNREACHED
			: agent.bot.paired
				? { glyph: "🤖", color: "green", dimColor: false }
				: { glyph: "🔗", color: "yellow", dimColor: false },
		agent.mail === undefined
			? UNREACHED
			: agent.mail.writes
				? { glyph: "📬", color: "gray", dimColor: false }
				: { glyph: "📪", color: "yellow", dimColor: false },
	];
}

/** Where a turn has got to, and how long it has been getting there. */
export interface Thinking {
	readonly frame: string;
	readonly seconds: number;
	/** The last thing the agent did, for the one line under the conversation. */
	readonly step?: string;
}

/** What the working row says of a turn that has not reached its first tool yet. */
const THINKING = "thinking";

/**
 * A step as the row under the conversation says it: what it is, and what it is on.
 *
 * Only the first line, because a step's detail is a whole shell command or a diff and that row is
 * one row. The rest of it is in the feed, which is where a thing is read after it has happened.
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
	readonly to?: string;
}

/** Markdown as the terminal will have it, for a line that arrives whole rather than in pieces. */
export function painted(text: string, width: number): string {
	let out = "";
	const stream = new MarkdownStream({
		write: (chunk) => {
			out += chunk;
		},
		color: true,
		width,
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
 *
 * The pane's width comes along for the one thing that cannot be decided later: a table is drawn to a
 * width and stays drawn to it, so a terminal resized afterwards folds its columns the way it folds a
 * paragraph. Prose is unaffected — it is wrapped fresh on every frame.
 */
export function shown(said: Utterance, width: number): Said {
	return {
		from: said.from,
		text: said.from === "agent" ? painted(said.text, width) : said.text,
		...(said.tone !== undefined ? { tone: said.tone } : {}),
		...(said.via !== undefined ? { via: said.via } : {}),
		...(said.to !== undefined ? { to: said.to } : {}),
	};
}

type Panel = "chat" | "logs" | "config";

/**
 * The two rows the column holds under the agents: the log feed and the config screen.
 *
 * They were panels of an agent, reached by tabbing inside one, and neither is about an agent. The
 * feed is the plane's — one stream, every agent in it — and the config screen is the plane's keys and
 * the plane's models. Sitting behind `demo` they read as `demo`'s, and to get at them you had to
 * pick an agent first and then ignore which one you had picked.
 *
 * So the column is the whole of what this console can show, top to bottom, and one key walks it. The
 * agents come first because they are what somebody opens this for; the plane's two rows sit at the
 * foot, where the things you set once and then leave alone belong.
 */
export const PLANE_ROWS = 2;

/** Which panel the column's row opens. Everything down to the row that makes an agent is a chat. */
export function panelAt(spot: number, agents: number): Panel {
	return spot <= agents ? "chat" : spot === agents + 1 ? "logs" : "config";
}

/** Turns a walk into a ring of `rows`, so neither end of the column is ever run off. */
function ringed(spot: number, by: 1 | -1, rows: number): number {
	return (((spot + by) % rows) + rows) % rows;
}

/** The next row down, or up. It wraps, so the first agent is one key past the config screen. */
export function walked(spot: number, by: 1 | -1, agents: number): number {
	return ringed(spot, by, agents + PLANE_ROWS + 1);
}

/** What tab is about to open, for the row that says what tab does. */
export function nextRow(spot: number, agents: readonly { readonly id: string }[]): string {
	const next = walked(spot, 1, agents.length);
	if (next < agents.length) return clipped(agents[next]?.id ?? "", 12);
	return next === agents.length ? "new agent" : next === agents.length + 1 ? "logs" : "config";
}

export type Talk = ReadonlyMap<string, readonly Said[]>;

export function saidBy(talk: Talk, agentId: string): readonly Said[] {
	return talk.get(agentId) ?? [];
}

export function append(talk: Talk, agentId: string, ...said: readonly Said[]): Talk {
	if (said.length === 0) return talk;
	return new Map(talk).set(agentId, [...saidBy(talk, agentId), ...said]);
}

/**
 * What the operator typed to this agent, oldest last: the list an up arrow walks back through.
 *
 * Taken from the conversation rather than kept alongside it, so that a console reopened tomorrow has
 * the history the pane is already showing. The same line twice running counts once, because a
 * history that keeps every `ls` is one you have to press your way through.
 */
export function typed(said: readonly Said[]): readonly string[] {
	const lines = said
		.filter((one) => one.from === "operator")
		.map((one) => one.text)
		.filter((line) => line.trim().length > 0);
	return lines.filter((line, index) => line !== lines[index - 1]);
}

/** How far back through what was already said the prompt has been walked, and what it left behind. */
export interface Walk {
	/** How many lines back, counting the last one said as one. */
	readonly back: number;
	/** What was in the prompt when the walk began, to be given back at the end of it. */
	readonly typing: string;
}

/**
 * Where a step back or forward through what was already said lands.
 *
 * Walking down past the newest line gives back whatever was being typed when the walk began, rather
 * than an empty prompt: a half-written line that a stray arrow eats is a line you have to remember
 * and type again. Walking up past the oldest stays on the oldest, which is what every shell does.
 */
export function recalled(
	past: readonly string[],
	walk: Walk | undefined,
	by: 1 | -1,
	draft: string,
): { readonly walk: Walk | undefined; readonly draft: string } {
	const typing = walk?.typing ?? draft;
	const back = Math.min(Math.max((walk?.back ?? 0) + by, 0), past.length);
	if (back === 0) return { walk: undefined, draft: typing };
	return { walk: { back, typing }, draft: past[past.length - back] ?? "" };
}

/**
 * The word a tab is standing on: back to the last space that was not escaped, and no further.
 *
 * There is no cursor at this prompt — what is typed goes on the end — so the word being completed
 * is always the last one. A space with a backslash in front of it is part of a name and not a
 * boundary, which is the whole reason this is not a `split`.
 */
export function completing(line: string): { readonly from: number; readonly word: string } {
	let from = 0;
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] === "\\") {
			index += 1;
			continue;
		}
		if (line[index] === " ") from = index + 1;
	}
	return { from, word: line.slice(from) };
}

/** As it was typed becomes as it is meant: `mis\ notas` is one directory, not two words. */
export function plain(word: string): string {
	return word.replace(/\\(.)/g, "$1");
}

/**
 * And back again, so that what a completion puts in the prompt is a word the shell reads as one.
 *
 * Everything the shell would otherwise act on is escaped, not only the space: a file called `$HOME`
 * that came back unescaped would be a completion that quietly typed a different path than the one
 * on the row that was chosen.
 */
export function quoted(word: string): string {
	return word.replace(/([\s\\"'$`!*?()[\]{}<>|&;#~])/g, "\\$1");
}

/** The most of a name every candidate agrees on, which is how far one tab can safely type. */
export function agreed(options: readonly string[]): string {
	const [first = ""] = options;
	let length = first.length;
	for (const option of options) {
		while (length > 0 && option.slice(0, length) !== first.slice(0, length)) length -= 1;
	}
	return first.slice(0, length);
}

/** A prompt after a tab: the line as it now stands, and what is still ambiguous about it. */
export interface Filled {
	readonly draft: string;
	/** Empty when the tab settled it. Otherwise the rows to offer, the way a `/` offers commands. */
	readonly options: readonly string[];
}

/**
 * What one tab does to the line.
 *
 * The same two things every shell does: one candidate is typed out in full, and several are typed
 * as far as they agree, leaving the hand at the first letter that would tell them apart. A
 * directory takes no space after it, because a directory is not the end of a path.
 */
export function filled(line: string, options: readonly string[]): Filled {
	const [only] = options;
	if (only === undefined) return { draft: line, options: [] };
	const head = line.slice(0, completing(line).from);
	if (options.length === 1) {
		return { draft: `${head}${quoted(only)}${only.endsWith("/") ? "" : " "}`, options: [] };
	}
	return { draft: `${head}${quoted(agreed(options))}`, options };
}

/**
 * Which row of the column a press landed on, or nothing when it landed between them.
 *
 * The column stands in the top left corner of the screen and keeps its width, so where its rows are
 * is arithmetic and not a measurement: a row of border, the header, the air over the list when there
 * is room for it, the agents, the row that makes one, then the plane's two. The number this answers
 * with is the number tab reaches the same row by.
 */
export function picked(at: At, shape: { agents: number; rows: number }): number | undefined {
	if (at.column < 1 || at.column > AGENTS_WIDTH || shape.rows <= 0) return undefined;
	// Read off `Column`, which gives up the air the moment it is too short to spare it.
	const budget = shape.rows - 2;
	const spaced = shape.agents + 8 <= budget;
	const head = spaced || budget >= 5;
	const shown = spaced ? shape.agents : Math.max(0, budget - 3 - (head ? 1 : 0));
	const row = at.row - 2 - (head ? 1 : 0) - (spaced ? 1 : 0);
	if (row >= 0 && row < shown) return row;
	// What follows the list: the blank under it when there is one, the row that makes an agent, the
	// blank that sets the plane's rows apart, then those two.
	const after = row - shown - (spaced ? 1 : 0);
	if (after === 0) return shape.agents;
	if (after === (spaced ? 2 : 1)) return shape.agents + 1;
	if (after === (spaced ? 3 : 2)) return shape.agents + 2;
	return undefined;
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
 *
 * `mark` is what stands off the operator's own line, and the only caller that gives it is the queue
 * above the prompt, which carries a mark of its own and does not want two.
 */
function spoken(said: Said, mark = "> "): string {
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
	// The agent's answer, and where it left for. An arrow, because `‹email›` already means a message
	// that arrived by mail, and the same mark on both is a conversation talking to itself: the pane
	// would show a question and its answer marked alike, and only one of the two went anywhere.
	if (said.to !== undefined) return `${ESC}[33m‹→ ${said.to}›${ESC}[39m ${said.text}`;
	// Yellow, where dim was wrong: a line nobody typed is the one worth finding again on a pane full
	// of answers, and dim is how a terminal says this may be skipped. Yellow is what the agents column
	// already paints a booked wakeup in, so the mark here and the clock in the list are one thing.
	if (said.via !== undefined) return `\u001b[33m‹${said.via}›\u001b[39m ${said.text}`;
	if (said.from === "operator") return `\u001b[36m${mark}${said.text}\u001b[39m`;
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

/** Where the mouse was when it was reported, in the terminal's own numbering: one for the first row. */
export interface At {
	readonly column: number;
	readonly row: number;
}

/**
 * What the mouse did: turned, or went down, moved with a button held, or came back up.
 *
 * The wheel is separate from the rest because it is the only one that says nothing about where it
 * happened that anybody here needs — it scrolls the pane that is open, wherever the pointer is.
 */
export type Moved =
	| { readonly did: "wheel"; readonly by: number }
	| { readonly did: "down" | "drag" | "up"; readonly at: At };

/**
 * What a chunk of mouse reporting says happened — and nothing at all when the chunk is not the
 * mouse, which is how the caller knows to hand it on to the keyboard.
 *
 * Reported as `ESC [ < button ; column ; row M`, with `m` for a release. The button carries flags
 * as well as a number: 64 is the wheel, 32 is motion with something held down, and the bits above
 * those are shift, meta and ctrl, which are none of this reader's business. Everything in the chunk
 * is answered for, wheel or not: one flick of a trackpad arrives as several reports at once, and a
 * click nobody claims is an escape sequence typed into the prompt.
 */
export function mouse(input: string): readonly Moved[] | undefined {
	const moves: Moved[] = [];
	let reported = false;
	for (const piece of input.split(ESC)) {
		const report = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(piece);
		if (report === null) continue;
		reported = true;
		const [, code = "0", column = "1", row = "1", end = "M"] = report;
		const button = Number(code);
		const at = { column: Number(column), row: Number(row) };
		if ((button & 64) !== 0) {
			// 64 is a notch up and 65 a notch down; 66 and 67 are the same wheel tilted sideways, which
			// this has nothing to scroll with and still has to swallow.
			if ((button & 3) === 0) moves.push({ did: "wheel", by: -WHEEL_ROWS });
			else if ((button & 3) === 1) moves.push({ did: "wheel", by: WHEEL_ROWS });
			continue;
		}
		if (end === "m") moves.push({ did: "up", at });
		else if ((button & 32) !== 0) moves.push({ did: "drag", at });
		// Only the left button draws a selection. The others are reported, swallowed, and left alone:
		// a terminal's own menu on the right button is not this console's to reinvent.
		else if ((button & 3) === 0) moves.push({ did: "down", at });
	}
	return reported ? moves : undefined;
}

/**
 * What a drag is holding: the rows, counted from the first row the pane is showing, and where in the
 * first and the last of them it opened and closed.
 *
 * The columns are counted from the first column of text rather than from the edge of the terminal,
 * because that is the only origin both the paste and the highlight can agree on: one is slicing a
 * string and the other is drawing into a box whose border and padding are not part of it.
 */
export interface Span {
	readonly from: number;
	readonly to: number;
	/** The column the hold opens at, on its first row. */
	readonly head: number;
	/** The column it closes before, on its last row. Past the end of a row means all of it. */
	readonly tail: number;
}

/** The border and the padding a panel draws before the first column of anything it says. */
const TEXT_INSET = 2;

/**
 * Which rows of a conversation a drag has hold of, or nothing when it began outside it.
 *
 * Counted from the bottom of the pane rather than the top, because that is where both panes are
 * anchored: they rest on the prompt, so the slack a short conversation leaves lands above it and
 * arithmetic that started at the top would be off by exactly that slack. `below` is everything the
 * pane drew under the last line — the prompt, its border, the command menu — which the pane knows
 * and this cannot work out for itself.
 *
 * Where the drag ends is clamped and where it began is not: a hand that pulls past the last row
 * means the last row, but a press on the prompt or on the agent list is not a selection at all.
 *
 * The cell the button came up on is held along with the rest, rather than being the first one let go
 * of: a hand that has to overshoot by one to catch the last character of a word is a hand that has
 * been told the wrong thing about where the selection ends.
 */
export function holding(
	drag: { readonly from: At; readonly to: At },
	pane: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
	shape: { readonly lines: number; readonly below: number },
): Span | undefined {
	if (shape.lines <= 0) return undefined;
	// One row of border at the bottom, and the rows the pane drew above it.
	const last = pane.y + pane.height - 2 - shape.below;
	const first = last - shape.lines + 1;
	// The terminal numbers its rows and columns from one and the layout numbers them from zero.
	const began = drag.from.row - 1;
	const column = drag.from.column - 1;
	if (began < first || began > last) return undefined;
	if (column < pane.x || column >= pane.x + pane.width) return undefined;
	const ended = Math.min(Math.max(drag.to.row - 1, first), last);
	// Which end of the drag is the head depends on which way the hand went, and on the same row that
	// is a question about columns rather than rows: a drag leftwards holds what it dragged over.
	const back = ended < began || (ended === began && drag.to.column < drag.from.column);
	const opened = back ? drag.to.column : drag.from.column;
	const closed = back ? drag.from.column : drag.to.column;
	const text = pane.x + TEXT_INSET;
	return {
		from: Math.min(began, ended) - first,
		to: Math.max(began, ended) - first,
		head: Math.max(0, opened - 1 - text),
		tail: Math.max(0, closed - text),
	};
}

/**
 * Where a visible column falls in a row as it was drawn, which is somewhere further along than the
 * column says: the colours are written into the row and take up no room on the screen.
 *
 * Counted in code points rather than in cells, so that a character made of two of them is never cut
 * in half. A character drawn two cells wide is still counted as one, which is a paste off by a column
 * for whoever selects across one — worth less than the crash the other way round would be.
 */
function at(line: string, column: number): number {
	let index = 0;
	let seen = 0;
	while (index < line.length && seen < column) {
		COLOUR.lastIndex = index;
		if (COLOUR.exec(line) !== null) {
			index = COLOUR.lastIndex;
			continue;
		}
		// A character written as two units of a string is one character on the screen, and cutting
		// between its halves would put half of it on the clipboard.
		const code = line.codePointAt(index);
		index += code !== undefined && code > 0xffff ? 2 : 1;
		seen += 1;
	}
	return index;
}

/** Sticky, because what is asked at every step is whether a colour begins exactly here. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stepping over the escape is the point.
const COLOUR = /\u001b\[[0-9;]*m/y;

/** A row as the screen shows it, with whatever part of it a drag is holding drawn inverted. */
export function inverted(line: string, held: Span | undefined, row: number): string {
	if (held === undefined || row < held.from || row > held.to) return line;
	// A row in the middle of a hold is held end to end; only the first and the last have a column the
	// hand actually chose.
	const opens = at(line, row === held.from ? held.head : 0);
	const closes = at(line, row === held.to ? held.tail : line.length);
	if (closes <= opens) return line;
	// `27` is the only code that undoes `7`, and nothing drawn into these rows uses it, so the colours
	// already in the line cannot cancel the highlight halfway through a word.
	return `${line.slice(0, opens)}${ESC}[7m${line.slice(opens, closes)}${ESC}[27m${line.slice(closes)}`;
}

/** The words of a held row, as they would be pasted: what is between the columns, and no colours. */
export function between(line: string, head: number, tail: number): string {
	return bare(line.slice(at(line, head), at(line, tail)));
}

/** A row as it would be pasted: without the colours it was drawn in, and without the space at its end. */
export function bare(line: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what is being removed.
	return line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
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

/** What the title row says about an agent besides its name, each piece in the colour it is read in. */
export interface Standing {
	/** The bot it answers on, which the column can only say it has. */
	readonly bot: string;
	/** The address it is reached at, which nothing on screen used to say at all. */
	readonly mail: string;
	readonly model: string;
	readonly spend: string;
}

/** Three columns between the pieces, so two facts never read as one. */
const GAP = 3;

function room(said: Standing): number {
	const pieces = [said.bot, said.mail, said.model, said.spend].filter((piece) => piece !== "");
	return pieces.join(" ".repeat(GAP)).length;
}

/**
 * What the title row says about the selected agent besides its name, in the room the tabs left it.
 *
 * Widest first, and dropped from the left as the terminal narrows: the money is what an operator
 * comes back to the screen for, and the model is what explains it, so the model is what goes when
 * only one of them fits. Nothing is truncated to a stump — a `deepseek-v4-fl…` is a fact half said,
 * and a row that says less is easier to read than a row that says everything badly.
 *
 * The two addresses go before either of those, in that order, because they are the longest things
 * here and the least perishable: where an agent is reached does not change while you watch it, and
 * the column beside this row has already said whether it has each of them. What this row adds is
 * which bot and which address, and that is a thing you look up once and then know.
 */
export function standing(agent: AgentSummary, had: number): Standing {
	const spent = money(agent.spentUsd);
	const full = agent.limitUsd === undefined ? spent : `${spent} / ${money(agent.limitUsd)}`;
	// The same glyph the column drew, so the row is the mark read out rather than a second notation.
	// Two columns wide and two units long, which is the one thing that lets the room below be counted
	// in characters the way every other piece here is.
	const [botMark, mailMark] = reached(agent);
	const bot = agent.bot?.username === undefined ? "" : `${botMark.glyph} @${agent.bot.username}`;
	const mail = agent.mail === undefined ? "" : `${mailMark.glyph} ${agent.mail.address}`;
	const model = agent.model ?? "";

	for (const said of [
		{ bot, mail, model, spend: full },
		{ bot, mail: "", model, spend: full },
		{ bot: "", mail: "", model, spend: full },
		{ bot: "", mail: "", model: "", spend: full },
		// The ceiling is the last thing to go before the row is empty: what was spent is a fact, and
		// what it was allowed to be is a second fact about the first one, worth less than half of the
		// room it takes to say both.
		{ bot: "", mail: "", model: "", spend: spent },
	]) {
		if (room(said) <= had) return said;
	}
	return { bot: "", mail: "", model: "", spend: "" };
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

/**
 * What an agent has spent, in the fewest columns that still answer what this column is asked.
 *
 * Four decimals is what the plane says in a sentence, where there is a whole line to say it on.
 * Here it is seven columns spent telling two agents apart by an amount neither of them has, in the
 * one place a number is scanned rather than read: what is looked for down this column is the row
 * that is not small, and `$0.0004` is a long way of writing small.
 */
function spending(usd: number): string {
	// Nothing spent is drawn as nothing, not as `$0.00`: a fleet of ceros is a column of noise to
	// read past, and what is being looked for here is the row that is not like the others.
	if (usd <= 0) return "";
	return usd < 0.01 ? "<$0.01" : money(usd);
}

/**
 * A row laid out to the width the column has: the name, then its numbers against the right edge.
 *
 * The name is what gives way now, which is the reverse of what this did before and is the whole of
 * the fix. The money and the wait used to queue for whatever a long name had left over, so the agent
 * that had booked its own next turn was the one whose spending went unsaid — the two facts here that
 * cannot be had by looking again in a second, and only ever one of them fit. A name cut short is
 * still that agent and the title row says it in full; a number not drawn is nobody's fact at all.
 *
 * Against the edge rather than after the name, because six agents' spending is a question about
 * which of them is the largest, and numbers starting at six different columns are read one at a time.
 */
export function laid(
	agent: AgentSummary,
	room: number = ROW_ROOM,
): { readonly name: string; readonly gap: string; readonly wake: string; readonly spent: string } {
	const spent = spending(agent.spentUsd);
	const wake = agent.wakeAt === undefined ? "" : until(agent.wakeAt);
	const tail = [wake, spent].filter((piece) => piece !== "").join(" ");
	const name = clipped(agent.id, tail === "" ? room : room - tail.length - 1);
	return {
		name,
		gap: tail === "" ? "" : " ".repeat(Math.max(1, room - name.length - tail.length)),
		wake,
		spent,
	};
}

/**
 * How a row's name is painted, which is the whole of what says the cursor is on it.
 *
 * There was a pointer here, in a column of its own to the left of the marks, and the column of its
 * own was the problem: the header said `agents` against the border while every row that followed
 * began two columns in, so the list read as indented under a title it did not line up with. Nothing
 * was in that gutter but one arrow. The name carries it instead, in the cyan the panel title gives
 * the same name — so the row and the pane it opens are the one colour, and the marks keep theirs.
 *
 * A reversed row would have been the other way to do it, and takes the colour away exactly where it
 * is being read: the mark is what this column is scanned for.
 */
export function pointed(
	here: boolean,
	running: boolean,
): { readonly bold: boolean; readonly color?: string; readonly dimColor: boolean } {
	if (here) return { bold: true, color: "cyan", dimColor: false };
	return { bold: false, dimColor: !running };
}

export function Column({
	agents,
	spot,
	busy,
	rows,
	arrows = true,
}: {
	readonly agents: readonly AgentSummary[];
	/** Which row of the whole column the keyboard is on, counted from the first agent. */
	readonly spot: number;
	/** Each agent mid-turn, against when its turn started. The column only asks whether. */
	readonly busy: ReadonlyMap<string, number>;
	readonly rows: number;
	/** Whether the arrows still walk this column, or have been handed to the screen beside it. */
	readonly arrows?: boolean;
}): ReactElement {
	const cursor = spot;
	// The row under the last agent, which tab reaches with the same press as any other.
	const making = cursor === agents.length;
	// A blank over the list and another under it, which is what makes the header a header and the
	// last row a thing of its own rather than a fourth agent. Given up the moment the column is short
	// enough that a gap would cost it an agent: air is what a list has when it has room for it. The
	// word `agents` goes next, once there is not even room for one under it.
	//
	// The two borders are rows and count against this — they did not, and a column a row or two too
	// tall for its box came out with lines written over each other rather than merely cut short.
	const budget = rows - 2;
	const spaced = agents.length + 8 <= budget;
	const head = spaced || budget >= 5;
	const listed = agents
		.slice(0, spaced ? agents.length : Math.max(0, budget - 3 - (head ? 1 : 0)))
		.map((agent, index) => {
			// Thinking is worth a different mark from merely being up: with several agents on screen it
			// is the one thing you cannot find out by asking again in a second.
			const mark = busy.has(agent.id) ? MARKS.busy : agent.running ? MARKS.running : MARKS.stopped;
			const here = index === cursor;
			const row = laid(agent);
			// Beside the mark rather than after the name, which is the only place in a column this narrow
			// where they line up: the name is as long as somebody made it and the numbers are pinned to
			// the far edge, so anything between the two is at a different column on every row.
			const [bot, mail] = reached(agent);
			return h(
				Text,
				{ key: agent.id, wrap: "truncate" },
				h(Text, { color: mark.color }, mark.glyph),
				h(Text, { color: bot.color, dimColor: bot.dimColor }, ` ${bot.glyph}`),
				h(Text, { color: mail.color, dimColor: mail.dimColor }, mail.glyph),
				h(Text, pointed(here, agent.running), ` ${row.name}`),
				row.gap === "" ? undefined : row.gap,
				// An agent that booked its own next turn is going to act while nobody is watching, which is
				// the one thing on this row worth a colour of its own.
				row.wake === "" ? undefined : h(Text, { color: "yellow", dimColor: true }, row.wake),
				row.spent === ""
					? undefined
					: h(Text, burning(agent), `${row.wake === "" ? "" : " "}${row.spent}`),
			);
		});
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
		head ? h(Text, { dimColor: true, key: "title" }, "agents") : undefined,
		spaced ? h(Text, { key: "over" }, " ") : undefined,
		...listed,
		spaced ? h(Text, { key: "under" }, " ") : undefined,
		// Last, and never given up to make room: making an agent is a row in the list of agents because
		// that is where somebody with none of them is already looking, and where somebody who wants
		// another one looks too. Behind a command it would be a thing only whoever wrote it can find.
		rows <= 0
			? undefined
			: h(
					Text,
					{ key: "+", wrap: "truncate" },
					// In the column the marks are in, so it reads as one more state a row can be in rather
					// than as a caption that wandered under the list.
					h(Text, { color: "green" }, "+"),
					h(Text, pointed(making, false), " new agent"),
				),
		// The plane's own rows, under the agents because that is the order somebody uses them in: you
		// come here to talk to an agent, and you go to the feed or the keys when something is wrong or
		// once, at the start. Drawn like the agents rather than like a title — they are pressed at, and
		// a row that is pressed at wears the colour that says the keyboard is on it.
		spaced ? h(Text, { key: "gap" }, " ") : undefined,
		h(Text, { key: "logs", ...pointed(cursor === agents.length + 1, true) }, "logs"),
		h(Text, { key: "config", ...pointed(cursor === agents.length + 2, true) }, "config"),
		// A list nothing points at does not say how to walk it. The row at the bottom of the screen
		// says where tab goes next, which only answers the question of somebody who already knows to
		// press it; this says what to press, inside the thing it is about. On the bottom border rather
		// than after the last row, so it reads as this column's own footing and not as one more thing
		// in the list — and given up first, when the column is too short to spare a row.
		//
		// It names whichever key walks the column from where the keyboard already is, which is the
		// arrows until the config screen's own list has been handed them: from there they are that
		// list's until it runs out above the cursor, so tab is the one that always answers. A footing
		// naming a key that does something else here would be worse than none.
		spaced ? h(Box, { flexGrow: 1, key: "rest" }) : undefined,
		spaced
			? h(
					Text,
					{ key: "how", wrap: "truncate" },
					h(Text, { color: "cyan", dimColor: true }, arrows ? "↑↓" : "tab"),
					h(Text, { dimColor: true }, " moves"),
				)
			: undefined,
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

/**
 * The commands the prompt is offering right now, and where in the list they start.
 *
 * The menu is taken out of the conversation rather than laid over it, and never takes the last row:
 * a pane being dragged to nothing must still be a pane, not a list with nowhere to type. Framed
 * rather than cut at the top, because this list is as long as the models are and a cursor arrowed
 * past the bottom of it would be a return pressed at a row nobody can see.
 *
 * Out here rather than inside the pane because the pane is not the only one who has to know: what a
 * drag lands on depends on how many rows this took, and a hand counting them differently from the
 * screen selects the wrong words.
 */
export function offering(
	menu: readonly Command[],
	pick: number,
	rows: number,
): { readonly from: number; readonly listed: readonly Command[] } {
	const height = Math.max(0, chatRows(rows) - 1);
	const from = frameFrom(menu.length, pick, height);
	return { from, listed: menu.slice(from, from + height) };
}

/**
 * The rows a chat pane sets aside above its prompt: the command menu while a slash is being typed,
 * the messages queued at a busy agent, and the line saying what the turn is doing while one is
 * running. All of them come out of the conversation.
 *
 * Worked out here rather than twice, because a drag arrives as a row of the terminal and this number
 * is half of turning it back into a line of text: a pane counting one thing while the mouse counts
 * another selects the wrong words. It says which rows it granted as well as how many, so the pane
 * draws exactly what was budgeted instead of arriving at the same answer a second way.
 */
export function aside(
	listed: number,
	working: boolean,
	queued: number,
	rows: number,
): { readonly taken: number; readonly queued: number; readonly working: boolean } {
	const room = chatRows(rows);
	// Messages waiting to be taken outrank the clock. The seconds are a comfort; a line somebody typed
	// and nobody has answered yet is the thing on this pane they are still owed.
	const waiting = Math.max(0, Math.min(queued, room - listed));
	// The working row gives way before the last row of conversation does. A pane squeezed to nothing
	// is still a conversation with a prompt under it, and a clock is not worth the last line of talk.
	const clock = working && room - listed - waiting > 0;
	return { taken: listed + waiting + (clock ? 1 : 0), queued: waiting, working: clock };
}

/** The conversation as the rows a pane of this size is showing of it, which is what a drag copies. */
export function reading(
	history: readonly Said[],
	columns: number,
	rows: number,
	taken: number,
	top: number | undefined,
): readonly string[] {
	return visible(wrapped(transcript(history), columns), chatRows(rows) - taken, top);
}

export function Chat({
	history,
	draft,
	rows,
	columns,
	thinking,
	queued,
	top,
	shell,
	confirm,
	menu,
	pick,
	held,
}: {
	readonly history: readonly Said[];
	readonly draft: string;
	readonly rows: number;
	readonly columns: number;
	readonly thinking: Thinking | undefined;
	/** What has been said to this agent that it has not been told yet, oldest first. */
	readonly queued: readonly Said[];
	/** The first row of conversation to show, or the end of it when nothing has been scrolled back to. */
	readonly top: number | undefined;
	/** The directory the next `!` runs in, or nothing at all while the prompt is the agent's. */
	readonly shell: string | undefined;
	/** The name being asked for before a delete goes through, or nothing while none was asked for. */
	readonly confirm: string | undefined;
	/** What the line being typed could still turn out to be, which is empty unless it began with a slash. */
	readonly menu: readonly Command[];
	readonly pick: number;
	/** The rows a drag is holding, counted from the first one this pane is showing. */
	readonly held: Span | undefined;
}): ReactElement {
	// The box around the prompt costs two rows. A pane with no room for them keeps the prompt and
	// gives up the border, because a border drawn where there is no room is the broken screen again.
	const boxed = rows > PROMPT_ROWS;
	const { from, listed } = offering(menu, pick, rows);
	const named = listed.map((command) => `${command.name} ${command.takes}`.trimEnd());
	const widest = Math.max(0, ...named.map((name) => name.length));
	const budget = aside(listed.length, thinking !== undefined, queued.length, rows);
	// Nothing when the pane had no row to spare for it, which is what `aside` decides for both of us.
	const working = budget.working ? thinking : undefined;
	// The end of the queue rather than the start of it, when only some of it fits: this pane is read
	// from the bottom, and the ones nearest the prompt are the ones just typed into it.
	const holding = queued.slice(queued.length - budget.queued);
	const clock = working === undefined ? "" : `${working.frame} ${working.seconds}s `;
	const lines = reading(history, columns, rows, budget.taken, top);
	// A question waiting for an answer is drawn over the shell's prompt, and it carries its own
	// answer: the keys are in the prompt because that is where the eye already is, and a prompt that
	// only asked left an empty red box with nothing to say what would close it. It names the agent out
	// loud too, since `delete?` on a pane you may have scrolled or arrowed to is a question about
	// nothing.
	const mark =
		confirm !== undefined
			? `delete ${confirm}?  y / n `
			: shell !== undefined
				? `! ${here(shell)} `
				: "> ";
	// The box takes its border and padding out of the width before anything else is measured.
	const width = columns - (boxed ? 4 : 0);
	// The prompt is one row and stays one row: what is worth seeing of a line still being typed is
	// its end, where the cursor is.
	const room = Math.max(0, width - mark.length - 1);
	// Red is the whole warning, and the border carries it too: the box the hand is in changes colour
	// under a line already half typed, which is what stops the answer from being reflex.
	const hue = confirm !== undefined ? "red" : shell !== undefined ? "magenta" : "cyan";
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
			//
			// What is held is drawn inverted, which is what a selection looks like everywhere else and is
			// the one thing the terminal stopped doing for us the moment the mouse was asked for. Drawn
			// into the row rather than laid over it: the highlight has to begin between two characters
			// of a line, and only the line knows where its own colours are written into it.
			...lines.map((line, index) =>
				h(
					Text,
					{ key: `${index}`, wrap: "truncate" },
					inverted(line === "" ? " " : line, held, index),
				),
			),
		),
		// Under the conversation and outside the prompt, where the answer being waited for is going to
		// appear — not in the box, which is a hand's own row and has to stay clear enough to type a
		// second question into while the first one is still being answered. A spinner alone says
		// something is happening; the number rising beside it is what separates slow from stuck, and
		// twice now the thing that looked slow was a hang. What the turn is on separates stuck on the
		// model from stuck on a test suite. It says nothing afterwards, because the feed keeps the record.
		working === undefined
			? null
			: h(
					Text,
					{ key: "working", wrap: "truncate" },
					h(Text, { color: "yellow" }, clock),
					// Cut to the pane's own width rather than the prompt's: this row rests on the box, not
					// inside it, so it has the columns the border and the padding would have taken.
					h(Text, { dimColor: true }, clipped(working.step ?? THINKING, columns - clock.length)),
				),
		// Under the clock and above the prompt: said, but not yet heard. A message typed at a busy agent
		// is queued for minutes, and put into the conversation at once it reads as one that has already
		// been taken — the answer still being written above it then looks like a reply to it. Waiting
		// here instead, it stays where the hand left it and joins the conversation when the agent does.
		//
		// One row each and the first line only, whatever was pasted: this is a queue, and a queue whose
		// rows are paragraphs eats the conversation it is waiting to be part of. The whole of it is in
		// the pane a moment later. Not dimmed — dim is how a terminal says this may be skipped, and this
		// is the opposite: it is the one thing here that has not happened yet.
		...holding.map((said, index) =>
			h(
				Text,
				{ key: `queued-${index}`, wrap: "truncate" },
				// Where the transcript will put `> `, which is why the line asks for none of its own: the
				// same row, one step short of having been said. A channel keeps its `‹telegram›` though —
				// who is waiting to be heard is exactly as worth knowing here as it is down in the pane.
				h(Text, { color: "cyan" }, "⋯ "),
				spoken(said, "").split("\n")[0] ?? "",
			),
		),
		// Outside the prompt's box and resting on it, the way the list of what a word could become
		// sits above the word in every other box that completes. Inside it, the box would grow and
		// shrink under the hand as the list filtered, which is the one thing a prompt must not do.
		...listed.map((command, index) =>
			h(
				Text,
				{ key: command.name, wrap: "truncate" },
				h(Text, { color: "cyan", bold: true }, index + from === pick ? " ▸ " : "   "),
				// Padded to the widest of the ones being shown rather than to a number written down
				// here, which the day a longer command is added becomes a name touching its own
				// description. Two columns of gap at the least, so they are never one word.
				h(Text, { bold: index + from === pick }, named[index]?.padEnd(widest + 2) ?? ""),
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
				draft.slice(Math.max(0, draft.length - room)),
				// No cursor while a question is up. There is nothing to type into it, and a block blinking
				// at the end is what made the first version of this look like it was waiting for a word.
				confirm === undefined ? h(Text, { inverse: true }, " ") : null,
			),
		),
	);
}

/**
 * The rows of a list that fit, with the one being pointed at among them.
 *
 * A list that simply took the first rows would hide the cursor the moment it moved past the bottom
 * of a short pane, and a cursor you cannot see is a keyboard pressing return at something unknown.
 */
export function framed<T>(items: readonly T[], cursor: number, height: number): readonly T[] {
	if (height <= 0) return [];
	const from = frameFrom(items.length, cursor, height);
	return items.slice(from, from + height);
}

/** The same window, said as where it starts — for a list whose rows have to know their own index. */
export function frameFrom(items: number, cursor: number, height: number): number {
	if (height <= 0) return 0;
	return Math.min(Math.max(0, cursor - height + 1), Math.max(0, items - height));
}

/**
 * What this screen is, said above the lists it is.
 *
 * The second paragraph is the one that has to be there. Everything else in this console is careful
 * about never widening what an agent may reach, and a screen that takes credentials and adds models
 * looks exactly like the place that rule was quietly dropped — so it says where what is typed here
 * goes instead: beside the operator's file, never into it, and never over what it declared.
 */
const KEYS = [
	"A key is what the proxy writes onto a request on its way out of an agent, in place of the worthless value the container holds. It is not in the sandbox, not in a transcript, and not shown again once it is here.",
	"",
	"Both lists are this plane's own, kept beside deploy/config.yaml rather than in it: what that file declares is read here and changed only there. Everything given here holds from the next turn — nothing restarts.",
];

/**
 * What the search tool is, above the three rows that decide it.
 *
 * The second paragraph is the reason this is a screen and not a line of YAML: choosing a provider
 * writes the grant that pays for it, so there is no second place to go afterwards and nothing to
 * restart. The first is why an agent cannot simply read the web itself.
 */
const SEARCHING = [
	"An agent has no route to the web of its own: it asks, and a model on the other side of one approved host does the searching and the reading and answers in prose with its sources in it.",
	"",
	"Choosing here is the whole of setting it up — the host, the key and what a search costs come with the provider, and the proxy is told to pay for that one endpoint and nothing else on it.",
];

/**
 * What this screen is, above the list of what it holds.
 *
 * Said once here rather than repeated in every section, and it is the sentence the whole screen
 * exists for: none of this is a file on the host to edit and nothing here is a reason to restart.
 */
const PLACES = [
	"Everything this plane can be given is here: the keys it pays with, what its agents think with, where they search from, everywhere they may reach, and the mailbox they are written to at.",
	"",
	"All of it is kept beside deploy/config.yaml rather than in it — what that file declares is read here and changed only there — and all of it holds from the next turn, with nothing restarted.",
];

/**
 * What the shelf is, above the list of what is on it.
 *
 * Two things, and the second is the one people arrive expecting to be false: a server on this list is
 * reached like everything else an agent reaches, so there is nowhere here to put a token.
 */
const SERVERS = [
	"A server is something somebody went and found — a URL, a command, the reading of a README — so the plane keeps it once and every agent after the first is a name off this list.",
	"",
	"None of them holds a key. A remote one is reached through the proxy like every other host, and one that wants an account is logged into from an agent that has it, with /mcp login.",
];

/**
 * What email is here, above the rows that connect it.
 *
 * The second paragraph is the choice this section exists to offer. Reading has one answer and always
 * did; sending has two, and the difference between them is whose domain the mail appears to be from
 * and whether anything ever tells you it did not arrive.
 */
const MAIL = [
	"One mailbox serves every agent: mail to you+scout@ is scout's and mail to you+clerk@ is clerk's, so connecting this is a thing done once, including for the agents that do not exist yet.",
	"",
	"Reading is IMAP, which wants no domain and nothing open on this machine. Sending is either the mailbox's own server, or a company that carries mail for a domain of yours and says whether it landed.",
	"",
	"Whose mail is read is a list rather than one address, and everybody on it instructs every agent. *@company.com is everyone at a domain, checked against the domain that signed the mail rather than the one it claims to be from.",
];

/**
 * What a grant is, above the list of the ones there are.
 *
 * The second paragraph is the whole of why this section is allowed to exist. Everywhere else this
 * console is careful never to widen what an agent may reach, and a screen with a box that opens hosts
 * looks exactly like the place that rule was dropped — so it says what the box can and cannot do:
 * reach, never a credential, and still through the proxy and still in the log.
 */
const REACH = [
	"An agent has no route out of its own: the sandbox sits on a network with nowhere to go, and every request it makes is one the proxy was told beforehand to allow. A host that is not on this list is a connection refused.",
	"",
	"A host opened here carries nothing. Keys are attached by name, in deploy/config.yaml, and that is the half of a grant this screen has no box for — so what is added here widens where an agent may go and not one thing about what it may spend.",
];

/** How many people a line of the mail list stands for, when it stands for more than one. */
function whoIs(entry: string): string {
	return entry.startsWith("*@") ? `everyone at ${entry.slice(2)}` : "";
}

/** The part of a grant that is narrower than its host, or nothing when it is the whole of it. */
function under(grant: GrantStanding): string {
	return [grant.pathPrefix ?? "", (grant.methods ?? []).join(" ")]
		.filter((part) => part.length > 0)
		.join("  ");
}

/** Which of the four lists a row came off, in the column that says so. */
const WHENCE: Readonly<Record<GrantOrigin, string>> = {
	file: "from the file",
	here: "opened here",
	model: "with a model",
	search: "for searching",
};

/** The same fact under the cursor, said as where it is changed instead of where it came from. */
const LEDGER: Readonly<Record<GrantOrigin, string>> = {
	file: "declared in deploy/config.yaml",
	here: "opened here   ⌫ closes it",
	// Short enough that the half worth having survives a narrow terminal: what brings a grant is
	// already in the column above, and where it is changed is the only part that is not.
	model: "a model brings it — change it in the models section",
	search: "the search brings it — change it in the search section",
};

/** A part of this plane with something to set, which is one row of the list this screen opens on. */
export type Section = (typeof CONFIG_SECTIONS)[number];

/** In the order they are walked, which is the order they are usually needed in. */
const SECTION_ORDER: readonly Section[] = CONFIG_SECTIONS;

const SECTIONS: Readonly<
	Record<Section, { readonly does: string; readonly said: readonly string[] }>
> = {
	models: { does: "the providers this plane can pay, and what its agents think with", said: KEYS },
	search: { does: "where web_search goes, and what a search costs", said: SEARCHING },
	grants: { does: "the hosts the agents may reach, and what they carry there", said: REACH },
	mcp: { does: "the servers on the shelf, and which agents hold them", said: SERVERS },
	email: { does: "the mailbox agents are reached at, and whose mail they read", said: MAIL },
};

/** The three facts about searching, in the order a hand fills them in. */
const SEARCH_FIELDS = ["provider", "model", "key"] as const;

/** What the mailbox's own submission server is called on a list of companies that are not it. */
const OWN_SERVER = "the mailbox's own server";

/**
 * The one thing about email that is typed rather than picked, and which of the three it is.
 *
 * Three, because connecting a mailbox is two questions with a round trip between them: the address
 * decides whether there is any point asking for a password, and on half the providers the answer is
 * that this account cannot be reached this way at all.
 */
export type MailField = "address" | "password" | "domain";

/** A row on the config screen: a section to open, a key to fill in, a model, or the row that adds one. */
export type ConfigRow =
	| { readonly kind: "section"; readonly section: Section }
	| { readonly kind: "provider"; readonly provider: ProviderStanding }
	| { readonly kind: "model"; readonly model: ModelStanding }
	| { readonly kind: "add" }
	| { readonly kind: "search"; readonly field: (typeof SEARCH_FIELDS)[number] }
	| { readonly kind: "server"; readonly server: ServerStanding }
	| { readonly kind: "add-server" }
	| { readonly kind: "grant"; readonly grant: GrantStanding }
	| { readonly kind: "add-grant" }
	| { readonly kind: "mail"; readonly field: "mailbox" | "carrier" | "domain" | "key" }
	/** One line of the list of who may write, which is an address or a whole domain. */
	| { readonly kind: "sender"; readonly entry: string }
	| { readonly kind: "add-sender" };

/**
 * The screen's rows in the order the arrows walk them, headers and blank lines left out.
 *
 * Shared with the keyboard rather than built twice, because what return does depends on which row it
 * is standing on — and a cursor counting one list while the screen draws another is a key pressed at
 * something other than what is highlighted.
 *
 * Which rows there are depends on the section that is open, and the sections themselves are the rows
 * when none is: one list at a time, because the four things there are to configure here share nothing
 * but the file they are kept in, and a single list of all of them would be a screen to scroll rather
 * than a screen to read.
 */
export function configRows(
	section: Section | undefined,
	providers: readonly ProviderStanding[],
	models: readonly ModelStanding[],
	servers: readonly ServerStanding[],
	grants: readonly GrantStanding[],
	mail?: MailStanding | undefined,
): readonly ConfigRow[] {
	if (section === undefined) {
		return SECTION_ORDER.map((one) => ({ kind: "section", section: one }) as const);
	}
	if (section === "search") {
		return SEARCH_FIELDS.map((field) => ({ kind: "search", field }) as const);
	}
	// The rows that mean something and no others: with the mailbox's own server carrying the mail there
	// is no key to pay it with, and most carriers work out the domain from the address they are given.
	// A row that can only ever say "not applicable" is a row somebody presses return on to find out.
	if (section === "email") {
		const carrier = mail === undefined ? undefined : CARRIERS[mail.carrier];
		return [
			{ kind: "mail", field: "mailbox" } as const,
			{ kind: "mail", field: "carrier" } as const,
			...(carrier?.needsDomain === true ? [{ kind: "mail", field: "domain" } as const] : []),
			...(carrier !== undefined ? [{ kind: "mail", field: "key" } as const] : []),
			// Below the mailbox rather than beside them, because it is the half that keeps being edited:
			// the account is connected once, and who may write to it changes every time somebody joins.
			// Nothing to add to until there is a mailbox — a list of people who may write to no address.
			...(mail?.mailbox === undefined
				? []
				: [
						...mail.senders.map((entry) => ({ kind: "sender", entry }) as const),
						{ kind: "add-sender" } as const,
					]),
		];
	}
	if (section === "mcp") {
		return [
			...servers.map((server) => ({ kind: "server", server }) as const),
			{ kind: "add-server" } as const,
		];
	}
	if (section === "grants") {
		return [
			...grants.map((grant) => ({ kind: "grant", grant }) as const),
			{ kind: "add-grant" } as const,
		];
	}
	return [
		...providers.map((provider) => ({ kind: "provider", provider }) as const),
		...models.map((model) => ({ kind: "model", model }) as const),
		{ kind: "add" } as const,
	];
}

/**
 * The offers left once what has been typed is taken as a narrowing of them.
 *
 * Every word has to appear somewhere in the provider or the name, in any order, so that "openai
 * mini" is a way of saying it and so is "mini openai". Shared with the keyboard for the same reason
 * the rows are: the one that gets added is the one that is highlighted, and two filters would
 * eventually disagree about which that is.
 */
export function matching(offers: readonly ModelOffer[], filter: string): readonly ModelOffer[] {
	const words = filter
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word.length > 0);
	return offers.filter((offer) => {
		const both = `${offer.provider} ${offer.id}`.toLowerCase();
		return words.every((word) => both.includes(word));
	});
}

/**
 * What there is to set here, one section at a time.
 *
 * A screen rather than a command, because all of it is a list to look down: the questions it answers
 * are which keys are missing and what searching costs, and a command that answered them one provider
 * at a time would be a question you have to already know how to ask.
 */
export function Config({
	/** Which section is open, or nothing while the list of them is what the arrows are walking. */
	section,
	providers,
	models,
	/** Where searching goes, or nothing while the plane is still being asked. */
	search,
	/** Every server on the shelf, with who holds each. */
	servers,
	/** Everywhere every agent may go, in the order the proxy tries them. */
	grants,
	/** The mailbox and the way its mail leaves, or nothing while the plane is still being asked. */
	mail,
	/** The one line of the mailbox being typed out, and which of the three it is. */
	mailing,
	cursor,
	/** The key being filled in, named by its variable, or nothing while the list has the keyboard. */
	typing,
	secret,
	/** The model being written out, as far as it has been typed, or nothing when none is. */
	adding,
	/** The server being shelved, as far as it has been typed, or nothing when none is. */
	shelving,
	/** The host being opened, as far as it has been typed, or nothing when none is. */
	opening,
	/** The address or domain being let in, as far as it has been typed, or nothing when none is. */
	admitting,
	/** The server a forget was asked about, while the answer is still being waited for. */
	forgetting,
	/** The model or host a drop was asked about, while the answer is still being waited for. */
	dropping,
	/** Everything the keys this plane holds could buy, or nothing while the providers are being asked. */
	offers,
	/** One of a short list being picked off it — a search provider, or one of its models. */
	choosing,
	/** Which of the offers left after `adding` narrowed them, or of `choosing`, the arrows stand on. */
	pick,
	/** What the plane said instead of answering, when it did that. */
	unanswered,
	rows,
	columns,
}: {
	readonly section: Section | undefined;
	readonly providers: readonly ProviderStanding[];
	readonly models: readonly ModelStanding[];
	readonly search: SearchStanding | undefined;
	readonly servers: readonly ServerStanding[];
	readonly grants: readonly GrantStanding[];
	readonly mail?: MailStanding | undefined;
	readonly mailing?: { readonly field: MailField; readonly text: string } | undefined;
	/**
	 * Which row the arrows are on, or -1 while they are still the column's and no row is theirs. Drawn
	 * with nothing pointed at then, the way the log feed beside it is: a highlight on a list that would
	 * not answer the next arrow is a cursor in the wrong place.
	 */
	readonly cursor: number;
	readonly typing: string | undefined;
	readonly secret: string;
	readonly adding: string | undefined;
	readonly shelving?: string | undefined;
	readonly opening?: string | undefined;
	readonly admitting?: string | undefined;
	readonly forgetting?: string | undefined;
	readonly dropping?: string | undefined;
	readonly offers?: readonly ModelOffer[] | undefined;
	readonly choosing?: { readonly what: string; readonly among: readonly string[] } | undefined;
	readonly pick?: number;
	readonly unanswered: string | undefined;
	readonly rows: number;
	readonly columns: number;
}): ReactElement {
	const boxed = rows > PROMPT_ROWS;
	const widest = Math.max(0, ...providers.map((provider) => provider.id.length));
	const widestKey = Math.max(0, ...providers.map((provider) => provider.keyEnv.length));
	const widestModel = Math.max(0, ...models.map((model) => model.id.length));
	const widestProvider = Math.max(0, ...models.map((model) => model.provider.length));
	const dim = (line: string): string => (line === "" ? "" : `${ESC}[2m${line}${ESC}[22m`);
	const said = (section === undefined ? PLACES : SECTIONS[section].said).map(dim);
	const walked = configRows(section, providers, models, servers, grants, mail);
	const row = walked[Math.min(cursor, walked.length - 1)];
	// Above the list, because it is why the list says what it says — and when the plane refused to
	// answer at all, it is the only thing standing between an empty screen and a wrong conclusion.
	const trouble =
		unanswered === undefined
			? []
			: [h(Text, { key: "unanswered", color: "red", wrap: "truncate" }, unanswered)];
	const listed: ReactElement[] = [];
	// Where the cursor ends up once the headers and the blank between the two lists are counted in.
	// The list is framed by what is drawn, and the cursor has to be framed by the same thing or a
	// short pane scrolls the highlight off its own screen.
	let at = 0;
	const heading = (label: string): ReactElement =>
		h(Text, { key: `heading-${label}`, dimColor: true, wrap: "truncate" }, label);
	// The prose above ends where the list begins, and without this the two run together into one
	// paragraph with rows in it.
	listed.push(h(Text, { key: "before" }, " "));
	// A short list being picked off, which is what a setting with a handful of known answers is. It is
	// drawn like the offers below and unlike them takes nothing typed: every answer is already on it,
	// so a box to write in would be a box whose only use is getting the spelling wrong.
	if (choosing !== undefined) {
		const on = Math.min(Math.max(0, pick ?? 0), Math.max(0, choosing.among.length - 1));
		listed.push(heading(choosing.what));
		for (const [index, one] of choosing.among.entries()) {
			if (index === on) at = listed.length;
			listed.push(
				h(
					Text,
					{ key: `among-${one}`, wrap: "truncate" },
					h(Text, { color: index === on ? "cyan" : "gray" }, index === on ? "›" : " "),
					h(Text, pointed(index === on, true), ` ${one}`),
				),
			);
		}
		return configScreen({
			listed,
			at,
			trouble,
			said,
			prompt: { kind: "dim", text: "⏎ takes the one the arrows are on" },
			boxed,
			rows,
			columns,
		});
	}
	if (adding !== undefined) {
		const found = offers === undefined ? [] : matching(offers, adding);
		const on = Math.min(Math.max(0, pick ?? 0), Math.max(0, found.length - 1));
		const widestOffer = Math.max(0, ...found.map((offer) => offer.id.length));
		// Written out is the way through whenever the list is not: a provider nothing here has a
		// catalog for, a key that has not been given yet, a name of your own. So it is said on every
		// row that has nothing to pick, which are the rows where somebody is about to need it.
		const byHand = "or write it out, as: name provider [the provider's own name for it]";
		if (offers === undefined) {
			listed.push(
				h(Text, { key: "asking", dimColor: true }, "asking every provider this plane can pay…"),
			);
		} else if (offers.length === 0) {
			listed.push(
				h(Text, { key: "none", dimColor: true, wrap: "truncate" }, "no key is held here yet —"),
			);
			listed.push(h(Text, { key: "byhand", dimColor: true, wrap: "truncate" }, byHand));
		} else if (found.length === 0) {
			listed.push(
				h(
					Text,
					{ key: "nomatch", dimColor: true, wrap: "truncate" },
					"nothing on offer matches that —",
				),
			);
			listed.push(h(Text, { key: "byhand", dimColor: true, wrap: "truncate" }, byHand));
		} else {
			listed.push(heading(`${found.length} on offer`));
			for (const [index, offer] of found.entries()) {
				if (index === on) at = listed.length;
				listed.push(
					h(
						Text,
						{ key: `offer-${offer.provider}-${offer.id}`, wrap: "truncate" },
						h(Text, { color: index === on ? "cyan" : "gray" }, index === on ? "›" : " "),
						h(Text, pointed(index === on, true), ` ${offer.id.padEnd(widestOffer + 2)}`),
						h(Text, { dimColor: true }, offer.provider),
					),
				);
			}
		}
		return configScreen({
			listed,
			at,
			trouble,
			said,
			prompt: { kind: "typed", mark: "model  ", text: adding, secret: false },
			boxed,
			rows,
			columns,
		});
	}
	// The list this screen opens on, which is the only place the four things it holds are one list.
	// Each row says what its section is for, because a column of bare nouns is a screen you have to
	// open every row of to find out which one you came here for.
	if (section === undefined) {
		const paid = providers.filter((provider) => provider.held).length;
		for (const [index, one] of SECTION_ORDER.entries()) {
			// Filled in when that section is something this plane could actually use right now: a model
			// it holds the key for, a search it can pay for, a server some agent was given. It is the
			// same dot the agents column uses.
			const ready =
				one === "models"
					? models.some((model) => model.held)
					: one === "search"
						? search?.held === true
						: one === "email"
							? mail?.mailbox !== undefined
							: one === "grants"
								? grants.length > 0
								: servers.some((server) => server.agents.length > 0);
			const mark = ready ? MARKS.running : MARKS.stopped;
			if (index === cursor) at = listed.length;
			listed.push(
				h(
					Text,
					{ key: `section-${one}`, wrap: "truncate" },
					h(Text, { color: mark.color }, mark.glyph),
					h(Text, pointed(index === cursor, ready), ` ${one.padEnd(10)}`),
					h(Text, { dimColor: true }, SECTIONS[one].does),
				),
			);
		}
		const open = walked[Math.min(cursor, walked.length - 1)];
		const which = open?.kind === "section" ? open.section : "models";
		return configScreen({
			listed,
			at,
			trouble,
			said,
			// What that section holds as it stands, which is the fact a row saying what it is for cannot
			// carry: the point of the list is finding the one thing that is not set up yet.
			prompt: {
				kind: "dim",
				text:
					which === "models"
						? `${models.length} to think with, ${paid} of ${providers.length} providers paid for`
						: which === "email"
							? mail === undefined
								? "asking the plane…"
								: mail.mailbox === undefined
									? "no mailbox, so nobody can write to an agent"
									: `${mail.mailbox}${mail.writes ? "" : "   reading only"}`
							: which === "mcp"
								? servers.length === 0
									? "nothing on the shelf yet"
									: `${servers.length} on the shelf, ${servers.filter((server) => server.agents.length > 0).length} of them given to somebody`
								: which === "grants"
									? grants.length === 0
										? "nowhere at all — every request an agent makes is refused"
										: `${grants.length} hosts, ${grants.filter((grant) => grant.origin === "here").length} opened here`
									: search === undefined
										? "asking the plane…"
										: search.held
											? `${search.provider} ${search.model}   $${search.perSearchUsd.toFixed(3)} a search`
											: `${search.keyEnv}   no key, refused at the proxy`,
			},
			boxed,
			rows,
			columns,
		});
	}
	if (section === "search") {
		// The same dot on all three, because none of them is in force without the key: a provider and a
		// model chosen against a key this plane does not hold is a search that is refused at the proxy.
		const mark = search?.held === true ? MARKS.running : MARKS.stopped;
		const value = (field: (typeof SEARCH_FIELDS)[number]): string =>
			search === undefined
				? "…"
				: field === "provider"
					? search.provider
					: field === "model"
						? search.model
						: search.keyEnv;
		for (const [index, field] of SEARCH_FIELDS.entries()) {
			if (index === cursor) at = listed.length;
			listed.push(
				h(
					Text,
					{ key: `search-${field}`, wrap: "truncate" },
					h(Text, { color: mark.color }, mark.glyph),
					h(Text, pointed(index === cursor, search?.held === true), ` ${field.padEnd(10)}`),
					h(Text, { dimColor: true }, value(field)),
				),
			);
		}
		const field = row?.kind === "search" ? row.field : "provider";
		return configScreen({
			listed,
			at,
			trouble,
			said,
			prompt:
				typing !== undefined
					? { kind: "typed", mark: `key for ${typing}  `, text: secret, secret: true }
					: {
							kind: "dim",
							// What the row costs or where its key came from, which is the half of each of these
							// three that no column has room for and the half worth knowing before pressing return.
							text:
								search === undefined
									? "asking the plane…"
									: field === "provider"
										? `${Object.keys(SEARCH_PROVIDERS).length} to search with   $${search.perSearchUsd.toFixed(3)} a search here`
										: field === "model"
											? `$${search.rate.input.toFixed(2)} in, $${search.rate.output.toFixed(2)} out, per million tokens`
											: search.here
												? `${search.keyEnv}   set here`
												: search.held
													? `${search.keyEnv}   from this plane's environment`
													: `${search.keyEnv}   no key, refused at the proxy`,
						},
			boxed,
			rows,
			columns,
		});
	}
	if (section === "email") {
		const carrier = mail === undefined ? undefined : CARRIERS[mail.carrier];
		// One dot per half, because the two fail for unrelated reasons: a mailbox nobody connected is a
		// channel that is not there, and a carrier nobody paid for is a channel that reads and cannot
		// answer. A single dot over both would go out for either and say which for neither.
		const value = (field: ConfigRow & { kind: "mail" }): { text: string; on: boolean } => {
			if (mail === undefined) return { text: "…", on: false };
			if (field.field === "mailbox") {
				return { text: mail.mailbox ?? "nothing connected", on: mail.mailbox !== undefined };
			}
			if (field.field === "carrier") {
				return { text: carrier?.title ?? OWN_SERVER, on: mail.writes };
			}
			if (field.field === "domain") {
				return { text: mail.domain.length > 0 ? mail.domain : "not said yet", on: mail.writes };
			}
			return { text: mail.keyEnv ?? "", on: mail.held };
		};
		const senders = mail?.senders ?? [];
		const widestSender = Math.max(0, ...senders.map((entry) => entry.length));
		// The heading goes in once, above whichever of the two rows comes first — the list is empty on
		// a mailbox nobody has paired, and an unlabelled `+ an address` under the key row would be a row
		// offering to add an address to something the screen never named.
		let labelled = false;
		for (const [index, one] of walked.entries()) {
			if (one.kind !== "mail" && !labelled) {
				labelled = true;
				listed.push(h(Text, { key: "between" }, " "));
				listed.push(heading("who may write"));
			}
			if (index === cursor) at = listed.length;
			if (one.kind === "mail") {
				const { text, on } = value(one);
				const mark = on ? MARKS.running : MARKS.stopped;
				listed.push(
					h(
						Text,
						{ key: `mail-${one.field}`, wrap: "truncate" },
						h(Text, { color: mark.color }, mark.glyph),
						h(Text, pointed(index === cursor, on), ` ${one.field.padEnd(10)}`),
						h(Text, { dimColor: true }, text),
					),
				);
				continue;
			}
			if (one.kind === "sender") {
				listed.push(
					h(
						Text,
						{ key: `sender-${one.entry}`, wrap: "truncate" },
						// Filled on every row, the way the grants list is: each line here is somebody whose
						// mail is being read right now, and a mark that varied would be a second question.
						h(Text, { color: MARKS.running.color }, MARKS.running.glyph),
						h(Text, pointed(index === cursor, true), ` ${one.entry.padEnd(widestSender + 2)}`),
						// What a wildcard actually admits, spelled out beside it. `*@company.com` is eleven
						// characters that stand for a number of people nobody counted, and the line that says
						// so is the difference between reading the list and trusting it.
						h(Text, { dimColor: true }, whoIs(one.entry)),
					),
				);
				continue;
			}
			if (one.kind === "add-sender") {
				listed.push(
					h(
						Text,
						{ key: "add-sender", wrap: "truncate" },
						h(Text, { dimColor: true }, "+"),
						h(Text, pointed(index === cursor, false), " an address"),
					),
				);
			}
		}
		const field = row?.kind === "mail" ? row.field : "mailbox";
		/**
		 * The half of the row under the cursor that no column had room for.
		 *
		 * A function rather than another arm of the chain below, because there are now nine rows this
		 * has to answer for and a ternary that deep is a paragraph nobody can check against the screen.
		 */
		const underneath = (): string => {
			if (mail === undefined) return "asking the plane…";
			if (row?.kind === "sender") {
				return "read as instructions, and answered from the agent's address   ⌫ stops it";
			}
			if (row?.kind === "add-sender") {
				// The other way onto the list, while it is still open: the phrase works from a phone, with
				// nothing typed here, and it is how the list was filled before this row existed. It is gone
				// from the row the moment somebody is on the list, because the phrase is spent by then.
				if (mail.phrase !== undefined) {
					return `an address, or mail "${mail.phrase}" to the mailbox from your own`;
				}
				// The two shapes, on the row that takes them, because a box that only accepted one of them
				// would be a box you find out about by getting it wrong.
				return "an address, or *@company.com for everyone at a domain";
			}
			if (field === "mailbox") {
				return (
					mail.trouble ??
					(mail.mailbox === undefined
						? "an address, then the app password your provider issued for it"
						: `${mail.host}   ⌫ disconnects it`)
				);
			}
			if (field === "carrier") {
				return `${Object.keys(CARRIERS).length} to send with, or the server the mailbox came with`;
			}
			if (field === "domain") {
				return `${carrier?.title ?? "a carrier"} sends only for a domain it was set up for`;
			}
			if (mail.here) return `${mail.keyEnv}   set here`;
			return mail.held
				? `${mail.keyEnv}   from this plane's environment`
				: `${mail.keyEnv}   no key, so nothing can be sent`;
		};
		return configScreen({
			listed,
			at,
			trouble,
			said,
			prompt:
				typing !== undefined
					? { kind: "typed", mark: `key for ${typing}  `, text: secret, secret: true }
					: mailing !== undefined
						? {
								kind: "typed",
								mark: mailing.field === "domain" ? "domain  " : `${mailing.field}  `,
								text: mailing.text,
								// The app password, never drawn back. It is the one thing on this screen that lets
								// whoever has it read every message in the account, tagged or not.
								secret: mailing.field === "password",
							}
						: admitting !== undefined
							? { kind: "typed", mark: "may write  ", text: admitting, secret: false }
							: forgetting !== undefined
								? {
										kind: "dim",
										text: `forget the mailbox at ${forgetting}? every agent stops being reachable — y or n`,
									}
								: dropping !== undefined
									? {
											kind: "dim",
											// What stops rather than what is being removed: the answer to this question is
											// silence at the other end, and the person on that row is never told.
											text: `stop reading mail from ${dropping}? nothing they write is answered after — y or n`,
										}
									: { kind: "dim", text: underneath() },
			boxed,
			rows,
			columns,
		});
	}
	if (section === "mcp") {
		const widestName = Math.max(0, ...servers.map((server) => server.name.length));
		for (const [index, server] of servers.entries()) {
			// Filled in when somebody has it, because a server on the shelf that no agent was given is
			// a URL written down: nothing is reaching it and nothing will until it is handed out.
			const has = server.agents.length > 0;
			const mark = has ? MARKS.running : MARKS.stopped;
			if (index === cursor) at = listed.length;
			listed.push(
				h(
					Text,
					{ key: `server-${server.name}`, wrap: "truncate" },
					h(Text, { color: mark.color }, mark.glyph),
					h(Text, pointed(index === cursor, has), ` ${server.name.padEnd(widestName + 2)}`),
					h(Text, { dimColor: true }, written(server.server)),
				),
			);
		}
		if (servers.length === cursor) at = listed.length;
		listed.push(
			h(
				Text,
				{ key: "add-server", wrap: "truncate" },
				h(Text, { color: "gray" }, " "),
				h(Text, pointed(servers.length === cursor, false), " + a server"),
			),
		);
		const standing = row?.kind === "server" ? row.server : undefined;
		return configScreen({
			listed,
			at,
			trouble,
			said,
			prompt:
				shelving !== undefined
					? { kind: "typed", mark: "server  ", text: shelving, secret: false }
					: forgetting !== undefined
						? // What it takes away rather than what it is called: this one comes off every agent that
							// had it, and the row under the cursor shows only one of them.
							{
								kind: "dim",
								text: `forget "${forgetting}"? it comes off every agent holding it — y or n`,
							}
						: {
								kind: "dim",
								// Who has it, which is the fact the row itself cannot carry and the one that decides
								// whether the row is doing anything at all.
								text:
									standing === undefined
										? "a name, then a URL to reach it at or a command to start it with"
										: standing.agents.length === 0
											? "nobody has it yet — ⏎ gives it to an agent"
											: `${standing.agents.join(", ")}${standing.loggedIn ? "   (logged in)" : ""}`,
							},
			boxed,
			rows,
			columns,
		});
	}
	if (section === "grants") {
		const widestHost = Math.max(0, ...grants.map((grant) => grant.host.length));
		const widestUnder = Math.max(0, ...grants.map((grant) => under(grant).length));
		for (const [index, grant] of grants.entries()) {
			if (index === cursor) at = listed.length;
			listed.push(
				h(
					Text,
					{ key: `grant-${grant.id}`, wrap: "truncate" },
					// Filled on every row, because every row is a grant in force: this list is the answer to
					// "can it reach that", and a mark that varied would be a second question over the first.
					h(Text, { color: MARKS.running.color }, MARKS.running.glyph),
					h(Text, pointed(index === cursor, true), ` ${grant.host.padEnd(widestHost + 2)}`),
					h(Text, { dimColor: true }, under(grant).padEnd(widestUnder + 2)),
					// Which of the four lists it came off, said on the row rather than only under it: three
					// of the four refuse the key that drops one, and a list that looked uniform would be a
					// list where that refusal arrives as a surprise.
					h(Text, { dimColor: true }, WHENCE[grant.origin]),
				),
			);
		}
		if (grants.length === cursor) at = listed.length;
		listed.push(
			h(
				Text,
				{ key: "add-grant", wrap: "truncate" },
				h(Text, { dimColor: true }, "+"),
				h(Text, pointed(grants.length === cursor, false), " a host"),
			),
		);
		const standing = row?.kind === "grant" ? row.grant : undefined;
		return configScreen({
			listed,
			at,
			trouble,
			said,
			prompt:
				opening !== undefined
					? { kind: "typed", mark: "host  ", text: opening, secret: false }
					: dropping !== undefined
						? // What it takes away rather than what it is called: this comes off every agent, and
							// the row under the cursor is the plane's list rather than one agent's.
							{ kind: "dim", text: `close "${dropping}"? no agent reaches it after — y or n` }
						: {
								kind: "dim",
								// What is attached on the way out, which is the fact the host cannot carry and the
								// one that decides whether this row is worth being careful about.
								text:
									standing === undefined
										? "a host every agent may reach, like api.chess.com — or * for the whole web"
										: `${standing.carries === undefined ? "carries nothing" : `carries ${standing.carries}`}   ${LEDGER[standing.origin]}`,
							},
			boxed,
			rows,
			columns,
		});
	}
	listed.push(heading("providers"));
	// The same marks the agents column uses, and they mean the same thing here: a dot that is filled
	// in is something this plane can actually use right now.
	for (const [index, provider] of providers.entries()) {
		const mark = provider.held ? MARKS.running : MARKS.stopped;
		if (index === cursor) at = listed.length;
		listed.push(
			h(
				Text,
				{ key: provider.keyEnv, wrap: "truncate" },
				h(Text, { color: mark.color }, mark.glyph),
				h(Text, pointed(index === cursor, provider.held), ` ${provider.id.padEnd(widest + 2)}`),
				h(Text, { dimColor: true }, provider.keyEnv.padEnd(widestKey + 2)),
				// What is waiting on this key, which is the whole reason one row matters more than another.
				// A provider with no models is still listed: it is how a second one gets set up at all.
				h(
					Text,
					{ dimColor: provider.models.length === 0 },
					provider.models.length === 0 ? "no models" : provider.models.join(" "),
				),
			),
		);
	}
	listed.push(h(Text, { key: "between" }, " "));
	listed.push(heading("models"));
	for (const [index, model] of models.entries()) {
		const mark = model.held ? MARKS.running : MARKS.stopped;
		const on = providers.length + index;
		if (on === cursor) at = listed.length;
		listed.push(
			h(
				Text,
				{ key: `model-${model.id}`, wrap: "truncate" },
				h(Text, { color: mark.color }, mark.glyph),
				h(Text, pointed(on === cursor, model.held), ` ${model.id.padEnd(widestModel + 2)}`),
				h(Text, { dimColor: true }, model.provider.padEnd(widestProvider + 2)),
				// Which of the two lists this row can be taken out of, said on the row rather than only
				// under it: half of them refuse the key that drops one, and a list that looked uniform
				// would be a list where that refusal arrives as a surprise.
				h(Text, { dimColor: true }, model.added ? "added here" : "from the file"),
			),
		);
	}
	if (cursor >= providers.length + models.length) at = listed.length;
	listed.push(
		h(
			Text,
			{ key: "add", wrap: "truncate" },
			h(Text, { dimColor: true }, "+"),
			h(Text, pointed(cursor >= providers.length + models.length, false), " a model"),
		),
	);
	// What the row the cursor is on is, which is the one thing a column of marks cannot say: a key
	// this plane was started with is changed by editing `.env`, and one given here is not.
	const from =
		row?.kind === "model"
			? // The provider's own name for it, which is the one part of a model the row has no column
				// for and the part that decides what is actually being paid for.
				row.model.added
				? `${row.model.model}   added here`
				: `${row.model.model}   declared in deploy/config.yaml`
			: row?.kind === "provider"
				? row.provider.here
					? `${row.provider.keyEnv}   set here`
					: row.provider.held
						? `${row.provider.keyEnv}   from this plane's environment`
						: // Short enough to survive a narrow terminal: the line is truncated rather than wrapped,
							// and the half that gets cut is the half that says what is wrong.
							`${row.provider.keyEnv}   no key, refused at the proxy`
				: "a model to think with, as: name provider [the provider's own name for it]";
	return configScreen({
		listed,
		at,
		trouble,
		said,
		prompt:
			typing !== undefined
				? // Never the characters. A key is read off a screen by whoever is behind the person typing
					// it, and this is a terminal that keeps its own scrollback.
					{ kind: "typed", mark: `key for ${typing}  `, text: secret, secret: true }
				: dropping !== undefined
					? // The question where the answer is typed, the way every other one on this screen is
						// asked: the keys are in the prompt, and nothing else has them while it is open.
						{ kind: "dim", text: `drop "${dropping}"? no agent thinks with it after — y or n` }
					: { kind: "dim", text: from },
		boxed,
		rows,
		columns,
	});
}

/**
 * The config screen's two halves: a list that takes the room it needs, and a prompt under it.
 *
 * Both of the things this screen does are a list and a line to type into, and drawing that twice was
 * how the list of models ended up scrolling differently from the list of keys.
 */
function configScreen({
	listed,
	at,
	trouble,
	said,
	prompt,
	boxed,
	rows,
	columns,
}: {
	readonly listed: readonly ReactElement[];
	readonly at: number;
	readonly trouble: readonly ReactElement[];
	readonly said: readonly string[];
	/** Either something being typed, which has the keyboard, or a dim line about the row under it. */
	readonly prompt:
		| {
				readonly kind: "typed";
				readonly mark: string;
				readonly text: string;
				readonly secret: boolean;
		  }
		| { readonly kind: "dim"; readonly text: string };
	readonly boxed: boolean;
	readonly rows: number;
	readonly columns: number;
}): ReactElement {
	const width = columns - (boxed ? 4 : 0);
	const room = Math.max(0, width - (prompt.kind === "typed" ? prompt.mark.length : 0) - 1);
	const height = chatRows(rows);
	// The list is what this screen is, so it takes the rows it needs and the prose above it is what
	// gives way — the other way round and a short terminal shows three paragraphs and no providers.
	const all = [...trouble, ...listed];
	const kept =
		all.length <= height
			? all
			: [...trouble, ...framed(listed, at, Math.max(0, height - trouble.length))];
	const head = visible(wrapped(said, columns, true), Math.max(0, height - kept.length), undefined);
	return h(
		Box,
		{ flexDirection: "column", flexGrow: 1 },
		h(
			Box,
			{ flexDirection: "column", flexGrow: 1, justifyContent: "flex-end", key: "list" },
			...head.map((line, index) =>
				h(Text, { key: `said${index}`, wrap: "truncate" }, line === "" ? " " : line),
			),
			...kept,
		),
		h(
			Box,
			boxed
				? {
						key: "prompt",
						borderStyle: "round",
						borderColor: prompt.kind === "typed" ? "cyan" : "gray",
						paddingX: 1,
					}
				: { key: "prompt" },
			prompt.kind === "dim"
				? h(Text, { wrap: "truncate", dimColor: true }, prompt.text)
				: h(
						Text,
						{ wrap: "truncate" },
						h(Text, { color: "cyan" }, prompt.mark),
						(prompt.secret ? "•".repeat(prompt.text.length) : prompt.text).slice(
							Math.max(0, prompt.text.length - room),
						),
						h(Text, { inverse: true }, " "),
					),
		),
	);
}

function Logs({
	lines,
	rows,
	top,
	held,
}: {
	readonly lines: readonly string[];
	readonly rows: number;
	readonly top: number | undefined;
	/** The rows a drag is holding, counted from the first one this pane is showing. */
	readonly held: Span | undefined;
}): ReactElement {
	return h(
		Box,
		// The newest line against the bottom edge, which is where a feed being watched is read.
		{ flexDirection: "column", flexGrow: 1, justifyContent: "flex-end" },
		...visible(lines, rows, top).map((line, index) =>
			h(
				Text,
				{ key: `${index}`, wrap: "truncate" },
				inverted(line === "" ? " " : line, held, index),
			),
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
	// One place in one list, which is the whole of where this console is pointed. The panel and the
	// agent used to be two selections crossed with each other, and half of the pairs meant nothing:
	// the log feed with `demo` picked behind it is the same screen as the log feed with `maxi`.
	// Clamped where it is read rather than where it is set: an agent can go away under the cursor, and
	// the rows below would then shift up, so a removal would land you on the config screen.
	const [raw, setSpot] = useState(0);
	const spot = Math.min(raw, agents.length + PLANE_ROWS);
	const panel = panelAt(spot, agents.length);
	const [lines, setLines] = useState<readonly string[]>([]);
	// One for the life of the console, because both the plane's stream and the ports this console
	// opens write into it and the folding it does is per agent across everything it has been told.
	const [feed] = useState(
		() =>
			new LogFeed(
				(line) => setLines((prev) => [...prev, line.replace(/\n$/, "")].slice(-REMEMBERED_LINES)),
				{ color: true },
			),
	);
	const [talk, setTalk] = useState<Talk>(conversations);
	// What has been said to each agent that the agent has not been told yet, because it was mid-turn
	// when it arrived. Held apart from the conversation until the turn that takes it starts, and then
	// moved into it whole — the plane has already written it down, so this is only about where it is
	// drawn. Empty when a console opens: what is queued now is a fact about this minute, and a
	// transcript replayed tomorrow is not being waited on by anybody.
	// Kept in a ref with the state beside it only for drawing. Two of the plane's events can arrive in
	// one chunk and both be answered before a single render happens between them, and the second of
	// them is the one that empties this: read back off a render that has not happened yet, it would
	// empty it of nothing and the message somebody typed would be gone.
	const queue = useRef<Talk>(new Map());
	const [waiting, setWaiting] = useState<Talk>(queue.current);
	// An answer being written, which is not in the transcript yet because it is not finished. Kept
	// apart from the conversation so that when it is finished it replaces itself rather than repeats.
	const [live, setLive] = useState<ReadonlyMap<string, string>>(new Map());
	const [draft, setDraft] = useState("");
	// How far back through what was already said the prompt has been walked, or nothing while it is
	// standing on the line being typed. Dropped whenever the prompt is about something else.
	const [recalling, setRecalling] = useState<Walk | undefined>(undefined);
	// What the last tab found and could not settle, kept against the line it was found for: a draft
	// that has moved on since is a list about a word nobody is typing any more, so the menu below
	// simply stops matching and the rows go. Nothing has to remember to clear it.
	const [finding, setFinding] = useState<{ line: string; options: readonly string[] } | undefined>(
		undefined,
	);
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
	// The agent a `/delete` was typed at, while the console is waiting to hear that it was meant. The
	// asking lives here rather than in the plane because it is the one part of a delete that has to
	// happen at a keyboard: a plane that answered `/delete <name>` without ever having been asked the
	// question would let a single line through, and that line is the whole of an agent.
	const [deleting, setDeleting] = useState<string | undefined>(undefined);
	// The providers, as the plane last answered. Asked for when the screen is opened rather than kept
	// up to date: nothing else changes them, and the one thing that does is on this keyboard.
	const [providers, setProviders] = useState<readonly ProviderStanding[]>([]);
	const [models, setModels] = useState<readonly ModelStanding[]>([]);
	const [search, setSearch] = useState<SearchStanding | undefined>(undefined);
	const [servers, setServers] = useState<readonly ServerStanding[]>([]);
	const [grants, setGrants] = useState<readonly GrantStanding[]>([]);
	// Which section of the config screen is open, or nothing while the list of them is. One at a time,
	// because what these have in common is where they are kept and nothing else — and the cursor is
	// theirs, so it starts at the top of whichever list was just opened.
	const [section, setSection] = useState<Section | undefined>(undefined);
	// The short list being picked off, when one is: what is being chosen, and every answer to it. Kept
	// apart from `adding` because that one takes a line typed out and this one never does.
	const [choosing, setChoosing] = useState<
		{ what: string; among: readonly string[]; take: (one: string) => void } | undefined
	>(undefined);
	// Why the list is empty, when it is empty because the plane would not answer. An empty screen that
	// swallowed the reason reads as a plane with no providers, and the reason is usually that the
	// console is newer than the plane it is talking to — which is a sentence, not a mystery.
	const [unanswered, setUnanswered] = useState<string | undefined>(undefined);
	// Which row of the config screen the arrows are on, or -1 while they are still the column's. A
	// screen arrived at by walking down a column should not swallow the key that walked there: the two
	// rows under the agents are the end of that walk, and going into what one of them holds is its own
	// press. Only the list of sections has this level — a section is opened deliberately, and its rows
	// have the arrows from the moment it is.
	const [where, setWhere] = useState(-1);
	// The variable a key is being typed into, and the key itself, which is never in the draft: a
	// secret that shared the prompt's state would be one keystroke of `tab` away from a chat pane.
	const [typing, setTyping] = useState<string | undefined>(undefined);
	const [secret, setSecret] = useState("");
	// The model being written out, kept apart from the draft for the same reason: the chat prompt is
	// one `tab` away and a half-typed line landing in it would be said to an agent.
	const [adding, setAdding] = useState<string | undefined>(undefined);
	// The server being written out, kept apart from the draft for the same reason as the model above.
	const [shelving, setShelving] = useState<string | undefined>(undefined);
	// The host being opened, kept apart for the same reason. One line and one word: everything else a
	// grant has is the half this console does not write.
	const [opening, setOpening] = useState<string | undefined>(undefined);
	// The server a forget was asked about, while the console waits to hear it was meant. Its own
	// question rather than the model's, because what it takes away is every agent's and not one row's.
	// The email section asks the same question about its mailbox, and holds the address here.
	const [forgetting, setForgetting] = useState<string | undefined>(undefined);
	// The mailbox and the way its mail leaves, or nothing until the plane has answered.
	const [mail, setMail] = useState<MailStanding | undefined>(undefined);
	// The one line of it being typed out. The password goes here rather than into the draft for the
	// reason every secret on this screen does: the chat prompt is one `tab` away.
	const [mailing, setMailing] = useState<{ field: MailField; text: string } | undefined>(undefined);
	// The address or domain being let in, kept apart from the mailbox's own line above: they are two
	// boxes on one section and telling them apart by which row was under the cursor is how a domain
	// ends up being tried as a mailbox to log into.
	const [admitting, setAdmitting] = useState<string | undefined>(undefined);
	// What the providers this plane can pay say they answer to, or nothing while they are being asked.
	// Fetched when the row that adds a model is entered rather than with the screen, because it is a
	// round trip to every provider at once and most visits here are about a key.
	const [offers, setOffers] = useState<readonly ModelOffer[] | undefined>(undefined);
	// The model, or the host, a drop was asked about while the console waits to hear it was meant. One
	// state for both because they are one question asked in two sections, and never both at once.
	const [dropping, setDropping] = useState<string | undefined>(undefined);
	// Where the panel actually is, measured rather than worked out: which row a click landed on is a
	// question about the layout Ink just did, and every arithmetic answer to it was off by a border.
	const pane = useRef<DOMElement | null>(null);
	// Where the button went down, for as long as it is still down. A ref rather than state because a
	// drag reports every row it crosses and re-rendering the anchor would be a render per row.
	const pressed = useRef<At | undefined>(undefined);
	// The rows the drag is holding, counted from the first one on screen.
	const [held, setHeld] = useState<Span | undefined>(undefined);
	// How many rows the last drag put on the clipboard, and whether a program took them. Said out
	// loud because a selection that vanishes on the next keystroke leaves nothing to show it worked.
	const [copy, setCopy] = useState<{ rows: number; sure: boolean } | undefined>(undefined);

	// Undefined on the row under the agents, which is not an agent but the way to make one, and on the
	// plane's two below it.
	const selected = agents[spot];
	// Clamped rather than corrected, the way the command menu is: the list can come back shorter than
	// it was, and nothing should have to be reset from inside a keystroke.
	const walk = configRows(section, providers, models, servers, grants, mail);
	const onRow =
		section === undefined && where < 0 ? -1 : Math.min(Math.max(0, where), walk.length - 1);
	const configRow = walk[onRow];
	// A command nobody can name is a command nobody has. Not offered over the shell, where a slash is
	// the start of a path, not over the log feed, which has no prompt for a command to go into, and
	// not over a name, which is not addressed to an agent that exists yet.
	const menu: readonly Command[] =
		panel !== "chat" || selected === undefined
			? []
			: shell
				? // Paths, and only ones a tab has already been pressed for: what a word could become is a
					// question for the sandbox, and asking it on every keystroke would be a round trip per
					// letter. The name is the candidate alone rather than the whole line, because the row is
					// read against the word above it and not against the command in front of that.
					finding?.line === draft
					? finding.options.map((option) => ({ name: option, takes: "", does: "" }))
					: []
				: completions(draft, models, selected.model);
	const at = Math.min(pick, menu.length - 1);
	const chosen = menu[at];
	// What the arrows are moving through, for the row that says so: a command until one has been
	// chosen, and after that whatever the chosen one takes.
	const among = shell ? "path" : /\s/.test(draft) ? "model" : "command";
	const writing = selected === undefined ? undefined : live.get(selected.id);
	const queued = selected === undefined ? [] : saidBy(waiting, selected.id);
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
	const width = chatWidth(columns);
	// The log stream is opened once and the window can be resized at any point in it, so the width a
	// table is drawn to is read when the table arrives rather than closed over when the stream opens.
	const room = useRef(width);
	room.current = width;
	// A blank row under the title, so the tabs read as the pane's own header rather than as the first
	// line of the conversation under them. It is paid for out of the conversation, which is why a short
	// pane does without: the last row a six-row terminal should spend on anything is one spent on air.
	const airy = body >= 8;
	const inner = body - (airy ? 2 : 1);

	// What the open pane has on screen, and how many rows it drew underneath them. Worked out here
	// rather than left to the pane, because a drag arrives as a row of the terminal and these two are
	// the whole of turning that row back into a line of text. The panes that are lists rather than
	// text — a name being typed, the models — show nothing here, and nothing is what a drag on them
	// takes: they have no lines anybody would want in a paste.
	const boxed = inner > PROMPT_ROWS;
	const listed = panel === "chat" && selected !== undefined ? offering(menu, at, inner).listed : [];
	const taken =
		panel === "chat" && selected !== undefined
			? aside(listed.length, busy.has(selected.id), queued.length, inner).taken
			: 0;
	const onScreen =
		panel === "logs"
			? visible(lines, inner, top)
			: panel === "chat" && selected !== undefined
				? reading(said, width, inner, taken, top)
				: [];
	// The feed has no prompt under it. The chat has one, the command menu when a slash is being typed,
	// whatever is queued at a busy agent and the working row while a turn runs, and all of them stand
	// between the last line of talk and the bottom border.
	const below = panel === "logs" ? 0 : taken + (boxed ? PROMPT_ROWS : 1);

	// Scrolled back is a place in one conversation or one feed, and it does not survive being pointed
	// at another: arriving in the middle of something nobody asked for is disorienting. Dropped during
	// the render that changes what is being shown rather than in an effect, which would draw the old
	// place once before correcting it.
	const showing = `${panel}:${selected?.id ?? ""}`;
	const [drawn, setDrawn] = useState(showing);
	if (drawn !== showing) {
		setDrawn(showing);
		setTop(undefined);
		// A walk back through one agent's history has nothing to say about the next one's.
		setRecalling(undefined);
	}

	// Once, for the life of the console: the plane streams until the socket closes, and asking twice
	// would double every line.
	//
	// The same stream feeds both panes, and that is what makes the chat a conversation rather than a
	// record of this console's own questions: a turn a schedule or a webhook started arrives here
	// exactly like one typed in, because nothing about it went through the prompt.
	useEffect(() => {
		// One per agent, held open for the length of an answer: markdown cannot be rendered a delta at
		// a time without somewhere to keep the half-finished line.
		const writers = new Map<string, MarkdownStream>();
		const finished = (agentId: string): void => {
			writers.delete(agentId);
			setLive((prev) => without(prev, agentId));
			setBusy((prev) => without(prev, agentId));
			setStep((prev) => without(prev, agentId));
		};
		const hold = (next: Talk): void => {
			queue.current = next;
			setWaiting(next);
		};

		client.logs((event) => {
			feed.push(event);
			if (event.kind === "said") {
				const line = shown(event.said, room.current);
				// A line the agent was too busy to be told waits above the prompt instead of going into the
				// conversation, because in the conversation it would sit above an answer to the question
				// before it and read as the thing that answer is answering.
				if (event.queued === true) hold(append(queue.current, event.agentId, line));
				else setTalk((prev) => append(prev, event.agentId, line));
			} else if (event.kind === "cleared") {
				// Including the half-written answer and the turn it belonged to. The turn was stopped to
				// make the clearing stick, so a pane left holding its last paragraph would be showing the
				// one part of the conversation that outlived it.
				setTalk((prev) => without(prev, event.agentId));
				hold(without(queue.current, event.agentId));
				finished(event.agentId);
			} else if (event.kind === "thinking") {
				// The only notice the console gets of a turn it did not ask for, and the only thing that
				// separates an agent working from an agent that was spoken to and has not started yet.
				//
				// It is also the moment whatever was queued stops waiting: this turn is the one taking it.
				// It joins the conversation here, after the answer the agent was busy writing, which is
				// where it belongs — said while that was being written, heard once it was done.
				setTalk((prev) => append(prev, event.agentId, ...saidBy(queue.current, event.agentId)));
				hold(without(queue.current, event.agentId));
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
						width: room.current,
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
	}, [client, feed]);

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

	// The operator's end of `/serve`. The plane records which ports should be reachable and this opens
	// them, here, because this is the machine with the browser on it — an agent running on a server
	// somewhere gets a link that works on a laptop without a single port being opened on the server.
	const [doors] = useState(
		() =>
			new LocalDoors(
				(agentId, port) => client.forward(agentId, port),
				(agentId, detail, failed) => feed.note(agentId, "serve", detail, failed),
			),
	);
	// On every answer to `agents` rather than on a change, because the answer is the only notice this
	// gets: `/serve` can be typed by an agent mid-turn, with nobody at the keyboard. Settling is a set
	// difference against what is already bound, so the ninety-nine times out of a hundred it has
	// nothing to do it does nothing.
	useEffect(() => {
		void doors.reconcile(wanted(agents));
	}, [doors, agents]);
	useEffect(() => () => doors.close(), [doors]);

	const readConfig = useCallback(async (): Promise<void> => {
		await Promise.all([
			client.providers(),
			client.models(),
			client.search(),
			client.servers(),
			client.grants(),
			client.mail(),
		])
			.then(([keys, thinking, searching, shelf, reach, post]) => {
				setProviders(keys);
				setModels(thinking);
				setSearch(searching);
				setServers(shelf);
				setGrants(reach);
				setMail(post);
				setUnanswered(undefined);
			})
			.catch((error: unknown) => setUnanswered((error as Error).message));
	}, [client]);

	// On arriving at a screen rather than on a timer: what these show is the plane's environment and a
	// file only this keyboard writes, and neither of them moves while nobody is looking. The chat
	// counts as arriving, because the menu under `/model ` is that same list of models, offered where
	// the command that uses one is typed. The log feed is the one pane with no use for either.
	useEffect(() => {
		if (panel !== "logs") void readConfig();
	}, [panel, readConfig]);

	// Off the screen, so the arrows are the column's again. A row remembered from the last visit would
	// hand the list the keyboard the moment the next walk down the column arrived here, which is the
	// whole of what that walk is not supposed to do.
	useEffect(() => {
		if (panel !== "config") setWhere(-1);
	}, [panel]);

	/**
	 * Asks the plane for something, reads the lists back, and leaves the refusal on screen if it came.
	 *
	 * The order is what matters. Both lists are read again rather than assumed, because what any of
	 * this did is not decided here — a key may be shadowed, an empty one hands the question back to the
	 * environment, a model may be refused for a reason only the plane knows. And the reason goes on
	 * after the read rather than before it, because a successful read clears the last one: written
	 * first, every refusal would be wiped a tick later by the refresh that was meant to show it.
	 */
	const say = useCallback(
		async (attempt: () => Promise<void>): Promise<void> => {
			let trouble: string | undefined;
			try {
				await attempt();
			} catch (error) {
				trouble = (error as Error).message;
			}
			await readConfig();
			if (trouble !== undefined) setUnanswered(trouble);
		},
		[readConfig],
	);

	const keep = useCallback(
		async (keyEnv: string, value: string): Promise<void> =>
			// A key that was refused and said nothing is a key you would paste again. It is the one thing
			// on this screen you cannot check by looking.
			say(() => client.setKey(keyEnv, value)),
		[client, say],
	);

	/**
	 * Adds a model from the line that was typed, or says what was wrong with it.
	 *
	 * Words rather than fields, because the fields are two and sometimes three, and a screen that
	 * asked for them one at a time would be three questions to answer before finding out the first was
	 * refused. The plane checks the same line the file's models are checked against, so a provider it
	 * does not know comes back saying which ones it does.
	 */
	const write = useCallback(
		async (line: string): Promise<void> => {
			const [id = "", provider = "", ...rest] = line.trim().split(/\s+/);
			await say(() =>
				client.addModel({
					id,
					provider,
					// Left out when it was not said, so the plane fills it in with the id — which is right
					// far more often than not, since the id is usually the provider's own name for it.
					...(rest.length > 0 ? { model: rest.join(" ") } : {}),
				}),
			);
		},
		[client, say],
	);

	const forget = useCallback(
		async (modelId: string): Promise<void> => say(() => client.dropModel(modelId)),
		[client, say],
	);

	/**
	 * Opens a host to every agent, which is the whole of a grant this console may write.
	 *
	 * One word rather than a form, because the other four fields of a grant are the half that is not
	 * offered here: a path and a method narrow something, and a credential is the thing the file keeps.
	 * The plane reads the host out of whatever was pasted, so a URL copied out of a refusal is a host.
	 */
	const openHost = useCallback(
		async (host: string): Promise<void> => say(() => client.addGrant(host)),
		[client, say],
	);

	const closeHost = useCallback(
		async (host: string): Promise<void> => say(() => client.dropGrant(host)),
		[client, say],
	);

	/**
	 * Points the search tool somewhere else, which is the whole of configuring one.
	 *
	 * Read back like everything else here, because the plane fills in the half of the answer that was
	 * not said: naming a provider alone takes that provider's first model, and what a search will cost
	 * from now on is a number only the plane's table has.
	 */
	const point = useCallback(
		async (spec: SearchSpec): Promise<void> => say(() => client.setSearch(spec)),
		[client, say],
	);

	/**
	 * Puts a server on the shelf from the line that was typed, the way `/mcp add` does.
	 *
	 * The same grammar and the same reading of it, because a second way of writing down a server would
	 * be a second thing that is nearly right: a URL is a URL wherever it appears, and anything that is
	 * not one is the command to start it with. Refused here rather than at the plane only for what a
	 * line cannot mean at all — the plane still checks its own.
	 */
	const shelve = useCallback(
		async (line: string): Promise<void> => {
			const [name = "", ...rest] = line.trim().split(/\s+/);
			const wrong = readName(name);
			if (wrong !== undefined) {
				setUnanswered(wrong);
				return;
			}
			const read = readServer(rest);
			if ("refused" in read) {
				setUnanswered(read.refused);
				return;
			}
			await say(() => client.addServer(name, read.server));
		},
		[client, say],
	);

	/**
	 * Finds out where an address's mail lives, and asks for the password only if it is worth asking.
	 *
	 * Two steps and a round trip between them, because the discovery is what says whether this account
	 * can be reached this way at all — half the large providers stopped issuing app passwords, and
	 * finding that out after somebody went and looked for one is the one wasted trip worth avoiding.
	 */
	const offerMail = useCallback(
		async (address: string): Promise<void> => {
			try {
				await client.offerMail(address);
			} catch (error) {
				setUnanswered((error as Error).message);
				return;
			}
			setMailing({ field: "password", text: "" });
		},
		[client],
	);

	/** Finishes it with the password, and starts reading. Nothing typed here reaches a transcript. */
	const connectMail = useCallback(
		async (password: string): Promise<void> => {
			// Mail with no tag on it has to reach somebody, and that somebody is who the console was
			// standing on. Without an agent there is nothing to fall back to and nothing to connect for.
			const fallback = selected?.id ?? agents[0]?.id;
			if (fallback === undefined) {
				setUnanswered("make an agent first — mail with no tag on it has to reach one");
				return;
			}
			await say(async () => {
				await client.connectMail(fallback, password);
			});
		},
		[agents, client, say, selected],
	);

	/** Names who carries the mail out, keeping whatever domain was already said for them. */
	const post = useCallback(
		async (title: string): Promise<void> => {
			const name = Object.keys(CARRIERS).find((one) => CARRIERS[one]?.title === title);
			const domain = mail?.domain ?? "";
			await say(() =>
				client.setCarrier(name === undefined ? undefined : { carrier: name, domain }),
			);
		},
		[client, mail, say],
	);

	/**
	 * Lets somebody write to every agent on this plane, from the line that was typed.
	 *
	 * Read back rather than assumed, because the plane settles what was meant: a bare domain comes back
	 * as `*@company.com`, and the two lines that are refused — something that is no address at all, and
	 * a domain the whole internet can sign up at — are refused with a sentence that goes on the screen.
	 */
	const allow = useCallback(
		async (typed: string): Promise<void> => {
			await say(async () => {
				await client.allowSender(typed);
			});
		},
		[client, say],
	);

	const deny = useCallback(
		async (entry: string): Promise<void> => say(() => client.denySender(entry)),
		[client, say],
	);

	/** Tells the carrier which domain it is sending for, which is the rest of naming one. */
	const sendingFor = useCallback(
		async (domain: string): Promise<void> =>
			say(() => client.setCarrier({ carrier: mail?.carrier ?? "", domain })),
		[client, mail, say],
	);

	/** Gives an agent one off the shelf, or takes it back — the toggle the picker's rows stand for. */
	const hold = useCallback(
		async (agentId: string, name: string, held: boolean): Promise<void> =>
			say(() => client.holdServer(agentId, name, held)),
		[client, say],
	);

	const unshelve = useCallback(
		async (name: string): Promise<void> => say(() => client.forgetServer(name)),
		[client, say],
	);

	/** Puts the mailbox down for the whole plane, which is every agent's address at once. */
	const unmail = useCallback(
		async (): Promise<void> => say(() => client.forgetMail()),
		[client, say],
	);

	/**
	 * Asks every provider this plane can pay what it will answer to.
	 *
	 * The answer is a list to pick from instead of a name to remember, which is the difference between
	 * handing over a key and being finished, and handing over a key and then being asked the one fact
	 * the key just bought the ability to look up. What could not be asked is said rather than dropped:
	 * a wrong key and a provider with nothing both come back as no models.
	 */
	const look = useCallback(async (): Promise<void> => {
		setOffers(undefined);
		await client
			.offers()
			.then((catalog) => {
				setOffers(catalog.offers);
				setUnanswered(catalog.trouble.length === 0 ? undefined : catalog.trouble.join(" · "));
			})
			.catch((error: unknown) => {
				// An empty list rather than none at all, so the screen stops saying it is asking and the
				// line that takes a model typed out by hand is the one left standing.
				setOffers([]);
				setUnanswered((error as Error).message);
			});
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
				// Asked again the moment the command is answered rather than waited two seconds for. A
				// command is the one thing typed here that changes what the list says: `/delete` takes a
				// row out of it, `/limit` changes the number in the title row above it. An agent that is
				// still listed after being deleted is a delete that looks like it did not happen.
				await client
					.agents()
					.then(setAgents)
					.catch(() => {});
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
		// Closes the open section of the config screen, leaving the cursor on the row it was opened
		// from: walking back out of something should end where walking into it began.
		const leave = (): void => {
			if (section !== undefined) setWhere(Math.max(0, SECTION_ORDER.indexOf(section)));
			setSection(undefined);
		};
		// And into one, at the top of it rather than at whatever row number the cursor happened to be
		// on: the count belongs to the list, and the lists are not the same length.
		const enter = (into: Section): void => {
			setSection(into);
			setWhere(0);
		};
		// Measured on the keystroke rather than kept in state: the conversation is re-wrapped as it
		// arrives and the feed grows between one key and the next, so a page is only ever a page now.
		const scroll = (by: number, pages: number): void => {
			const height = panel === "logs" ? inner : chatRows(inner);
			const total = panel === "logs" ? lines.length : wrapped(transcript(said), width).length;
			setTop((prev) => scrolled(prev, by + Math.round(pages * height), { total, height }));
		};

		/** Puts what a drag was holding on the clipboard, by whatever means this machine has. */
		const take = async (span: Span): Promise<void> => {
			const rows = onScreen.slice(span.from, span.to + 1);
			// Cut exactly where the highlight was drawn, so that what is pasted is what was seen held.
			// The rows between the first and the last are held end to end, having no column of their own.
			const text = rows
				.map((line, index) =>
					between(
						line,
						index === 0 ? span.head : 0,
						index === rows.length - 1 ? span.tail : line.length,
					),
				)
				.join("\n");
			if (text === "") return;
			const sure = await copied(text);
			// The escape sequence only when no program took it, and never instead of one: it is the only
			// path that works from the far end of an `ssh`, where the clipboard worth landing on is the
			// one in front of the person and `pbcopy` would write to the machine they logged in to.
			// Nothing comes back to say whether the terminal understood it, which is why the row that
			// reports this says which of the two happened rather than claiming both worked.
			if (!sure) process.stdout.write(osc52(text));
			setCopy({ rows: span.to - span.from + 1, sure });
		};

		/**
		 * Walks the lines this operator has typed to this agent, one key at a time.
		 *
		 * The half-written line is carried along in the walk rather than overwritten, so that coming
		 * back down past the newest one hands it back exactly as it was left.
		 */
		const step = (by: 1 | -1): void => {
			const next = recalled(typed(said), recalling, by, draft);
			setRecalling(next.walk);
			setDraft(next.draft);
		};

		/** Puts a candidate in the prompt in place of the word the tab was standing on. */
		const put = (option: string): void => {
			const head = draft.slice(0, completing(draft).from);
			// No space after a directory: it is not the end of a path, and the next tab goes into it.
			setDraft(`${head}${quoted(option)}${option.endsWith("/") ? "" : " "}`);
			setFinding(undefined);
			setPick(0);
		};

		/**
		 * One tab at a shell prompt: as much of the word as the sandbox can settle, and the rest offered.
		 *
		 * The answer comes back from another machine, so the line may have moved on while it was in
		 * flight. It is applied only if it did not — and the offer carries the line it belongs to, which
		 * is what makes a stale one draw nothing rather than have to be cancelled.
		 */
		const complete = async (): Promise<void> => {
			if (selected === undefined) return;
			const asked = draft;
			const options = await client
				.complete(selected.id, plain(completing(asked).word))
				.catch(() => [] as readonly string[]);
			const next = filled(asked, options);
			setDraft((prev) => (prev === asked ? next.draft : prev));
			setPick(0);
			setFinding(next.options.length > 0 ? { line: next.draft, options: next.options } : undefined);
		};

		// First, and before anything looks at the key: a mouse report is an escape sequence, and every
		// branch below this one would take it for either a keystroke or something to type.
		const moves = mouse(input);
		if (moves !== undefined) {
			for (const move of moves) {
				if (move.did === "wheel") {
					// The rows being held are rows of the screen, and the screen is about to say something
					// else on them.
					setHeld(undefined);
					scroll(move.by, 0);
					continue;
				}
				if (move.did === "down") {
					// A press in the column is that row opened, which is what a list on the left of a screen
					// invites. Answered on the way down rather than on the way up, the way a row of a list
					// answers everywhere else — and it starts no drag, since the column has no text anybody
					// wants on a clipboard. Never the only way to get anywhere: tab reaches every one of
					// these rows, and this is the shortcut for a hand that is already on the mouse.
					const row = picked(move.at, { agents: agents.length, rows: body });
					if (row !== undefined) {
						setSpot(row);
						setHeld(undefined);
						setCopy(undefined);
						continue;
					}
					pressed.current = move.at;
					setHeld(undefined);
					setCopy(undefined);
					continue;
				}
				const began = pressed.current;
				const box = pane.current;
				if (began === undefined || box === null) continue;
				const span = holding({ from: began, to: move.at }, measureElement(box), {
					lines: onScreen.length,
					below,
				});
				if (move.did === "drag") {
					setHeld(span);
					continue;
				}
				pressed.current = undefined;
				// A button that went down and came up without moving is a click, and a click selects
				// nothing: this pane is read with the mouse resting in it, and a stray one that copied the
				// line under the pointer would quietly replace whatever was on the clipboard.
				if (move.at.row === began.row && move.at.column === began.column) {
					setHeld(undefined);
					continue;
				}
				setHeld(span);
				if (span !== undefined) void take(span);
			}
			return;
		}
		// Any key at all lets go of a selection, the way clicking elsewhere would: the rows under it are
		// about to be scrolled, typed over or replaced by another agent's conversation.
		if (held !== undefined) setHeld(undefined);
		if (copy !== undefined) setCopy(undefined);

		/**
		 * A question is up, and until it is answered there is nothing else this keyboard does.
		 *
		 * Above every other branch on purpose. A confirmation you can arrow away from, tab away from or
		 * type over is not one: it either has the keyboard or it is decoration. And because it has the
		 * keyboard, `y` is the only key that means yes and every other key means no — including the
		 * return that was pressed a moment ago to ask the question, which is the one key a hand is
		 * already on and the one an accident would land on.
		 */
		if (deleting !== undefined) {
			setDeleting(undefined);
			if (input === "y" || input === "Y") void ask(deleting, `/delete ${deleting}`, "say");
			return;
		}
		// The same question, about a model or a host, and modal for the same reason: it is asked with the
		// cursor already standing on the row, so the hand is on the keys that would answer it by
		// accident. Told apart by the section it was asked in, the way the one below is.
		if (dropping !== undefined) {
			setDropping(undefined);
			if (input === "y" || input === "Y") {
				void (section === "grants"
					? closeHost(dropping)
					: section === "email"
						? deny(dropping)
						: forget(dropping));
			}
			return;
		}
		// And about a server, which is asked apart from the model's because what it takes away is wider:
		// forgetting one takes it off every agent that had it, not off the row the cursor is on.
		if (forgetting !== undefined) {
			setForgetting(undefined);
			// The same question over two things, told apart by the section it was asked in: only one of
			// them has a list of servers under the cursor, and only the other has a mailbox at all.
			if (input === "y" || input === "Y") {
				void (section === "email" ? unmail() : unshelve(forgetting));
			}
			return;
		}
		/**
		 * A key is being typed, and until it is entered or given up on nothing else has the keyboard.
		 *
		 * Above the panes for the same reason the question above is: every branch below would read a
		 * character of a secret as something else — a `!` as a shell, a `/` as a command, a `d` under
		 * ctrl as half a page — and the first of those to hit would leave the rest of a live API key
		 * typed into a chat pane, on its way to an agent.
		 */
		if (typing !== undefined) {
			const entered = (value: string): void => {
				setTyping(undefined);
				setSecret("");
				void keep(typing, value);
			};
			if (key.escape) {
				setTyping(undefined);
				setSecret("");
				return;
			}
			if (key.return) {
				// An empty line is not nothing: it is the way to take back a key given here, and hand the
				// question back to whatever the plane's own environment says.
				entered(secret);
				return;
			}
			if (key.backspace || key.delete) {
				setSecret((prev) => prev.slice(0, -1));
				return;
			}
			if (input.length === 0 || key.ctrl || key.meta) return;
			// A key is pasted far more often than it is typed, and it arrives with its newline still on
			// it about as often as not.
			const [first = "", ...rest] = input.split(/\r|\n/);
			if (rest.length === 0) {
				setSecret((prev) => prev + first);
				return;
			}
			entered(secret + first);
			return;
		}
		/**
		 * A setting with a handful of known answers is being picked off a list of them.
		 *
		 * Nothing here reads a character, and that is the difference between this and the box under it:
		 * every answer a search provider could have is already on the list, so there is nothing to type
		 * and every other key is swallowed rather than falling through to a pane that would act on it.
		 */
		if (choosing !== undefined) {
			const on = Math.min(Math.max(0, pick), Math.max(0, choosing.among.length - 1));
			if (key.escape) {
				setChoosing(undefined);
				return;
			}
			if (key.upArrow) {
				setPick(Math.max(0, on - 1));
				return;
			}
			if (key.downArrow) {
				setPick(Math.min(Math.max(0, choosing.among.length - 1), on + 1));
				return;
			}
			if (key.return) {
				const one = choosing.among[on];
				setChoosing(undefined);
				setPick(0);
				if (one !== undefined) choosing.take(one);
			}
			return;
		}
		// A model is being picked, and like the key above it the branch sits here so that none of the
		// panes below read a character of what is typed as one of their own. The arrows are the list's
		// while it is up, which is what they are in every other box that completes.
		if (adding !== undefined) {
			const found = offers === undefined ? [] : matching(offers, adding);
			const on = Math.min(Math.max(0, pick), Math.max(0, found.length - 1));
			const entered = (value: string): void => {
				const words = value
					.trim()
					.split(/\s+/)
					.filter((word) => word.length > 0);
				setAdding(undefined);
				setOffers(undefined);
				// Three words is somebody naming the model themselves — an id, the provider, and the
				// provider's own name for it — so it is taken as written even while the list has a row
				// highlighted. Anything shorter is a narrowing of the list, and what it narrowed to is
				// what was meant.
				const picked = words.length >= 3 ? undefined : found[on];
				if (picked !== undefined) void write(`${picked.id} ${picked.provider}`);
				else if (words.length > 0) void write(value);
			};
			if (key.escape) {
				setAdding(undefined);
				setOffers(undefined);
				return;
			}
			if (key.upArrow) {
				setPick(Math.max(0, on - 1));
				return;
			}
			if (key.downArrow) {
				setPick(Math.min(Math.max(0, found.length - 1), on + 1));
				return;
			}
			if (key.return) {
				entered(adding);
				return;
			}
			// Back to the top of whatever the line now narrows to: a row four down in the old list is a
			// different model in the new one, and it is the one that would have been added.
			if (key.backspace || key.delete) {
				setAdding((prev) => (prev ?? "").slice(0, -1));
				setPick(0);
				return;
			}
			if (input.length === 0 || key.ctrl || key.meta) return;
			const [first = "", ...rest] = input.split(/\r|\n/);
			if (rest.length === 0) {
				setAdding((prev) => (prev ?? "") + first);
				setPick(0);
				return;
			}
			entered(adding + first);
			return;
		}
		/**
		 * A server is being written out, and until it is entered or given up on nothing else has this.
		 *
		 * A line rather than a list, and it has to be: what is being typed is a URL somebody went and
		 * found or a command with its arguments, and neither is a thing this plane could offer to pick
		 * from. Here for the same reason the other boxes are — a `/` in a URL is a `/`, not a command.
		 */
		/**
		 * A line of the mailbox is being typed, and until it is entered nothing else has the keyboard.
		 *
		 * Above the panes for the reason the key box is: one of these three is an app password, and a
		 * branch below would read half of it as a command and leave the other half in a chat prompt.
		 */
		if (mailing !== undefined) {
			const entered = (value: string): void => {
				const { field } = mailing;
				setMailing(undefined);
				const said = field === "password" ? value : value.trim();
				if (said.length === 0) return;
				if (field === "address") void offerMail(said);
				else if (field === "password") void connectMail(said);
				else void sendingFor(said);
			};
			if (key.escape) {
				setMailing(undefined);
				return;
			}
			if (key.return) {
				entered(mailing.text);
				return;
			}
			if (key.backspace || key.delete) {
				setMailing((prev) =>
					prev === undefined ? prev : { ...prev, text: prev.text.slice(0, -1) },
				);
				return;
			}
			if (input.length === 0 || key.ctrl || key.meta) return;
			// An app password arrives pasted, in the four-by-four grouping the provider printed it in and
			// often with the newline the copy took with it.
			const [first = "", ...rest] = input.split(/\r|\n/);
			if (rest.length === 0) {
				setMailing((prev) => (prev === undefined ? prev : { ...prev, text: prev.text + first }));
				return;
			}
			entered(mailing.text + first);
			return;
		}
		/**
		 * A host is being typed, and until it is entered or given up on nothing else has the keyboard.
		 *
		 * Here with the other boxes rather than below the panes, because what is being typed is a URL as
		 * often as a host — pasted straight out of the refusal that sent somebody to this screen — and a
		 * branch below would read the `/` in it as the start of a command.
		 */
		if (opening !== undefined) {
			const entered = (value: string): void => {
				setOpening(undefined);
				if (value.trim().length > 0) void openHost(value);
			};
			if (key.escape) {
				setOpening(undefined);
				return;
			}
			if (key.return) {
				entered(opening);
				return;
			}
			if (key.backspace || key.delete) {
				setOpening((prev) => (prev ?? "").slice(0, -1));
				return;
			}
			if (input.length === 0 || key.ctrl || key.meta) return;
			const [first = "", ...rest] = input.split(/\r|\n/);
			if (rest.length === 0) {
				setOpening((prev) => (prev ?? "") + first);
				return;
			}
			entered(opening + first);
			return;
		}
		// The same box as the host above it, and here for the same reason: what is typed is one word,
		// and every branch below would read a character of it as a key of its own.
		if (admitting !== undefined) {
			const entered = (value: string): void => {
				setAdmitting(undefined);
				if (value.trim().length > 0) void allow(value);
			};
			if (key.escape) {
				setAdmitting(undefined);
				return;
			}
			if (key.return) {
				entered(admitting);
				return;
			}
			if (key.backspace || key.delete) {
				setAdmitting((prev) => (prev ?? "").slice(0, -1));
				return;
			}
			if (input.length === 0 || key.ctrl || key.meta) return;
			const [first = "", ...rest] = input.split(/\r|\n/);
			if (rest.length === 0) {
				setAdmitting((prev) => (prev ?? "") + first);
				return;
			}
			entered(admitting + first);
			return;
		}
		if (shelving !== undefined) {
			const entered = (value: string): void => {
				setShelving(undefined);
				if (value.trim().length > 0) void shelve(value);
			};
			if (key.escape) {
				setShelving(undefined);
				return;
			}
			if (key.return) {
				entered(shelving);
				return;
			}
			if (key.backspace || key.delete) {
				setShelving((prev) => (prev ?? "").slice(0, -1));
				return;
			}
			if (input.length === 0 || key.ctrl || key.meta) return;
			// A URL is pasted rather than typed about as often as a key is, newline and all.
			const [first = "", ...rest] = input.split(/\r|\n/);
			if (rest.length === 0) {
				setShelving((prev) => (prev ?? "") + first);
				return;
			}
			entered(shelving + first);
			return;
		}
		// After the mouse guard, so a wheel report is never read as this, and before the panes, so it
		// reaches the agent being watched from whichever one is open. Only while it is thinking: escape
		// on an agent with nothing to stop is a key pressed at the wrong moment, not a command.
		if (key.escape) {
			// On the config screen it is the way back out of a section, which is what escape is in every
			// list that opens one. Before the stop, because a turn thinking behind this screen is not what
			// a key pressed on it is about.
			if (panel === "config" && section !== undefined) {
				leave();
				return;
			}
			// And out of the list of sections, which is the level above that: whatever left does, escape
			// does, so a hand coming out of a box and a hand on the arrows end up in the same place.
			if (panel === "config" && onRow >= 0) {
				setWhere(-1);
				return;
			}
			if (selected !== undefined && busy.has(selected.id)) {
				void client.stop(selected.id).catch(() => {});
				// A turn stopped before it said anything leaves the question standing alone in the
				// conversation, so the question goes back into the prompt: what a hand stops a turn for is
				// usually that it asked the wrong thing, and retyping it is the work of asking it again.
				// Only over an empty prompt, and only while nothing has come back — an answer half written
				// is an answer, and the line that asked for it is history by then.
				const last = said.at(-1);
				if (draft === "" && last?.from === "operator") setDraft(last.text);
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
		// Tab means the next thing, and what the next thing is depends on whether there is a line under
		// the hand: the next completion while something is being typed, the next row of the column when
		// there is not. That is the whole of moving around here — one key, one list, top to bottom,
		// with shift for the way back. The bare arrows stay the prompt's, which is what they are at
		// every other prompt, and nothing is left needing a chord or a mouse.
		//
		// While the menu is up these keys belong to it, which is what they do in every other box that
		// completes. Swapping the row out from under a half-typed command loses the command.
		if (key.tab) {
			// At a shell prompt the tab is the shell's, which is what it is at every shell: a hand that
			// borrowed this prompt to walk around a box is a hand that will press it looking for a
			// directory, and swapping the pane out from under that is the wrong answer twice over. The
			// way to the other panes is still there, over an empty line, where there is nothing to
			// complete.
			if (shell && draft !== "") {
				if (chosen !== undefined) put(chosen.name);
				else void complete();
				return;
			}
			if (chosen !== undefined) {
				setDraft(`${chosen.name} `);
				setPick(0);
				return;
			}
			setSpot((prev) => walked(prev, key.shift ? -1 : 1, agents.length));
			return;
		}
		// Up and down the column, which is what these two keys do beside a list on every screen that
		// has one. They were the prompt's history and the history is now left and right, which cost it
		// nothing: this prompt takes no cursor, so there was never a line to walk along with them, and
		// the column is the thing on this screen that is a list.
		//
		// The whole of it, the same ring `tab` walks: the agents, the row that makes one, and then the
		// feed and the config screen under them. Stopping the arrows at the last agent made the two
		// rows at the foot reachable only by a key nobody had been pressing to get anywhere else.
		if (key.upArrow) {
			// The config screen's own list is a list too, and it holds the arrows once it has been handed
			// them, while there is any of it above the cursor. At the top they go back to the column, so
			// that screen is left by the same key that arrived on it — and out of an open section first,
			// one level per press, which is the same walk backwards.
			if (panel === "config" && onRow > 0) setWhere(onRow - 1);
			else if (panel === "config" && section !== undefined) leave();
			else if (panel === "config" && onRow === 0) setWhere(-1);
			else if (menu.length > 0) setPick(Math.max(0, at - 1));
			else setSpot((prev) => walked(prev, -1, agents.length));
			return;
		}
		if (key.downArrow) {
			// Down that list stops at the end of it instead of carrying on round to the first agent:
			// reading to the bottom of something is not a way of asking to be somewhere else. It stops on
			// the way in too, on the column's own last row: a walk down the column ends where the column
			// does, and the list beside it is stepped into on purpose or not at all.
			if (panel === "config") {
				if (onRow >= 0) setWhere(Math.min(walk.length - 1, onRow + 1));
			} else if (menu.length > 0) setPick(Math.min(menu.length - 1, at + 1));
			else setSpot((prev) => walked(prev, 1, agents.length));
			return;
		}
		// Back through what was already sent, and forward again. Left is older because left is back.
		if (key.leftArrow || key.rightArrow) {
			if (panel === "chat" && menu.length === 0) step(key.leftArrow ? 1 : -1);
			// Left is back here too, on a screen where a section is a list opened out of a list. Escape
			// still does it and so does walking up off the top, because these are three hands reaching for
			// the same move: the one already on the arrows should not have to find another key.
			else if (panel === "config" && key.leftArrow && section !== undefined) leave();
			// One more level of the same walk: the list of sections is itself something the column was
			// standing beside, and giving the arrows back is how you leave it.
			else if (panel === "config" && key.leftArrow && onRow >= 0) setWhere(-1);
			// And right is in, which is what takes the arrows off the column to begin with: the screen is
			// reached by walking down it and entered by walking across.
			else if (panel === "config" && key.rightArrow && onRow < 0) setWhere(0);
			// And right is in, so the four arrows are the whole of moving about this screen: two for the
			// list you are on and two for which list that is. Only into a section — the rows inside one
			// open a box to type in or a question to answer, which is what return is for and not a level
			// to walk into, and an arrow that sometimes opened a text box would be an arrow to be wary of.
			else if (panel === "config" && key.rightArrow && configRow?.kind === "section") {
				enter(configRow.section);
			}
			return;
		}
		if (panel === "config") {
			// The list is entered before it is used: while the arrows are still the column's there is no
			// row under them, and this is the press that puts one there. The other way in is right, and
			// naming both is what the row of keys at the foot does.
			if (key.return && onRow < 0) {
				setWhere(0);
				return;
			}
			// Everything this screen does is about the row the arrows are standing on, which is why there
			// is nothing here to type into until one of these is pressed.
			if (key.return && configRow !== undefined) {
				if (configRow.kind === "section") enter(configRow.section);
				if (configRow.kind === "provider") {
					setTyping(configRow.provider.keyEnv);
					setSecret("");
				}
				// Two of the three are picked off a list this console already has — the providers that will
				// search and the models each of them drives are a table, not an opinion — and the third is
				// a key, taken the same way every other key on this screen is.
				if (configRow.kind === "search" && search !== undefined) {
					if (configRow.field === "key") {
						setTyping(search.keyEnv);
						setSecret("");
					} else {
						const among =
							configRow.field === "provider"
								? Object.keys(SEARCH_PROVIDERS)
								: (SEARCH_PROVIDERS[search.provider]?.models ?? []);
						const standing = configRow.field === "provider" ? search.provider : search.model;
						setChoosing({
							what:
								configRow.field === "provider" ? "searches" : `${search.provider} searches with`,
							among,
							// A provider chosen alone leaves the model to the plane, which takes that provider's
							// first: the model it was on belongs to whoever it was chosen from.
							take: (one) =>
								void point(
									configRow.field === "provider"
										? { provider: one }
										: { provider: search.provider, model: one },
								),
						});
						// Standing on what is already set, so a list opened to look at it is a list that can be
						// closed again without having changed anything by pressing return on the first row.
						setPick(Math.max(0, among.indexOf(standing)));
					}
				}
				// The row under the models, which is the one that makes one — the same shape as the row
				// under the agents, because it is the same idea and a second one would be a second thing
				// to learn. The providers are asked what they offer on the way in, so what opens is a
				// list to look down rather than a box wanting a name nobody memorises.
				if (configRow.kind === "add") {
					setAdding("");
					setPick(0);
					void look();
				}
				if (configRow.kind === "add-server") setShelving("");
				if (configRow.kind === "add-grant") setOpening("");
				// Which agent has it, which is the only thing about a server there is to decide here: what
				// it is was decided when it was found, and the list of who could have it is the column on
				// the left. Toggling, because the same row means both — a name on the list that already has
				// it says so, and pressing return on it is how it stops.
				if (configRow.kind === "server" && agents.length > 0) {
					const { name, agents: has } = configRow.server;
					const among = agents.map(
						(agent) => `${agent.id}${has.includes(agent.id) ? "   has it" : ""}`,
					);
					setChoosing({
						what: `${name} goes to`,
						among,
						take: (one) => {
							const id = agents[among.indexOf(one)]?.id;
							if (id !== undefined) void hold(id, name, !has.includes(id));
						},
					});
					setPick(0);
				}
				// Four rows, and each is the way its own half of email is decided: the mailbox is typed out
				// because an address is not a thing this plane could offer to pick from, the carrier is picked
				// because the list of companies that will do this is a table, the domain is typed because it
				// is yours, and the key is taken the way every other key on this screen is taken.
				if (configRow.kind === "mail" && mail !== undefined) {
					if (configRow.field === "mailbox") {
						if (mail.mailbox === undefined) setMailing({ field: "address", text: "" });
						// Connected already: the address is the one thing here that is not changed in place, because
						// a second mailbox over the first is the same act as forgetting this one and connecting that.
						else setUnanswered(`${mail.mailbox} is connected — ⌫ disconnects it`);
					}
					if (configRow.field === "carrier") {
						const among = [OWN_SERVER, ...Object.values(CARRIERS).map((one) => one.title)];
						setChoosing({
							what: "the mail goes out through",
							among,
							take: (one) => void post(one),
						});
						// Standing on what is already set, so a list opened to look at it can be closed again without
						// having changed anything by pressing return on the first row.
						setPick(Math.max(0, among.indexOf(CARRIERS[mail.carrier]?.title ?? OWN_SERVER)));
					}
					if (configRow.field === "domain") setMailing({ field: "domain", text: mail.domain });
					if (configRow.field === "key" && mail.keyEnv !== undefined) {
						setTyping(mail.keyEnv);
						setSecret("");
					}
				}
				if (configRow?.kind === "add-sender") setAdmitting("");
				// A line of this list is not edited, because there is nothing in it to edit: it is one
				// address or one domain, and changing it is taking it off and typing the other one.
				if (configRow?.kind === "sender") {
					setUnanswered(`${configRow.entry} may write — ⌫ stops it`);
				}
			}
			if ((key.backspace || key.delete) && configRow?.kind === "server") {
				setForgetting(configRow.server.name);
			}
			// Asked rather than done, like every other ⌫ on this screen. What it costs is not the line —
			// that is one row to type again — it is that somebody's mail goes unread from now on, and they
			// are never told: their messages simply stop being answered.
			if ((key.backspace || key.delete) && configRow?.kind === "sender") {
				setDropping(configRow.entry);
			}
			if (
				(key.backspace || key.delete) &&
				configRow?.kind === "mail" &&
				configRow.field === "mailbox" &&
				mail?.mailbox !== undefined
			) {
				setForgetting(mail.mailbox);
			}
			// Backspace rather than a letter, because every letter is a character somebody will one day
			// type into a box on this screen, and this is the key that already means take it away.
			if ((key.backspace || key.delete) && configRow?.kind === "model") {
				// Said here rather than left to the plane to refuse: the plane's refusal would arrive
				// after the question was answered, and a `y` that then does nothing is worse than a
				// question that was never asked.
				if (configRow.model.added) setDropping(configRow.model.id);
				else setUnanswered(`"${configRow.model.id}" is the file's — drop it there`);
			}
			// The same key on the same terms, and the same three refusals said here rather than after the
			// question: one of these lists is the file's and two of them belong to a section above.
			if ((key.backspace || key.delete) && configRow?.kind === "grant") {
				const { origin, host } = configRow.grant;
				if (origin === "here") setDropping(host);
				else if (origin === "file") setUnanswered(`"${host}" is the file's — close it there`);
				else setUnanswered(`"${host}" ${LEDGER[origin]}`);
			}
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
			// The walk ends where the line was sent: the next up arrow starts again from the newest.
			setRecalling(undefined);
			// Asking something is asking to see the answer, so a conversation being read back through
			// returns to its end rather than leaving the answer to arrive out of sight.
			setTop(undefined);
			// Intercepted here rather than left to the plane, so that the asking cannot be skipped by
			// typing the whole thing at once: whatever was written after `/delete` is dropped and the
			// bare command goes down, which destroys nothing and says what deleting this would cost.
			// The question it prints is then asked again by the prompt, where a hand can answer it.
			if (!shell && text.split(/\s+/)[0] === "/delete") {
				setDeleting(selected.id);
				void ask(selected.id, "/delete", "say");
				return;
			}
			// Answered by moving the column rather than by sending anything down. What that screen holds
			// belongs to the plane and not to the agent whose prompt this is, and an answer about the keys
			// every agent is paid for with, written into one agent's conversation, is exactly the confusion
			// that putting those rows at the foot of the column was meant to end. Naming a section skips the
			// list; naming something that is not one is left to go down, where the plane says what there is.
			if (!shell && text.split(/\s+/)[0] === "/config") {
				const named = text.split(/\s+/).slice(1).join(" ").toLowerCase();
				const opening = SECTION_ORDER.find((one) => one === named);
				if (named === "" || opening !== undefined) {
					setSpot(agents.length + PLANE_ROWS);
					setSection(opening);
					setWhere(0);
					return;
				}
			}
			// Deliberately not awaited: the turn runs while the console keeps taking keys, which is what
			// lets an agent be asked something and another one be watched while it thinks.
			if (text.length > 0) void ask(selected.id, text, shell ? "shell" : "say");
		};

		if (key.return) {
			// The first return takes the command off the menu, the second sends it. Every command here
			// can be given an argument, so a return that sent the moment a name was highlighted would
			// make `/limit 5` the one thing the menu could not be used to type. A name already typed in
			// full is not completed onto itself — at that point the menu is agreeing, not offering.
			if (chosen !== undefined && shell) {
				put(chosen.name);
				return;
			}
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

	// The panel says which row of the column it belongs to, and nothing else: the three-way breadcrumb
	// that used to stand here was a second copy of a selection the column already draws.
	const title = panel !== "chat" ? panel : selected === undefined ? "new agent" : selected.id;
	// A selection disappears the moment the next key is pressed, so without a word here there is
	// nothing to say it ever landed. It says which way it went, too: a program on this machine took
	// it, or the sequence went to the terminal and no answer to it is coming back.
	const took =
		copy === undefined
			? ""
			: `   ⧉ ${copy.rows} ${copy.rows === 1 ? "row" : "rows"} ${copy.sure ? "copied" : "sent to the terminal"}`;
	// What the left of the title row has already spent, so that what goes at the right end knows how
	// much of the row is left for it. Three columns of gap, so the two halves never touch.
	const tabs = `${title}${top === undefined ? "" : "   ↑ scrolled"}${took}   `;
	const state: Standing =
		selected === undefined
			? { bot: "", mail: "", model: "", spend: "" }
			: standing(selected, width - tabs.length);
	const heat = selected === undefined ? { dimColor: true } : burning(selected);
	// The same two colours the column paints these in, so a yellow mark in the list and the yellow
	// name of the bot it belongs to are one fact seen twice rather than two things to work out.
	const [botMark, mailMark] = selected === undefined ? [undefined, undefined] : reached(selected);
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
			h(Column, {
				agents,
				spot,
				busy,
				rows: body,
				arrows: panel !== "config" || onRow < 0,
				key: "agents",
			}),
			h(
				Box,
				{
					flexDirection: "column",
					flexGrow: 1,
					borderStyle: "round",
					borderColor: "gray",
					paddingX: 1,
					// Held so a mouse report can be turned back into a row of text. Nothing here reads it
					// during a render; it is measured on the click, against the layout as it stands then.
					ref: pane,
					key: "panel",
				},
				h(
					Box,
					{ flexDirection: "row", key: "tabs" },
					h(Text, { bold: true, color: "cyan" }, title),
					// What a pane showing the end of things cannot say for itself: that this one is not.
					// Without it, an answer arriving out of sight looks like an agent that said nothing.
					top === undefined ? null : h(Text, { color: "yellow" }, "   ↑ scrolled"),
					took === "" ? null : h(Text, { color: copy?.sure === true ? "green" : "yellow" }, took),
					// Pushed to the far end rather than set after the tabs, so that the tabs do not move
					// sideways as a number under them grows: they are pressed at, and a target that
					// wanders while you reach for it is worse than one that says less.
					h(Box, { flexGrow: 1, key: "gap" }),
					state.bot === "" || botMark === undefined
						? null
						: h(Text, { color: botMark.color, dimColor: botMark.dimColor }, `${state.bot}   `),
					state.mail === "" || mailMark === undefined
						? null
						: h(Text, { color: mailMark.color, dimColor: mailMark.dimColor }, `${state.mail}   `),
					state.model === "" ? null : h(Text, { dimColor: true }, `${state.model}   `),
					state.spend === "" ? null : h(Text, heat, state.spend),
				),
				airy ? h(Text, { key: "under" }, " ") : null,
				panel === "logs"
					? h(Logs, { lines, rows: inner, top, held, key: "logs" })
					: panel === "config"
						? h(Config, {
								section,
								providers,
								models,
								search,
								servers,
								grants,
								mail,
								mailing,
								cursor: onRow,
								typing,
								secret,
								adding,
								shelving,
								opening,
								admitting,
								forgetting,
								dropping,
								offers,
								choosing,
								pick,
								unanswered,
								rows: inner,
								columns: width,
								key: "config",
							})
						: selected === undefined
							? h(New, {
									draft,
									rows: inner,
									columns: width,
									making: building,
									refused,
									key: "new",
								})
							: h(Chat, {
									history: said,
									draft,
									rows: inner,
									columns: width,
									thinking,
									queued,
									top,
									// Standing at the door until a command says otherwise, which is where the plane
									// starts an agent's shell and what it goes back to when the sandbox is replaced.
									shell:
										shell && selected !== undefined
											? (cwd.get(selected.id) ?? SANDBOX_REPO_PATH)
											: undefined,
									confirm: deleting,
									menu,
									pick: at,
									held,
									key: "chat",
								}),
			),
		),
		h(
			Box,
			{ flexDirection: "row", key: "hint" },
			h(Text, null, " "),
			// The key stands out from what it does, because the key is the part being looked for.
			...(choosing !== undefined
				? // A list of every answer there is, so the row says the three keys that exist here.
					[
						["↑↓", "move"],
						["⏎", "choose"],
						["esc", "cancel"],
						["^C", "quit"],
					]
				: adding !== undefined
					? // The list has the arrows while it is up, and return takes what they are standing on.
						[
							...(offers !== undefined && matching(offers, adding).length > 0
								? [
										["↑↓", "move"],
										["⏎", "add"],
									]
								: [["⏎", "add"]]),
							["esc", "cancel"],
							["^C", "quit"],
						]
					: shelving !== undefined || opening !== undefined || admitting !== undefined
						? // A line with nothing to pick off, so the arrows are not named: there is no list here.
							[
								["⏎", "add"],
								["esc", "cancel"],
								["^C", "quit"],
							]
						: typing !== undefined
							? // A key is being typed and has the keyboard, so the row is the two ways out of that.
								[
									["⏎", "save"],
									["esc", "cancel"],
									["^C", "quit"],
								]
							: dropping !== undefined
								? [
										["y", section === "grants" ? "close" : "drop"],
										["n", "cancel"],
										["^C", "quit"],
									]
								: forgetting !== undefined
									? [
											["y", "forget"],
											["n", "cancel"],
											["^C", "quit"],
										]
									: panel === "logs"
										? // The arrows walk the column here as they do over a conversation, so the feed is
											// moved with the same chords a conversation is moved with rather than with the two
											// keys that mean somewhere else on every other row of this screen. Nothing else
											// this row usually offers exists here.
											[
												["↑↓", "move"],
												["^U^D", "scroll"],
												["^C", "quit"],
											]
										: panel === "config"
											? // What return does here depends on the row, so the row is what the hint says. A hint
												// naming a key that does nothing on the row under the cursor is the same lie as a
												// hint for a key that does nothing at all.
												[
													["↑↓", "move"],
													// The row under the cursor when there is one, and the list itself when the
													// arrows are still the column's: what is opened differs, the key does not.
													...(onRow < 0 || configRow?.kind === "section"
														? // Both, the way the row back names both: the arrows are the whole of moving
															// about this screen once you know that, and the way to know it is to read it.
															[["→ ⏎", "open"]]
														: configRow?.kind === "provider"
															? [["⏎", "set key"]]
															: configRow?.kind === "add"
																? [["⏎", "add model"]]
																: configRow?.kind === "search"
																	? [["⏎", configRow.field === "key" ? "set key" : "change"]]
																	: configRow?.kind === "add-server"
																		? [["⏎", "add server"]]
																		: configRow?.kind === "server"
																			? [
																					["⏎", "give"],
																					["⌫", "forget"],
																				]
																			: configRow?.kind === "mail"
																				? [
																						[
																							"⏎",
																							configRow.field === "key"
																								? "set key"
																								: configRow.field === "mailbox"
																									? "connect"
																									: "change",
																						],
																						...(configRow.field === "mailbox"
																							? [["⌫", "disconnect"]]
																							: []),
																					]
																				: configRow?.kind === "add-sender"
																					? [["⏎", "let write"]]
																					: configRow?.kind === "sender"
																						? [["⌫", "stop reading"]]
																						: configRow?.kind === "add-grant"
																							? [["⏎", "open host"]]
																							: configRow?.kind === "grant"
																								? // Only the ones this console wrote: the other three lists
																									// refuse this key, and a hint for a key that is refused is
																									// the same lie as a hint for a key that does nothing.
																									configRow.grant.origin === "here"
																									? [["⌫", "close host"]]
																									: []
																								: configRow?.kind === "model" &&
																										configRow.model.added
																									? [["⌫", "drop model"]]
																									: []),
													// Only where there is one to leave, because a key named on a row it does nothing
													// on is the same lie as a key named for nothing at all. Both keys named, the way
													// `^U^D` names two: a hand on the arrows and a hand coming from a text box are
													// looking for different ones, and the row is where either of them finds it.
													...(section === undefined ? [] : [["← esc", "back"]]),
													["tab", nextRow(spot, agents)],
													["^C", "quit"],
												]
											: menu.length > 0
												? // The keys have been taken by the menu, so the row says what they do now instead of
													// what they did a keystroke ago. A hint left standing for a key the menu has taken is
													// the same lie as a hint for a key that does nothing.
													[
														["↑↓", among],
														["⏎", "choose"],
														["^C", "quit"],
													]
												: deleting !== undefined
													? // A question is open and it has the keyboard, so the row says the two keys that mean
														// anything. Everything it usually offers would be a way out of answering that does
														// not exist — and `n` is spelled out rather than left as "any other key", because a
														// key to press is a thing a hand does and "any other key" is a thing to work out.
														[
															["y", "delete"],
															["n", "cancel"],
															["^C", "quit"],
														]
													: selected === undefined
														? // Nothing else the row usually offers is true here: there is no conversation to
															// scroll, no shell to open and no commands, until the name has been given.
															[
																["↑↓", "agents"],
																["⏎", "create"],
																["^C", "quit"],
															]
														: [
																["↑↓", "agents"],
																// Only while there is a line to walk back to: left and right do nothing in a
																// conversation nobody has typed into yet, and a hint for a key that does nothing
																// is the same lie as a hint for a key the menu has taken.
																...(typed(said).length > 0 ? [["←→", "history"]] : []),
																["^U^D", "scroll"],
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
export function resume(kept: Record<string, readonly Utterance[]>, width: number): Talk {
	return new Map(
		Object.entries(kept).map(([agentId, history]) => [
			agentId,
			history.map((said) => shown(said, width)),
		]),
	);
}

/**
 * The console, which is what `squad` on its own opens.
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
	const conversations = resume(
		await client.transcripts().catch(() => ({})),
		chatWidth(process.stdout.columns ?? 80),
	);
	// The console takes the whole window and gives it back on the way out, the way `less` and `vim`
	// do. It draws a screen the terminal did not draw, so the scrollback behind it held pictures of
	// older frames rather than the conversation, and a wheel or a page key that reached it scrolled
	// away from a live console into one of those pictures. On the alternate screen there is no
	// scrollback to fall into, and nothing this printed is left behind in the shell it was opened
	// from. Frames are written line by line rather than redrawn whole, which is what stops a console
	// that repaints on every token from flickering while it is read.
	const app = render(h(App, { client, initial, conversations }), {
		exitOnCtrlC: false,
		alternateScreen: true,
		incrementalRendering: true,
	});
	process.stdout.write(MOUSE_ON);
	try {
		await app.waitUntilExit();
	} finally {
		// Whatever happened. A terminal left reporting its mouse prints an escape sequence at whoever
		// clicks in it next, and they will be at a shell prompt with no idea what did that to them.
		process.stdout.write(MOUSE_OFF);
	}
	return 0;
}
