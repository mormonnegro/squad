import { describe, expect, it } from "vitest";
import { CronError, nextRun, parseCron } from "../src/cron.ts";

const at = (iso: string): Date => new Date(iso);
const iso = (date: Date): string => date.toISOString();

describe("parseCron", () => {
	it("rejects an expression with the wrong number of fields", () => {
		expect(() => parseCron("* * * *")).toThrow(CronError);
		expect(() => parseCron("* * * * * *")).toThrow(CronError);
	});

	it("rejects values outside their field's range", () => {
		expect(() => parseCron("60 * * * *")).toThrow(/0-59/);
		expect(() => parseCron("* 24 * * *")).toThrow(/0-23/);
		expect(() => parseCron("* * 32 * *")).toThrow(/1-31/);
	});

	it("rejects a backwards range", () => {
		expect(() => parseCron("30-10 * * * *")).toThrow(/ends before it starts/);
	});

	it("accepts names for months and weekdays", () => {
		expect(parseCron("0 0 1 jan mon").month.values.has(1)).toBe(true);
		expect(parseCron("0 0 1 jan mon").dayOfWeek.values.has(1)).toBe(true);
	});

	it("treats both 0 and 7 as Sunday", () => {
		expect(parseCron("0 0 * * 7").dayOfWeek.values).toEqual(new Set([0]));
	});

	it("expands steps and lists", () => {
		expect([...parseCron("0/15 * * * *").minute.values]).toEqual([0, 15, 30, 45]);
		expect([...parseCron("1,2,3 * * * *").minute.values]).toEqual([1, 2, 3]);
		expect([...parseCron("10-20/5 * * * *").minute.values]).toEqual([10, 15, 20]);
	});
});

describe("nextRun", () => {
	it("returns the next matching minute, never the current one", () => {
		expect(iso(nextRun("* * * * *", at("2026-03-01T10:00:00.000Z")))).toBe(
			"2026-03-01T10:01:00.000Z",
		);
	});

	it("ignores sub-minute precision in the starting point", () => {
		expect(iso(nextRun("* * * * *", at("2026-03-01T10:00:30.500Z")))).toBe(
			"2026-03-01T10:01:00.000Z",
		);
	});

	it("finds a daily time later the same day", () => {
		expect(iso(nextRun("30 14 * * *", at("2026-03-01T10:00:00.000Z")))).toBe(
			"2026-03-01T14:30:00.000Z",
		);
	});

	it("rolls over to the next day once the time has passed", () => {
		expect(iso(nextRun("30 14 * * *", at("2026-03-01T15:00:00.000Z")))).toBe(
			"2026-03-02T14:30:00.000Z",
		);
	});

	it("finds the next matching weekday", () => {
		// 2026-03-01 is a Sunday, so the next Monday is the 2nd.
		expect(iso(nextRun("0 9 * * mon", at("2026-03-01T00:00:00.000Z")))).toBe(
			"2026-03-02T09:00:00.000Z",
		);
	});

	it("fires when either day-of-month or day-of-week matches", () => {
		// Vixie semantics: the 15th or any Monday, whichever comes first.
		expect(iso(nextRun("0 0 15 * mon", at("2026-03-03T00:00:00.000Z")))).toBe(
			"2026-03-09T00:00:00.000Z",
		);
	});

	it("crosses a month boundary", () => {
		expect(iso(nextRun("0 0 1 * *", at("2026-03-15T00:00:00.000Z")))).toBe(
			"2026-04-01T00:00:00.000Z",
		);
	});

	it("crosses a year boundary", () => {
		expect(iso(nextRun("0 0 1 jan *", at("2026-06-01T00:00:00.000Z")))).toBe(
			"2027-01-01T00:00:00.000Z",
		);
	});

	it("finds 29 February in a leap year", () => {
		expect(iso(nextRun("0 0 29 feb *", at("2026-03-01T00:00:00.000Z")))).toBe(
			"2028-02-29T00:00:00.000Z",
		);
	});

	it("rejects a date that never occurs", () => {
		expect(() => nextRun("0 0 30 feb *", at("2026-01-01T00:00:00.000Z"))).toThrow(/no next run/);
	});

	describe("time zones", () => {
		it("interprets the expression in the given zone", () => {
			// 09:00 in Montevideo is 12:00 UTC.
			expect(iso(nextRun("0 9 * * *", at("2026-03-01T00:00:00.000Z"), "America/Montevideo"))).toBe(
				"2026-03-01T12:00:00.000Z",
			);
		});

		it("keeps local time across a spring-forward transition", () => {
			// New York moves to UTC-4 on 2026-03-08, so 09:00 local shifts from 14:00 to 13:00 UTC.
			expect(iso(nextRun("0 9 * * *", at("2026-03-07T15:00:00.000Z"), "America/New_York"))).toBe(
				"2026-03-08T13:00:00.000Z",
			);
		});

		it("keeps local time across an autumn-back transition", () => {
			// New York returns to UTC-5 on 2026-11-01.
			expect(iso(nextRun("0 9 * * *", at("2026-10-31T15:00:00.000Z"), "America/New_York"))).toBe(
				"2026-11-01T14:00:00.000Z",
			);
		});

		it("handles a zone ahead of UTC", () => {
			// 09:00 in Tokyo is midnight UTC, and the run must be strictly after the starting point.
			expect(iso(nextRun("0 9 * * *", at("2026-03-01T00:00:00.000Z"), "Asia/Tokyo"))).toBe(
				"2026-03-02T00:00:00.000Z",
			);
		});

		it("rejects an unknown zone", () => {
			expect(() => nextRun("* * * * *", at("2026-03-01T00:00:00.000Z"), "Mars/Olympus")).toThrow(
				/Unknown time zone/,
			);
		});
	});
});
