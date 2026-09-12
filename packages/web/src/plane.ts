import type {
	AgentSummary,
	ModelOffer,
	ModelStanding,
	PlaneEvent,
	Plugin,
	ProviderStanding,
	ServerStanding,
	Utterance,
} from "@squad/control-plane";

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

/**
 * A plugin that has been connected: which one it is, under what name, and who holds it.
 *
 * The plane calls this a server standing, because underneath it is a server on a shelf. On this
 * side it is a connection somebody made — one of possibly several to the same company — and the
 * screen is about accounts rather than about addresses.
 */
export type Connected = ServerStanding;

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
/**
 * A way in that was handed to somebody: who it is for, until when, and what became of it.
 *
 * Written out here rather than imported, like everything else on this wire: what matters is that
 * the two ends agree on the fields that are read.
 */
export interface Invitation {
	readonly id: string;
	readonly label: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	/** How many more browsers it may let in. Zero is spent. */
	readonly left: number;
	/** The devices that came in on it. */
	readonly admitted: readonly string[];
}

export interface DeviceRow {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
	readonly lastSeenAt: string;
	/** The invitation this browser came in on, for the ones that did not come in on the token. */
	readonly from?: string;
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

	async #door(path: string, init?: RequestInit): Promise<unknown> {
		const knock = this.#wire.door;
		if (knock === undefined) throw new PlaneError("This connection has no door.");
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

	/** Every way in that was handed out, and what became of it. */
	async invites(): Promise<readonly Invitation[]> {
		const said = (await this.#door("/invites")) as { invites?: Invitation[] };
		return said.invites ?? [];
	}

	/**
	 * One more way in, for one person.
	 *
	 * The secret comes back once and is never readable again — the plane keeps a hash and nothing
	 * else — so whatever asked for this has to put it in front of somebody before it forgets it.
	 */
	async invite(
		label: string,
		lasts: "hour" | "day" | "week",
		uses: number,
	): Promise<{ invite: Invitation; secret: string }> {
		const said = (await this.#door("/invites", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ label, lasts, uses }),
		})) as { invite: Invitation; secret: string };
		return said;
	}

	/** Calls one off. What it already let in stays in, under its own name, in the device list. */
	async revokeInvite(id: string): Promise<void> {
		await this.#door(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
	}

	async renameDevice(id: string, name: string): Promise<void> {
		await this.#door(`/devices/${encodeURIComponent(id)}`, {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	}

	/**
	 * What this plane's keys actually buy, asked of the providers themselves.
	 *
	 * The only thing here that can tell a working key from a typo. Everything else knows whether a
	 * key is present; this one calls the provider with it and reports what came back, which is why a
	 * screen that has just been handed a key asks it before saying the key is fine.
	 */
	async offers(): Promise<{ offers: readonly ModelOffer[]; trouble: readonly string[] }> {
		const answer = await this.#ask({ op: "offers" });
		const catalog = answer.catalog as { offers?: ModelOffer[]; trouble?: string[] } | undefined;
		return { offers: catalog?.offers ?? [], trouble: catalog?.trouble ?? [] };
	}

	/**
	 * Every model this plane is configured with, and whether it can pay for it.
	 *
	 * The agent settings screen picks from this rather than from what the providers offer: what an
	 * agent may be set to is what the plane has been configured with, and offering the rest would be
	 * a menu whose entries fail at the proxy.
	 */
	async models(): Promise<readonly ModelStanding[]> {
		const answer = await this.#ask({ op: "models" });
		return (answer.models as ModelStanding[] | undefined) ?? [];
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

	/**
	 * The plugins screen in one answer: what there is to connect, and what has been.
	 *
	 * The catalogue comes down the wire with the connections rather than being compiled into this
	 * page, so a plane that knows about a plugin this bundle has never heard of still offers it.
	 */
	async plugins(): Promise<{ catalog: readonly Plugin[]; instances: readonly Connected[] }> {
		const answer = await this.#ask({ op: "plugins" });
		const said = answer.plugins as { catalog?: Plugin[]; instances?: Connected[] } | undefined;
		return { catalog: said?.catalog ?? [], instances: said?.instances ?? [] };
	}

	/** One more copy of a plugin. The plane picks the name, because the shelf is the plane's. */
	async connectPlugin(
		pluginId: string,
		label?: string,
	): Promise<{ name: string; wants: "login" | "nothing" }> {
		const answer = await this.#ask({
			op: "connect-plugin",
			pluginId,
			...(label !== undefined && label !== "" ? { label } : {}),
		});
		const made = answer.made as { name?: string; wants?: "login" | "nothing" } | undefined;
		return { name: made?.name ?? pluginId, wants: made?.wants ?? "login" };
	}

	/**
	 * Adds one that is on no shelf, from the line as it was typed.
	 *
	 * The line goes up whole and is read there: a URL, `sse` and a URL, or the command to start. The
	 * plane owns what those mean, and a page that guessed would be a second answer to one question.
	 */
	async addPlugin(name: string, line: string): Promise<void> {
		await this.#ask({ op: "add-plugin", name, line });
	}

	/** Says which copy a connection is — "the live account" — or stops saying it when empty. */
	async labelPlugin(name: string, label: string): Promise<void> {
		await this.#ask({ op: "label-plugin", name, label });
	}

	/**
	 * Opens the consent screen for one connection and answers with where it is.
	 *
	 * The page is opened from here rather than by the plane, because the browser that can open it is
	 * this one — the plane may be a container on a machine nobody is sitting at.
	 */
	async loginPlugin(name: string): Promise<{ url: string; redirectUri: string }> {
		const answer = await this.#ask({ op: "login-plugin", name });
		const page = answer.page as { url?: string; redirectUri?: string } | undefined;
		return { url: page?.url ?? "", redirectUri: page?.redirectUri ?? "" };
	}

	async logoutPlugin(name: string): Promise<void> {
		await this.#ask({ op: "logout-plugin", name });
	}

	/** Gives an agent one of the connections, or takes it back. */
	async holdPlugin(agentId: string, name: string, held: boolean): Promise<void> {
		await this.#ask({ op: "hold-server", agentId, name, held });
	}

	/** Takes a connection off the shelf, and off every agent that had it. */
	async forgetPlugin(name: string): Promise<void> {
		await this.#ask({ op: "forget-server", name });
	}

	/** What one agent may spend in a day. `null` takes the ceiling off. */
	async setLimit(agentId: string, usd: number | null): Promise<void> {
		await this.#ask({ op: "set-limit", agentId, usd });
	}
}

/**
 * The wire a browser has: an event stream down, and a POST up.
 *
 * `EventSource` rather than a socket because reconnection is the hard half of a live connection and
 * this is the one transport where the browser has already written it. What it cannot do is carry
 * the session id, which is why that arrives as the stream's first event rather than in a header.
 *
 * One wire, and it is same-origin: this page is served by the plane it drives, and what lets it in
 * is the cookie that plane set when the token was spent on the way here. There used to be two more
 * — an origin with a token on every request, and a rendezvous for a plane nobody can dial — and
 * they existed for a console that could be pointed at several machines. That console is a thing to
 * build once running one is simple, and the shape of the wire is the first place the difference
 * between those two shows up.
 */
export function browserWire(): Wire {
	return {
		async door(path, init) {
			const response = await fetch(path, {
				...init,
				headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
				// The cookie this plane set when it let this browser in, which is the whole of the key.
				credentials: "include",
			});
			if (!response.ok) throw new PlaneError((await response.text()).trim());
			return response.json();
		},
		open(onLine, onDown, onUp) {
			return new Promise<Session>((settle, fail) => {
				const source = new EventSource("/events");
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
							const response = await fetch("/rpc", {
								method: "POST",
								headers: { "x-squad-session": session ?? "" },
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
