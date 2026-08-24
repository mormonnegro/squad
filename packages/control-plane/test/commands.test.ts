import { describe, expect, it } from "vitest";
import { type CommandContext, isCommand, money, runCommand } from "../src/commands.ts";

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
