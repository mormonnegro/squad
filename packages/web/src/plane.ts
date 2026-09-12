import type { AgentSummary, PlaneEvent, ProviderStanding, Utterance } from "@squad/control-plane";
import { link } from "@squad/relay/link";

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

/** One browser that has been let in, as a screen shows it. */
export interface DeviceRow {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
	readonly lastSeenAt: string;
}

/** The connection under the client: how a line goes out, and how the lines coming back arrive. */
export interface Wire {
	open(
		onLine: (line: string) => void,
		onDown: (why: Error) => void,
		/**
		 * The connection is carrying again, after having stopped.
		 *
		 * Needed because the transport underneath repairs itself and nothing above it could tell. An
		 * `EventSource` reconnects on its own, so what a dropped connection actually is here is a gap
		 * — and a screen told only about the start of a gap says the plane is down for as long as it
		 * is left open, over a console that has been working again for an hour.
		 */
		onUp?: () => void,
	): Promise<Session>;

	/**
	 * The plane's own HTTP door, where this connection has one.
	 *
	 * Not everything about a plane travels the protocol. Which browsers have been let in is a fact
	 * about that door — who knocked on it and what it handed back — and a connection that does not go
	 * through it has no answer to give. A relayed one is exactly that: it reaches the control socket
	 * sealed, past the door entirely, and what authorises it is the plane's own token rather than a
	 * device. So this is missing there, and a screen that needs it asks first instead of being told
	 * a half-truth.
	 */
	door?(path: string, init?: RequestInit): Promise<unknown>;
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
	#up: (() => void) | undefined;

	constructor(wire: Wire) {
		this.#wire = wire;
	}

	/** Told when the connection comes back, so a screen that said it was gone can stop saying it. */
	onUp(handler: () => void): void {
		this.#up = handler;
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
			() => this.#up?.(),
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

	/**
	 * The browsers this plane has let in, and which of them is asking.
	 *
	 * Over HTTP rather than down the protocol, because a device is a fact about the browser's door
	 * and not about the plane: a console in a terminal reaches the same plane over a socket and has
	 * no device at all, so this is not a question that protocol could answer.
	 */
	async devices(): Promise<{ devices: readonly DeviceRow[]; here?: string }> {
		const answer = (await this.#door("/devices")) as { devices?: DeviceRow[]; here?: string };
		return {
			devices: answer.devices ?? [],
			...(answer.here === undefined ? {} : { here: answer.here }),
		};
	}

	/** Whether this connection can answer for the door at all. A relayed one cannot. */
	get hasDoor(): boolean {
		return this.#wire.door !== undefined;
	}

	async #door(path: string, init?: RequestInit): Promise<unknown> {
		const knock = this.#wire.door;
		if (knock === undefined) {
			throw new PlaneError("This environment is reached through a relay, which has no door.");
		}
		return knock.call(this.#wire, path, init);
	}

	/** Out, for that one. Every other browser is untouched, which is the point of the list. */
	async revoke(id: string): Promise<boolean> {
		const answer = (await this.#door(`/devices/${encodeURIComponent(id)}`, {
			method: "DELETE",
		})) as {
			gone?: boolean;
		};
		return answer.gone === true;
	}

	async renameDevice(id: string, name: string): Promise<void> {
		await this.#door(`/devices/${encodeURIComponent(id)}`, {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	}

	/** Every key this plane could be given, and whether it is holding one. Never the values. */
	async providers(): Promise<readonly ProviderStanding[]> {
		const answer = await this.#ask({ op: "providers" });
		return (answer.providers as ProviderStanding[] | undefined) ?? [];
	}

	/**
	 * Hands this plane a provider key, or takes one back when the value is empty.
	 *
	 * Nothing comes back but the name: the plane answers with which key it set and never with what
	 * was set, so a screen cannot show a secret it was never told. Reading one back is not a feature
	 * that is missing, it is a door this wire does not have.
	 */
	async setKey(keyEnv: string, value: string): Promise<void> {
		await this.#ask({ op: "key", keyEnv, value });
	}
}

/**
 * The wire a browser has: an event stream down, and a POST up.
 *
 * `EventSource` rather than a socket because reconnection is the hard half of a live connection and
 * this is the one transport where the browser has already written it. What it cannot do is carry the
 * session id, which is why that arrives as the stream's first event rather than in a header.
 */
/**
 * The wire for a plane that cannot be dialled, which meets this page at a rendezvous instead.
 *
 * The same shape as the one above and, from the `Plane` upwards, indistinguishable from it: lines
 * go down and come back, and nothing that reads them knows which road they took. That is the whole
 * design — `squad relay` has always been a pipe with the protocol in it, and this is that pipe with
 * both ends dialling outwards so that neither has to be reachable.
 *
 * What crosses the relay is sealed with a key derived from the token, which the relay is never
 * given. It is handed a room number instead, derived from the same token one way, so pairing two
 * sockets is all it can do with it.
 */
export function wireTo(one: {
	origin: string;
	token?: string | undefined;
	relay?: string | undefined;
}): Wire {
	// Decided once, here, because everything above a `Wire` is written not to care: a connection is
	// lines out and lines back, and a screen that asked which road they took would be a screen with
	// two of everything on it.
	return one.relay === undefined || one.token === undefined
		? browserWire(one.origin, one.token)
		: relayWire(one.relay, one.token);
}

export function relayWire(relayOrigin: string, token: string): Wire {
	return {
		open(onLine, onDown) {
			return link({
				origin: relayOrigin,
				secret: token,
				side: "console",
				onLine,
				onDown,
			}).then((opened) => ({
				post: (line: string) => opened.send(line),
				close: () => opened.close(),
			}));
		},
	};
}

export function browserWire(origin = "", token?: string): Wire {
	// In the address of the stream because an `EventSource` can carry it nowhere else — it has no
	// header API, and a cookie set by another origin is not ours to have. The wire is a `fetch` and
	// takes it in a header, where an address cannot be copied out of a history.
	const carried = token === undefined ? "" : `?t=${encodeURIComponent(token)}`;
	return {
		async door(path, init) {
			const response = await fetch(`${origin}${path}`, {
				...init,
				headers: {
					"content-type": "application/json",
					...(token === undefined ? {} : { "x-squad-token": token }),
					...(init?.headers ?? {}),
				},
				// Same-origin and cross-origin both: the cookie is what a page this plane served has,
				// and the header is what a page somewhere else has.
				credentials: "include",
			});
			if (!response.ok) throw new PlaneError((await response.text()).trim());
			return response.json();
		},
		open(onLine, onDown, onUp) {
			return new Promise<Session>((settle, fail) => {
				const source = new EventSource(`${origin}/events${carried}`);
				let session: string | undefined;

				source.addEventListener("session", (event) => {
					// A session arriving when one is already held is the browser having reconnected the
					// stream by itself. The plane is a fresh connection at the far end, so the id has to
					// be taken — and the screen has to be told, because the only thing it heard about
					// this was that it had gone.
					const again = session !== undefined;
					session = (event as MessageEvent<string>).data;
					if (again) {
						onUp?.();
						return;
					}
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
