import { describe, expect, it } from "vitest";
import { refusedToAgent, TheKeyboard } from "../image/keyboard.ts";

/** A clock that only moves when the test says so, because everything here is about time passing. */
function clock(): { now: () => number; pass: (ms: number) => void } {
	let at = 1_000;
	return {
		now: () => at,
		pass: (ms) => {
			at += ms;
		},
	};
}

describe("who is driving", () => {
	it("starts with the agent, which is where a screen spends its life", () => {
		expect(new TheKeyboard().holder).toBe("agent");
	});

	it("hands it to the operator when they take it, and back when they give it back", () => {
		const keyboard = new TheKeyboard();
		expect(keyboard.take().holder).toBe("operator");
		expect(keyboard.release().holder).toBe("agent");
	});

	it("gives it back on its own when nobody is there", () => {
		// The failure this prevents is the common one: a closed tab, and an agent locked out of its own
		// screen until somebody remembers a page they shut yesterday.
		const time = clock();
		const keyboard = new TheKeyboard(time.now, 90_000);
		keyboard.take();
		time.pass(89_000);
		expect(keyboard.holder).toBe("operator");
		time.pass(2_000);
		expect(keyboard.holder).toBe("agent");
	});

	it("keeps it while the operator is still being sent frames", () => {
		const time = clock();
		const keyboard = new TheKeyboard(time.now, 90_000);
		keyboard.take();
		for (let tick = 0; tick < 10; tick += 1) {
			time.pass(60_000);
			keyboard.take();
		}
		expect(keyboard.holder).toBe("operator");
	});
});

describe("what the agent asks for", () => {
	it("leaves a note without taking anything", () => {
		const keyboard = new TheKeyboard();
		const state = keyboard.ask("sign me into Drive");
		expect(state.note).toBe("sign me into Drive");
		// Asking is not a way to put yourself on hold. An agent that could would do it on every turn
		// it found hard.
		expect(state.holder).toBe("agent");
	});

	it("drops the note when the keyboard goes back, because handing it back is the answer", () => {
		const keyboard = new TheKeyboard();
		keyboard.ask("sign me in");
		keyboard.take();
		expect(keyboard.release().note).toBeUndefined();
	});

	it("keeps a note short enough to be a line on a screen", () => {
		const keyboard = new TheKeyboard();
		expect((keyboard.ask("x".repeat(900)).note ?? "").length).toBeLessThanOrEqual(300);
	});

	it("treats a blank note as no note at all", () => {
		expect(new TheKeyboard().ask("   ").note).toBeUndefined();
	});
});

describe("what the agent is told", () => {
	it("says not to retry, and what to do instead", () => {
		// The sentence is the whole of the behaviour here: a refusal that only said "denied" is one a
		// model retries in a loop until the turn dies.
		const said = refusedToAgent(undefined);
		expect(said).toContain("Do not retry");
		expect(said).toContain("wake_me");
	});

	it("reminds it what it asked for, when the operator is there because it asked", () => {
		expect(refusedToAgent("sign me into Drive")).toContain("sign me into Drive");
	});
});
