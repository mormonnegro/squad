import { randomUUID } from "node:crypto";
import { isTrustLevel, type TrustLevel } from "@squad/events";
import { nextRun } from "./cron.ts";

export type ScheduleKind = "cron" | "once";

/** Who asked for the schedule. Bounds how much authority its wakeups may carry. */
/**
 * Who booked a wakeup, which decides both what it may say and whether it can be called off here.
 *
 * `operator` is the configuration file — the operator's, and not this plane's to rewrite: taking one
 * out here would put it back on the next restart. `console` is the same person saying the same thing
 * where the plane can also forget it. `agent` is the agent's own note to itself, which is why it can
 * never carry operator trust however it is asked for.
 */
export type ScheduleAuthor = "operator" | "console" | "agent";

export interface Schedule {
	readonly id: string;
	readonly agentId: string;
	readonly kind: ScheduleKind;
	/** Five-field cron expression, for kind "cron". */
	readonly expression?: string;
	/** ISO instant, for kind "once". */
	readonly runAt?: string;
	readonly timeZone: string;
	readonly channel: string;
	readonly body: string;
	readonly trust: TrustLevel;
	readonly createdBy: ScheduleAuthor;
	readonly nextRunAt: string;
	readonly lastRunAt?: string;
}

export type NewSchedule = Omit<Schedule, "id" | "nextRunAt" | "lastRunAt" | "timeZone"> &
	Partial<Pick<Schedule, "id" | "timeZone">>;

export class ScheduleError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid schedule: ${issues.join("; ")}`);
		this.name = "ScheduleError";
		this.issues = issues;
	}
}

/**
 * Validates a schedule and resolves its first run.
 *
 * An agent may schedule itself, but not with operator authority. Without that rule a single
 * successful injection becomes permanent: the injected turn schedules a wakeup carrying operator
 * trust, and from then on the agent instructs itself on the attacker's behalf, with no attacker
 * present to notice or revoke.
 */
export function createSchedule(input: NewSchedule, from: Date = new Date()): Schedule {
	const issues: string[] = [];
	const timeZone = input.timeZone ?? "UTC";

	if (typeof input.agentId !== "string" || input.agentId.length === 0) {
		issues.push("agentId is required");
	}
	if (input.kind !== "cron" && input.kind !== "once") issues.push("kind must be cron or once");
	if (typeof input.channel !== "string" || input.channel.length === 0) {
		issues.push("channel is required");
	}
	if (typeof input.body !== "string") issues.push("body must be a string");
	if (!isTrustLevel(input.trust)) issues.push("trust must be operator, participant or public");
	if (
		input.createdBy !== "operator" &&
		input.createdBy !== "console" &&
		input.createdBy !== "agent"
	) {
		issues.push("createdBy must be operator, console or agent");
	}
	if (input.createdBy === "agent" && input.trust === "operator") {
		issues.push("an agent cannot schedule a wakeup with operator trust");
	}

	let nextRunAt: string | undefined;
	if (input.kind === "cron") {
		if (typeof input.expression !== "string") issues.push("cron schedules need an expression");
		else {
			try {
				nextRunAt = nextRun(input.expression, from, timeZone).toISOString();
			} catch (error) {
				issues.push(error instanceof Error ? error.message : String(error));
			}
		}
	} else if (input.kind === "once") {
		const parsed = Date.parse(input.runAt ?? "");
		if (Number.isNaN(parsed)) issues.push("once schedules need a valid runAt instant");
		else nextRunAt = new Date(parsed).toISOString();
	}

	if (issues.length > 0 || nextRunAt === undefined) throw new ScheduleError(issues);

	return {
		id: input.id ?? randomUUID(),
		agentId: input.agentId,
		kind: input.kind,
		timeZone,
		channel: input.channel,
		body: input.body,
		trust: input.trust,
		createdBy: input.createdBy,
		nextRunAt,
		...(input.expression !== undefined ? { expression: input.expression } : {}),
		...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
	};
}

/**
 * Advances a cron schedule past `after`, or returns undefined when it should not run again.
 *
 * A control plane that was down for a week should not fire a week of missed hourly ticks; the
 * agent takes one turn and continues from the present.
 */
export function advance(schedule: Schedule, after: Date): Schedule | undefined {
	if (schedule.kind === "once" || schedule.expression === undefined) return undefined;

	return {
		...schedule,
		lastRunAt: after.toISOString(),
		nextRunAt: nextRun(schedule.expression, after, schedule.timeZone).toISOString(),
	};
}

/** What a wakeup typed at a console can be: a cron line, a time of day, or a wait. */
export type When =
	| { readonly kind: "cron"; readonly expression: string }
	| { readonly kind: "once"; readonly runAt: string };

const EVERY = /^every\s+(\d{1,3})\s*(m|min|mins|minutes?|h|hours?)$/i;
const IN = /^in\s+(\d{1,4})\s*(m|min|mins|minutes?|h|hours?|d|days?)$/i;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

/**
 * When somebody means, out of what they would type.
 *
 * Cron is the thing underneath and it is not the thing anybody wants to write at eight in the
 * morning to say "at eight in the morning". So three shapes are read, and the raw five fields are
 * still one of them — a person who knows cron is not made to translate their own knowledge into a
 * worse language.
 *
 * `08:00` is every day at eight, because a time of day with no day on it is a habit. `in 2h` is
 * once, because a wait is a thing that happens and then is over. `every 10m` is the third, which is
 * the shape a person reaches for when they mean often rather than at.
 */
export function readWhen(
	said: string,
	now: Date = new Date(),
): When | { readonly refused: string } {
	const text = said.trim();
	if (text.length === 0) return { refused: "a time: 08:00, every 10m, in 2h, or five cron fields" };

	const clock = CLOCK.exec(text);
	if (clock !== null) {
		const hour = Number(clock[1]);
		const minute = Number(clock[2]);
		if (hour > 23 || minute > 59) return { refused: `"${text}" is not a time of day` };
		return { kind: "cron", expression: `${minute} ${hour} * * *` };
	}

	const often = EVERY.exec(text);
	if (often !== null) {
		const count = Number(often[1]);
		const unit = (often[2] ?? "").toLowerCase();
		if (count < 1) return { refused: `"${text}" is not an interval` };
		if (unit.startsWith("m")) {
			if (count > 59) return { refused: "every so many minutes stops at 59 — say hours instead" };
			return { kind: "cron", expression: `*/${count} * * * *` };
		}
		if (count > 23) return { refused: "every so many hours stops at 23 — say a time of day" };
		return { kind: "cron", expression: `0 */${count} * * *` };
	}

	const wait = IN.exec(text);
	if (wait !== null) {
		const count = Number(wait[1]);
		const unit = (wait[2] ?? "").toLowerCase();
		const minutes = unit.startsWith("m") ? count : unit.startsWith("h") ? count * 60 : count * 1440;
		if (minutes < 1) return { refused: `"${text}" is no time at all` };
		return { kind: "once", runAt: new Date(now.getTime() + minutes * 60_000).toISOString() };
	}

	// Five fields, which is what cron is. Whether they are five valid ones is the scheduler's to say,
	// and it says it in its own words when the wakeup is made.
	if (text.split(/\s+/).length === 5) return { kind: "cron", expression: text };

	return { refused: `"${text}" is not a time: 08:00, every 10m, in 2h, or five cron fields` };
}
