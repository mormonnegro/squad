import { Box, renderToString, Text } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { COMMANDS, type Command } from "../src/commands.ts";
import {
	Agents,
	type At,
	bare,
	Chat,
	doing,
	here,
	holding,
	laid,
	mouse,
	New,
	pointed,
	resume,
	Setup,
	type Span,
	saidBy,
	scrolled,
	standing,
	type Thinking,
	transcript,
	until,
	visible,
} from "../src/console.ts";
import type { AgentSummary } from "../src/control-plane.ts";
import type { ModelOffer } from "../src/models.ts";

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
	const drag = (from: number, to: number): { from: At; to: At } => ({
		from: { column: 40, row: from },
		to: { column: 40, row: to },
	});

	it("counts from the first row the pane is showing", () => {
		// Rows 5 and 25 of the terminal are the first and the last of the conversation.
		expect(holding(drag(5, 25), pane, shape)).toEqual({ from: 0, to: 20 });
		expect(holding(drag(10, 12), pane, shape)).toEqual({ from: 5, to: 7 });
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
		expect(holding(drag(10, 99), pane, shape)).toEqual({ from: 5, to: 20 });
		expect(holding(drag(10, -5), pane, shape)).toEqual({ from: 0, to: 5 });
		expect(holding(drag(27, 27), pane, shape)).toBeUndefined();
		expect(holding(drag(2, 10), pane, shape)).toBeUndefined();
		expect(
			holding({ from: { column: 4, row: 10 }, to: { column: 4, row: 12 } }, pane, shape),
		).toBeUndefined();
	});

	// The feed has no prompt under it, so its last line is one row higher than the chat's.
	it("takes the rows a pane drew below the text as the pane reports them", () => {
		expect(holding(drag(28, 28), pane, { lines: 24, below: 0 })).toEqual({ from: 23, to: 23 });
	});

	it("holds nothing in a pane that is showing nothing", () => {
		expect(holding(drag(10, 12), pane, { lines: 0, below: 3 })).toBeUndefined();
	});
});

/** What lands on the clipboard is the words, not the colours they were drawn in. */
describe("bare", () => {
	it("strips what was only ever for the screen", () => {
		expect(bare("\u001b[36mdara\u001b[39m: hola   ")).toBe("dara: hola");
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
describe("Agents", () => {
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
			h(Agents, { agents: [waiting], cursor: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).toContain("15m");
	});

	it("marks a thinking agent apart from one that is only up", () => {
		const drawn = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Map([["scribe", Date.now()]]), rows: 10 }),
		);

		expect(drawn).toContain("● scout");
		expect(drawn).toContain("◐ scribe");
		expect(drawn).toContain("○ sleeper");
	});

	// The list is what you read while an answer streams past it, and one that resizes as it streams
	// is unreadable. Flex would otherwise take the column's width as a preference.
	it("keeps its width beside a pane whose text does not fit", () => {
		const drawn = renderToString(
			h(
				Box,
				{ flexDirection: "row" },
				h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 10 }),
				h(Box, { flexGrow: 1 }, h(Text, null, "unbreakable".repeat(20))),
			),
			{ columns: 80 },
		);

		expect(drawn.split("\n")[0]).toMatch(/^╭─{22}╮/);
	});

	// One of the rows is the one that makes an agent, so three rows hold two agents and it.
	it("shows only what the pane has room for", () => {
		const drawn = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 3 }),
		);

		expect(drawn).toContain("scribe");
		expect(drawn).not.toContain("sleeper");
	});

	// "Which of these is burning through its day" is a question about all of them at once, and the
	// header can only ever answer it about the one being looked at.
	it("says what each agent has spent", () => {
		const drawn = renderToString(
			h(Agents, {
				agents: [{ ...listed("scout", true), spentUsd: 0.42 }],
				cursor: 0,
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
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).not.toContain("$0.00");
	});

	// Making an agent is a row in the list of agents because that is where somebody who wants one is
	// already looking. Behind a command it is a thing only whoever wrote the command ever finds.
	it("offers a row that makes one, under the agents", () => {
		const drawn = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).toContain("+ new agent");
		expect(drawn.trimEnd().split("\n").at(-2)).toContain("+ new agent");
	});

	// The first thing a plane with nothing in it can do, on the row the cursor opens on: an empty
	// column that only said "no agents" left nowhere to go but out of the console.
	it("is the only row there is when there are no agents", () => {
		const drawn = renderToString(
			h(Agents, { agents: [], cursor: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).toContain("+ new agent");
		expect(drawn).not.toContain("●");
	});

	// The whole of what the cursor broke: a pointer in a gutter of its own left the header against
	// one column and every row under it against another, and the gutter was empty on all but one row.
	it("keeps every row in the column its header starts in", () => {
		const rows = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 10 }),
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
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 10 }),
		).split("\n");
		const blank = (row: string | undefined): boolean => /^│\s+│$/.test(row ?? "");

		expect(blank(rows[rows.findIndex((row) => row.includes("agents")) + 1])).toBe(true);
		expect(blank(rows[rows.findIndex((row) => row.includes("+ new agent")) - 1])).toBe(true);
	});

	// Air is what a column has when it has room for it. An agent it could have drawn is not what it
	// should be spending a row on.
	it("gives the blanks up rather than an agent, when it is short", () => {
		const drawn = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 4 }),
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
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 2 }),
		);

		expect(drawn).toContain("+ new agent");
		expect(drawn).toContain("scout");
		expect(drawn).not.toContain("scribe");
	});

	// The two of them used to bid for the same eight columns and the money always lost, so the one
	// agent whose spending went unsaid was the one about to spend again while nobody was watching.
	it("says what an agent has spent even when it has a turn booked", () => {
		const drawn = renderToString(
			h(Agents, {
				agents: [
					{
						...listed("scribe", true),
						spentUsd: 1.5,
						wakeAt: new Date(Date.now() + 900_000).toISOString(),
					},
				],
				cursor: 0,
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
			h(Agents, {
				agents: [
					{ ...listed("ana", true), spentUsd: 1.5 },
					{ ...listed("bernardo", true), spentUsd: 12 },
				],
				cursor: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);
		const rows = drawn.split("\n");
		const first = rows.find((row) => row.includes("ana"));
		const second = rows.find((row) => row.includes("bernardo"));

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
			h(Agents, {
				agents: [{ ...listed("scout", true), spentUsd: 0.0004 }],
				cursor: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);

		expect(drawn).toContain("<$0.01");
		expect(drawn).not.toContain("0.0004");
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
	};

	it("says what it thinks with and what it has spent against its ceiling", () => {
		expect(standing(agent, 60)).toEqual({
			model: "deepseek-v4-flash",
			spend: "$0.42 / $5.00",
		});
	});

	// The money is what an operator comes back to the screen for; the model is what explains it.
	it("gives up the model before the money as the terminal narrows", () => {
		expect(standing(agent, 20)).toEqual({ model: "", spend: "$0.42 / $5.00" });
	});

	// What was spent is a fact; what it was allowed to be is a second fact about the first.
	it("gives up the ceiling next, and then everything", () => {
		expect(standing(agent, 8)).toEqual({ model: "", spend: "$0.42" });
		expect(standing(agent, 2)).toEqual({ model: "", spend: "" });
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
		expect(drawn).not.toContain("> ");
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

	// The prompt is what a hand is on, so it is the step that gives way rather than the line being
	// typed — and a step that was cut says so, rather than merely stopping.
	it("gives the room to the line being typed, and cuts the step to what is left", () => {
		const drawn = chat({
			history: [],
			columns: 40,
			draft: "segui",
			thinking: { frame: "⠙", seconds: 4, step: `bash ${"x".repeat(200)}` },
		}).split("\n");

		expect(drawn).toHaveLength(3);
		expect(drawn[1]).toContain("segui");
		expect(drawn[1]).toContain("…");
	});

	// The shell prompt has to say which directory the next command runs in, and that is this row.
	it("says nothing about a step while the prompt is the sandbox's", () => {
		const drawn = chat({
			history: [],
			shell: "/work",
			thinking: { frame: "⠙", seconds: 4, step: "bash pnpm test" },
		});

		expect(drawn).not.toContain("pnpm test");
	});

	/**
	 * The one thing a pane may never do. Anything it draws past its last row lands on the border, on
	 * the column beside it, and below the bottom of the terminal — the screen does not scroll, it
	 * breaks, and the only way back is to quit.
	 */
	it("never draws more rows than it was given", () => {
		const paragraph = { from: "agent" as const, text: "palabra ".repeat(200).trim() };

		for (const rows of [2, 5, 12]) {
			expect(chat({ history: [paragraph], rows }).split("\n")).toHaveLength(rows);
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
	 * Over the spinner, not under it. `!` reaches the box whether or not the agent is thinking, and a
	 * line typed at what looked like the agent's prompt would have run in the sandbox instead.
	 */
	it("keeps saying it is the shell while the agent thinks", () => {
		const drawn = chat({
			history: [],
			shell: "/home/agent/.self",
			thinking: { frame: "⠙", seconds: 42 },
		});

		expect(drawn).toContain("! ~/.self");
		expect(drawn).not.toContain("42s");
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

describe("Setup", () => {
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
	const pane = (props: {
		cursor?: number;
		typing?: string | undefined;
		secret?: string;
		adding?: string | undefined;
		offers?: readonly ModelOffer[] | undefined;
		pick?: number;
		unanswered?: string | undefined;
		rows?: number;
		columns?: number;
	}) =>
		renderToString(
			h(Setup, {
				providers,
				models,
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
