import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Account {
	/** What the agent has spent today, in US dollars. */
	readonly spentUsd: number;
	/**
	 * The ceiling set for it at the keyboard: a number, `null` for none, undefined for never set.
	 *
	 * Three states and not two, because "no ceiling" is a decision and "nobody decided here" is not.
	 * Flattening them would make `/limit off` hand back whatever ceiling the config declared, which
	 * is the opposite of what the operator just asked for and would happen silently.
	 */
	readonly limitUsd: number | null | undefined;
}

interface Entry {
	readonly day: string;
	readonly usd: number;
	readonly limitUsd?: number | null;
}

/**
 * What day it is, in UTC.
 *
 * The plane runs in a container whose idea of local time is nobody's, and an operator reading
 * "today" wants one answer rather than one per machine that asks.
 */
export function today(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * What each agent has spent today, and the ceiling it is spending against.
 *
 * Two different things in one file because they are never wanted apart: what a turn cost is only
 * worth knowing next to what is left. Only today's total is kept — yesterday's would be a history
 * nobody asked this to keep, and a file that only grows is one more thing to remember to clean up
 * on a machine nobody is administering. The ceiling outlives the day, so it survives that trim.
 */
export class SpendLedger {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async account(agentId: string, now?: Date): Promise<Account> {
		const entry = (await this.#serialize(() => this.#read()))[agentId];
		return {
			// Spent today, so an entry left from yesterday counts as nothing rather than as a ceiling
			// already reached. The trim happens on the next write; reading is not a reason to write.
			spentUsd: entry?.day === today(now) ? entry.usd : 0,
			limitUsd: entry?.limitUsd,
		};
	}

	async record(agentId: string, usd: number, now?: Date): Promise<void> {
		if (!(usd > 0)) return;
		await this.#update(agentId, (entry) => ({
			day: today(now),
			usd: (entry?.day === today(now) ? entry.usd : 0) + usd,
			...(entry?.limitUsd !== undefined ? { limitUsd: entry.limitUsd } : {}),
		}));
	}

	/** `null` is a ceiling taken off, and is remembered as such rather than as one never set. */
	async setLimit(agentId: string, usd: number | null, now?: Date): Promise<void> {
		await this.#update(agentId, (entry) => ({
			day: entry?.day ?? today(now),
			usd: entry?.day === today(now) ? entry.usd : 0,
			limitUsd: usd,
		}));
	}

	async forget(agentId: string): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			if (!(agentId in all)) return;
			delete all[agentId];
			await this.#write(all);
		});
	}

	async #update(agentId: string, next: (entry: Entry | undefined) => Entry): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			all[agentId] = next(all[agentId]);
			await this.#write(all);
		});
	}

	async #read(): Promise<Record<string, Entry>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			return parsed as Record<string, Entry>;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, Entry>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed: a plane killed mid-write would otherwise leave half a file,
		// which reads as nobody having spent anything and hands every agent its ceiling back.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(all, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic, and every agent on the plane shares this object.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
