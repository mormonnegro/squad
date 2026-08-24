import { Box, renderToString, Text } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import {
	Agents,
	Chat,
	here,
	mouse,
	resume,
	saidBy,
	scrolled,
	type Thinking,
	transcript,
	until,
	visible,
} from "../src/console.ts";
import type { AgentSummary } from "../src/control-plane.ts";

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

	it("names the agent's own wakeup as one, rather than as an answer", () => {
		expect(transcript([{ from: "agent", via: "wake", text: "seguir" }])[0]).toContain("‹wake›");
	});

	// A turn that failed said nothing, and the person who asked is owed the reason where they asked.
	it("says a failure in the conversation it happened in", () => {
		expect(transcript([{ from: "plane", text: "exited 1" }])[0]).toBe(
			"\u001b[31mexited 1\u001b[39m",
		);
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
 * downstream of this either scrolls on it or types it into the prompt.
 */
describe("mouse", () => {
	const roll = (button: number): string => `\u001b[<${button};40;12M`;

	it("reads the wheel in both directions", () => {
		expect(mouse(roll(64))).toBeLessThan(0);
		expect(mouse(roll(65))).toBeGreaterThan(0);
	});

	// One flick of a trackpad arrives as several reports in a single chunk, and a pane that moved
	// once for the flick would take a minute to cross a long answer.
	it("adds up the reports that arrived together", () => {
		const one = mouse(roll(64)) ?? 0;

		expect(mouse(roll(64).repeat(3))).toBe(one * 3);
	});

	// The bug this was extracted for. Asking the terminal for the wheel asks it for the clicks too,
	// and a click nobody answers for is `[<0;39;15M[<0;39;15m` typed into the prompt.
	it("answers for a click, which moves nothing and must still not be typed", () => {
		const press = roll(0);

		expect(mouse(press + press.replace(/M$/, "m"))).toBe(0);
	});

	it("leaves what is not the mouse to whoever it was meant for", () => {
		expect(mouse("hola")).toBeUndefined();
		expect(mouse("")).toBeUndefined();
		// Escape is read here first and is the start of every mouse report, so a plain one getting
		// answered for as a wheel that moved nothing is a key that silently stops working.
		expect(mouse("\u001b")).toBeUndefined();
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
		const talk = resume({ scout: [{ from: "operator", text: "hola" }] });

		expect(saidBy(talk, "scout")).toEqual([{ from: "operator", text: "hola" }]);
	});

	// The stored line is the words. Markdown becomes ANSI on the way in, once, rather than on every
	// keystroke that re-wraps the pane.
	it("renders the agent's markdown as the terminal will show it", () => {
		const [said] = saidBy(resume({ scout: [{ from: "agent", text: "**hecho**" }] }), "scout");

		expect(said?.text).not.toBe("**hecho**");
		expect(said?.text).toContain("hecho");
	});

	it("keeps where a line came from, so the pane can say", () => {
		const talk = resume({ scout: [{ from: "agent", via: "wake", text: "seguir" }] });

		expect(saidBy(talk, "scout")[0]?.via).toBe("wake");
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

		expect(drawn).toContain("scout 15m");
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

		expect(drawn.split("\n")[0]).toMatch(/^╭─{16}╮/);
	});

	it("shows only what the pane has room for", () => {
		const drawn = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 2 }),
		);

		expect(drawn).toContain("scribe");
		expect(drawn).not.toContain("sleeper");
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
	}) =>
		renderToString(
			h(Chat, {
				draft: "",
				rows: 4,
				columns: 40,
				thinking: undefined,
				top: undefined,
				shell: undefined,
				...props,
			}),
			{ columns: 40 },
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
});

/** The prompt has one row and the line being typed needs most of it, so the directory gets little. */
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
