import { describe, expect, it } from "vitest";
import { advance, createSchedule, ScheduleError } from "../src/schedule.ts";

const at = (iso: string): Date => new Date(iso);

const common = {
	agentId: "a1",
	channel: "slack:C1",
	body: "check the deploy queue",
	trust: "operator",
	createdBy: "operator",
} as const;

const base = { ...common, kind: "cron", expression: "0 9 * * *" } as const;
const once = { ...common, kind: "once", runAt: "2026-03-01T09:00:00.000Z" } as const;

describe("createSchedule", () => {
	it("resolves the first run from the expression", () => {
		const schedule = createSchedule(base, at("2026-03-01T00:00:00.000Z"));
		expect(schedule.nextRunAt).toBe("2026-03-01T09:00:00.000Z");
		expect(schedule.id).toMatch(/[0-9a-f-]{36}/);
		expect(schedule.timeZone).toBe("UTC");
	});

	it("resolves the first run in the schedule's own zone", () => {
		const schedule = createSchedule(
			{ ...base, timeZone: "America/Montevideo" },
			at("2026-03-01T00:00:00.000Z"),
		);
		expect(schedule.nextRunAt).toBe("2026-03-01T12:00:00.000Z");
	});

	it("takes the instant of a one-shot schedule", () => {
		const schedule = createSchedule(once, at("2026-03-01T00:00:00.000Z"));
		expect(schedule.nextRunAt).toBe("2026-03-01T09:00:00.000Z");
	});

	it("refuses to let an agent give itself operator authority", () => {
		expect(() => createSchedule({ ...base, createdBy: "agent" })).toThrow(
			/cannot schedule a wakeup with operator trust/,
		);
	});

	it("lets an agent schedule itself at a lower trust level", () => {
		const schedule = createSchedule(
			{ ...base, createdBy: "agent", trust: "participant" },
			at("2026-03-01T00:00:00.000Z"),
		);
		expect(schedule.createdBy).toBe("agent");
		expect(schedule.trust).toBe("participant");
	});

	it("rejects a cron schedule without an expression", () => {
		expect(() => createSchedule({ ...common, kind: "cron" })).toThrow(/need an expression/);
	});

	it("rejects a one-shot schedule without a valid instant", () => {
		expect(() => createSchedule({ ...once, runAt: "soon" })).toThrow(/valid runAt instant/);
	});

	it("surfaces an unparseable expression as a schedule problem", () => {
		expect(() => createSchedule({ ...base, expression: "* * *" })).toThrow(ScheduleError);
	});

	it("reports every problem at once", () => {
		try {
			createSchedule({
				agentId: "",
				kind: "weekly" as never,
				channel: "",
				body: 1 as never,
				trust: "x" as never,
				createdBy: "nobody" as never,
			});
			expect.unreachable();
		} catch (error) {
			expect((error as ScheduleError).issues).toHaveLength(6);
		}
	});
});

describe("advance", () => {
	it("moves a cron schedule to its next run", () => {
		const schedule = createSchedule(base, at("2026-03-01T00:00:00.000Z"));
		const next = advance(schedule, at("2026-03-01T09:00:00.000Z"));

		expect(next?.nextRunAt).toBe("2026-03-02T09:00:00.000Z");
		expect(next?.lastRunAt).toBe("2026-03-01T09:00:00.000Z");
	});

	it("skips runs missed while the control plane was down", () => {
		const schedule = createSchedule(
			{ ...base, expression: "0 * * * *" },
			at("2026-03-01T00:00:00.000Z"),
		);
		const next = advance(schedule, at("2026-03-08T00:30:00.000Z"));

		// A week of missed hourly ticks becomes one turn, continuing from the present.
		expect(next?.nextRunAt).toBe("2026-03-08T01:00:00.000Z");
	});

	it("keeps local time across a daylight-saving change", () => {
		const schedule = createSchedule(
			{ ...base, timeZone: "America/New_York" },
			at("2026-03-07T00:00:00.000Z"),
		);
		expect(schedule.nextRunAt).toBe("2026-03-07T14:00:00.000Z");
		expect(advance(schedule, at("2026-03-07T14:00:00.000Z"))?.nextRunAt).toBe(
			"2026-03-08T13:00:00.000Z",
		);
	});

	it("retires a one-shot schedule", () => {
		const schedule = createSchedule(once, at("2026-03-01T00:00:00.000Z"));
		expect(advance(schedule, at("2026-03-01T09:00:00.000Z"))).toBeUndefined();
	});
});
