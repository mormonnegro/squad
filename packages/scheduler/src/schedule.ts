import { randomUUID } from "node:crypto";
import { isTrustLevel, type TrustLevel } from "@agent-dive/events";
import { nextRun } from "./cron.ts";

export type ScheduleKind = "cron" | "once";

/** Who asked for the schedule. Bounds how much authority its wakeups may carry. */
export type ScheduleAuthor = "operator" | "agent";

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
	if (input.createdBy !== "operator" && input.createdBy !== "agent") {
		issues.push("createdBy must be operator or agent");
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
