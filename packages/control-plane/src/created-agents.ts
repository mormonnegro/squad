import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface CreatedAgent {
	readonly id: string;
	readonly createdAt: string;
}

/**
 * The agents that were made while the plane was running, so they are still there when it restarts.
 *
 * The config file is the operator's and no plane may write it, which leaves nowhere for an agent
 * created from the CLI to be written down. Here is that place. It records only the name: everything
 * else about the agent comes from the config's defaults, so what these agents may reach stays a
 * question only the operator's file answers.
 */
export class CreatedAgentStore {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	async list(): Promise<readonly string[]> {
		return (await this.#read()).map((agent) => agent.id);
	}

	async add(agentId: string): Promise<void> {
		const agents = await this.#read();
		if (agents.some((agent) => agent.id === agentId)) return;
		await this.#write([...agents, { id: agentId, createdAt: new Date().toISOString() }]);
	}

	async forget(agentId: string): Promise<void> {
		const agents = await this.#read();
		const kept = agents.filter((agent) => agent.id !== agentId);
		if (kept.length !== agents.length) await this.#write(kept);
	}

	async #read(): Promise<readonly CreatedAgent[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(entry: unknown): entry is CreatedAgent =>
					typeof entry === "object" &&
					entry !== null &&
					typeof (entry as CreatedAgent).id === "string",
			);
		} catch {
			return [];
		}
	}

	async #write(agents: readonly CreatedAgent[]): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the old file rather than
		// half of a new one: a truncated file here reads as "no agents" and loses them all.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(agents, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}
}
