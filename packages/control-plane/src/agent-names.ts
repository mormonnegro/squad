import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StampedName {
	readonly id: string;
	readonly [stamp: string]: string;
}

/**
 * A list of agent names the plane wrote down, because the config file could not be.
 *
 * The config is the operator's and no plane may write it, which leaves the two things that happen
 * at runtime with nowhere to go: an agent made from the console, and an agent deleted from it. Both
 * are a name and a date, so both live in a file of this shape — `agents.json` for the ones made
 * here, `deleted.json` for the ones taken away. It records only the name: everything else about an
 * agent comes from the config or its defaults, so what these agents may reach stays a question only
 * the operator's file answers.
 */
export class AgentNameStore {
	readonly #path: string;
	readonly #stamp: string;

	constructor(path: string, stamp: string) {
		this.#path = path;
		this.#stamp = stamp;
	}

	async list(): Promise<readonly string[]> {
		return (await this.#read()).map((entry) => entry.id);
	}

	async add(agentId: string): Promise<void> {
		const names = await this.#read();
		if (names.some((entry) => entry.id === agentId)) return;
		await this.#write([...names, { id: agentId, [this.#stamp]: new Date().toISOString() }]);
	}

	async forget(agentId: string): Promise<void> {
		const names = await this.#read();
		const kept = names.filter((entry) => entry.id !== agentId);
		if (kept.length !== names.length) await this.#write(kept);
	}

	async #read(): Promise<readonly StampedName[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(entry: unknown): entry is StampedName =>
					typeof entry === "object" &&
					entry !== null &&
					typeof (entry as StampedName).id === "string",
			);
		} catch {
			return [];
		}
	}

	async #write(names: readonly StampedName[]): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the old file rather than
		// half of a new one: a truncated file here reads as "no agents" and loses them all.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(names, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}
}
