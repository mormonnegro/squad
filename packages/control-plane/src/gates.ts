import { readFile, rename, writeFile } from "node:fs/promises";

/**
 * A kind of outbound thing an agent must be asked about before it does it.
 *
 * The ones where the agent stops being something that reads and starts being something that other
 * people hear from — a mail goes out over the operator's address, a Telegram message arrives in
 * somebody's phone, and neither can be taken back by deciding afterwards that it should not have
 * gone. What an agent reaches on its way out is a different question, answered by the proxy with a
 * list of hosts; this is about what leaves in the operator's name.
 *
 * Deliberately short. A list of thirty things to tick is a list nobody reads, and every entry that
 * is not a message to a person is either already bounded by a grant or is not a door at all.
 */
export type Gate = "mail" | "telegram";

export const GATES: readonly Gate[] = ["mail", "telegram"];

export function isGate(said: string): said is Gate {
	return (GATES as readonly string[]).includes(said);
}

/** Which gate a reply's channel falls under, or none for the ones that are nobody's inbox. */
export function gateOf(channel: string): Gate | undefined {
	const prefix = channel.split(":")[0];
	if (prefix === "email") return "mail";
	if (prefix === "telegram") return "telegram";
	return undefined;
}

/** How it reads in a sentence about a held message. */
export function gateSaid(gate: Gate): string {
	return gate === "mail" ? "by mail" : "on Telegram";
}

/**
 * Which agents must be asked before something of theirs goes out, and about what.
 *
 * Beside the other things a console decides rather than in the operator's file, on the same terms as
 * every grant made here: the file is theirs, and a plane that wrote to it would be rewriting the one
 * document they read to find out what they had agreed to.
 */
export class Gates {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** What this agent is held on, in the order the list is written in rather than the file's. */
	async of(agentId: string): Promise<readonly Gate[]> {
		return await this.#serialize(async () => {
			const held = (await this.#read())[agentId] ?? [];
			return GATES.filter((gate) => held.includes(gate));
		});
	}

	async all(): Promise<Record<string, readonly Gate[]>> {
		return await this.#serialize(async () => await this.#read());
	}

	/** True when this changed something, so a console can tell a change from a thing already true. */
	async hold(agentId: string, gate: Gate): Promise<boolean> {
		return await this.#serialize(async () => {
			const all = await this.#read();
			const held = all[agentId] ?? [];
			if (held.includes(gate)) return false;
			await this.#write({ ...all, [agentId]: [...held, gate] });
			return true;
		});
	}

	async free(agentId: string, gate: Gate): Promise<boolean> {
		return await this.#serialize(async () => {
			const all = await this.#read();
			const held = all[agentId] ?? [];
			if (!held.includes(gate)) return false;
			await this.#write({ ...all, [agentId]: held.filter((one) => one !== gate) });
			return true;
		});
	}

	/** An agent that is gone takes its holds with it, for the reason its doors go: a name is reused. */
	async forget(agentId: string): Promise<void> {
		await this.#serialize(async () => {
			const { [agentId]: _gone, ...left } = await this.#read();
			await this.#write(left);
		});
	}

	async #read(): Promise<Record<string, Gate[]>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const all: Record<string, Gate[]> = {};
			for (const [agentId, held] of Object.entries(parsed as Record<string, unknown>)) {
				if (!Array.isArray(held)) continue;
				all[agentId] = held.filter((one): one is Gate => typeof one === "string" && isGate(one));
			}
			return all;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, readonly Gate[]>): Promise<void> {
		const kept = Object.fromEntries(Object.entries(all).filter(([, held]) => held.length > 0));
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
