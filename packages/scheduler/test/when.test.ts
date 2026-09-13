import { describe, expect, it } from "vitest";
import { readWhen } from "../src/schedule.ts";

/**
 * Cron is the thing underneath, and it is not the thing anybody wants to write at eight in the
 * morning to say "at eight in the morning". These are the three shapes a person types instead — and
 * cron itself is still one of them, because somebody who knows it should not have to translate
 * their own knowledge into something worse.
 */
describe("when somebody means", () => {
	it("reads a time of day as a habit", () => {
		expect(readWhen("08:00")).toEqual({ kind: "cron", expression: "0 8 * * *" });
		expect(readWhen("23:45")).toEqual({ kind: "cron", expression: "45 23 * * *" });
	});

	it("reads an interval as often rather than at", () => {
		expect(readWhen("every 10m")).toEqual({ kind: "cron", expression: "*/10 * * * *" });
		expect(readWhen("every 2 hours")).toEqual({ kind: "cron", expression: "0 */2 * * *" });
	});

	// A wait happens and is over, which is the difference between it and a habit.
	it("reads a wait as something that happens once", () => {
		const now = new Date("2026-09-13T10:00:00.000Z");
		expect(readWhen("in 90m", now)).toEqual({ kind: "once", runAt: "2026-09-13T11:30:00.000Z" });
		expect(readWhen("in 2h", now)).toEqual({ kind: "once", runAt: "2026-09-13T12:00:00.000Z" });
		expect(readWhen("in 1d", now)).toEqual({ kind: "once", runAt: "2026-09-14T10:00:00.000Z" });
	});

	it("takes five fields as the cron they are", () => {
		expect(readWhen("0 9 * * 1-5")).toEqual({ kind: "cron", expression: "0 9 * * 1-5" });
	});

	it("says what it takes when it was given something else", () => {
		for (const said of ["", "mañana", "25:00", "every 90m", "in 0h", "0 9 * *"]) {
			expect(readWhen(said)).toHaveProperty("refused");
		}
	});
});
