import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Schedule } from "./schedule.ts";

export interface ScheduleStore {
	save(schedule: Schedule): Promise<void>;
	remove(id: string): Promise<void>;
	get(id: string): Promise<Schedule | undefined>;
	list(agentId?: string): Promise<Schedule[]>;
	/** Schedules that should already have run by `instant`, soonest first. */
	due(instant: Date): Promise<Schedule[]>;
}

function byNextRun(a: Schedule, b: Schedule): number {
	return a.nextRunAt < b.nextRunAt ? -1 : a.nextRunAt > b.nextRunAt ? 1 : 0;
}

function isDue(schedule: Schedule, instant: Date): boolean {
	return Date.parse(schedule.nextRunAt) <= instant.getTime();
}

export class MemoryScheduleStore implements ScheduleStore {
	readonly #schedules = new Map<string, Schedule>();

	async save(schedule: Schedule): Promise<void> {
		this.#schedules.set(schedule.id, schedule);
	}

	async remove(id: string): Promise<void> {
		this.#schedules.delete(id);
	}

	async get(id: string): Promise<Schedule | undefined> {
		return this.#schedules.get(id);
	}

	async list(agentId?: string): Promise<Schedule[]> {
		return [...this.#schedules.values()]
			.filter((schedule) => agentId === undefined || schedule.agentId === agentId)
			.sort(byNextRun);
	}

	async due(instant: Date): Promise<Schedule[]> {
		return (await this.list()).filter((schedule) => isDue(schedule, instant));
	}
}

/**
 * A single JSON file, replaced atomically.
 *
 * Schedules are the only record that an agent is supposed to wake up at all; losing them on
 * restart turns a recurring job into one that ran until the last deploy and then quietly stopped.
 */
export class FileScheduleStore implements ScheduleStore {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async save(schedule: Schedule): Promise<void> {
		await this.#mutate((schedules) => [
			...schedules.filter((existing) => existing.id !== schedule.id),
			schedule,
		]);
	}

	async remove(id: string): Promise<void> {
		await this.#mutate((schedules) => schedules.filter((schedule) => schedule.id !== id));
	}

	async get(id: string): Promise<Schedule | undefined> {
		return (await this.list()).find((schedule) => schedule.id === id);
	}

	async list(agentId?: string): Promise<Schedule[]> {
		const schedules = await this.#serialize(() => this.#read());
		return schedules
			.filter((schedule) => agentId === undefined || schedule.agentId === agentId)
			.sort(byNextRun);
	}

	async due(instant: Date): Promise<Schedule[]> {
		return (await this.list()).filter((schedule) => isDue(schedule, instant));
	}

	async #read(): Promise<Schedule[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			return Array.isArray(parsed) ? (parsed as Schedule[]) : [];
		} catch {
			return [];
		}
	}

	// Read-modify-write is not atomic, so concurrent writers would otherwise lose schedules.
	async #mutate(update: (schedules: Schedule[]) => Schedule[]): Promise<void> {
		await this.#serialize(async () => {
			const next = update(await this.#read());
			await mkdir(dirname(this.#path), { recursive: true });
			const temporary = `${this.#path}.${process.pid}.tmp`;
			await writeFile(temporary, JSON.stringify(next), "utf8");
			await rename(temporary, this.#path);
		});
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
