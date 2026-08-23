import { Box, renderToString, Text } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { Agents, append, Chat, extend, saidBy, tail, transcript } from "../src/console.ts";
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
		expect(transcript([{ from: "agent", text: "one\ntwo" }])).toEqual(["one", "two", ""]);
	});

	it("leaves a blank line between one turn and the next", () => {
		expect(
			transcript([
				{ from: "agent", text: "a" },
				{ from: "agent", text: "b" },
			]),
		).toEqual(["a", "", "b", ""]);
	});
});

describe("tail", () => {
	it("keeps the last lines, which are the ones still worth reading", () => {
		expect(tail(["a", "b", "c"], 2)).toEqual(["b", "c"]);
	});

	it("shows all of a conversation that fits", () => {
		expect(tail(["a", "b"], 10)).toEqual(["a", "b"]);
	});

	// A pane can be given no rows at all while the window is being dragged, and slice(-0) is the
	// whole array rather than none of it.
	it("has nothing to show a pane with no room", () => {
		expect(tail(["a", "b"], 0)).toEqual([]);
		expect(tail(["a", "b"], -3)).toEqual([]);
	});
});

/**
 * How a streamed answer is assembled: one empty thing said, then chunks added to it.
 */
describe("extend", () => {
	const started = append(new Map(), "scout", { from: "agent", text: "" });

	it("adds a chunk to the answer in progress", () => {
		const talk = extend(extend(started, "scout", "web"), "scout", "hook");

		expect(saidBy(talk, "scout")).toEqual([{ from: "agent", text: "webhook" }]);
	});

	// A chunk can outlive the turn it belongs to — the plane keeps writing for a moment after an
	// error was said in place — and there is nothing for it to land on.
	it("has nothing to add before anything was said", () => {
		expect(extend(new Map(), "scout", "web")).toEqual(new Map());
	});

	it("leaves the other agents' conversations where they were", () => {
		const both = append(started, "scribe", { from: "operator", text: "hola" });

		expect(saidBy(extend(both, "scout", "web"), "scribe")).toEqual([
			{ from: "operator", text: "hola" },
		]);
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
		created: false,
	});
	const three = [listed("scout", true), listed("scribe", true), listed("sleeper", false)];

	it("marks a thinking agent apart from one that is only up", () => {
		const drawn = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Set(["scribe"]), rows: 10 }),
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
				h(Agents, { agents: three, cursor: 0, busy: new Set<string>(), rows: 10 }),
				h(Box, { flexGrow: 1 }, h(Text, null, "unbreakable".repeat(20))),
			),
			{ columns: 80 },
		);

		expect(drawn.split("\n")[0]).toMatch(/^╭─{16}╮/);
	});

	it("shows only what the pane has room for", () => {
		const drawn = renderToString(
			h(Agents, { agents: three, cursor: 0, busy: new Set<string>(), rows: 2 }),
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

	it("keeps the room the prompt needs, at the cost of the oldest line", () => {
		const drawn = renderToString(h(Chat, { history: long, draft: "", rows: 4, thinking: false }));

		expect(drawn).toContain("line 19");
		expect(drawn).not.toContain("line 17");
		expect(drawn).toContain(">");
	});

	it("shows the line being typed", () => {
		const drawn = renderToString(
			h(Chat, { history: [], draft: "que es", rows: 4, thinking: false }),
		);

		expect(drawn).toContain("que es");
	});

	// Nothing typed now will be lost, but it will be answered after this turn, and the prompt is
	// where that is said.
	it("says the agent is thinking rather than inviting a line", () => {
		const drawn = renderToString(h(Chat, { history: [], draft: "", rows: 4, thinking: true }));

		expect(drawn).toContain("…");
	});
});
