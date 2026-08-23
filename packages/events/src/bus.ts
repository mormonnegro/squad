import { type AgentEvent, createEvent, type NewAgentEvent } from "./event.ts";
import { renderTurn } from "./render.ts";
import { type EventStore, MemoryEventStore, type QueuedEvent } from "./store.ts";

export interface Wakeup {
	readonly agentId: string;
	readonly events: readonly AgentEvent[];
	/** The events rendered into one prompt, with untrusted content already fenced. */
	readonly prompt: string;
}

/** Runs one turn. Throwing leaves the events queued for another attempt. */
export type WakeupHandler = (wakeup: Wakeup) => Promise<void>;

export interface EventBusOptions {
	readonly store?: EventStore;
	/** Attempts before an event is set aside instead of blocking the queue forever. */
	readonly maxAttempts?: number;
	readonly onDeadLetter?: (agentId: string, dead: readonly QueuedEvent[]) => void;
	readonly onError?: (agentId: string, error: Error) => void;
}

/**
 * Delivers events to agents as wakeups, one turn at a time per agent.
 *
 * A channel message, a cron tick and a webhook are the same thing from the agent's side: something
 * happened, and the agent should take a turn. Coalescing whatever arrived into a single turn keeps
 * a burst of messages from becoming a burst of concurrent agents fighting over the same sandbox.
 */
export class EventBus {
	readonly #store: EventStore;
	readonly #handlers = new Map<string, WakeupHandler>();
	readonly #running = new Set<string>();
	readonly #pendingRuns = new Set<string>();
	readonly #maxAttempts: number;
	readonly #onDeadLetter: ((agentId: string, dead: readonly QueuedEvent[]) => void) | undefined;
	readonly #onError: ((agentId: string, error: Error) => void) | undefined;
	#idle: Promise<void> = Promise.resolve();

	constructor(options: EventBusOptions = {}) {
		this.#store = options.store ?? new MemoryEventStore();
		this.#maxAttempts = options.maxAttempts ?? 3;
		this.#onDeadLetter = options.onDeadLetter;
		this.#onError = options.onError;
	}

	/** Registers the runtime that takes turns for an agent, and drains anything already queued. */
	async register(agentId: string, handler: WakeupHandler): Promise<void> {
		this.#handlers.set(agentId, handler);
		await this.#schedule(agentId);
	}

	unregister(agentId: string): void {
		this.#handlers.delete(agentId);
	}

	/** Accepts an event and wakes the agent. Resolves once the event is durably queued. */
	async publish(input: NewAgentEvent): Promise<AgentEvent> {
		const event = createEvent(input);
		await this.#store.append(event);
		void this.#schedule(event.agentId);
		return event;
	}

	/** Redelivers work left over from a previous process. */
	async recover(): Promise<void> {
		for (const agentId of await this.#store.agentsWithWork()) await this.#schedule(agentId);
	}

	/** Resolves once no turn is in flight. Exists so callers and tests can await quiescence. */
	async drain(): Promise<void> {
		while (this.#running.size > 0 || this.#pendingRuns.size > 0) await this.#idle;
	}

	async #schedule(agentId: string): Promise<void> {
		if (!this.#handlers.has(agentId)) return;
		// A turn already in flight will pick up whatever arrived while it ran, so marking is enough.
		if (this.#running.has(agentId)) {
			this.#pendingRuns.add(agentId);
			return;
		}

		this.#running.add(agentId);
		const run = this.#runUntilEmpty(agentId).finally(() => this.#running.delete(agentId));
		this.#idle = Promise.all([this.#idle, run]).then(() => {});
		await run;
	}

	async #runUntilEmpty(agentId: string): Promise<void> {
		for (;;) {
			this.#pendingRuns.delete(agentId);
			const handler = this.#handlers.get(agentId);
			if (!handler) return;

			const queued = await this.#store.pending(agentId);
			if (queued.length === 0) {
				if (!this.#pendingRuns.has(agentId)) return;
				continue;
			}

			const events = queued.map((item) => item.event);
			const ids = events.map((event) => event.id);

			try {
				await handler({ agentId, events, prompt: renderTurn(events) });
				await this.#store.ack(agentId, ids);
			} catch (error) {
				await this.#store.recordFailure(agentId, ids);
				this.#onError?.(agentId, error instanceof Error ? error : new Error(String(error)));

				const dead = await this.#store.drainDead(agentId, this.#maxAttempts);
				if (dead.length > 0) this.#onDeadLetter?.(agentId, dead);
				// Retrying immediately would spin; the next publish or recover drives the retry.
				return;
			}
		}
	}
}
