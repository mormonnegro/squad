import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentEvent, isOwnNote } from "@agent-dive/events";

/**
 * One line of the conversation an agent is part of.
 *
 * `from` is who is speaking and not merely how it arrived, because the two come apart: a webhook
 * body and an operator's message are both text addressed to the agent, and only one of them may be
 * obeyed. The transcript keeps the words undecorated — what a terminal makes of them is the
 * console's business, and the plane also answers to callers that have no terminal.
 */
export interface Utterance {
	/**
	 * `shell` is the sandbox itself, printing what `!` asked it to run. Kept apart from `plane`
	 * because that one means the plane explaining a failure and is drawn as one — thirty lines of
	 * build log in the colour reserved for errors reads as thirty things having gone wrong.
	 */
	readonly from: "operator" | "agent" | "other" | "plane" | "shell";
	readonly text: string;
	/**
	 * Whether the plane is reporting a thing that went wrong or a thing that worked, when it is
	 * reporting either. Most of what the plane says is neither — a listing, an account, what a
	 * command did — and that is the absent case and by far the commonest one.
	 *
	 * Meaning rather than decoration, which is why it is kept here: only the plane knows whether the
	 * sentence it just wrote is bad news, and a console left to guess from the words would guess.
	 */
	readonly tone?: "bad" | "good";
	/** How it reached the agent, when that is not the operator typing: a channel, or its own wakeup. */
	readonly via?: string;
	/** Written by the transcript, so a caller only has to have the words. */
	readonly at?: string;
}

/**
 * Who an inbound event is, said in the terms the transcript keeps.
 *
 * Operator trust is minted in exactly one place — the socket that has to be held before it can be
 * reached — so it is the only label that means a person typed this, whatever carried it. Everything
 * else is somebody or something else talking, and is kept apart rather than flattened into "the
 * user": a conversation that showed a webhook the way it shows its operator is one where reading
 * back through it cannot tell you who asked for what.
 */
export function overheard(event: AgentEvent): Utterance {
	if (isOwnNote(event)) return { from: "agent", via: "wake", text: event.body };
	if (event.trust === "operator") {
		return event.source === "channel"
			? { from: "operator", text: event.body }
			: { from: "operator", via: event.source, text: event.body };
	}
	return { from: "other", via: event.channel, text: event.body };
}

/**
 * How much of a conversation is kept. Enough to reopen the console and find the thread again,
 * bounded because this is read whole every time a console opens.
 */
const KEPT = 200;

/**
 * What was said to and by each agent, on disk, so that closing the console is not the same as
 * ending the conversation.
 *
 * A file per agent, replaced atomically and trimmed on the way in. The trimming is why this is a
 * JSON array rather than an appended line: the window is the record, and a file that only ever grew
 * would be one more thing to remember to clean up on a machine nobody is administering.
 */
export class Transcript {
	readonly #dir: string;
	readonly #keep: number;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(dir: string, options: { readonly keep?: number } = {}) {
		this.#dir = dir;
		this.#keep = options.keep ?? KEPT;
	}

	async append(agentId: string, said: Utterance): Promise<void> {
		const entry: Utterance = { at: new Date().toISOString(), ...said };
		await this.#serialize(async () => {
			const kept = [...(await this.#read(agentId)), entry].slice(-this.#keep);
			await mkdir(this.#dir, { recursive: true });
			const path = this.#path(agentId);
			const temporary = `${path}.${process.pid}.tmp`;
			await writeFile(temporary, JSON.stringify(kept), "utf8");
			await rename(temporary, path);
		});
	}

	async read(agentId: string): Promise<readonly Utterance[]> {
		return this.#serialize(() => this.#read(agentId));
	}

	/**
	 * Throws the conversation away, leaving the agent it belonged to alone.
	 *
	 * Called for a name being forgotten and for an agent only starting over. The first is why a file
	 * is never left behind: a name can be given out again, and the agent made under it would open its
	 * first console holding somebody else's memory.
	 */
	async forget(agentId: string): Promise<void> {
		await this.#serialize(() => rm(this.#path(agentId), { force: true }));
	}

	/** Encoded rather than trusted: a name with a slash in it would otherwise name another directory. */
	#path(agentId: string): string {
		return join(this.#dir, `${encodeURIComponent(agentId)}.json`);
	}

	async #read(agentId: string): Promise<Utterance[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path(agentId), "utf8"));
			return Array.isArray(parsed) ? (parsed as Utterance[]) : [];
		} catch {
			return [];
		}
	}

	// Read-modify-write is not atomic, and two agents answering at once share this object.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
