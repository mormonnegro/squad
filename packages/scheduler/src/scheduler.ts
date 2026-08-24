import type { NewAgentEvent } from "@agent-dive/events";
import { advance, createSchedule, type NewSchedule, type Schedule } from "./schedule.ts";
import { MemoryScheduleStore, type ScheduleStore } from "./store.ts";

/** The half of the event bus the scheduler needs. Narrow so a test can stand in for it. */
export interface WakeupPublisher {
	publish(event: NewAgentEvent): Promise<unknown>;
}

export interface SchedulerOptions {
	readonly publisher: WakeupPublisher;
	readonly store?: ScheduleStore;
	/** How often to look for due schedules. This is the lag, and an agent may ask to wake in a second. */
	readonly intervalMs?: number;
	readonly onError?: (schedule: Schedule, error: Error) => void;
}

const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Turns schedules into wakeups.
 *
 * A tick is published as an ordinary event so a cron wakeup and a human message reach the agent
 * through the same path, with the same trust labelling and the same one-turn-at-a-time guarantee.
 */
export class Scheduler {
	readonly #publisher: WakeupPublisher;
	readonly #store: ScheduleStore;
	readonly #intervalMs: number;
	readonly #onError: ((schedule: Schedule, error: Error) => void) | undefined;
	#timer: NodeJS.Timeout | undefined;
	#ticking = false;

	constructor(options: SchedulerOptions) {
		this.#publisher = options.publisher;
		this.#store = options.store ?? new MemoryScheduleStore();
		this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.#onError = options.onError;
	}

	async add(input: NewSchedule, from: Date = new Date()): Promise<Schedule> {
		const schedule = createSchedule(input, from);
		await this.#store.save(schedule);
		return schedule;
	}

	async remove(id: string): Promise<void> {
		await this.#store.remove(id);
	}

	async list(agentId?: string): Promise<Schedule[]> {
		return this.#store.list(agentId);
	}

	/** Fires everything due at `now` and returns how many wakeups were published. */
	async tick(now: Date = new Date()): Promise<number> {
		// Ticks must not overlap: a slow publish would otherwise fire the same schedule twice.
		if (this.#ticking) return 0;
		this.#ticking = true;

		try {
			let fired = 0;
			for (const schedule of await this.#store.due(now)) {
				// The store is advanced before publishing. A crash in between costs one missed run,
				// whereas advancing afterwards would let a crash loop wake the agent without end.
				const next = advance(schedule, now);
				if (next) await this.#store.save(next);
				else await this.#store.remove(schedule.id);

				try {
					await this.#publisher.publish({
						agentId: schedule.agentId,
						source: "schedule",
						trust: schedule.trust,
						channel: schedule.channel,
						subject: `Scheduled wakeup ${schedule.id}`,
						body: schedule.body,
						metadata: { scheduleId: schedule.id, createdBy: schedule.createdBy },
					});
					fired += 1;
				} catch (error) {
					this.#onError?.(schedule, error instanceof Error ? error : new Error(String(error)));
				}
			}
			return fired;
		} finally {
			this.#ticking = false;
		}
	}

	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			void this.tick();
		}, this.#intervalMs);
		// The control plane should be able to exit on its own; a poll loop is not a reason to live.
		this.#timer.unref?.();
	}

	stop(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}
}
