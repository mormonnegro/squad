import { until as THEIRS } from "@squad/control-plane/console";
import { describe, expect, it } from "vitest";
import { until as OURS } from "../src/until.ts";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const at = (seconds: number): string => new Date(NOW + seconds * 1000).toISOString();

describe("how long until it wakes", () => {
	// The browser cannot import the plane's copy, so this is what stops the two from drifting apart
	// and telling the same operator two different things about the same instant.
	it("says exactly what the plane says", () => {
		for (const seconds of [0, 1, 30, 59, 60, 90, 3599, 3600, 5400, 86_399, 86_400, 400_000]) {
			expect(OURS(at(seconds), NOW)).toBe(THEIRS(at(seconds), NOW));
		}
	});

	it("counts down in the unit the number deserves", () => {
		expect(OURS(at(45), NOW)).toBe("45s");
		expect(OURS(at(120), NOW)).toBe("2m");
		expect(OURS(at(7200), NOW)).toBe("2h");
		expect(OURS(at(172_800), NOW)).toBe("2d");
	});

	// A wakeup whose moment has passed is one the plane is about to run, not one it owes time to.
	it("never counts backwards", () => {
		expect(OURS(at(-500), NOW)).toBe("0s");
	});
});
