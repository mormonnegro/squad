import type { AgentSummary, PlaneEvent, Utterance } from "@squad/control-plane";

/**
 * A response to something asked, or an event nobody asked for.
 *
 * Written out here rather than imported because it is the wire, and the wire is the one thing the
 * two ends have to agree on without either owning the other. What the plane sends is a superset of
 * what this reads: a client that does not know an answer's shape ignores it, and that is what lets
 * a browser left open across an update keep working until it is reloaded.
 */
type Answer =
	| { readonly id: string; readonly event: PlaneEvent }
	| { readonly id: string; readonly chunk: string }
	| { readonly id: string; readonly ok: false; readonly error: string }
	| { readonly id: string; readonly ok: true };

/** What an `ok` carried, which differs per operation and is read by the method that asked. */
type Payload = Readonly<Record<string, unknown>>;

/**
 * A wakeup an agent is waiting on: when it fires, and what it will be told when it does.
 *
 * Declared here rather than imported from the scheduler, like everything else on this wire. What
 * matters is that the two ends agree on the fields that are read, and a browser that does not know
 * about a field a newer plane sends ignores it.
 */
export interface Wake {
	readonly id: string;
	readonly kind: "cron" | "once";
	/** Five fields, for kind "cron". */
	readonly expression?: string;
	readonly timeZone: string;
	/** What the agent is told when this fires. Its own words, when it was the one who booked it. */
	readonly body: string;
	readonly createdBy: string;
	readonly nextRunAt: string;
	readonly lastRunAt?: string;
}

export class PlaneError extends Error {}

/** The connection under the client: how a line goes out, and how the lines coming back arrive. */
export interface Wire {
	open(onLine: (line: string) => void, onDown: (why: Error) => void): Promise<Session>;
}

export interface Session {
	post(line: string): Promise<void>;
	close(): void;
}

/**
 * The plane, from a browser.
 *
 * The same protocol the console speaks, over the same correlation by `id`, because it is the same
 * protocol: this is `ControlClient` with a different pipe under it, and everything it can do is
 * something a console could already do. Deliberately so — a browser that could ask for something the
 * socket cannot answer would be a second control surface to keep in step with the first.
 */
export class Plane {
	readonly #wire: Wire;
	readonly #handlers = new Map<string, (answer: Answer) => void>();
	readonly #watchers = new Set<(event: PlaneEvent) => void>();
	#session: Session | undefined;
	#next = 1;
	#down: ((why: Error) => void) | undefined;

	constructor(wire: Wire) {
		this.#wire = wire;
	}

	/** Told when the connection goes, so the screen can say so rather than quietly stop moving. */
	onDown(handler: (why: Error) => void): void {
		this.#down = handler;
	}

	async connect(): Promise<void> {
		this.#session = await this.#wire.open(
			(line) => this.#arrived(line),
			(why) => {
				// Everything in flight fails together. A promise still waiting on a connection that has
				// gone is a spinner that never stops, which is worse than an error.
				for (const [id, handler] of this.#handlers) {
					this.#handlers.delete(id);
					handler({ id, ok: false, error: why.message });
				}
				this.#session = undefined;
				this.#down?.(why);
			},
		);
	}

	close(): void {
		this.#session?.close();
		this.#session = undefined;
	}

	get connected(): boolean {
		return this.#session !== undefined;
	}

	#arrived(line: string): void {
		let answer: Answer;
		try {
			answer = JSON.parse(line) as Answer;
		} catch {
			return;
		}
		const handler = this.#handlers.get(answer.id);
		if (handler === undefined) return;
		// Only an `ok` ends an id. A chunk is the answer still being written, and an event is one of
		// however many the subscription will carry for the life of the connection — spending the
		// handler on either drops everything that comes after the first one, which for `logs` is every
		// event the plane will ever send.
		if ("ok" in answer) this.#handlers.delete(answer.id);
		handler(answer);
	}

	async #ask(request: Record<string, unknown>, onChunk?: (text: string) => void): Promise<Payload> {
		const session = this.#session;
		if (session === undefined) throw new PlaneError("Not connected to the plane.");
		const id = String(this.#next++);

		const answered = new Promise<Payload>((settle, fail) => {
			this.#handlers.set(id, (answer) => {
				// A chunk is the answer being written rather than the answer. The handler is still
				// registered — `#arrived` only unregisters on something terminal — so more can arrive.
				if ("chunk" in answer) {
					onChunk?.(answer.chunk);
					return;
				}
				if ("ok" in answer && !answer.ok) fail(new PlaneError(answer.error));
				else settle(answer as unknown as Payload);
			});
		});

		await session.post(JSON.stringify({ ...request, id })).catch((error: Error) => {
			this.#handlers.delete(id);
			throw new PlaneError(error.message);
		});
		return answered;
	}

	/**
	 * Everything the plane does, from now on. Subscribed once and never answered.
	 *
	 * Nothing replays: a stream nobody was reading has no backlog, so a client coming back asks again
	 * for the state it missed rather than being handed a gap dressed as history.
	 */
	watch(onEvent: (event: PlaneEvent) => void): void {
		this.#watchers.add(onEvent);
		if (this.#watchers.size > 1) return;
		const session = this.#session;
		if (session === undefined) throw new PlaneError("Not connected to the plane.");
		const id = String(this.#next++);
		this.#handlers.set(id, (answer) => {
			if ("event" in answer) for (const watcher of this.#watchers) watcher(answer.event);
		});
		void session.post(JSON.stringify({ id, op: "logs" }));
	}

	async agents(): Promise<readonly AgentSummary[]> {
		const answer = await this.#ask({ op: "agents" });
		// Older planes answered without these, and a console that assumed them crashed on the first
		// row rather than on the field it wanted.
		return (answer.agents as AgentSummary[]).map((agent) => ({
			...agent,
			asking: agent.asking ?? [],
			wants: agent.wants ?? [],
		}));
	}

	async schedules(agentId: string): Promise<readonly Wake[]> {
		const answer = await this.#ask({ op: "schedules", agentId });
		return (answer.schedules as Wake[] | undefined) ?? [];
	}

	/** Stops one of an agent's own wakeups. The plane refuses the ones its configuration declares. */
	async unschedule(agentId: string, scheduleId: string): Promise<void> {
		await this.#ask({ op: "unschedule", agentId, scheduleId });
	}

	async transcripts(): Promise<Record<string, readonly Utterance[]>> {
		const answer = await this.#ask({ op: "transcripts" });
		return answer.transcripts as Record<string, readonly Utterance[]>;
	}

	async wake(agentId: string, body: string, onText?: (text: string) => void): Promise<string> {
		const answer = await this.#ask({ op: "wake", agentId, body }, onText);
		return (answer.text as string | undefined) ?? "";
	}

	async command(agentId: string, line: string): Promise<string> {
		const answer = await this.#ask({ op: "command", agentId, line });
		return (answer.text as string | undefined) ?? "";
	}

	async shell(agentId: string, line: string): Promise<{ text: string; cwd: string }> {
		const answer = await this.#ask({ op: "shell", agentId, line });
		return { text: (answer.text as string) ?? "", cwd: (answer.cwd as string) ?? "" };
	}

	async complete(agentId: string, word: string): Promise<readonly string[]> {
		const answer = await this.#ask({ op: "complete", agentId, word });
		return (answer.options as string[] | undefined) ?? [];
	}

	async create(agentId: string): Promise<AgentSummary> {
		const answer = await this.#ask({ op: "create", agentId });
		return answer.agent as AgentSummary;
	}

	async stop(agentId: string): Promise<void> {
		await this.#ask({ op: "stop", agentId });
	}

	async remove(agentId: string, purge: boolean): Promise<void> {
		await this.#ask({ op: "remove", agentId, purge });
	}

	async answerReach(agentId: string, host: string, open: boolean): Promise<void> {
		await this.#ask({ op: "reach", agentId, host, open });
	}

	async answerTalk(agentId: string, to: string, open: boolean): Promise<void> {
		await this.#ask({ op: "talk", agentId, to, open });
	}
}

/**
 * The wire a browser has: an event stream down, and a POST up.
 *
 * `EventSource` rather than a socket because reconnection is the hard half of a live connection and
 * this is the one transport where the browser has already written it. What it cannot do is carry the
 * session id, which is why that arrives as the stream's first event rather than in a header.
 */
export function browserWire(origin = "", token?: string): Wire {
	// In the address of the stream because an `EventSource` can carry it nowhere else — it has no
	// header API, and a cookie set by another origin is not ours to have. The wire is a `fetch` and
	// takes it in a header, where an address cannot be copied out of a history.
	const carried = token === undefined ? "" : `?t=${encodeURIComponent(token)}`;
	return {
		open(onLine, onDown) {
			return new Promise<Session>((settle, fail) => {
				const source = new EventSource(`${origin}/events${carried}`);
				let session: string | undefined;

				source.addEventListener("session", (event) => {
					session = (event as MessageEvent<string>).data;
					settle({
						async post(line) {
							const response = await fetch(`${origin}/rpc`, {
								method: "POST",
								headers: {
									"x-squad-session": session ?? "",
									...(token === undefined ? {} : { "x-squad-token": token }),
								},
								body: line,
							});
							if (!response.ok) throw new Error(await response.text());
						},
						close() {
							source.close();
						},
					});
				});

				source.addEventListener("message", (event) => onLine(event.data));
				source.addEventListener("error", () => {
					// Before the session arrives this is a connection that never opened, and after it is
					// one that has gone. The browser retries either way; what differs is who is waiting.
					const why = new Error("The connection to the plane went.");
					if (session === undefined) fail(why);
					else onDown(why);
				});
			});
		},
	};
}
