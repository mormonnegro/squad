import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "./event.ts";

export interface QueuedEvent {
	readonly event: AgentEvent;
	readonly attempts: number;
}

/** Durable backlog of events an agent has not yet processed. */
export interface EventStore {
	append(event: AgentEvent): Promise<void>;
	pending(agentId: string): Promise<QueuedEvent[]>;
	/** Removes events the agent finished with. */
	ack(agentId: string, ids: readonly string[]): Promise<void>;
	/** Records a failed attempt, so a poisonous event cannot be retried forever. */
	recordFailure(agentId: string, ids: readonly string[]): Promise<void>;
	/** Removes events that exhausted their attempts and returns them. */
	drainDead(agentId: string, maxAttempts: number): Promise<QueuedEvent[]>;
	agentsWithWork(): Promise<string[]>;
}

export class MemoryEventStore implements EventStore {
	readonly #queues = new Map<string, QueuedEvent[]>();

	async append(event: AgentEvent): Promise<void> {
		const queue = this.#queues.get(event.agentId) ?? [];
		queue.push({ event, attempts: 0 });
		this.#queues.set(event.agentId, queue);
	}

	async pending(agentId: string): Promise<QueuedEvent[]> {
		return [...(this.#queues.get(agentId) ?? [])];
	}

	async ack(agentId: string, ids: readonly string[]): Promise<void> {
		const remove = new Set(ids);
		const queue = (this.#queues.get(agentId) ?? []).filter((item) => !remove.has(item.event.id));
		this.#queues.set(agentId, queue);
	}

	async recordFailure(agentId: string, ids: readonly string[]): Promise<void> {
		const failed = new Set(ids);
		const queue = (this.#queues.get(agentId) ?? []).map((item) =>
			failed.has(item.event.id) ? { event: item.event, attempts: item.attempts + 1 } : item,
		);
		this.#queues.set(agentId, queue);
	}

	async drainDead(agentId: string, maxAttempts: number): Promise<QueuedEvent[]> {
		const queue = this.#queues.get(agentId) ?? [];
		const dead = queue.filter((item) => item.attempts >= maxAttempts);
		this.#queues.set(
			agentId,
			queue.filter((item) => item.attempts < maxAttempts),
		);
		return dead;
	}

	async agentsWithWork(): Promise<string[]> {
		return [...this.#queues.entries()]
			.filter(([, queue]) => queue.length > 0)
			.map(([agentId]) => agentId);
	}
}

/**
 * One JSON file per agent, replaced atomically.
 *
 * Durability is the point: a wakeup that only exists in memory is lost when the control plane
 * restarts, which turns a scheduled or webhook-triggered turn into a silent no-op.
 */
export class FileEventStore implements EventStore {
	readonly #directory: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(directory: string) {
		this.#directory = directory;
	}

	async append(event: AgentEvent): Promise<void> {
		await this.#mutate(event.agentId, (queue) => [...queue, { event, attempts: 0 }]);
	}

	async pending(agentId: string): Promise<QueuedEvent[]> {
		return this.#serialize(() => this.#read(agentId));
	}

	async ack(agentId: string, ids: readonly string[]): Promise<void> {
		const remove = new Set(ids);
		await this.#mutate(agentId, (queue) => queue.filter((item) => !remove.has(item.event.id)));
	}

	async recordFailure(agentId: string, ids: readonly string[]): Promise<void> {
		const failed = new Set(ids);
		await this.#mutate(agentId, (queue) =>
			queue.map((item) =>
				failed.has(item.event.id) ? { event: item.event, attempts: item.attempts + 1 } : item,
			),
		);
	}

	async drainDead(agentId: string, maxAttempts: number): Promise<QueuedEvent[]> {
		let dead: QueuedEvent[] = [];
		await this.#mutate(agentId, (queue) => {
			dead = queue.filter((item) => item.attempts >= maxAttempts);
			return queue.filter((item) => item.attempts < maxAttempts);
		});
		return dead;
	}

	async agentsWithWork(): Promise<string[]> {
		let entries: string[];
		try {
			entries = await readdir(this.#directory);
		} catch {
			return [];
		}

		const agents: string[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const agentId = decodeURIComponent(entry.slice(0, -".json".length));
			if ((await this.pending(agentId)).length > 0) agents.push(agentId);
		}
		return agents;
	}

	#path(agentId: string): string {
		return join(this.#directory, `${encodeURIComponent(agentId)}.json`);
	}

	async #read(agentId: string): Promise<QueuedEvent[]> {
		try {
			const text = await readFile(this.#path(agentId), "utf8");
			const parsed: unknown = JSON.parse(text);
			return Array.isArray(parsed) ? (parsed as QueuedEvent[]) : [];
		} catch {
			return [];
		}
	}

	// Read-modify-write is not atomic, so concurrent publishes would otherwise lose events.
	async #mutate(agentId: string, update: (queue: QueuedEvent[]) => QueuedEvent[]): Promise<void> {
		await this.#serialize(async () => {
			const next = update(await this.#read(agentId));
			const path = this.#path(agentId);
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${process.pid}.tmp`;
			await writeFile(temporary, JSON.stringify(next), "utf8");
			await rename(temporary, path);
		});
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
