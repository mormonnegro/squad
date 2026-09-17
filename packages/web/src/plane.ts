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

/**
 * A room, and who is in it.
 *
 * Written out here like everything else on this wire. A room's conversation is not part of it: it
 * arrives with the others, under the address its lines come in on, because to a console it is one
 * more thing being said somewhere.
 */
export interface Room {
	readonly name: string;
	readonly members: readonly string[];
}

/** Where a room's conversation is kept, and the channel its lines arrive on. */
export function roomChannel(name: string): string {
	return `room:${name}`;
}

/**
 * One thing an agent has written down that it knows how to do.
 *
 * Written out here like everything else on this wire. It lives in the agent's own repository and is
 * read out of it every time: what a console shows is what is in the box, not what it was told once.
 */
export interface Skill {
	readonly name: string;
	readonly does: string;
	readonly lines: number;
}

/**
 * One name in one of an agent's folders.
 *
 * Written out here like everything else on this wire. A listing is read once and drawn; nothing on
 * this side keeps one, because the box is the answer and it changes while you are looking at it.
 */
export interface FileEntry {
	readonly name: string;
	readonly kind: "dir" | "file";
	/** A symlink, drawn as whatever it points at and worth saying is one. */
	readonly link?: boolean;
	readonly size: number;
	readonly changedAt: string;
}

/**
 * What is at a path: the names in it, or the fact that it is a file.
 *
 * One answer for both because an address is not a promise about what is at the end of it. A link to
 * a folder that has since become a file is a link somebody will click, and a screen that had to
 * guess first would be a screen that guesses wrong in front of them.
 */
export type Listing =
	| {
			readonly at: string;
			readonly kind: "dir";
			readonly entries: readonly FileEntry[];
			/** How many are in there, which is more than arrived when the listing was cut short. */
			readonly total: number;
	  }
	| {
			readonly at: string;
			readonly kind: "file";
			readonly size: number;
			readonly changedAt: string;
	  };

/** As much of a file as one answer carries, from a byte offset, as base64. */
export interface Slice {
	readonly at: string;
	readonly from: number;
	readonly size: number;
	readonly changedAt: string;
	readonly data: string;
	readonly more: boolean;
}

/**
 * What the server behind a served port is printing, and as much of it as one answer carries.
 *
 * Four states, and the screen says a different sentence for each: nothing is listening on that port;
 * something is, and its output goes somewhere nobody can read behind its back; something is, and it
 * is writing to a file; nothing is any more, but the file it was writing to is still there — which
 * is where a server stands a second after it crashed, and the reason anybody opened this.
 */
export interface Printed {
	readonly port: number;
	readonly listening: boolean;
	readonly pid?: number;
	/** What it was started as, so a screen can say whose output it is showing. */
	readonly cmd?: string;
	/** Where the output goes: a path when that is a file, and what it is instead when it is not. */
	readonly to?: string;
	/** The file being read, absent when there is none to read. */
	readonly at?: string;
	readonly from: number;
	readonly size: number;
	readonly data: string;
	/** The file is shorter than where the reader left off, so the server was started again. */
	readonly restarted: boolean;
}

/**
 * Something outside this plane that gives an agent a turn.
 *
 * The secret is only ever on the one that comes back from making it. Everything read afterwards has
 * it left out, because a list is read over a shoulder and there is nothing to do with it twice.
 */
export interface Trigger {
	readonly name: string;
	readonly agentId: string;
	readonly from: string;
	readonly secret?: string;
	readonly only: readonly string[];
	/** What the operator says arrives here, and what they want done about it. */
	readonly says?: string;
	readonly madeAt: string;
	readonly firedAt?: string;
	readonly fired: number;
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

/**
 * A repository this plane holds, and who holds it with what.
 *
 * Written out here rather than imported, like everything else on this wire: what matters is that
 * the two ends agree on the fields that are read.
 */
export interface RepoRow {
	readonly repo: string;
	readonly url: string;
	readonly by: readonly {
		readonly agentId: string;
		/** The branches that agent may push. Empty is read-only. */
		readonly push: readonly string[];
		/** `file` is the operator's configuration, and not this console's to change. */
		readonly origin: "file" | "here";
	}[];
}

/** One repository the plane's token can see, as something to pick from a list. */
export interface RepoOffer {
	readonly repo: string;
	readonly push: boolean;
	readonly private: boolean;
	readonly pushedAt?: string;
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

/** One model a tool could use, and whether this plane holds the key that pays for it. */
export interface ToolOffer {
	readonly provider: string;
	readonly model: string;
	readonly keyEnv: string;
	readonly held: boolean;
	readonly rate: { readonly input: number; readonly output: number };
	readonly using: boolean;
}

/** What is doing a job now, and everything that could. Undefined for a tool nobody turned on. */
export interface ToolStanding {
	readonly using:
		| {
				readonly provider: string;
				readonly model: string;
				readonly keyEnv: string;
				readonly held: boolean;
		  }
		| undefined;
	readonly offers: readonly ToolOffer[];
}

/** The password manager the agents' browsers sign in from, as a screen may know it: never the value. */
export interface VaultStanding {
	readonly held: boolean;
	/** Connected here rather than exported into the plane's own environment on the host. */
	readonly here: boolean;
}

export interface Tools {
	readonly search: ToolStanding;
	readonly vision: ToolStanding;
	readonly pointing: ToolStanding;
	readonly vault: VaultStanding;
}

const EMPTY_TOOLS: Tools = {
	search: { using: undefined, offers: [] },
	vision: { using: undefined, offers: [] },
	pointing: { using: undefined, offers: [] },
	vault: { held: false, here: false },
};

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

	/**
	 * Books one more turn for an agent: when, and what to tell it when the moment comes.
	 *
	 * `when` goes to the plane as it was typed. The plane reads a time of day, an interval, a wait or
	 * five cron fields — one reader, so that `08:00` cannot come to mean two things depending on which
	 * console was open. The time zone is this browser's, because eight in the morning is the reader's
	 * and the plane's own is a container's, which is nobody's.
	 */
	async schedule(agentId: string, when: string, body: string): Promise<void> {
		await this.#ask({
			op: "schedule",
			agentId,
			when,
			body,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	}

	/** Stops one of an agent's own wakeups. The plane refuses the ones its configuration declares. */
	async unschedule(agentId: string, scheduleId: string): Promise<void> {
		await this.#ask({ op: "unschedule", agentId, scheduleId });
	}

	async rooms(): Promise<readonly Room[]> {
		const answer = await this.#ask({ op: "rooms" });
		return (answer.rooms as Room[] | undefined) ?? [];
	}

	async makeRoom(name: string, members: readonly string[]): Promise<readonly Room[]> {
		const answer = await this.#ask({ op: "makeRoom", name, members });
		return (answer.rooms as Room[] | undefined) ?? [];
	}

	async joinRoom(name: string, agentId: string): Promise<readonly Room[]> {
		const answer = await this.#ask({ op: "joinRoom", name, agentId });
		return (answer.rooms as Room[] | undefined) ?? [];
	}

	async leaveRoom(name: string, agentId: string): Promise<readonly Room[]> {
		const answer = await this.#ask({ op: "leaveRoom", name, agentId });
		return (answer.rooms as Room[] | undefined) ?? [];
	}

	async dropRoom(name: string): Promise<readonly Room[]> {
		const answer = await this.#ask({ op: "dropRoom", name });
		return (answer.rooms as Room[] | undefined) ?? [];
	}

	/** Says something to everybody in a room. Each of them takes a turn on it. */
	async sayInRoom(name: string, text: string): Promise<void> {
		await this.#ask({ op: "sayInRoom", name, text });
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

	/**
	 * What is in one of an agent's folders, or that the path is a file.
	 *
	 * The same reach the shell already had and a different shape: `!ls` is a screenful to read and
	 * type against, and this is rows to point at. Asked again every time it is drawn — a box changes
	 * while somebody is looking at it, and a listing kept on this side would be a picture of a
	 * minute ago.
	 */
	async files(agentId: string, at: string): Promise<Listing> {
		const answer = await this.#ask({ op: "files", agentId, at });
		return answer.listing as Listing;
	}

	/** As much of one of its files as an answer carries, from a byte offset. base64, always. */
	async readFile(agentId: string, at: string, from = 0): Promise<Slice> {
		const answer = await this.#ask({ op: "read-file", agentId, at, from });
		return answer.slice as Slice;
	}

	/**
	 * What is printing on one of its served ports, from a byte offset. `-1` is the end of it.
	 *
	 * The end by default because a log is read backwards: whoever opens one is looking for the last
	 * thing that happened, and the first thing a dev server writes is a banner nobody came for.
	 */
	async printing(agentId: string, port: number, from = -1): Promise<Printed> {
		const answer = await this.#ask({ op: "printing", agentId, port, from });
		return answer.printed as Printed;
	}

	/**
	 * Puts a chunk of a file into the box, at an offset. The last of them says so and lands it.
	 *
	 * Chunked because a line of this protocol is not the place for a video, and because an upload
	 * with no progress on it is an upload people cancel. Nothing appears under the name until the
	 * last chunk, so a drop that fails halfway leaves nothing for the agent to read as a document.
	 */
	async putFile(
		agentId: string,
		at: string,
		data: string,
		from: number,
		last: boolean,
	): Promise<{ size: number; done: boolean }> {
		const answer = await this.#ask({ op: "put-file", agentId, at, data, from, last });
		const wrote = answer.wrote as { size?: number; done?: boolean } | undefined;
		return { size: wrote?.size ?? 0, done: wrote?.done ?? last };
	}

	/**
	 * Gives one of its files another name, which is also how one is moved: `to` is a path in the
	 * same box.
	 *
	 * Nothing is written over. A name that is already taken comes back as a refusal in those words,
	 * because the reason anybody renames a file is that they are looking at the folder it is in.
	 */
	async moveFile(agentId: string, at: string, to: string): Promise<string> {
		const answer = await this.#ask({ op: "move-file", agentId, at, to });
		return (answer.moved as { at?: string } | undefined)?.at ?? to;
	}

	/** Deletes one of its files, or a folder and everything under it. It does not come back. */
	async removeFile(agentId: string, at: string): Promise<void> {
		await this.#ask({ op: "remove-file", agentId, at });
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

	/** What outside this plane gives an agent a turn. */
	async triggers(): Promise<readonly Trigger[]> {
		const answer = await this.#ask({ op: "triggers" });
		return (answer.triggers as Trigger[] | undefined) ?? [];
	}

	/** Makes one. The secret comes back with it, this once, and is never readable again. */
	async addTrigger(
		agentId: string,
		name: string,
		from: string,
		only: readonly string[],
		says?: string,
	): Promise<Trigger | undefined> {
		const answer = await this.#ask({
			op: "add-trigger",
			agentId,
			name,
			from,
			only,
			...(says === undefined || says.trim() === "" ? {} : { says }),
		});
		return (answer.triggers as Trigger[] | undefined)?.[0];
	}

	/** Says what arrives at one, in the operator's words. It reaches the turn as their instruction. */
	async describeTrigger(name: string, says: string): Promise<void> {
		await this.#ask({ op: "describe-trigger", name, says });
	}

	async dropTrigger(name: string): Promise<void> {
		await this.#ask({ op: "drop-trigger", name });
	}

	/** What this agent has written down that it knows how to do. */
	async skills(agentId: string): Promise<readonly Skill[]> {
		const answer = await this.#ask({ op: "skills", agentId });
		return (answer.skills as Skill[] | undefined) ?? [];
	}

	/** Asks it to write what it has just been doing down as a skill. It answers by taking a turn. */
	async keepSkill(agentId: string, name: string, about?: string): Promise<void> {
		await this.#ask({ op: "keep-skill", agentId, name, ...(about === undefined ? {} : { about }) });
	}

	/** Copies one of its skills into another agent. */
	async giveSkill(agentId: string, name: string, to: string): Promise<void> {
		await this.#ask({ op: "give-skill", agentId, name, to });
	}

	/** Lets out one of the answers an agent has written and is not allowed to send unasked. */
	async answerSend(agentId: string, at: number, send: boolean): Promise<void> {
		await this.#ask({ op: "send", agentId, at, send });
	}

	/** Holds what this agent would send on one channel until somebody says so, or lets it go again. */
	async setGate(agentId: string, gate: string, hold: boolean): Promise<void> {
		await this.#ask({ op: "gate", agentId, gate, hold });
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

	/**
	 * Where a port an agent opened is read, which is a name of that port's own.
	 *
	 * Asked of the door rather than built here, and it is the door's to answer: the name comes from
	 * the address the door is reached at, and in development that is not the address this page is
	 * read at. Answers nothing when the console is being read at an address that can have no names
	 * under it — a machine's own address on a network — and then the path is what to keep, because
	 * the path lands on the page that says so.
	 */
	async servedAt(agentId: string, port: number): Promise<string | undefined> {
		const answer = (await this.#door(
			`/at/where?agent=${encodeURIComponent(agentId)}&port=${port}`,
		)) as { url?: string | null };
		return answer.url ?? undefined;
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

	/**
	 * Both tools that have a model behind them, and every model either of them could use.
	 *
	 * One question rather than two, because one screen draws both: searching and looking are the same
	 * kind of thing — a job done somewhere else by a model the operator picks, paid for with a key no
	 * agent ever sees — and asking twice would draw half the screen a moment early.
	 */
	async tools(): Promise<Tools> {
		const answer = await this.#ask({ op: "tools" });
		// Filled in over the empty one rather than taken whole, for the reason the agents list is: a
		// plane older than this bundle answers without the parts it has never heard of, and a screen
		// that read one of them straight off would not draw a row short — it would throw on the field
		// it wanted and take the whole page with it. Which is exactly what a dev server does every
		// time, since the page is newer than the plane it is pointed at by definition.
		return { ...EMPTY_TOOLS, ...((answer.tools as Partial<Tools> | undefined) ?? {}) };
	}

	/** Points the searching at a provider, or at another of that provider's models. */
	async chooseSearch(spec: { provider: string; model?: string }): Promise<void> {
		await this.#ask({ op: "set-search", spec });
	}

	/** Points the looking at a model, or `null` to leave it to whatever each agent thinks with. */
	async chooseVision(spec: { provider: string; model?: string } | null): Promise<void> {
		await this.#ask({ op: "set-vision", spec });
	}

	/** Points the pointing at a model, or `null` to go back to reading a page for its numbers. */
	async choosePointing(spec: { provider: string; model?: string } | null): Promise<void> {
		await this.#ask({ op: "set-pointing", spec });
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
	async loginPlugin(
		name: string,
		clientId?: string,
		clientSecret?: string,
	): Promise<{ url: string; redirectUri: string }> {
		const answer = await this.#ask({
			op: "login-plugin",
			name,
			...(clientId === undefined || clientId === "" ? {} : { clientId }),
			...(clientSecret === undefined || clientSecret === "" ? {} : { clientSecret }),
		});
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

	/** Every repository held here, who holds it with what, and whether there is a token at all. */
	async repos(): Promise<{ token: boolean; repos: readonly RepoRow[] }> {
		const answer = await this.#ask({ op: "repos" });
		const said = answer.repos as { token?: boolean; repos?: RepoRow[] } | undefined;
		return { token: said?.token ?? false, repos: said?.repos ?? [] };
	}

	/**
	 * What this plane's token can see on GitHub.
	 *
	 * Asked of GitHub every time. A token is given repositories and taken off them elsewhere, and a
	 * list kept on this side would be a list that is quietly wrong about what can be handed over.
	 */
	async githubRepos(): Promise<readonly RepoOffer[]> {
		const answer = await this.#ask({ op: "github-repos" });
		return (answer.offers as RepoOffer[] | undefined) ?? [];
	}

	/** The token every repository here is reached with. Nothing comes back but the name of it. */
	async setGithubToken(token: string): Promise<void> {
		await this.#ask({ op: "github-token", token });
	}

	/**
	 * Gives one agent a repository with a scope on it.
	 *
	 * `push` is the branches it may push: `[]` is a repository it may only read, and leaving it out
	 * is the agent's own lane. What comes back is a sentence worth showing or an empty one — GitHub
	 * saying the token can see it and not write to it is the case that has to be said out loud.
	 */
	async holdRepo(agentId: string, repo: string, push?: readonly string[]): Promise<string> {
		const answer = await this.#ask({
			op: "hold-repo",
			agentId,
			repo,
			...(push === undefined ? {} : { push }),
		});
		return (answer.text as string | undefined) ?? "";
	}

	async dropRepo(agentId: string, repo: string): Promise<void> {
		await this.#ask({ op: "drop-repo", agentId, repo });
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
