import { Box, renderToString, Text } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { COMMANDS, type Command } from "../src/commands.ts";
import {
	Agents,
	Chat,
	detail,
	doing,
	here,
	mouse,
	New,
	resume,
	saidBy,
	scrolled,
	standing,
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

	// In the colour the agents column gives a booked wakeup, and not dim: this is the only line on the
	// pane that nobody asked for, so it is the one somebody scrolls back looking for.
	it("names the agent's own wakeup as one, rather than as an answer", () => {
		expect(transcript([{ from: "agent", via: "wake", text: "seguir" }])[0]).toBe(
			"\u001b[33m‹wake›\u001b[39m seguir",
		);
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
		model: undefined,
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

		expect(drawn.split("\n")[0]).toMatch(/^╭─{20}╮/);
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
	it("is the only row, and the one the cursor is on, when there are no agents", () => {
		const drawn = renderToString(
			h(Agents, { agents: [], cursor: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(drawn).toContain("▸ + new agent");
	});

	it("marks the row only while the cursor is on it", () => {
		const on = renderToString(
			h(Agents, { agents: three, cursor: three.length, busy: new Map<string, number>(), rows: 10 }),
		);
		const off = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Map<string, number>(), rows: 10 }),
		);

		expect(on).toContain("▸ + new agent");
		expect(off).not.toContain("▸ + new agent");
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

	// Which agent is walking into its ceiling is the question the money alone cannot answer: $4 is
	// nothing against fifty and almost everything against five.
	it("draws what an agent has spent against what it may", () => {
		const near = renderToString(
			h(Agents, {
				agents: [{ ...listed("scout", true), spentUsd: 4, limitUsd: 5 }],
				cursor: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);
		const far = renderToString(
			h(Agents, {
				agents: [{ ...listed("scout", true), spentUsd: 4, limitUsd: 50 }],
				cursor: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);

		expect(near).toContain("▰▰▰▰▱");
		expect(far).toContain("▰▱▱▱▱");
	});

	// A ceiling with nothing spent against it is five empty cells saying nothing has happened, which
	// is what having no row at all says, in no columns.
	it("draws no bar for an agent that has spent nothing", () => {
		const drawn = renderToString(
			h(Agents, {
				agents: [{ ...listed("scout", true), limitUsd: 5 }],
				cursor: 0,
				busy: new Map<string, number>(),
				rows: 10,
			}),
		);

		expect(drawn).not.toContain("▱");
	});

	// Three things want one row, and which of them goes when it will not hold all three is the whole
	// rule: the money is why the row is drawn at all, the wait is the warning, and the bar is a second
	// fact about the money — a fact about a fact is what a narrow terminal can afford to lose.
	it("gives up the bar before the wait, and the wait before the money", () => {
		const agent = {
			...listed("scribe", true),
			spentUsd: 1.5,
			limitUsd: 5,
			wakeAt: new Date(Date.now() + 900_000).toISOString(),
		};

		expect(detail(agent, 15)).toEqual({ spent: "$1.50", bar: "▰▰▱▱▱", wake: "15m" });
		expect(detail(agent, 14)).toEqual({ spent: "$1.50", bar: "", wake: "15m" });
		expect(detail(agent, 6)).toEqual({ spent: "$1.50", bar: "", wake: "" });
	});

	// An agent is a name and, when there is something to say under it, a second row. The budget is
	// rows and not agents, or the column draws itself past its own border and over the pane beside it.
	it("counts the row under a name against the room it has", () => {
		const spending = [
			{ ...listed("scout", true), spentUsd: 0.42 },
			{ ...listed("scribe", true), spentUsd: 0.42 },
		];
		const drawn = renderToString(
			h(Agents, { agents: spending, cursor: 0, busy: new Map<string, number>(), rows: 3 }),
		);

		expect(drawn).toContain("scout");
		expect(drawn).not.toContain("scribe");
		expect(drawn).toContain("+ new agent");
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
			rows: 8,
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
