import { describe, expect, it } from "vitest";
import {
	type CommandContext,
	isCommand,
	isShell,
	money,
	runCommand,
	shellOutput,
} from "../src/commands.ts";

/** A context that remembers what was asked of it, which is the half a string cannot show. */
function context(start: { spentUsd?: number; limitUsd?: number } = {}) {
	const state = { spentUsd: start.spentUsd ?? 0, limitUsd: start.limitUsd };
	const set: (number | null)[] = [];
	return {
		set,
		context: {
			account: async () => state,
			setLimit: async (usd: number | null) => {
				set.push(usd);
				state.limitUsd = usd ?? undefined;
			},
		} satisfies CommandContext,
	};
}

describe("isCommand", () => {
	it("is the slash and nothing else about the line", () => {
		expect(isCommand("/limit 5")).toBe(true);
		expect(isCommand("/")).toBe(true);
		expect(isCommand("limit 5")).toBe(false);
		// A message can be about a path, and the agent is the one who should read it.
		expect(isCommand("look at src/limit.ts")).toBe(false);
	});
});

/**
 * Money is read at a glance to decide whether to worry, so the two things it has to do are never
 * show a turn as costing nothing and never show a day as a wall of digits.
 */
describe("money", () => {
	it("keeps the price of a cheap turn from rounding away to zero", () => {
		expect(money(0.0009)).toBe("$0.0009");
	});

	it("is two decimals once there is a cent to see", () => {
		expect(money(1.5)).toBe("$1.50");
		expect(money(0)).toBe("$0.00");
	});
});

describe("runCommand", () => {
	it("reports what has been spent and against what", async () => {
		const { context: ctx, set } = context({ spentUsd: 0.42, limitUsd: 5 });

		const answer = await runCommand("/limit", ctx);

		expect(answer).toContain("$0.42");
		expect(answer).toContain("$5.00");
		// Asking is not setting. A bare `/limit` that wrote would make reading the number dangerous.
		expect(set).toEqual([]);
	});

	it("says there is no ceiling rather than leaving the question open", async () => {
		const answer = await runCommand("/limit", context().context);

		expect(answer).toContain("no limit");
	});

	it("sets a ceiling in dollars a day", async () => {
		const { context: ctx, set } = context();

		const answer = await runCommand("/limit 5", ctx);

		expect(set).toEqual([5]);
		expect(answer).toContain("$5.00");
	});

	// The number is about money, so the character people put in front of money should not be an error.
	it("takes the dollar sign people type anyway", async () => {
		const { context: ctx, set } = context();

		await runCommand("/limit $5.50", ctx);

		expect(set).toEqual([5.5]);
	});

	/**
	 * `null` rather than "unset", because the two are different answers. Unsetting would hand back
	 * whatever the config declared, which is the ceiling the operator is at that moment removing.
	 */
	it("takes a ceiling off without restoring the one in the file", async () => {
		const { context: ctx, set } = context({ limitUsd: 5 });

		const answer = await runCommand("/limit off", ctx);

		expect(set).toEqual([null]);
		expect(answer).toContain("No spending limit");
	});

	it("says nothing about a limit it refuses to set", async () => {
		const { context: ctx, set } = context();

		for (const line of ["/limit cinco", "/limit 0", "/limit -3", "/limit 5 dollars"]) {
			const answer = await runCommand(line, ctx);
			expect(answer).toContain("not an amount");
		}

		expect(set).toEqual([]);
	});

	/** Somebody who typed a command that does not exist is somebody who wants the list. */
	it("answers an unknown command with the ones there are", async () => {
		const answer = await runCommand("/spend", context().context);

		expect(answer).toContain('No command "/spend"');
		expect(answer).toContain("/limit");
	});

	it("answers a bare slash with the same list", async () => {
		const bare = await runCommand("/", context().context);

		expect(bare).toBe(await runCommand("/help", context().context));
		expect(bare).toContain("/limit");
	});
});

describe("isShell", () => {
	it("is the bang and nothing else about the line", () => {
		expect(isShell("!ls -la")).toBe(true);
		expect(isShell("!")).toBe(true);
		expect(isShell("ls -la")).toBe(false);
		// Excitement is not a command, and this is a box people type Spanish into.
		expect(isShell("qué bueno!")).toBe(false);
	});
});

/** ESC written as its six characters, because a raw one in a source file does not survive editing. */
const ESC = "\u001b";

describe("shellOutput", () => {
	const ran = (over: Partial<Parameters<typeof shellOutput>[0]>) =>
		shellOutput({ stdout: "", stderr: "", exitCode: 0, ...over });

	it("is what the command printed", () => {
		expect(ran({ stdout: "README.md\nsrc\n" })).toBe("README.md\nsrc");
	});

	// A command that printed nothing and worked is the most confusing thing a pane can show, because
	// it is identical to a console that dropped the request.
	it("says so when a command printed nothing at all", () => {
		expect(ran({})).toBe("(no output)");
	});

	it("keeps what went to stderr, which is where the reason usually is", () => {
		expect(ran({ stderr: "sh: nope: not found", exitCode: 127 })).toBe(
			"sh: nope: not found\nexit 127",
		);
	});

	/** The difference between a test run that reported failures and one that died before it could. */
	it("says how it ended whenever that is not well", () => {
		expect(ran({ stdout: "2 failed", exitCode: 1 })).toBe("2 failed\nexit 1");
		expect(ran({ exitCode: 1 })).toBe("exit 1");
	});

	it("does not say how it ended when it ended well", () => {
		expect(ran({ stdout: "ok" })).toBe("ok");
	});

	/**
	 * The one place a file the agent wrote is drawn on the operator's terminal. A `!cat` of something
	 * it authored must not be able to move the cursor around the console doing the reading.
	 */
	it("takes the escape sequences out, so output cannot redraw the console", () => {
		expect(ran({ stdout: `${ESC}[31mred${ESC}[39m\n` })).toBe("red");
		expect(ran({ stdout: `${ESC}[2Jcleared\n` })).toBe("cleared");
		expect(ran({ stdout: `${ESC}[1;1Hhome\n` })).toBe("home");
		expect(ran({ stdout: `a${ESC}7b\n` })).toBe("ab");
	});

	it("keeps the tab and the newline, which are the two a pane can draw", () => {
		expect(ran({ stdout: "one\ttwo\nthree\n" })).toBe("one\ttwo\nthree");
	});

	it("takes the carriage return with them, since a pane has no margin to go back to", () => {
		expect(ran({ stdout: "10%\r20%\r30%\n" })).toBe("10%20%30%");
	});

	/**
	 * The transcript is rewritten whole on every line, so one `find /` left in it is paid for by
	 * every line said after it. The middle goes: the first lines say what it did and the last say
	 * how it ended.
	 */
	it("cuts the middle out of output nobody is going to read", () => {
		const printed = ran({ stdout: Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") });
		const lines = printed.split("\n");

		expect(lines).toHaveLength(201);
		expect(lines[0]).toBe("line 0");
		expect(lines.at(-1)).toBe("line 499");
		expect(printed).toContain("300 more lines");
	});

	it("leaves output that fits exactly as it was", () => {
		const printed = ran({ stdout: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") });

		expect(printed.split("\n")).toHaveLength(200);
		expect(printed).not.toContain("more lines");
	});
});
