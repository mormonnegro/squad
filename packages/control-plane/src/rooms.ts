import { readFile, rename, writeFile } from "node:fs/promises";
import type { Channel, Reply } from "@squad/channels";
import { type NewAgentEvent, ROOM_CHANNEL } from "@squad/events";
import { MOST_HOPS, mentioned } from "./team.ts";

/**
 * A place where several agents work on the same thing, and the operator watches them do it.
 *
 * The unit above an agent. One agent is a conversation and one errand; a room is a brief given to
 * three of them at once, with the answers in one thread where they can be compared — which is the
 * thing an operator with a handful of agents actually does, and which they were doing until now by
 * typing the same paragraph into three panes and holding the three answers in their head.
 *
 * Members, and nothing else. No owner, no roles, no order of speaking: what a room is for is that
 * everybody in it heard the same thing, and every rule beyond that one is a guess at work nobody
 * has done yet.
 */
export interface Room {
	readonly name: string;
	readonly members: readonly string[];
}

/** The channel a room's messages travel on, named for the room. */
export function roomChannel(name: string): string {
	return `${ROOM_CHANNEL}:${name}`;
}

/** Which room one of those names, or nothing when the channel is not a room's. */
export function roomIn(channel: string): string | undefined {
	if (!channel.startsWith(`${ROOM_CHANNEL}:`)) return undefined;
	const name = channel.slice(ROOM_CHANNEL.length + 1);
	return name.length > 0 ? name : undefined;
}

/** Named like an agent, for the reason an agent is: it is typed, said out loud, and put in a URL. */
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function nameRefused(name: string): string | undefined {
	if (name.length === 0) return "A room needs a name.";
	if (!NAME.test(name)) {
		return `"${name}" will not do as a room name: lowercase letters, digits and dashes, starting with a letter or a digit.`;
	}
	return undefined;
}

/**
 * The rooms this plane has, kept beside the other things opened at a console.
 *
 * Not in the configuration file, for the reason none of the console's grants are: the file is the
 * operator's, and a plane that wrote to it would be rewriting the one document they read to find
 * out what they had agreed to. A room made here is the plane's to forget again.
 */
export class Rooms {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async all(): Promise<readonly Room[]> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			return Object.entries(held)
				.map(([name, members]) => ({ name, members }))
				.sort((one, other) => one.name.localeCompare(other.name));
		});
	}

	async of(name: string): Promise<Room | undefined> {
		return await this.#serialize(async () => {
			const members = (await this.#read())[name];
			return members === undefined ? undefined : { name, members };
		});
	}

	/** Everybody in a room with this agent, out of every room it is in. Never the agent itself. */
	async mates(agentId: string): Promise<readonly string[]> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			const mates = new Set<string>();
			for (const members of Object.values(held)) {
				if (!members.includes(agentId)) continue;
				for (const one of members) if (one !== agentId) mates.add(one);
			}
			return [...mates];
		});
	}

	async make(name: string, members: readonly string[]): Promise<Room> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			if (held[name] !== undefined) throw new Error(`There is already a room called #${name}.`);
			const kept = [...new Set(members)];
			await this.#write({ ...held, [name]: kept });
			return { name, members: kept };
		});
	}

	/** True when it was not already in, so a console can tell a change from a thing already true. */
	async join(name: string, agentId: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			const members = held[name];
			if (members === undefined) throw new Error(`There is no room called #${name}.`);
			if (members.includes(agentId)) return false;
			await this.#write({ ...held, [name]: [...members, agentId] });
			return true;
		});
	}

	async leave(name: string, agentId: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			const members = held[name];
			if (members === undefined) throw new Error(`There is no room called #${name}.`);
			const left = members.filter((one) => one !== agentId);
			if (left.length === members.length) return false;
			await this.#write({ ...held, [name]: left });
			return true;
		});
	}

	async drop(name: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			if (held[name] === undefined) return false;
			const { [name]: _gone, ...left } = held;
			await this.#write(left);
			return true;
		});
	}

	/**
	 * Takes an agent that is gone out of every room it was in.
	 *
	 * The room stays, empty if it has to. A name is reused — an agent deleted and made again is a
	 * different agent with the same name — and a room that quietly re-admitted it would be putting
	 * a stranger in front of work nobody showed it.
	 */
	async forget(agentId: string): Promise<void> {
		await this.#serialize(async () => {
			const held = await this.#read();
			const left: Record<string, string[]> = {};
			for (const [name, members] of Object.entries(held)) {
				left[name] = members.filter((one) => one !== agentId);
			}
			await this.#write(left);
		});
	}

	async #read(): Promise<Record<string, string[]>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const held: Record<string, string[]> = {};
			for (const [name, members] of Object.entries(parsed as Record<string, unknown>)) {
				if (!Array.isArray(members)) continue;
				held[name] = members.filter((one): one is string => typeof one === "string");
			}
			return held;
		} catch {
			return {};
		}
	}

	async #write(held: Record<string, string[]>): Promise<void> {
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(held, null, "\t")}\n`, {
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

export interface RoomChannelOptions {
	/** Who is in the room, so an answer reaches the people who heard the question. */
	readonly members: (name: string) => Promise<readonly string[]>;
	/** Puts the answer in the room's thread, where the operator reads it. */
	readonly post: (name: string, from: string, body: string) => Promise<unknown>;
	/** Wakes one member with what was said. */
	readonly publish: (event: NewAgentEvent) => Promise<unknown>;
	/** How far the turn being answered had already travelled, so the answer travels one further. */
	readonly hops: (agentId: string) => number;
}

/**
 * Carries an agent's answer into the room it was spoken to in.
 *
 * Two things happen to it, and they are not the same thing. It is posted — the operator asked three
 * agents at once precisely so the three answers land in one thread, and an answer nobody can read is
 * not an answer. And it wakes the members it named, and only those: in a room of three, an answer
 * that woke everybody would cost two more turns for every one taken, and by the fourth exchange the
 * room would be an argument nobody is reading and a bill nobody agreed to.
 *
 * Naming somebody is the whole of the door, and it is the same door an operator opens by typing
 * `@scout`: the agent that writes "@dev, the migration is yours" has said who this concerns, in the
 * sentence that says why. The hop count stops the rest — a chain started by one person's message is
 * four turns long, whoever is in the room.
 */
export class RoomChannel implements Channel {
	readonly name = ROOM_CHANNEL;
	readonly #options: RoomChannelOptions;

	constructor(options: RoomChannelOptions) {
		this.#options = options;
	}

	async send(reply: Reply): Promise<void> {
		const room = roomIn(reply.channel);
		if (room === undefined) throw new Error(`"${reply.channel}" names no room`);
		const members = await this.#options.members(room);
		if (!members.includes(reply.agentId)) {
			throw new Error(`${reply.agentId} is not in #${room} any more`);
		}

		// Posted whatever else happens: the thread is the point of the room, and an answer that named
		// nobody is still the answer to what the operator asked.
		await this.#options.post(room, reply.agentId, reply.body);

		const named = mentioned(
			reply.body,
			members.filter((one) => one !== reply.agentId),
		);
		if (named.length === 0) return;

		const hops = this.#options.hops(reply.agentId) + 1;
		if (hops > MOST_HOPS) {
			throw new Error(
				`this would be hop ${hops} of a conversation that started ${MOST_HOPS} turns ago, and past that the room is talking rather than working. It is posted in #${room}, where everybody can read it, and nobody was woken`,
			);
		}

		for (const to of named) {
			await this.#options.publish({
				agentId: to,
				source: "channel",
				channel: roomChannel(room),
				// Never operator, whatever the agent that said it holds. One agent talked into something
				// by what it read would otherwise be instructing the whole room in the plane's own voice.
				trust: "participant",
				actor: { id: reply.agentId },
				body: reply.body,
				metadata: {
					hops: String(hops),
					with: members.filter((one) => one !== to).join(", "),
				},
			});
		}
	}
}
