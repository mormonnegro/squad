import { readFile, rename, writeFile } from "node:fs/promises";
import type { Channel, Reply } from "@squad/channels";
import { AGENT_CHANNEL, type NewAgentEvent } from "@squad/events";

/**
 * One agent as another one is shown it: who it is, what it is for, and whether this one may write.
 *
 * The description is the operator's rather than the agent's own, because it is what an agent picks
 * between the others by, and a description an agent could write for itself is one it could write to
 * be picked.
 */
export interface Teammate {
	readonly id: string;
	readonly description?: string;
	readonly open: boolean;
}

/** The channel a message between two agents travels on, named for the one that sent it. */
export function agentChannel(agentId: string): string {
	return `${AGENT_CHANNEL}:${agentId}`;
}

/** Which agent is at the far end of one of those, or nothing when the channel is not one. */
export function agentIn(channel: string): string | undefined {
	if (!channel.startsWith(`${AGENT_CHANNEL}:`)) return undefined;
	const id = channel.slice(AGENT_CHANNEL.length + 1);
	return id.length > 0 ? id : undefined;
}

/**
 * How far a message may travel from the turn a person started.
 *
 * Every hop is a turn, and a turn is money: two agents that answer each other politely would
 * otherwise go on doing it all night, each one paying for the next, and the first anybody hears of
 * it is the bill. Nothing about the exchange is wrong — it is the same courtesy that makes a person
 * say thanks — which is why this is a count rather than a rule about content.
 *
 * Counted from what a person said, so an operator's next message starts the chain again. Four is a
 * hand-off, an answer, a follow-up and its answer: past that they are talking, and talking is what
 * the operator is for.
 */
export const MOST_HOPS = 4;

/** How many hops the message that woke this turn had already made. */
export function hopsIn(metadata: Readonly<Record<string, string>> | undefined): number {
	const said = Number(metadata?.hops ?? 0);
	return Number.isFinite(said) && said > 0 ? Math.floor(said) : 0;
}

/**
 * The message one agent leaves for another, as the plane finds it once the turn is over.
 *
 * Read tolerantly and dropped rather than repaired, on the wakeup's terms: the sanctioned way to
 * make one is a tool that cannot produce anything else, so what arrives malformed is an agent that
 * wrote the file by hand — which it can, having a shell — and the safe answer to a request nobody
 * can read is not to act on it.
 */
export interface Sent {
	readonly to: string;
	readonly note: string;
}

/** How many one turn may send. The tool caps this too; this is the cap that decides. */
export const MOST_SENT = 3;

/** The notes a turn wrote, dropping anything that is not one, and no more of them than agreed. */
export function parseSent(text: string): readonly Sent[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;

	const sent = parsed
		.flatMap((one): Sent[] => {
			if (typeof one !== "object" || one === null) return [];
			const { to, note } = one as Record<string, unknown>;
			if (typeof to !== "string" || typeof note !== "string") return [];
			const name = to.trim();
			const written = note.trim();
			return name.length > 0 && written.length > 0 ? [{ to: name, note: written }] : [];
		})
		.slice(0, MOST_SENT);
	return sent.length > 0 ? sent : undefined;
}

/**
 * The agents an operator named in what they typed, out of the ones there are.
 *
 * This is the whole of how a door opens for one turn, and why it is a mention rather than something
 * cleverer: the operator writing "ask @scout what the page says" has said who this turn may write
 * to, in the sentence that says why, and neither of them can be true without the other. Anything
 * fuzzier — a name that happens to appear in the work, a match on a description — would be the plane
 * guessing at consent.
 *
 * Only ever called with what an operator wrote. A mention inside a mail or a webhook body is a
 * stranger typing an `@`, and the reason the trust level exists at all.
 */
export function mentioned(text: string, ids: readonly string[]): readonly string[] {
	return ids.filter((id) => {
		// Bounded on both sides so that `@scout` does not open `@scouting`, and so an address in a
		// pasted line — `hi@scout.example` — is not read as naming anybody.
		const at = new RegExp(`(^|[^\\w@.-])@${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`);
		return at.test(text);
	});
}

/**
 * Which agents an operator has let write to which, on top of whatever their config file says.
 *
 * Kept beside the hosts opened at the console rather than written back into the file, for the reason
 * every other console-made grant is: the file is the operator's, and a plane that edited it would be
 * a plane rewriting the one document they read to find out what they had agreed to.
 */
export class TeamEdges {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** Who this agent may write to, out of the doors opened here. */
	async open(from: string): Promise<readonly string[]> {
		return await this.#serialize(async () => (await this.#read())[from] ?? []);
	}

	async add(from: string, to: string): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			const already = all[from] ?? [];
			if (already.includes(to)) return;
			await this.#write({ ...all, [from]: [...already, to] });
		});
	}

	/** True when there was one to close, so a console can tell a typo from a door already shut. */
	async drop(from: string, to: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const all = await this.#read();
			const left = (all[from] ?? []).filter((one) => one !== to);
			if (left.length === (all[from] ?? []).length) return false;
			await this.#write({ ...all, [from]: left });
			return true;
		});
	}

	/**
	 * Forgets an agent that is gone, from both ends.
	 *
	 * Both ends because a name is reused: an agent deleted and made again is a different agent with
	 * the same name, and doors left standing would be doors nobody in this plane ever opened for it.
	 */
	async forget(agentId: string): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			const left: Record<string, string[]> = {};
			for (const [from, to] of Object.entries(all)) {
				if (from === agentId) continue;
				left[from] = to.filter((one) => one !== agentId);
			}
			await this.#write(left);
		});
	}

	async #read(): Promise<Record<string, string[]>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const all: Record<string, string[]> = {};
			for (const [from, to] of Object.entries(parsed as Record<string, unknown>)) {
				if (!Array.isArray(to)) continue;
				all[from] = to.filter((one): one is string => typeof one === "string");
			}
			return all;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, string[]>): Promise<void> {
		const kept = Object.fromEntries(Object.entries(all).filter(([, to]) => to.length > 0));
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(kept, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, this.#path);
	}

	async #serialize<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(work, work);
		this.#tail = next.then(
			() => undefined,
			() => undefined,
		);
		return await next;
	}
}

export interface AgentChannelOptions {
	/** Puts the message in front of the other agent, which is the whole of what sending one is. */
	readonly publish: (event: NewAgentEvent) => Promise<unknown>;
	/** Which agents this plane has, so a reply to one that is gone fails where it can be reported. */
	readonly has: (agentId: string) => boolean;
	/** How far the turn being answered had already travelled, so the answer travels one further. */
	readonly hops: (agentId: string) => number;
}

/**
 * Carries an agent's answer back to the agent that wrote to it.
 *
 * A channel like the others, and registered beside them, because from the turn's side answering a
 * peer is answering whoever spoke: the reply goes back down whatever brought the message, and a
 * conversation between two agents is one more thing that can bring one.
 *
 * Nothing is checked here about whether the two are allowed to talk, and that is deliberate. This
 * channel only exists inside a turn that was woken by the other agent, which is to say inside a
 * conversation the operator already allowed to start; refusing the answer would be refusing the
 * half of it that was asked for. What bounds it is the hop count, which is about money rather than
 * about permission.
 */
export class AgentChannel implements Channel {
	readonly name = AGENT_CHANNEL;
	readonly #options: AgentChannelOptions;

	constructor(options: AgentChannelOptions) {
		this.#options = options;
	}

	async send(reply: Reply): Promise<void> {
		const to = agentIn(reply.channel);
		if (to === undefined) throw new Error(`"${reply.channel}" names no agent`);
		if (!this.#options.has(to)) throw new Error(`No agent "${to}" in this plane any more`);

		const hops = this.#options.hops(reply.agentId) + 1;
		if (hops > MOST_HOPS) {
			throw new Error(
				`this answer would be hop ${hops} of a conversation with ${to}, and ${MOST_HOPS} is the most without somebody asking for it. Nothing was sent, and neither agent is woken again`,
			);
		}

		await this.#options.publish({
			agentId: to,
			source: "channel",
			channel: agentChannel(reply.agentId),
			// Never operator, whatever the agent that sent it holds. An agent talked into something by
			// what it read would otherwise launder that into an instruction for every agent it can
			// reach, and one compromised agent would be the whole plane.
			trust: "participant",
			actor: { id: reply.agentId },
			body: reply.body,
			metadata: { hops: String(hops) },
		});
	}
}
