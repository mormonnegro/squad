import { Box, renderToString, Text } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { COMMANDS, type Command } from "../src/commands.ts";
import {
	type At,
	agreed,
	bare,
	between,
	Chat,
	Column,
	Config,
	completing,
	doing,
	filled,
	here,
	holding,
	inverted,
	laid,
	type MailField,
	mouse,
	New,
	nextRow,
	panelAt,
	picked,
	plain,
	pointed,
	quoted,
	reached,
	recalled,
	resume,
	type Said,
	type Section,
	type Span,
	saidBy,
	scrolled,
	standing,
	type Thinking,
	transcript,
	typed,
	until,
	visible,
	type Walk,
	walked,
} from "../src/console.ts";
import type { AgentSummary } from "../src/control-plane.ts";
import type { GrantStanding } from "../src/grants.ts";
import type { MailStanding } from "../src/mailbox.ts";
import type { ServerStanding } from "../src/mcp.ts";
import type { ModelOffer } from "../src/models.ts";
import type { SearchStanding } from "../src/search.ts";

/**
 * The transcript is the words; the colour is put on at the last moment.
 *
 * What keeps that honest is that the agent's text arrives already rendered — it is markdown turned
 * into ANSI upstream — so anything this did to it would be damage.
 */
describe("transcript", () => {
	it("marks what the operator typed", () => {
		expect(transcript([{ from: "operator", text: "hola" }])[0]).toBe("\u001b[36m> hola\u001b[39m");
	});

	it("passes the agent's own rendering through untouched", () => {
		const bold = "\u001b[1mwebhook\u001b[22m is a callback";

		expect(transcript([{ from: "agent", text: bold }])[0]).toBe(bold);
	});

	it("gives an answer the lines it was written with", () => {
		expect(transcript([{ from: "agent", text: "one\ntwo" }])).toEqual(["one", "two"]);
	});

	// The operator's line and a webhook's are both text addressed to the agent, and only one of them
	// may be obeyed. A pane that drew them alike could not be read back through to find out which.
	it("names what arrived from somewhere other than the keyboard", () => {
		const line = transcript([{ from: "other", via: "webhook:github", text: "ship it" }])[0];

		expect(line).toContain("‹webhook:github›");
		expect(line).toContain("ship it");
	});

	// In the colour the agents column gives a booked wakeup, and not dim: this is the only line on the
	// pane that nobody asked for, so it is the one somebody scrolls back looking for.
	it("names the agent's own wakeup as one, rather than as an answer", () => {
		expect(transcript([{ from: "agent", via: "wake", text: "seguir" }])[0]).toBe(
			"\u001b[33m‹wake›\u001b[39m seguir",
		);
	});

	// Asked for a joke by mail, the operator watched the agent answer in the pane and had no way of
	// telling whether the mail ever went. The answer is the same either way; where it went is not.
	it("says where an answer left for, when it left", () => {
		expect(transcript([{ from: "agent", to: "email", text: "listo" }])[0]).toBe(
			"\u001b[33m‹→ email›\u001b[39m listo",
		);
	});

	// The same word for opposite directions. Marked alike, a question and its answer read as two
	// messages that arrived, and the one that went is the one worth being able to see go.
	it("does not mark an answer the way it marks a message that arrived", () => {
		const [went] = transcript([{ from: "agent", to: "email", text: "listo" }]);
		const [came] = transcript([{ from: "operator", via: "email", text: "contame un chiste" }]);

		expect(went).toContain("‹→ email›");
		expect(came).toContain("‹email›");
		expect(came).not.toContain("→");
	});

	// A turn that failed said nothing, and the person who asked is owed the reason where they asked.
	it("says a failure in the conversation it happened in", () => {
		expect(transcript([{ from: "plane", tone: "bad", text: "exited 1" }])[0]).toBe(
			"\u001b[31mexited 1\u001b[39m",
		);
	});

	it("says a thing that worked in the colour of a thing that worked", () => {
		expect(transcript([{ from: "plane", tone: "good", text: "logged in" }])[0]).toBe(
			"\u001b[32mlogged in\u001b[39m",
		);
	});

	// Nearly everything the plane says is an answer to a question that was asked, and red is what
	// makes the few lines that are not answers stand out. Coloured alike, none of them did.
	it("leaves an answer the colour of the terminal it was asked in", () => {
		expect(transcript([{ from: "plane", text: "On the shelf:\n  notion" }])).toEqual([
			"On the shelf:",
			"  notion",
		]);
	});

	// Between turns and not after each: the pane shows the last rows that fit, so a trailing blank
	// is a row of conversation given up to hold a gap against the prompt.
	it("leaves a blank line between one turn and the next, and none after the last", () => {
		expect(
			transcript([
				{ from: "agent", text: "a" },
				{ from: "agent", text: "b" },
			]),
		).toEqual(["a", "", "b"]);
	});

	// It is the operator's line, but it was not said to the agent, and `> !ls` read back later looks
	// like the agent was asked to run something it was never even told about.
	it("marks a shell line with the bang it was typed under, not with the agent's mark", () => {
		const line = transcript([{ from: "operator", text: "!ls" }])[0];

		expect(line).toContain("! ls");
		expect(line).not.toContain("> ");
	});

	// The bang is a mark, not the first letter of the command, so it stands off it like `> ` does.
	it("holds the bang off the command however the line was typed", () => {
		expect(transcript([{ from: "operator", text: "!   ls -la" }])[0]).toContain("! ls -la");
	});

	// What a command printed belongs to the command, the way it does in a terminal.
	it("keeps what a command printed against the command", () => {
		expect(
			transcript([
				{ from: "operator", text: "!ls" },
				{ from: "shell", text: "agent.yaml" },
			]),
		).toEqual([expect.stringContaining("! ls"), "agent.yaml"]);
	});
});

describe("visible", () => {
	it("keeps the last lines, which are the ones still worth reading", () => {
		expect(visible(["a", "b", "c"], 2, undefined)).toEqual(["b", "c"]);
	});

	it("shows all of a conversation that fits", () => {
		expect(visible(["a", "b"], 10, undefined)).toEqual(["a", "b"]);
	});

	// A pane can be given no rows at all while the window is being dragged, and slice(-0) is the
	// whole array rather than none of it.
	it("has nothing to show a pane with no room", () => {
		expect(visible(["a", "b"], 0, undefined)).toEqual([]);
		expect(visible(["a", "b"], -3, undefined)).toEqual([]);
	});

	it("shows the rows from where it was scrolled to", () => {
		expect(visible(["a", "b", "c", "d"], 2, 1)).toEqual(["b", "c"]);
	});

	/**
	 * Why the position is a line and not a distance from the end. A feed goes on arriving while it is
	 * being read, and measured from the end the paragraph worth stopping on slides up out of the pane
	 * at exactly the rate that made it worth stopping on.
	 */
	it("holds its place while the feed grows underneath it", () => {
		const before = visible(["a", "b", "c", "d"], 2, 1);

		expect(visible(["a", "b", "c", "d", "e", "f"], 2, 1)).toEqual(before);
	});

	// Scrolling down arrives at the end of the feed rather than below it, and scrolling up past the
	// start stops at the start: a pane of blank rows is a console that looks like it has crashed.
	it("does not scroll past either end", () => {
		expect(visible(["a", "b", "c"], 2, 99)).toEqual(["b", "c"]);
		expect(visible(["a", "b", "c"], 2, -99)).toEqual(["a", "b"]);
	});
});

/**
 * The mouse arrives as text, on the same stream as everything the operator types, and everything
 * downstream of this either scrolls on it, selects on it, or types it into the prompt.
 */
describe("mouse", () => {
	const report = (button: number, column = 40, row = 12, end = "M"): string =>
		`\u001b[<${button};${column};${row}${end}`;

	it("reads the wheel in both directions", () => {
		const [up] = mouse(report(64)) ?? [];
		const [down] = mouse(report(65)) ?? [];

		expect(up?.did === "wheel" && up.by).toBeLessThan(0);
		expect(down?.did === "wheel" && down.by).toBeGreaterThan(0);
	});

	// One flick of a trackpad arrives as several reports in a single chunk, and a pane that moved
	// once for the flick would take a minute to cross a long answer.
	it("answers for every report that arrived together", () => {
		expect(mouse(report(64).repeat(3))).toHaveLength(3);
	});

	it("tells a press from the drag that follows it and the release that ends it", () => {
		expect(mouse(report(0, 30, 9))).toEqual([{ did: "down", at: { column: 30, row: 9 } }]);
		expect(mouse(report(32, 30, 14))).toEqual([{ did: "drag", at: { column: 30, row: 14 } }]);
		expect(mouse(report(0, 30, 14, "m"))).toEqual([{ did: "up", at: { column: 30, row: 14 } }]);
	});

	// The bug this was extracted for. Asking the terminal for the mouse asks it for every button,
	// and a report nobody answers for is `[<2;39;15M` typed into the prompt.
	it("swallows the buttons it has nothing to do with", () => {
		expect(mouse(report(2))).toEqual([]);
		expect(mouse(report(66))).toEqual([]);
	});

	it("leaves what is not the mouse to whoever it was meant for", () => {
		expect(mouse("hola")).toBeUndefined();
		expect(mouse("")).toBeUndefined();
		// Escape is read here first and is the start of every mouse report, so a plain one getting
		// answered for as a mouse that did nothing is a key that silently stops working.
		expect(mouse("\u001b")).toBeUndefined();
	});
});

/**
 * Which rows of the screen a drag has hold of. The numbers here are the ones a real 100x30 window
 * draws: the panel is the full height of the panes row, the prompt has its box, and the last line
 * of talk lands on row 24 with the first on row 4.
 */
describe("holding", () => {
	const pane = { x: 24, y: 0, width: 76, height: 29 };
	const shape = { lines: 21, below: 3 };
	/** The pane's own edge and the two columns of border and padding it draws before any text. */
	const TEXT = 27;
	const drag = (from: number, to: number): { from: At; to: At } => ({
		from: { column: 40, row: from },
		to: { column: 40, row: to },
	});
	/** Which rows, for the tests that are about rows. */
	const rows = (span: Span | undefined): { from: number; to: number } | undefined =>
		span === undefined ? undefined : { from: span.from, to: span.to };

	it("counts from the first row the pane is showing", () => {
		// Rows 5 and 25 of the terminal are the first and the last of the conversation.
		expect(rows(holding(drag(5, 25), pane, shape))).toEqual({ from: 0, to: 20 });
		expect(rows(holding(drag(10, 12), pane, shape))).toEqual({ from: 5, to: 7 });
	});

	// A hand drags upwards as often as down, and a selection that only worked one way would look
	// like a selection that works when you are lucky.
	it("holds the same rows dragged either way", () => {
		expect(holding(drag(12, 10), pane, shape)).toEqual(holding(drag(10, 12), pane, shape));
	});

	// Pulling past the end means the end. Pressing outside means nothing at all: a drag that began
	// on the prompt or in the list of agents is not a selection, and answering for it would put the
	// last line of somebody else's conversation on the clipboard.
	it("clamps where the drag ends and refuses where it began", () => {
		expect(rows(holding(drag(10, 99), pane, shape))).toEqual({ from: 5, to: 20 });
		expect(rows(holding(drag(10, -5), pane, shape))).toEqual({ from: 0, to: 5 });
		expect(holding(drag(27, 27), pane, shape)).toBeUndefined();
		expect(holding(drag(2, 10), pane, shape)).toBeUndefined();
		expect(
			holding({ from: { column: 4, row: 10 }, to: { column: 4, row: 12 } }, pane, shape),
		).toBeUndefined();
	});

	// The feed has no prompt under it, so its last line is one row higher than the chat's.
	it("takes the rows a pane drew below the text as the pane reports them", () => {
		expect(rows(holding(drag(28, 28), pane, { lines: 24, below: 0 }))).toEqual({
			from: 23,
			to: 23,
		});
	});

	it("holds nothing in a pane that is showing nothing", () => {
		expect(holding(drag(10, 12), pane, { lines: 0, below: 3 })).toBeUndefined();
	});

	/**
	 * The whole of the complaint that started this: a hand asking for four words of a line was given
	 * the line, its indentation and the space at its end. What the columns are counted from is the
	 * first character of the text and not the edge of the terminal, since the paste has to slice a
	 * string that knows nothing of the border the pane is drawn with.
	 */
	it("holds the columns the hand went over, not the whole row", () => {
		const along = (from: number, to: number): { from: At; to: At } => ({
			from: { column: from, row: 10 },
			to: { column: to, row: 10 },
		});

		expect(holding(along(TEXT, TEXT + 3), pane, shape)).toEqual({
			from: 5,
			to: 5,
			head: 0,
			tail: 4,
		});
		// The cell the button came up on is held: a hand catching the last character of a word should
		// not have to overshoot it by one.
		expect(holding(along(TEXT + 5, TEXT + 5), pane, shape)?.tail).toBe(6);
	});

	it("holds the same columns dragged either way along a row", () => {
		const rightwards = { from: { column: 30, row: 10 }, to: { column: 44, row: 10 } };
		const leftwards = { from: { column: 44, row: 10 }, to: { column: 30, row: 10 } };

		expect(holding(leftwards, pane, shape)).toEqual(holding(rightwards, pane, shape));
		expect(holding(rightwards, pane, shape)).toEqual({ from: 5, to: 5, head: 3, tail: 18 });
	});

	/** Across rows the head belongs to the first row and the tail to the last, whichever way the
	 * hand travelled: what is held is everything between them, the way it reads. */
	it("gives the head to the first row and the tail to the last", () => {
		const down = { from: { column: 40, row: 10 }, to: { column: 30, row: 12 } };
		const up = { from: { column: 30, row: 12 }, to: { column: 40, row: 10 } };

		expect(holding(down, pane, shape)).toEqual({ from: 5, to: 7, head: 13, tail: 4 });
		expect(holding(up, pane, shape)).toEqual(holding(down, pane, shape));
	});

	// A press on the border or the padding is inside the pane and before the text, which is the same
	// as the start of the line: it is where a hand goes to take a whole line from the beginning.
	it("takes a press before the first character as the start of the line", () => {
		const edge = { from: { column: 25, row: 10 }, to: { column: 40, row: 10 } };

		expect(holding(edge, pane, shape)?.head).toBe(0);
	});
});

/** What is held is drawn inverted, and the colours already in the row have to survive it. */
describe("inverted", () => {
	const held = { from: 1, to: 3, head: 5, tail: 4 };

	it("leaves a row nothing is holding exactly as it was", () => {
		expect(inverted("hola mundo", held, 0)).toBe("hola mundo");
		expect(inverted("hola mundo", undefined, 2)).toBe("hola mundo");
	});

	it("holds a row in the middle from end to end", () => {
		expect(inverted("hola mundo", held, 2)).toBe("\u001b[7mhola mundo\u001b[27m");
	});

	it("opens on the first row where the hand pressed, and closes on the last where it let go", () => {
		expect(inverted("hola mundo", held, 1)).toBe("hola \u001b[7mmundo\u001b[27m");
		expect(inverted("hola mundo", held, 3)).toBe("\u001b[7mhola\u001b[27m mundo");
	});

	// The columns are what is on the screen, and the colours are not on the screen: counting them
	// would put the highlight several characters short of where the hand is.
	it("counts past the colours the row is written with", () => {
		expect(
			inverted("\u001b[36mdara\u001b[39m: hola", { from: 0, to: 0, head: 6, tail: 10 }, 0),
		).toBe("\u001b[36mdara\u001b[39m: \u001b[7mhola\u001b[27m");
	});

	it("holds nothing when the hand did not move off the character it pressed on", () => {
		expect(inverted("hola mundo", { from: 0, to: 0, head: 4, tail: 4 }, 0)).toBe("hola mundo");
	});
});

/** And what is pasted is what was drawn held, or the highlight was telling the hand a story. */
describe("between", () => {
	const line = "\u001b[36mdara\u001b[39m: hola mundo   ";

	it("takes the words between the columns, without the colours", () => {
		expect(between(line, 6, 10)).toBe("hola");
		expect(between(line, 0, 4)).toBe("dara");
	});

	it("takes the rest of the row when the columns run past its end", () => {
		expect(between(line, 6, 999)).toBe("hola mundo");
	});

	it("takes nothing at all from a row held between one column and itself", () => {
		expect(between(line, 6, 6)).toBe("");
	});
});

/** What lands on the clipboard is the words, not the colours they were drawn in. */
describe("bare", () => {
	it("strips what was only ever for the screen", () => {
		expect(bare("\u001b[36mdara\u001b[39m: hola   ")).toBe("dara: hola");
	});
});

describe("typed", () => {
	const said = (from: Said["from"], text: string): Said => ({ from, text });

	it("keeps what this operator typed, oldest first", () => {
		expect(
			typed([
				said("operator", "hola"),
				said("agent", "hola a vos"),
				said("operator", "/model"),
				said("other", "a push landed"),
			]),
		).toEqual(["hola", "/model"]);
	});

	/** A blank line is not a line anybody wants back: walking onto one reads as the walk breaking. */
	it("leaves out what was blank", () => {
		expect(typed([said("operator", "hola"), said("operator", "   ")])).toEqual(["hola"]);
	});

	/** Asking the same thing twice is one thing to walk back to, the way it is in a shell. */
	it("collapses a line said twice running", () => {
		expect(
			typed([said("operator", "/model"), said("operator", "/model"), said("operator", "hola")]),
		).toEqual(["/model", "hola"]);
	});

	it("keeps a line that comes round again later", () => {
		expect(
			typed([said("operator", "/model"), said("operator", "hola"), said("operator", "/model")]),
		).toEqual(["/model", "hola", "/model"]);
	});
});

/**
 * The column read back from a press, since the keyboard reaches it by a chord.
 *
 * The bare arrows belong to the line being typed, so moving between agents costs `^N` or `^P` — and
 * a list sitting in the left of the screen is a list a hand goes to point at. Rows counted rather
 * than measured: the column stands in the corner and keeps its width.
 */
describe("picked", () => {
	const shape = { agents: 2, rows: 20 };

	it("gives the agent whose row was pressed", () => {
		expect(picked({ row: 4, column: 4 }, shape)).toBe(0);
		expect(picked({ row: 5, column: 4 }, shape)).toBe(1);
	});

	it("gives the row that makes one, which is the number past the last agent", () => {
		expect(picked({ row: 7, column: 4 }, shape)).toBe(2);
	});

	it("gives the plane's own rows, which stand under the list", () => {
		expect(picked({ row: 9, column: 4 }, shape)).toBe(3);
		expect(picked({ row: 10, column: 4 }, shape)).toBe(4);
	});

	it("gives nothing for the header, the air, or a row with nothing on it", () => {
		expect(picked({ row: 2, column: 4 }, shape)).toBeUndefined();
		expect(picked({ row: 3, column: 4 }, shape)).toBeUndefined();
		expect(picked({ row: 6, column: 4 }, shape)).toBeUndefined();
		expect(picked({ row: 8, column: 4 }, shape)).toBeUndefined();
		expect(picked({ row: 15, column: 4 }, shape)).toBeUndefined();
	});

	it("gives nothing for a press in the panel beside it", () => {
		expect(picked({ row: 4, column: 40 }, shape)).toBeUndefined();
	});

	/** The column gives up its air before it gives up an agent, and the rows move up with it. */
	it("follows the list when the column is too short for air", () => {
		const tight = { agents: 3, rows: 9 };

		expect(picked({ row: 3, column: 4 }, tight)).toBe(0);
		expect(picked({ row: 5, column: 4 }, tight)).toBe(2);
		expect(picked({ row: 6, column: 4 }, tight)).toBe(3);
		expect(picked({ row: 7, column: 4 }, tight)).toBe(4);
		expect(picked({ row: 8, column: 4 }, tight)).toBe(5);
	});
});

/**
 * One key down the whole column, wrapping, which is what makes it one list rather than three lists.
 *
 * Wrapping is the point rather than a detail: without it the plane's two rows at the foot would cost
 * a walk through every agent to reach from the first of them, and no walk at all to reach going up.
 */
describe("walked", () => {
	it("moves one row down the column", () => {
		expect(walked(0, 1, 3)).toBe(1);
		expect(walked(1, 1, 3)).toBe(2);
	});

	it("comes back to the first agent from the last of the plane's rows", () => {
		expect(walked(5, 1, 3)).toBe(0);
	});

	it("reaches that row from the first agent, going up", () => {
		expect(walked(0, -1, 3)).toBe(5);
	});

	/** With no agents at all the column is three rows, and tab still walks all three. */
	it("walks a plane with nothing on it", () => {
		expect(walked(0, 1, 0)).toBe(1);
		expect(walked(2, 1, 0)).toBe(0);
	});
});

describe("panelAt", () => {
	it("opens a conversation down to the row that makes one, and the plane's screens under it", () => {
		expect(panelAt(0, 2)).toBe("chat");
		expect(panelAt(1, 2)).toBe("chat");
		expect(panelAt(2, 2)).toBe("chat");
		expect(panelAt(3, 2)).toBe("logs");
		expect(panelAt(4, 2)).toBe("config");
	});
});

/** What tab is about to open, which is what the row under the screen promises it will. */
describe("nextRow", () => {
	const agents = [{ id: "demo" }, { id: "maxi" }];

	it("names the row one tab away", () => {
		expect(nextRow(0, agents)).toBe("maxi");
		expect(nextRow(1, agents)).toBe("new agent");
		expect(nextRow(2, agents)).toBe("logs");
		expect(nextRow(3, agents)).toBe("config");
		expect(nextRow(4, agents)).toBe("demo");
	});

	it("cuts a name too long to promise in a footer", () => {
		expect(nextRow(3, [{ id: "an-agent-with-a-very-long-name" }])).toBe("an-agent-wi…");
	});
});

describe("completing", () => {
	it("takes the last word, and says where it starts", () => {
		expect(completing("cd worktrees")).toEqual({ from: 3, word: "worktrees" });
	});

	it("is the whole line when there is one word", () => {
		expect(completing("packages/")).toEqual({ from: 0, word: "packages/" });
	});

	it("is empty at a space, which is a word not begun", () => {
		expect(completing("cd ")).toEqual({ from: 3, word: "" });
	});

	/** An escaped space is a character of a name, so a tab after it is still on the same word. */
	it("walks through a space that was escaped", () => {
		expect(completing("cat mis\\ not")).toEqual({ from: 4, word: "mis\\ not" });
	});
});

describe("plain and quoted", () => {
	it("takes the escapes off what was typed, to ask about the name itself", () => {
		expect(plain("mis\\ notas/dia\\ 1")).toBe("mis notas/dia 1");
	});

	/** What goes back in has to survive the shell that will read it a keystroke later. */
	it("puts them back on everything the shell would otherwise act on", () => {
		expect(quoted("mis notas/")).toBe("mis\\ notas/");
		expect(quoted("$HOME.txt")).toBe("\\$HOME.txt");
		expect(quoted("what?.md")).toBe("what\\?.md");
	});

	it("leaves the separators alone, since a path is what is being written", () => {
		expect(quoted("packages/control-plane/")).toBe("packages/control-plane/");
	});

	it("comes back to itself", () => {
		expect(plain(quoted("mi carpeta (vieja)/"))).toBe("mi carpeta (vieja)/");
	});
});

describe("agreed", () => {
	it("is as far as every candidate is the same", () => {
		expect(agreed(["control-plane/", "control-server/"])).toBe("control-");
	});

	it("is the whole of it when there is only one", () => {
		expect(agreed(["packages/"])).toBe("packages/");
	});

	it("is nothing when they part at the first letter", () => {
		expect(agreed(["deploy/", "site/"])).toBe("");
	});

	it("is nothing at all when there is nothing", () => {
		expect(agreed([])).toBe("");
	});
});

describe("filled", () => {
	it("types a lone candidate out in full, and moves on to the next word", () => {
		expect(filled("cat READ", ["README.md"])).toEqual({ draft: "cat README.md ", options: [] });
	});

	/** A directory is not the end of a path, so the next tab goes into it rather than past it. */
	it("leaves the hand inside a directory it completed", () => {
		expect(filled("cd pack", ["packages/"])).toEqual({ draft: "cd packages/", options: [] });
	});

	it("types as far as the candidates agree, and offers the rest", () => {
		expect(
			filled("cd packages/co", ["packages/control-plane/", "packages/control-server/"]),
		).toEqual({
			draft: "cd packages/control-",
			options: ["packages/control-plane/", "packages/control-server/"],
		});
	});

	it("leaves the line alone when nothing matches", () => {
		expect(filled("cd nada", [])).toEqual({ draft: "cd nada", options: [] });
	});

	it("replaces the word it was standing on and nothing before it", () => {
		expect(filled("cp -r src/ pack", ["packages/"])).toEqual({
			draft: "cp -r src/ packages/",
			options: [],
		});
	});

	it("escapes what it types, so a name with a space in it goes in as one word", () => {
		expect(filled("cd mis", ["mis notas/"])).toEqual({ draft: "cd mis\\ notas/", options: [] });
	});
});

describe("recalled", () => {
	const past = ["primero", "segundo", "tercero"];

	it("hands back the newest line first, and holds on to what was half typed", () => {
		expect(recalled(past, undefined, 1, "medio escr")).toEqual({
			walk: { back: 1, typing: "medio escr" },
			draft: "tercero",
		});
	});

	it("goes further back a step at a time", () => {
		const one = recalled(past, undefined, 1, "");
		const two = recalled(past, one.walk, 1, one.draft);

		expect(two).toEqual({ walk: { back: 2, typing: "" }, draft: "segundo" });
	});

	/** Stopping on the oldest rather than emptying the prompt, which is what every shell does. */
	it("stays on the oldest once there is nothing further back", () => {
		const deep: Walk = { back: 3, typing: "" };

		expect(recalled(past, deep, 1, "primero")).toEqual({ walk: deep, draft: "primero" });
	});

	it("comes back down through the lines it walked up", () => {
		expect(recalled(past, { back: 3, typing: "" }, -1, "primero")).toEqual({
			walk: { back: 2, typing: "" },
			draft: "segundo",
		});
	});

	/**
	 * The line that was being written when the walk began comes back whole. A stray arrow that ate it
	 * would leave nothing to do but remember it and type it again.
	 */
	it("gives back the half-written line at the end of the walk", () => {
		expect(recalled(past, { back: 1, typing: "medio escr" }, -1, "tercero")).toEqual({
			walk: undefined,
			draft: "medio escr",
		});
	});

	it("leaves the prompt alone when there is nothing to walk", () => {
		expect(recalled([], undefined, 1, "medio escr")).toEqual({
			walk: undefined,
			draft: "medio escr",
		});
		expect(recalled(past, undefined, -1, "medio escr")).toEqual({
			walk: undefined,
			draft: "medio escr",
		});
	});
});

/**
 * Following the end and being parked on a row are different states, and the whole of scrolling is
 * knowing which one it is in.
 */
describe("scrolled", () => {
	const pane = { total: 100, height: 10 };

	it("leaves the end when it is moved off it", () => {
		expect(scrolled(undefined, -1, pane)).toBe(89);
		expect(scrolled(undefined, -10, pane)).toBe(80);
	});

	// Arriving back at the end is arriving back at following it: an agent asked something while the
	// pane was parked one row above the bottom would answer permanently out of sight.
	it("follows the end again once it is scrolled back to it", () => {
		expect(scrolled(89, 1, pane)).toBeUndefined();
		expect(scrolled(20, 500, pane)).toBeUndefined();
	});

	it("stops at the first row rather than above it", () => {
		expect(scrolled(3, -50, pane)).toBe(0);
	});

	// The bug this was extracted for: a pane showing everything it has is at its end whatever is
	// pressed at it, and one that says otherwise is telling the operator to go looking for nothing.
	it("is at the end already when everything fits", () => {
		expect(scrolled(undefined, -10, { total: 3, height: 20 })).toBeUndefined();
		expect(scrolled(undefined, -10, { total: 0, height: 20 })).toBeUndefined();
	});
});

/**
 * A conversation is not this console's questions and answers, it is everything an agent was told
 * and everything it said, whoever set it going.
 */
describe("resume", () => {
	it("picks up the conversation the plane kept", () => {
		const talk = resume({ scout: [{ from: "operator", text: "hola" }] }, 80);

		expect(saidBy(talk, "scout")).toEqual([{ from: "operator", text: "hola" }]);
	});

	// The stored line is the words. Markdown becomes ANSI on the way in, once, rather than on every
	// keystroke that re-wraps the pane.
	it("renders the agent's markdown as the terminal will show it", () => {
		const [said] = saidBy(resume({ scout: [{ from: "agent", text: "**hecho**" }] }, 80), "scout");

		expect(said?.text).not.toBe("**hecho**");
		expect(said?.text).toContain("hecho");
	});

	it("keeps where a line came from, so the pane can say", () => {
		const talk = resume({ scout: [{ from: "agent", via: "wake", text: "seguir" }] }, 80);

		expect(saidBy(talk, "scout")[0]?.via).toBe("wake");
	});
});

/**
 * Which row the keyboard is on, said in the name itself now that there is no gutter to say it in.
 *
 * The list is the one place on the screen where a row is chosen rather than read, so it has to be
 * legible at a glance and legible without the pointer that used to push the whole column sideways.
 */
describe("pointed", () => {
	// The same cyan the panel title gives the same name, so the row and the pane it opens read as
	// one thing rather than as two places the name happens to appear.
	it("marks the row the cursor is on in the colour the title gives the same name", () => {
		expect(pointed(true, true)).toEqual({ bold: true, color: "cyan", dimColor: false });
	});

	it("leaves a running agent the colour of the terminal, and dims one that is stopped", () => {
		expect(pointed(false, true).dimColor).toBe(false);
		expect(pointed(false, false).dimColor).toBe(true);
	});

	// Dim is how a terminal says a line may be skipped, and the row the keyboard is standing on is
	// the one row that may not be. A stopped agent is still where the next keystroke goes.
	it("does not dim the row the cursor is on, stopped or not", () => {
		expect(pointed(true, false).dimColor).toBe(false);
	});
});

/**
 * The column exists to answer one question at a glance: which of these is doing something. Merely
 * being up is the answer you could have got by asking again in a second; thinking is not.
 */
describe("Column", () => {
	const listed = (id: string, running: boolean): AgentSummary => ({
		id,
		running,
		startedAt: undefined,
		grants: 1,
		schedules: 0,
		wakeAt: undefined,
		created: false,
		spentUsd: 0,
		limitUsd: undefined,
		model: undefined,
		served: [],
		bot: undefined,
		mail: undefined,
	});
	const three = [listed("scout", true), listed("scribe", true), listed("sleeper", false)];

	// An agent that booked its own next turn will act with nobody watching. The wait is the only
	// warning of that there is, and it belongs on the row rather than behind a command.
	it("shows how long until an agent wakes itself", () => {
		const waiting = {
			...listed("scout", true),
			wakeAt: new Date(Date.now() + 900_000).toISOString(),
		};
		const drawn = renderToString(
			h(Column, { agents: [waiting], spot: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).toContain("15m");
	});

	it("marks a thinking agent apart from one that is only up", () => {
		const drawn = renderToString(
			h(Column, {
				agents: three,
				spot: 0,
				busy: new Map([["scribe", Date.now()]]),
				rows: 10,
			}),
		);

		expect(drawn).toContain("●      scout");
		expect(drawn).toContain("◐      scribe");
		expect(drawn).toContain("○      sleeper");
	});

	// The list is what you read while an answer streams past it, and one that resizes as it streams
	// is unreadable. Flex would otherwise take the column's width as a preference.
	it("keeps its width beside a pane whose text does not fit", () => {
		const drawn = renderToString(
			h(
				Box,
				{ flexDirection: "row" },
				h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 10 }),
				h(Box, { flexGrow: 1 }, h(Text, null, "unbreakable".repeat(20))),
			),
			{ columns: 80 },
		);

		expect(drawn.split("\n")[0]).toMatch(/^╭─{22}╮/);
	});

	// One of the rows is the one that makes an agent, so three rows hold two agents and it.
	it("shows only what the pane has room for", () => {
		const drawn = renderToString(
			h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 8 }),
		);

		expect(drawn).toContain("scribe");
		expect(drawn).not.toContain("sleeper");
	});

	// "Which of these is burning through its day" is a question about all of them at once, and the
	// header can only ever answer it about the one being looked at.
	it("says what each agent has spent", () => {
		const drawn = renderToString(
			h(Column, {
				agents: [{ ...listed("scout", true), spentUsd: 0.42 }],
				spot: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);

		expect(drawn).toContain("$0.42");
	});

	// A fleet of zeroes is a column of noise to read past, and what is looked for here is the row
	// that is not like the others.
	it("says nothing about an agent that has spent nothing", () => {
		const drawn = renderToString(
			h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).not.toContain("$0.00");
	});

	// Making an agent is a row in the list of agents because that is where somebody who wants one is
	// already looking. Behind a command it is a thing only whoever wrote the command ever finds.
	it("offers a row that makes one, under the agents", () => {
		const drawn = renderToString(
			h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).toContain("+ new agent");
		const rows = drawn.split("\n");
		expect(rows.findIndex((row) => row.includes("+ new agent"))).toBeGreaterThan(
			rows.findIndex((row) => row.includes("sleeper")),
		);
	});

	// The first thing a plane with nothing in it can do, on the row the cursor opens on: an empty
	// column that only said "no agents" left nowhere to go but out of the console.
	it("is the only row there is when there are no agents", () => {
		const drawn = renderToString(
			h(Column, { agents: [], spot: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).toContain("+ new agent");
		expect(drawn).not.toContain("●");
	});

	// The whole of what the cursor broke: a pointer in a gutter of its own left the header against
	// one column and every row under it against another, and the gutter was empty on all but one row.
	it("keeps every row in the column its header starts in", () => {
		const rows = renderToString(
			h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 10 }),
		).split("\n");
		const at = (text: string): number =>
			rows.find((row) => row.includes(text))?.indexOf(text) ?? -1;

		expect(at("agents")).toBeGreaterThan(0);
		expect(at("●")).toBe(at("agents"));
		expect(at("+ new agent")).toBe(at("agents"));
	});

	// A header touching the first agent is a fourth agent, and the row that makes one touching the
	// last is a fifth. The blanks are what say which of these rows are the list.
	it("sets the list off from its header and from the row that makes one", () => {
		const rows = renderToString(
			h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 13 }),
		).split("\n");
		const blank = (row: string | undefined): boolean => /^│\s+│$/.test(row ?? "");

		expect(blank(rows[rows.findIndex((row) => row.includes("agents")) + 1])).toBe(true);
		expect(blank(rows[rows.findIndex((row) => row.includes("+ new agent")) - 1])).toBe(true);
	});

	// Air is what a column has when it has room for it. An agent it could have drawn is not what it
	// should be spending a row on.
	it("gives the blanks up rather than an agent, when it is short", () => {
		const drawn = renderToString(
			h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 9 }),
		);

		expect(drawn).toContain("sleeper");
		expect(drawn).toContain("+ new agent");
		expect(drawn.split("\n").some((row) => /^│\s+│$/.test(row))).toBe(false);
	});

	// The agents are the content and the row is the way to add to them, but a column that dropped it
	// to fit one more agent would be a column you cannot make an agent from at exactly the moment
	// you have too many to see.
	it("keeps the row when there is not room for every agent", () => {
		const drawn = renderToString(
			h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows: 7 }),
		);

		expect(drawn).toContain("+ new agent");
		expect(drawn).toContain("scout");
		expect(drawn).not.toContain("scribe");
	});

	/**
	 * Rendered inside a box of the height it was told about, which is the only way this shows up.
	 *
	 * Ink does not cut a column that asks for more rows than its box has — it writes the overflow over
	 * what is already drawn, so `logs` came out through the middle of `+ new agent`. On its own the
	 * column reports whatever height it likes and every assertion about it passes.
	 */
	it("fits the box it was given, at every height it is given one", () => {
		for (let rows = 5; rows <= 16; rows++) {
			const drawn = renderToString(
				h(
					Box,
					{ flexDirection: "row", height: rows },
					h(Column, { agents: three, spot: 0, busy: new Map<string, number>(), rows }),
				),
			).split("\n");

			expect(drawn.length, `${rows} rows`).toBe(rows);
			// The plane's own two are what a short column keeps: a console you cannot reach the keys
			// from is a console that cannot be set up at all.
			expect(drawn.some((row) => row.trim() === "│ logs                 │")).toBe(true);
			expect(drawn.some((row) => row.trim() === "│ config               │")).toBe(true);
		}
	});

	// The two of them used to bid for the same eight columns and the money always lost, so the one
	// agent whose spending went unsaid was the one about to spend again while nobody was watching.
	it("says what an agent has spent even when it has a turn booked", () => {
		const drawn = renderToString(
			h(Column, {
				agents: [
					{
						...listed("scribe", true),
						spentUsd: 1.5,
						wakeAt: new Date(Date.now() + 900_000).toISOString(),
					},
				],
				spot: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);

		expect(drawn).toContain("15m");
		expect(drawn).toContain("$1.50");
	});

	// The numbers are what the row is read for and the name is recoverable — the title row says it in
	// full — so when they will not all fit it is the name that is cut, not one of the two facts.
	it("cuts the name rather than a number when the row will not hold both", () => {
		const agent = {
			...listed("support-emma", true),
			spentUsd: 1.5,
			wakeAt: new Date(Date.now() + 900_000).toISOString(),
		};

		expect(laid(agent, 18)).toEqual({
			name: "support…",
			gap: " ",
			wake: "15m",
			spent: "$1.50",
		});
	});

	// Six agents' spending is a question about which of them is the largest, and numbers that start
	// at six different columns are read one at a time.
	it("lines the numbers up against the right edge, whatever the name", () => {
		const drawn = renderToString(
			h(Column, {
				agents: [
					{ ...listed("ana", true), spentUsd: 1.5 },
					{ ...listed("beto", true), spentUsd: 12 },
				],
				spot: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);
		const rows = drawn.split("\n");
		const first = rows.find((row) => row.includes("ana"));
		const second = rows.find((row) => row.includes("beto"));

		// Where each of them ends, which is what lining numbers up means when they are not the same
		// length: it is the last digit that has to sit under the last digit.
		expect((first?.indexOf("$1.50") ?? 0) + "$1.50".length).toBe(
			(second?.indexOf("$12.00") ?? 0) + "$12.00".length,
		);
	});

	// Four decimals is what the plane says in a sentence. Here it is seven columns telling two agents
	// apart by an amount neither of them has, in the one place a number is scanned rather than read.
	it("says a spend under a cent short, and leaves the room to the ones that are not", () => {
		const drawn = renderToString(
			h(Column, {
				agents: [{ ...listed("scout", true), spentUsd: 0.0004 }],
				spot: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);

		expect(drawn).toContain("<$0.01");
		expect(drawn).not.toContain("0.0004");
	});

	// The question asked of this column is which of six agents has a bot at all, and that is asked of
	// the list rather than of a row: marks that started at a different column on every line would be
	// read one at a time, which is the thing a mark is for instead of a word.
	it("leaves the room for a way in an agent has not got, so the names still line up", () => {
		const drawn = renderToString(
			h(Column, {
				agents: [
					{
						...listed("ana", true),
						bot: { username: "ana_bot", paired: true },
						mail: { address: "agents+ana@squad.dev", writes: true },
					},
					listed("beto", true),
				],
				spot: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		)
			.split("\n")
			.map(bare);

		expect(drawn.find((row) => row.includes("ana"))).toContain("🤖📬");
		expect(drawn.find((row) => row.includes("ana"))?.indexOf("ana")).toBe(
			drawn.find((row) => row.includes("beto"))?.indexOf("beto"),
		);
	});
});

/**
 * Both of these are states no other screen admits to. A bot whose token was pasted and whose link
 * nobody tapped answers nobody, and a mailbox connected for reading takes an agent's mail and leaves
 * it no way to reply — and from anywhere else in this console both look like working.
 */
describe("reached", () => {
	const agent: AgentSummary = {
		id: "demo",
		running: true,
		startedAt: undefined,
		grants: 0,
		schedules: 0,
		wakeAt: undefined,
		created: false,
		spentUsd: 0,
		limitUsd: undefined,
		model: undefined,
		served: [],
		bot: { username: "demo_bot", paired: true },
		mail: { address: "agents+demo@squad.dev", writes: true },
	};

	// A terminal paints an emoji in the colours it comes with, so a yellow asked for here is a warning
	// that never arrives. The half connected are drawn as something else instead.
	it("draws the half connected rather than colouring them", () => {
		expect(reached(agent)[0].glyph).toBe("🤖");
		expect(reached({ ...agent, bot: { username: "demo_bot", paired: false } })[0].glyph).toBe("🔗");
		expect(reached(agent)[1].glyph).toBe("📬");
		expect(
			reached({ ...agent, mail: { address: "agents+demo@squad.dev", writes: false } })[1].glyph,
		).toBe("📪");
	});

	// The colour is what the title row paints the username and the address in, where the piece is
	// words rather than a picture. An account the plane connected once is an address for every agent
	// it has, so a colour on a working mailbox would be six rows saying the same thing.
	it("carries the colour the title row says a name in", () => {
		expect(reached(agent)[0].color).toBe("green");
		expect(reached({ ...agent, bot: { username: "demo_bot", paired: false } })[0].color).toBe(
			"yellow",
		);
		expect(reached(agent)[1].color).toBe("gray");
	});

	// Two columns of room, because the marks beside it take two each and a row that gave the space
	// back would put its name where no other row has one.
	it("leaves the room for a way in an agent has not been given", () => {
		const [bot, mail] = reached({ ...agent, bot: undefined, mail: undefined });

		expect([bot.glyph, mail.glyph]).toEqual(["  ", "  "]);
	});
});

/**
 * The title row is the only place an agent says what it is. Everything here was already crossing
 * the socket and being thrown away, and the cost of that was going to read the operator's file to
 * find out which model an agent was answering badly with.
 */
describe("standing", () => {
	const agent: AgentSummary = {
		id: "demo",
		running: true,
		startedAt: undefined,
		grants: 1,
		schedules: 0,
		wakeAt: undefined,
		created: false,
		spentUsd: 0.42,
		limitUsd: 5,
		model: "deepseek-v4-flash",
		served: [],
		bot: { username: "demo_bot", paired: true },
		mail: { address: "agents+demo@squad.dev", writes: true },
	};

	it("says where it is reached, what it thinks with, and what it has spent against its ceiling", () => {
		expect(standing(agent, 80)).toEqual({
			bot: "🤖 @demo_bot",
			mail: "📬 agents+demo@squad.dev",
			model: "deepseek-v4-flash",
			spend: "$0.42 / $5.00",
		});
	});

	// The address is the longest thing on the row and the column beside it has already said there is
	// one. Which address it is can be had from `/email`, and does not change while you watch it.
	it("gives up the address first as the terminal narrows, and the bot next", () => {
		expect(standing(agent, 60)).toEqual({
			bot: "🤖 @demo_bot",
			mail: "",
			model: "deepseek-v4-flash",
			spend: "$0.42 / $5.00",
		});
		expect(standing(agent, 40)).toEqual({
			bot: "",
			mail: "",
			model: "deepseek-v4-flash",
			spend: "$0.42 / $5.00",
		});
	});

	// The money is what an operator comes back to the screen for; the model is what explains it.
	it("gives up the model before the money", () => {
		expect(standing(agent, 20)).toEqual({
			bot: "",
			mail: "",
			model: "",
			spend: "$0.42 / $5.00",
		});
	});

	// What was spent is a fact; what it was allowed to be is a second fact about the first.
	it("gives up the ceiling next, and then everything", () => {
		expect(standing(agent, 8)).toEqual({ bot: "", mail: "", model: "", spend: "$0.42" });
		expect(standing(agent, 2)).toEqual({ bot: "", mail: "", model: "", spend: "" });
	});

	// A bot whose token was pasted and whose link nobody tapped has no username to say and is not a
	// bot anybody can write to. The mark in the column is what says it is there and waiting.
	it("says nothing of a bot with no name to give", () => {
		expect(standing({ ...agent, bot: { username: undefined, paired: false } }, 80).bot).toBe("");
	});

	// A `deepseek-v4-fl…` is a fact half said. A row that says less reads better than one that says
	// everything badly, so nothing here is ever cut to a stump.
	it("never shows half of a name", () => {
		const { model } = standing(agent, 25);

		expect(model === "" || model === "deepseek-v4-flash").toBe(true);
	});

	it("says the spend of an agent with no ceiling without inventing one", () => {
		expect(standing({ ...agent, limitUsd: undefined }, 60).spend).toBe("$0.42");
	});
});

describe("Chat", () => {
	const long = Array.from({ length: 20 }, (_, index) => ({
		from: "agent" as const,
		text: `line ${index}`,
	}));
	const chat = (props: {
		history: readonly { from: "operator" | "agent"; text: string }[];
		draft?: string;
		rows?: number;
		columns?: number;
		thinking?: Thinking | undefined;
		queued?: readonly Said[];
		top?: number | undefined;
		shell?: string | undefined;
		confirm?: string | undefined;
		menu?: readonly Command[];
		pick?: number;
		held?: Span | undefined;
	}) =>
		renderToString(
			h(Chat, {
				draft: "",
				rows: 4,
				columns: 40,
				thinking: undefined,
				queued: [],
				top: undefined,
				shell: undefined,
				confirm: undefined,
				menu: [],
				pick: 0,
				held: undefined,
				...props,
			}),
			{ columns: props.columns ?? 40 },
		);

	it("keeps the room the prompt needs, at the cost of the oldest line", () => {
		const drawn = chat({ history: long });

		expect(drawn).toContain("line 19");
		expect(drawn).not.toContain("line 17");
		expect(drawn).toContain(">");
	});

	// Scrolled back, the pane is showing history — but it is still a pane with a bottom, and the row
	// budget is the same one whether the rows are the newest or the oldest.
	it("shows an older stretch without giving up a row to do it", () => {
		const drawn = chat({ history: long, rows: 8, top: 2 }).split("\n");

		expect(drawn).toHaveLength(8);
		expect(drawn.join("\n")).toContain("line 2");
		expect(drawn.join("\n")).not.toContain("line 19");
	});

	it("shows the line being typed", () => {
		expect(chat({ history: [], draft: "que es" })).toContain("que es");
	});

	// A spinner says something is happening. The number beside it is what says whether it is still
	// happening, which is the question being asked after the first few seconds.
	it("says how long the agent has been thinking, not only that it is", () => {
		const drawn = chat({ history: [], thinking: { frame: "⠙", seconds: 42 } });

		expect(drawn).toContain("⠙ 42s");
	});

	/**
	 * The whole of why it is not in the box. A turn takes minutes and the next question is thought of
	 * during them; a prompt wearing a spinner is a box that looks like it is not taking keys.
	 */
	it("leaves the prompt free to type into while the turn runs", () => {
		const drawn = chat({ history: [], draft: "y de paso", thinking: { frame: "⠙", seconds: 42 } });

		expect(drawn).toContain("> y de paso");
	});

	// Forty seconds is the same forty seconds whether the agent is stuck on the model or running a
	// test suite, and only one of those is worth waiting out.
	it("says what it is doing beside how long it has been doing it", () => {
		const drawn = chat({
			history: [],
			columns: 60,
			thinking: { frame: "⠙", seconds: 42, step: "bash pnpm test" },
		});

		expect(drawn).toContain("⠙ 42s");
		expect(drawn).toContain("bash pnpm test");
	});

	// A turn that has not reached its first tool is still doing something, and a clock with nothing
	// beside it is a number floating under the conversation.
	it("says it is thinking before there is a step to name", () => {
		expect(chat({ history: [], thinking: { frame: "⠙", seconds: 3 } })).toContain("⠙ 3s thinking");
	});

	// The row is one row wherever it is: a step's detail is a whole shell command, and one drawn to
	// its full length would wrap and cost the conversation a line on every tool call.
	it("cuts a long step to the width of the pane, and says it was cut", () => {
		const drawn = chat({
			history: [],
			columns: 40,
			thinking: { frame: "⠙", seconds: 4, step: `bash ${"x".repeat(200)}` },
		}).split("\n");

		expect(drawn[0]).toHaveLength(40);
		expect(drawn[0]).toContain("…");
	});

	// Both are true at once and neither answers for the other: one says where the next line will run,
	// the other says the last one is still running. They stopped sharing a row, so they stopped queueing.
	it("says what the turn is doing while the prompt is the sandbox's", () => {
		const drawn = chat({
			history: [],
			shell: "/work",
			thinking: { frame: "⠙", seconds: 4, step: "bash pnpm test" },
		});

		expect(drawn).toContain("bash pnpm test");
		expect(drawn).toContain("! /work");
	});

	/**
	 * A message typed at a busy agent is answered minutes later, and put straight into the conversation
	 * it lands above the answer still being written — so that answer reads as a reply to it.
	 */
	it("holds a message the agent has not been told yet above the prompt", () => {
		const drawn = chat({
			history: [{ from: "agent", text: "un webhook es" }],
			columns: 60,
			rows: 8,
			thinking: { frame: "⠙", seconds: 9 },
			queued: [{ from: "operator", text: "puede ser cada 10 minutos?" }],
		});

		expect(bare(drawn)).toContain("⋯ puede ser cada 10 minutos?");
		// Its own mark rather than the transcript's, which is the whole of saying it is still waiting.
		expect(bare(drawn)).not.toContain("> puede ser");
	});

	// Two questions asked while one answer is being written are two rows, in the order they were
	// typed: they are answered in that order, and a queue drawn out of order is not a queue.
	it("keeps the ones waiting in the order they were typed", () => {
		const drawn = chat({
			history: [],
			columns: 60,
			rows: 8,
			queued: [
				{ from: "operator", text: "primera" },
				{ from: "operator", text: "segunda" },
			],
		}).split("\n");
		const first = drawn.findIndex((line) => line.includes("primera"));

		expect(first).toBeGreaterThanOrEqual(0);
		expect(drawn[first + 1]).toContain("segunda");
	});

	// Who is waiting to be heard is worth as much above the prompt as it is down in the pane: a
	// message that arrived by mail and one somebody typed are both text addressed to the agent.
	it("says where a queued message came from, when it came from somewhere else", () => {
		const drawn = chat({
			history: [],
			columns: 60,
			rows: 8,
			queued: [{ from: "other", via: "telegram", text: "hola" }],
		});

		expect(drawn).toContain("⋯ ");
		expect(drawn).toContain("‹telegram›");
	});

	// The seconds are a comfort and can be gone without. A line somebody typed that nobody has
	// answered yet is the thing on this pane they are still owed.
	it("gives up the clock before it gives up a message still waiting", () => {
		const drawn = chat({
			history: [{ from: "agent", text: "hola" }],
			rows: 4,
			thinking: { frame: "⠙", seconds: 9, step: "bash pnpm test" },
			queued: [{ from: "operator", text: "y de paso" }],
		});

		expect(bare(drawn)).toContain("⋯ y de paso");
		expect(drawn).not.toContain("bash pnpm test");
	});

	/**
	 * The one thing a pane may never do. Anything it draws past its last row lands on the border, on
	 * the column beside it, and below the bottom of the terminal — the screen does not scroll, it
	 * breaks, and the only way back is to quit.
	 */
	it("never draws more rows than it was given", () => {
		const paragraph = { from: "agent" as const, text: "palabra ".repeat(200).trim() };

		for (const rows of [1, 2, 5, 12]) {
			expect(chat({ history: [paragraph], rows }).split("\n")).toHaveLength(rows);
			// The working row and the queue are more things standing between the talk and the prompt,
			// and a pane with no room for them goes without rather than drawing off its own bottom edge.
			expect(
				chat({
					history: [paragraph],
					rows,
					menu: [{ name: "/model", takes: "<name>", does: "answer with" }],
					thinking: { frame: "⠙", seconds: 4, step: "bash pnpm test" },
					queued: Array.from({ length: 6 }, (_, index) => ({
						from: "operator" as const,
						text: `pregunta ${index}`,
					})),
				}).split("\n"),
			).toHaveLength(rows);
		}
	});

	// A line being typed outruns the pane long before it is finished. Wrapping it would cost a row
	// of conversation on every keystroke past the edge; what is worth seeing is the end of it.
	it("holds the prompt to one row, showing the end of what is typed", () => {
		const drawn = chat({ history: [], draft: `${"x".repeat(300)}final` }).split("\n");

		// Its two borders and the line between them, and the line is where the end of the draft is.
		expect(drawn).toHaveLength(3);
		expect(drawn[1]).toContain("final");
	});

	// The border is worth two rows of a tall pane and is unaffordable in a short one, where those two
	// rows are the conversation. Drawing it anyway is the broken screen again.
	it("gives up the prompt's border rather than the room it does not have", () => {
		const drawn = chat({ history: [{ from: "agent", text: "hola" }], rows: 2 }).split("\n");

		expect(drawn).toHaveLength(2);
		expect(drawn[0]).toContain("hola");
		expect(drawn[1]).toContain(">");
	});

	// The mode has to be visible while it is on: finding out that a line ran in the sandbox by
	// watching it run is finding out too late.
	it("says which directory the line being typed will run in", () => {
		const drawn = chat({ history: [], draft: "ls -la", shell: "/home/agent/.self/src" });

		expect(drawn).toContain("! ~/.self/src");
		expect(drawn).toContain("ls -la");
		expect(drawn).not.toContain("> ");
	});

	/**
	 * `!` reaches the box whether or not the agent is thinking, and a line typed at what looked like
	 * the agent's prompt would have run in the sandbox instead.
	 */
	it("keeps saying it is the shell while the agent thinks", () => {
		const drawn = chat({
			history: [],
			shell: "/home/agent/.self",
			thinking: { frame: "⠙", seconds: 42 },
		});

		expect(drawn).toContain("! ~/.self");
	});

	// Where it breaks matters as much as that it breaks: a path has no space in it, and text that
	// only broke on spaces would draw it off the edge. The prompt is left out — it is the one row
	// carrying colour, and colour is not width.
	it("breaks a word that has nowhere to break", () => {
		const said = chat({ history: [{ from: "agent", text: "/home/agent/.self/".repeat(20) }] })
			.split("\n")
			.slice(0, -1);

		for (const row of said) expect(row.length).toBeLessThanOrEqual(40);
	});

	it("offers what the line being typed could still become", () => {
		const drawn = chat({
			history: [],
			draft: "/li",
			menu: [...COMMANDS],
			pick: 0,
			rows: 8,
			columns: 90,
		});

		expect(drawn).toContain("/limit");
		expect(drawn).toContain("what it has spent today, and the ceiling for it");
	});

	// A name written against its own description reads as one word. The gap is measured off the
	// widest entry being shown, so adding a longer command does not silently close it.
	it("keeps the descriptions off the names, whatever the names are", () => {
		const drawn = chat({
			history: [],
			draft: "/",
			menu: [...COMMANDS],
			pick: 0,
			// Room for every one of them, since the point is how they line up against each other.
			rows: COMMANDS.length + 4,
			columns: 90,
		});

		const named = COMMANDS.map((command) => `${command.name} ${command.takes}`.trimEnd());
		const widest = Math.max(...named.map((name) => name.length));

		for (const [index, command] of COMMANDS.entries()) {
			expect(drawn).toContain(
				`${named[index]?.padEnd(widest + 2)}${command.does.split(" ")[0] ?? ""}`,
			);
		}
	});

	// The arrows are the only way to reach an entry that is not the first, so which one they are on
	// has to be visible. A list that highlights nothing is a list you cannot choose from.
	it("marks the entry the arrows are on", () => {
		const drawn = chat({ history: [], draft: "/", menu: [...COMMANDS], pick: 1, rows: 8 });
		const marked = drawn.split("\n").find((row) => row.includes("▸"));

		expect(marked).toContain(COMMANDS[1]?.name);
	});

	/**
	 * Which stops being true the moment the menu is longer than the pane, and it is: the models are on
	 * it now, and a plane can configure more of them than a short terminal has rows. A list cut at the
	 * top would leave the cursor arrowed off the bottom, pressing return at a row nobody can see.
	 */
	it("brings the fold along when the arrows go past the bottom of it", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({
			name: `/model m${index}`,
			takes: "",
			does: "openai/gpt-5",
		}));

		const drawn = chat({ history: [], draft: "/model ", menu: many, pick: 17, rows: 8 });

		expect(drawn.split("\n").find((row) => row.includes("▸"))).toContain("/model m17");
	});

	// The menu is drawn out of the conversation's rows, not over them: a row drawn where a row
	// already is scrolls the terminal by one and tears the frame in half.
	it("takes its rows from the conversation rather than from the prompt", () => {
		const drawn = chat({ history: long, draft: "/", menu: [...COMMANDS], pick: 0, rows: 8 });

		expect(drawn.split("\n")).toHaveLength(8);
		expect(drawn).toContain("/limit");
		expect(drawn).toContain("line 19");
	});
});

/**
 * The pane behind the last row of the column. A name is all a keyboard decides here, which is why
 * the pane says so: what the agent behind it may reach is the operator's file and nothing typed
 * into this box moves it.
 */
describe("New", () => {
	const pane = (props: {
		draft?: string;
		rows?: number;
		columns?: number;
		making?: { name: string; frame: string; seconds: number } | undefined;
		refused?: string | undefined;
	}) =>
		renderToString(
			h(New, {
				draft: "",
				rows: 8,
				columns: 60,
				making: undefined,
				refused: undefined,
				...props,
			}),
			{ columns: props.columns ?? 60 },
		);

	it("shows the name being typed", () => {
		expect(pane({ draft: "support-emma" })).toContain("support-emma");
	});

	it("says what a new agent is given, since the name is the only part being chosen", () => {
		expect(pane({})).toContain("lowercase, digits and dashes");
	});

	// Every refusal here is about the name that was just typed — it is taken, or it is not a name —
	// and the name is still in the prompt, which is the one place the answer is any use.
	it("says why the last name was refused, where that name still is", () => {
		const drawn = pane({ draft: "scout", refused: `"scout" is already here` });

		expect(drawn).toContain("already here");
		expect(drawn).toContain("scout");
	});

	// A minute of pulling an image and scaffolding a repository, with the prompt it was typed at
	// gone: a wait with no name on it cannot be told from the one before it.
	it("says which name is being built, and for how long", () => {
		const drawn = pane({ making: { name: "scout", frame: "⠙", seconds: 12 } });

		expect(drawn).toContain("⠙ creating scout");
		expect(drawn).toContain("12s");
	});

	/** The one thing a pane may never do: a row drawn past its last one breaks the whole screen. */
	it("never draws more rows than it was given", () => {
		for (const rows of [2, 5, 12]) {
			expect(pane({ rows, columns: 24 }).split("\n")).toHaveLength(rows);
		}
	});
});

describe("Config", () => {
	const providers = [
		{ id: "deepseek", keyEnv: "DEEPSEEK_API_KEY", models: ["flash"], held: false, here: false },
		{ id: "openai", keyEnv: "OPENAI_API_KEY", models: ["mini"], held: true, here: false },
		{ id: "groq", keyEnv: "GROQ_API_KEY", models: [], held: true, here: true },
	];
	const models = [
		{
			id: "flash",
			provider: "deepseek",
			model: "deepseek-chat",
			host: "api.deepseek.com",
			keyEnv: "DEEPSEEK_API_KEY",
			added: false,
			held: false,
		},
		{
			id: "mini",
			provider: "openai",
			model: "gpt-5-mini",
			host: "api.openai.com",
			keyEnv: "OPENAI_API_KEY",
			added: true,
			held: true,
		},
	];
	const offers = [
		{ provider: "openai", id: "gpt-5" },
		{ provider: "openai", id: "gpt-5-mini" },
		{ provider: "groq", id: "kimi-k2" },
	];
	const searching = {
		provider: "openai",
		model: "gpt-5-mini",
		endpoint: "https://api.openai.com/v1/responses",
		shape: "responses" as const,
		keyEnv: "OPENAI_API_KEY",
		perSearchUsd: 0.01,
		rate: { input: 0.25, output: 2 },
		chosen: false,
		held: true,
		here: false,
	};
	const shelf = [
		{
			name: "linear",
			server: { transport: "http" as const, url: "https://mcp.linear.app/mcp" },
			agents: ["scout"],
			loggedIn: true,
		},
		{
			name: "files",
			server: { transport: "stdio" as const, command: "mcp-files", args: ["/home/agent"] },
			agents: [],
			loggedIn: false,
		},
	];
	const post: MailStanding = {
		mailbox: "desk@squad.dev",
		host: "imap.fastmail.com",
		carrier: "mailgun",
		domain: "squad.dev",
		keyEnv: "MAILGUN_API_KEY",
		held: true,
		here: false,
		writes: true,
		senders: [],
		phrase: undefined,
		trouble: undefined,
	};
	const reach: readonly GrantStanding[] = [
		{
			id: "model:sonnet",
			host: "api.anthropic.com",
			origin: "model",
			carries: "ANTHROPIC_API_KEY",
		},
		{
			id: "search:openai",
			host: "api.openai.com",
			pathPrefix: "/v1/responses",
			methods: ["POST"],
			origin: "search",
			carries: "OPENAI_API_KEY",
		},
		{ id: "github", host: "api.github.com", origin: "file", carries: "GITHUB_TOKEN" },
		{ id: "reach:api.chess.com", host: "api.chess.com", origin: "here" },
	];
	/** Every one of these is about the models section, which is where this screen's lists are. */
	const pane = (props: {
		section?: Section | undefined;
		search?: SearchStanding | undefined;
		servers?: readonly ServerStanding[];
		grants?: readonly GrantStanding[];
		mail?: MailStanding | undefined;
		mailing?: { field: MailField; text: string } | undefined;
		admitting?: string | undefined;
		cursor?: number;
		typing?: string | undefined;
		secret?: string;
		adding?: string | undefined;
		shelving?: string | undefined;
		opening?: string | undefined;
		forgetting?: string | undefined;
		dropping?: string | undefined;
		offers?: readonly ModelOffer[] | undefined;
		choosing?: { what: string; among: readonly string[] } | undefined;
		pick?: number;
		unanswered?: string | undefined;
		rows?: number;
		columns?: number;
	}) =>
		renderToString(
			h(Config, {
				section: "models",
				providers,
				models,
				search: searching,
				servers: shelf,
				grants: reach,
				mail: post,
				cursor: 0,
				typing: undefined,
				secret: "",
				adding: undefined,
				unanswered: undefined,
				rows: 24,
				columns: 60,
				...props,
			}),
			{ columns: props.columns ?? 60 },
		);

	// The whole question this screen answers, in the column a glance goes down: which of these can
	// this plane actually pay for right now.
	it("marks the providers this plane holds a key for", () => {
		const rows = pane({}).split("\n");

		expect(rows.find((row) => row.includes("deepseek"))).toContain("○");
		expect(rows.find((row) => row.includes("openai"))).toContain("●");
	});

	it("says which models are waiting on each key", () => {
		expect(pane({})).toContain("flash");
	});

	// A provider with no models is still a row: it is how a second one gets set up at all, and a
	// screen that only listed what is configured would be a screen you cannot add anything from.
	it("lists a provider nothing is configured on yet", () => {
		expect(pane({})).toContain("groq");
	});

	it("says of the row the cursor is on where its key came from", () => {
		expect(pane({ cursor: 1 })).toContain("from this plane's environment");
		expect(pane({ cursor: 2 })).toContain("set here");
		expect(pane({ cursor: 0 })).toContain("no key, refused at the proxy");
	});

	it("lists the models under the keys they are waiting on", () => {
		const drawn = pane({});

		expect(drawn).toContain("models");
		expect(drawn).toContain("flash");
		expect(drawn).toContain("mini");
	});

	/**
	 * Which list a model belongs to, said on the row rather than only under it. Half of them refuse
	 * the key that drops one, and a list that looked uniform would be one where that is a surprise.
	 */
	it("says which models this screen may take back", () => {
		const drawn = pane({}).split("\n");

		expect(drawn.find((row) => row.includes("from the file"))).toContain("flash");
		expect(drawn.find((row) => row.includes("added here"))).toContain("mini");
	});

	// The same shape as the row under the agents, which is the row that makes one. A screen you can
	// only read is a screen that sends you back to the file this was meant to replace.
	it("ends the models with the row that adds one", () => {
		expect(pane({})).toContain("+ a model");
	});

	it("says of a model row where it was declared", () => {
		expect(pane({ cursor: 3 })).toContain("declared in deploy/config.yaml");
		expect(pane({ cursor: 4 })).toContain("added here");
	});

	// The one row with nothing to say about itself, so it says what typing there is for instead.
	it("says how a model is written out, on the row that takes one", () => {
		expect(pane({ cursor: 5, columns: 90 })).toContain("name provider");
	});

	/** Not a secret, unlike the key: it is a name and a provider, and getting it wrong is ordinary. */
	it("shows a model being typed as the words it is", () => {
		const drawn = pane({ adding: "sonnet anthropic" });

		expect(drawn).toContain("model");
		expect(drawn).toContain("sonnet anthropic");
	});

	// What a key buys, offered rather than asked for: the list is the difference between configuring a
	// provider and remembering what its models are called.
	it("lists what the providers offer, once the row that adds one is entered", () => {
		const drawn = pane({ adding: "", offers });

		expect(drawn).toContain("3 on offer");
		expect(drawn).toContain("gpt-5-mini");
		expect(drawn).toContain("kimi-k2");
	});

	it("keeps only the offers every word matches", () => {
		const drawn = pane({ adding: "openai mini", offers });

		expect(drawn).toContain("gpt-5-mini");
		expect(drawn).not.toContain("kimi-k2");
	});

	// Which one return would take, marked without a colour: colour is the first thing a screenshot,
	// a pipe or a monochrome terminal drops, and this is the row about to be added.
	it("points at the offer return would take", () => {
		const rows = pane({ adding: "", offers, pick: 1, columns: 90 }).split("\n");

		expect(rows.find((row) => row.includes("gpt-5-mini"))).toContain("›");
		expect(rows.find((row) => row.includes("kimi-k2"))).not.toContain("›");
	});

	/**
	 * A catalog is the provider's length, not the pane's — openai alone answers with dozens. Arrowing
	 * onto a row below the fold has to bring the fold with it, or the cursor walks off the screen and
	 * return adds a model nobody can see.
	 */
	it("keeps the offer under the cursor on the screen, however long the catalog is", () => {
		const many = Array.from({ length: 80 }, (_, index) => ({
			provider: "openai",
			id: `gpt-5-${index}`,
		}));

		const drawn = pane({ adding: "", offers: many, pick: 60, columns: 90 });

		expect(drawn).toContain("gpt-5-60");
		expect(drawn.split("\n").find((row) => row.includes("gpt-5-60"))).toContain("›");
	});

	// A round trip to every provider at once, which is long enough on a slow one that a blank list
	// would read as a plane with nothing to offer.
	it("says it is asking while the providers have not answered", () => {
		expect(pane({ adding: "", offers: undefined, columns: 90 })).toContain("asking every provider");
	});

	// The way out when the list has nothing: a provider this console has no catalog for is still a
	// model somebody can name.
	it("says how to write one out when nothing is on offer", () => {
		const drawn = pane({ adding: "", offers: [], columns: 90 });

		expect(drawn).toContain("no key is held here yet");
		expect(drawn).toContain("name provider");
	});

	it("says how to write one out when nothing matches what was typed", () => {
		const drawn = pane({ adding: "zzz", offers, columns: 90 });

		expect(drawn).toContain("nothing on offer matches");
		expect(drawn).toContain("name provider");
	});

	/**
	 * Never the characters. A key is read off a screen by whoever is standing behind the person
	 * typing it, and this is a terminal that keeps its own scrollback.
	 */
	it("shows a key being typed as its length and nothing else", () => {
		const drawn = pane({ typing: "DEEPSEEK_API_KEY", secret: "sk-typed" });

		expect(drawn).toContain("key for DEEPSEEK_API_KEY");
		expect(drawn).toContain("••••••••");
		expect(drawn).not.toContain("sk-typed");
	});

	/**
	 * The screen a console reaching an older plane gets. Without the reason on it, an empty list is a
	 * plane that has no providers — which is a conclusion, and the wrong one.
	 */
	it("says why the list is empty, rather than showing an empty list", () => {
		expect(pane({ unanswered: 'this plane does not know "providers"' })).toContain(
			'does not know "providers"',
		);
	});

	it("keeps the reason on screen while the list is there too", () => {
		const drawn = pane({ unanswered: "GITHUB_TOKEN is not a provider key" });

		expect(drawn).toContain("not a provider key");
		expect(drawn).toContain("deepseek");
	});

	/** The one thing a pane may never do: a row drawn past its last one breaks the whole screen. */
	it("never draws more rows than it was given", () => {
		for (const rows of [3, 6, 14, 30]) {
			expect(pane({ rows, columns: 30 }).split("\n").length).toBeLessThanOrEqual(rows);
			expect(
				pane({ rows, columns: 30, unanswered: "this plane is older than this console" }).split("\n")
					.length,
			).toBeLessThanOrEqual(rows);
		}
	});

	// The list is what this screen is, so it takes the rows it needs and the prose above it gives
	// way. The other way round is a short terminal showing three paragraphs and no providers.
	it("keeps the providers when there is only room for some of it", () => {
		expect(pane({ rows: 6 })).toContain("deepseek");
	});

	/**
	 * The list this screen opens on, which is the only screen where everything it holds is one list.
	 *
	 * Four things share nothing but the file they are kept in, so they are four lists rather than one
	 * to scroll — and this is the row that has to say which of them is the one you came here for.
	 */
	describe("the sections", () => {
		const list = (props: Parameters<typeof pane>[0] = {}) =>
			pane({ section: undefined, columns: 90, ...props });

		it("lists what there is to set, with what each of them is for", () => {
			const drawn = list();

			expect(drawn).toContain("models");
			expect(drawn).toContain("search");
			expect(drawn).toContain("what its agents think with");
			expect(drawn).toContain("where web_search goes");
			expect(drawn).toContain("which agents hold them");
		});

		// The same dot the agents column uses, meaning the same thing: something this plane could
		// actually use right now. It is the whole point of the list — finding what is not set up yet.
		it("marks a section this plane can already pay for", () => {
			const rows = list({ search: { ...searching, held: false } }).split("\n");

			expect(rows.find((row) => row.includes("what its agents think with"))).toContain("●");
			expect(rows.find((row) => row.includes("where web_search goes"))).toContain("○");
		});

		// Arriving beside this list is not standing in it, so there is a cursor it draws no row for:
		// what the line under it says then is what entering the list would land on, which is the
		// first row. A screen that went blank there would be one that looks broken while it waits.
		it("stands on the first row while the arrows are still the column's", () => {
			expect(list({ cursor: -1 })).toContain("2 of 3 providers paid for");
		});

		it("says under the list what the section it is standing on holds", () => {
			expect(list({ cursor: 0 })).toContain("2 of 3 providers paid for");
			expect(list({ cursor: 1 })).toContain("gpt-5-mini");
		});

		// The one thing worth knowing before opening a section that costs money on every use.
		it("says what a search costs, on the row that opens the search", () => {
			expect(list({ cursor: 1 })).toContain("$0.010 a search");
		});

		it("says the search is refused rather than pricing one that cannot happen", () => {
			expect(list({ cursor: 1, search: { ...searching, held: false } })).toContain(
				"no key, refused at the proxy",
			);
		});

		// A shelf nobody was given anything off is a shelf doing nothing, which is the count worth
		// having: how many are on it says less than how many are reaching anything.
		it("counts the shelf, and how much of it anybody has", () => {
			expect(list({ cursor: 3 })).toContain("2 on the shelf, 1 of them given to somebody");
			expect(list({ cursor: 3, servers: [] })).toContain("nothing on the shelf yet");
		});
	});

	/**
	 * Three rows: who searches, what they search with, and the key that pays for it.
	 *
	 * The whole of configuring a search tool, on one screen, because the three are useless apart — a
	 * provider chosen against a key this plane does not hold is a search refused at the proxy.
	 */
	describe("the search section", () => {
		const search = (props: Parameters<typeof pane>[0] = {}) =>
			pane({ section: "search", columns: 90, ...props });

		it("says where searching goes and what drives it", () => {
			const drawn = search();

			expect(drawn).toContain("provider");
			expect(drawn).toContain("openai");
			expect(drawn).toContain("gpt-5-mini");
			expect(drawn).toContain("OPENAI_API_KEY");
		});

		// Dark on all three rows, because none of them is in force without the key.
		it("marks every row by whether the key behind them is held", () => {
			expect(search()).toContain("●");
			expect(search({ search: { ...searching, held: false } })).not.toContain("●");
		});

		it("says of the row it is on what it costs or where its key came from", () => {
			expect(search({ cursor: 1 })).toContain("$0.25 in, $2.00 out");
			expect(search({ cursor: 2 })).toContain("from this plane's environment");
			expect(search({ cursor: 2, search: { ...searching, here: true } })).toContain("set here");
			expect(search({ cursor: 2, search: { ...searching, held: false } })).toContain(
				"no key, refused at the proxy",
			);
		});

		// The same prompt the providers take, for the same reason: it is a key, and a key is never on
		// a screen that keeps its own scrollback.
		it("takes the key without showing a character of it", () => {
			const drawn = search({ cursor: 2, typing: "OPENAI_API_KEY", secret: "sk-typed" });

			expect(drawn).toContain("key for OPENAI_API_KEY");
			expect(drawn).not.toContain("sk-typed");
		});

		// Every answer is already on the list, so there is nothing to type and nothing to spell wrong.
		it("lists what there is to choose among, when one is being chosen", () => {
			const drawn = search({
				choosing: { what: "searches", among: ["openai", "perplexity"] },
				pick: 1,
			});

			expect(drawn).toContain("searches");
			expect(drawn.split("\n").find((row) => row.includes("perplexity"))).toContain("›");
		});
	});

	/**
	 * The shelf, which is the plane's rather than an agent's.
	 *
	 * `/mcp` in a chat answers what this agent has. The question left over is what has anybody got,
	 * and is any of it going unused — which you would otherwise open every agent in turn to ask.
	 */
	describe("the mcp section", () => {
		const shelved = (props: Parameters<typeof pane>[0] = {}) =>
			pane({ section: "mcp", columns: 90, ...props });

		it("says what each server is, in the shape it was written in", () => {
			const drawn = shelved();

			expect(drawn).toContain("https://mcp.linear.app/mcp");
			expect(drawn).toContain("mcp-files /home/agent");
		});

		// A server nobody has is a URL written down: nothing is reaching it and nothing will until it
		// is handed out, which is the difference this dot is for.
		it("marks the ones some agent was actually given", () => {
			const rows = shelved().split("\n");

			expect(rows.find((row) => row.includes("linear"))).toContain("●");
			expect(rows.find((row) => row.includes("files"))).toContain("○");
		});

		it("says who holds the one it is standing on", () => {
			expect(shelved({ cursor: 0 })).toContain("scout");
			expect(shelved({ cursor: 1 })).toContain("nobody has it yet");
		});

		it("says when a server has an account here", () => {
			expect(shelved({ cursor: 0 })).toContain("logged in");
		});

		// The row under the list, the same shape as the one that adds a model, because it is the same
		// idea: the list ends in the way to put something new on it.
		it("ends in the row that adds one, and says what a line there may be", () => {
			const drawn = shelved({ cursor: 2 });

			expect(drawn).toContain("+ a server");
			expect(drawn).toContain("a URL to reach it at or a command to start it with");
		});

		it("shows the line being written out", () => {
			expect(shelved({ cursor: 2, shelving: "linear https://mcp.linear.app/mcp" })).toContain(
				"linear https://mcp.linear.app/mcp",
			);
		});

		// Forgetting is wider than the row it is pressed on, so the question says so rather than
		// naming the server and leaving the rest to be found out afterwards.
		it("asks before forgetting, and says it comes off every agent", () => {
			expect(shelved({ cursor: 0, forgetting: "linear" })).toContain(
				"comes off every agent holding it",
			);
		});
	});

	/**
	 * Everywhere the agents may go, from all four places that decide it.
	 *
	 * The question this screen answers is "can it reach that", and the answer does not depend on which
	 * list a grant came off — so they are one list, with a column saying where each is changed.
	 */
	describe("the grants section", () => {
		const reached = (props: Parameters<typeof pane>[0] = {}) =>
			pane({ section: "grants", columns: 90, ...props });

		it("lists every host anything may reach, whichever list it came off", () => {
			const drawn = reached();

			expect(drawn).toContain("api.anthropic.com");
			expect(drawn).toContain("api.github.com");
			expect(drawn).toContain("api.chess.com");
		});

		// Three of the four lists refuse the key that closes a row, so the row says which it is. A list
		// that looked uniform would be a list where that refusal arrives as a surprise.
		it("says on each row which list decides it", () => {
			const rows = reached().split("\n");

			expect(rows.find((row) => row.includes("api.anthropic.com"))).toContain("with a model");
			expect(rows.find((row) => row.includes("api.github.com"))).toContain("from the file");
			expect(rows.find((row) => row.includes("api.chess.com"))).toContain("opened here");
		});

		it("says how narrow a grant is, when it is narrower than the host", () => {
			const rows = reached().split("\n");

			expect(rows.find((row) => row.includes("api.openai.com"))).toContain("/v1/responses");
			expect(rows.find((row) => row.includes("api.openai.com"))).toContain("POST");
		});

		// What is attached on the way out is the fact a host cannot show, and the one that decides
		// whether the row under the cursor is worth being careful about.
		it("names what rides along, on the row it is standing on", () => {
			expect(reached({ cursor: 0 })).toContain("carries ANTHROPIC_API_KEY");
		});

		/**
		 * The whole of why this section is allowed to write anything. A host opened here is reach and
		 * nothing else, and the row says so where the others name a key.
		 */
		it("says a host opened here carries nothing", () => {
			expect(reached({ cursor: 3 })).toContain("carries nothing");
		});

		it("says where a grant it will not close is closed instead", () => {
			expect(reached({ cursor: 0 })).toContain("change it in the models section");
			expect(reached({ cursor: 1 })).toContain("change it in the search section");
			expect(reached({ cursor: 2 })).toContain("deploy/config.yaml");
		});

		it("ends in the row that opens one, and says what may be typed there", () => {
			const drawn = reached({ cursor: 4 });

			expect(drawn).toContain("+ a host");
			expect(drawn).toContain("api.chess.com");
			expect(drawn).toContain("* for the whole web");
		});

		it("shows the host being written out", () => {
			expect(reached({ cursor: 4, opening: "api.chess" })).toContain("api.chess");
		});

		// Closing is wider than the row it is pressed on: the grant is the plane's, not one agent's.
		it("asks before closing, and says nothing reaches it after", () => {
			expect(reached({ cursor: 3, dropping: "api.chess.com" })).toContain(
				"no agent reaches it after",
			);
		});

		// A plane that grants nothing refuses every request an agent makes, which is a thing to say
		// outright rather than leave as an empty list somebody reads as "not set up yet".
		it("says an empty list is a plane that refuses everything", () => {
			expect(reached({ grants: [] })).toContain("+ a host");
		});
	});

	/**
	 * The mailbox, and whoever carries what is written back out of it.
	 *
	 * Two halves that fail for unrelated reasons — a mailbox nobody connected reaches nothing, and a
	 * carrier nobody paid for reads and cannot answer — so the screen keeps a dot for each.
	 */
	describe("the email section", () => {
		const mailed = (props: Parameters<typeof pane>[0] = {}) =>
			pane({ section: "email", columns: 90, ...props });
		// The rows the arrows walk, told from the prose above them by the dot each one opens with — the
		// prose says "mailbox" and "domain" too, and a screen searched for a word would find those first.
		const fields = (drawn: string): readonly string[] =>
			drawn
				.split("\n")
				.map(bare)
				.filter((row) => /^[●○] /.test(row));

		it("says the mailbox, who carries the answers, and what pays for that", () => {
			const drawn = mailed();

			expect(drawn).toContain("desk@squad.dev");
			expect(drawn).toContain("Mailgun");
			expect(drawn).toContain("squad.dev");
			expect(drawn).toContain("MAILGUN_API_KEY");
		});

		// The mailbox is connected and the carrier is not paid for: one dot lit and one dark, which a
		// single dot over the pair could not say.
		it("marks reading and sending apart, because they fail apart", () => {
			const drawn = fields(mailed({ mail: { ...post, held: false, writes: false } }));

			expect(drawn.find((row) => row.startsWith("● mailbox"))).toBeDefined();
			expect(drawn.find((row) => row.startsWith("○ carrier"))).toBeDefined();
		});

		// Most carriers work the domain out of the address. Mailgun will not, so the row is there for
		// Mailgun and gone for the rest, rather than sitting on every screen saying nothing.
		it("leaves out the rows that could only say they do not apply", () => {
			expect(fields(mailed()).map((row) => row.slice(2, 12).trim())).toEqual([
				"mailbox",
				"carrier",
				"domain",
				"key",
			]);

			const guessed = mailed({ mail: { ...post, carrier: "resend", keyEnv: "RESEND_API_KEY" } });
			expect(fields(guessed).map((row) => row.slice(2, 12).trim())).toEqual([
				"mailbox",
				"carrier",
				"key",
			]);

			// The mailbox's own submission server: no company to name a domain to and no key to pay.
			const own = mailed({ mail: { ...post, carrier: "", domain: "", keyEnv: undefined } });
			expect(own).toContain("the mailbox's own server");
			expect(fields(own).map((row) => row.slice(2, 12).trim())).toEqual(["mailbox", "carrier"]);
		});

		it("says of the row it is on the half the column has no room for", () => {
			expect(mailed({ cursor: 0 })).toContain("imap.fastmail.com");
			expect(mailed({ cursor: 2 })).toContain("sends only for a domain it was set up for");
			expect(mailed({ cursor: 3 })).toContain("from this plane's environment");
			expect(mailed({ cursor: 3, mail: { ...post, here: true } })).toContain("set here");
			expect(mailed({ cursor: 3, mail: { ...post, held: false } })).toContain(
				"no key, so nothing can be sent",
			);
		});

		it("says what there is to type when nothing is connected", () => {
			const drawn = mailed({
				cursor: 0,
				mail: { ...post, mailbox: undefined, host: undefined, writes: false },
			});

			expect(drawn).toContain("nothing connected");
			expect(drawn).toContain("the app password your provider issued for it");
		});

		// The plane's own complaint, said instead of the hint — a mailbox that stopped reading is the
		// one thing this screen exists to show, and the hint would draw over it.
		it("says what went wrong instead of what to type", () => {
			expect(
				mailed({ cursor: 0, mail: { ...post, trouble: "the password was refused" } }),
			).toContain("the password was refused");
		});

		it("shows an address as it is typed, and never a password", () => {
			expect(mailed({ mailing: { field: "address", text: "desk@" } })).toContain("desk@");

			const secret = mailed({ mailing: { field: "password", text: "kwil-brac-nemo-shad" } });
			expect(secret).toContain("password");
			expect(secret).not.toContain("kwil-brac-nemo-shad");
		});

		it("asks before forgetting, and says every agent stops being reachable", () => {
			expect(mailed({ cursor: 0, forgetting: "desk@squad.dev" })).toContain(
				"forget the mailbox at desk@squad.dev",
			);
		});

		/**
		 * Who the mailbox is read for, which is a different question from whether it is read at all.
		 *
		 * The four rows above say a channel is up. These say who it is up for, and that list is the whole
		 * of the account's security: everybody on it spends turns and instructs agents, so it is a list
		 * that has to be readable at a glance rather than one kept in a file somebody remembers editing.
		 */
		const admitted = (senders: readonly string[], props: Parameters<typeof pane>[0] = {}) =>
			mailed({ mail: { ...post, senders, phrase: undefined }, ...props });

		it("lists who may write, under a heading of their own", () => {
			const drawn = admitted(["nico@squad.dev", "*@company.com"]);

			expect(drawn).toContain("who may write");
			expect(drawn).toContain("nico@squad.dev");
			expect(drawn).toContain("*@company.com");
			expect(drawn).toContain("+ an address");
		});

		// Eleven characters that stand for a number of people nobody counted. The line beside them is
		// the difference between reading the list and trusting it.
		it("says in words what a whole domain admits", () => {
			expect(admitted(["*@company.com"])).toContain("everyone at company.com");
			expect(admitted(["nico@squad.dev"])).not.toContain("everyone at squad.dev");
		});

		// Nothing to add to until there is a mailbox: a list of people who may write to no address is a
		// question asked in the wrong order.
		it("offers nobody until there is a mailbox", () => {
			const nowhere = mailed({
				mail: { ...post, mailbox: undefined, host: undefined, senders: [] },
			});

			expect(nowhere).not.toContain("who may write");
			expect(nowhere).not.toContain("+ an address");
		});

		// The other door, on the row that would otherwise be the only one. The phrase works from a
		// phone with nothing typed here, and it is spent the moment anybody is on the list.
		it("names the pairing phrase while the list is empty, and not after", () => {
			const empty = mailed({ cursor: 4, mail: { ...post, senders: [], phrase: "kwilbracne" } });
			expect(empty).toContain('mail "kwilbracne" to the mailbox');

			const filled = admitted(["nico@squad.dev"], { cursor: 5 });
			expect(filled).not.toContain("kwilbracne");
			expect(filled).toContain("*@company.com for everyone at a domain");
		});

		it("says what a row on the list does, and what stops it", () => {
			expect(admitted(["nico@squad.dev"], { cursor: 4 })).toContain("read as instructions");
		});

		it("shows an address as it is typed onto the list", () => {
			expect(admitted(["nico@squad.dev"], { admitting: "*@compa" })).toContain("*@compa");
		});

		it("asks before dropping somebody, and says their mail stops being answered", () => {
			expect(admitted(["nico@squad.dev"], { cursor: 4, dropping: "nico@squad.dev" })).toContain(
				"stop reading mail from nico@squad.dev",
			);
		});
	});
});

/** The prompt has one row and the line being typed needs most of it, so the directory gets little. */
describe("doing", () => {
	it("says the tool and what it is on", () => {
		expect(doing({ action: "read", detail: "src/proxy.ts" })).toBe("read src/proxy.ts");
	});

	// A step's detail is a whole shell command or a diff, and this row is one row. The feed keeps
	// the rest, which is where a thing is read once it has already happened.
	it("takes the first line of a detail that runs to several", () => {
		expect(doing({ action: "bash", detail: "  pnpm   test \n--watch\nmore" })).toBe(
			"bash pnpm test",
		);
	});

	it("is the tool alone when there is nothing to say about it", () => {
		expect(doing({ action: "think", detail: "" })).toBe("think");
	});
});

describe("here", () => {
	it("says the agent's home the way a shell does", () => {
		expect(here("/home/agent/.self")).toBe("~/.self");
		expect(here("/home/agent")).toBe("~");
	});

	// Another user's directory is not this one's home, and a prompt that said `~` would be lying
	// about which one it is standing in.
	it("leaves a path that only looks like home alone", () => {
		expect(here("/home/agentina/src")).toBe("/home/agentina/src");
		expect(here("/tmp")).toBe("/tmp");
	});

	// The end is where you are; the front is the part you already know.
	it("gives up the front of a path too long for the row", () => {
		const shown = here("/home/agent/.self/packages/control-plane/src", 20);

		expect(shown).toBe("…s/control-plane/src");
		expect(shown.length).toBe(20);
	});
});

/** Fourteen characters is what the column has left once the border, the mark and a name have theirs. */
describe("until", () => {
	const now = Date.parse("2026-08-23T12:00:00.000Z");
	const inSeconds = (seconds: number): string => new Date(now + seconds * 1000).toISOString();

	it("says the wait in the coarsest unit that still says it", () => {
		expect(until(inSeconds(45), now)).toBe("45s");
		expect(until(inSeconds(900), now)).toBe("15m");
		expect(until(inSeconds(3 * 3600), now)).toBe("3h");
		expect(until(inSeconds(2 * 86400), now)).toBe("2d");
	});

	// A wakeup the scheduler has not got to yet is due, not overdue by however long the tick took.
	it("does not count backwards past the moment it was due", () => {
		expect(until(inSeconds(-30), now)).toBe("0s");
	});
});
