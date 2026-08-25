import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The lowest port a console can bind without being root, which is where the operator's end is. */
export const LOWEST_PORT = 1024;
export const HIGHEST_PORT = 65_535;

export interface Served {
	/** The port inside the sandbox: the one the agent bound, and the only one it knows about. */
	readonly port: number;
	/**
	 * The port it is opened on where the operator is.
	 *
	 * The same number unless another agent already had it. Two agents both running a dev server land
	 * on 3000 without either of them having chosen it, and one machine has one 3000 — so the number
	 * gives way rather than the second agent being refused for something it did not do.
	 */
	readonly at: number;
}

/**
 * Which ports each agent has open, and where each of them is reached.
 *
 * A record rather than a live connection, because nothing here holds anything open: the plane knows
 * what should be reachable and the console is what makes it so, and either can restart without the
 * other. That is also why it is written down — a console opened tomorrow finds the same links
 * without anyone having to remember which port the agent picked.
 */
export class ServedPorts {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async of(agentId: string): Promise<readonly Served[]> {
		return (await this.#serialize(() => this.#read()))[agentId] ?? [];
	}

	async all(): Promise<Record<string, readonly Served[]>> {
		return this.#serialize(() => this.#read());
	}

	/**
	 * Opens a port, and answers with where it landed — which is the port itself when it is free.
	 *
	 * Asking twice is not an error and does not move it: the agent that restarts its server has no way
	 * of knowing whether the last turn already asked, and a second link for the same thing would be
	 * the console binding twice and failing the second time.
	 */
	async open(agentId: string, port: number): Promise<Served> {
		return this.#serialize(async () => {
			const all = await this.#read();
			const already = (all[agentId] ?? []).find((one) => one.port === port);
			if (already !== undefined) return already;

			const taken = new Set(Object.values(all).flatMap((served) => served.map((one) => one.at)));
			let at = port;
			while (taken.has(at) && at < HIGHEST_PORT) at += 1;
			const served: Served = { port, at };
			all[agentId] = [...(all[agentId] ?? []), served].sort((one, other) => one.port - other.port);
			await this.#write(all);
			return served;
		});
	}

	/** Answers whether there was one to close, so a `/serve stop` typed at nothing can say so. */
	async close(agentId: string, port: number): Promise<boolean> {
		return this.#serialize(async () => {
			const all = await this.#read();
			const kept = (all[agentId] ?? []).filter((one) => one.port !== port);
			if (kept.length === (all[agentId] ?? []).length) return false;
			if (kept.length > 0) all[agentId] = kept;
			else delete all[agentId];
			await this.#write(all);
			return true;
		});
	}

	async forget(agentId: string): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			if (!(agentId in all)) return;
			delete all[agentId];
			await this.#write(all);
		});
	}

	async #read(): Promise<Record<string, readonly Served[]>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			return parsed as Record<string, readonly Served[]>;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, readonly Served[]>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the old file rather than
		// half of a new one, which would read as an agent serving nothing.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(all, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic, and every agent on the plane shares this object — which is
	// exactly what decides where a second agent's 3000 lands.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}

/**
 * Where a served port is opened, as an address to put in front of a person.
 *
 * `<agent>.localhost` rather than `localhost` because every modern browser resolves it to loopback
 * with nothing configured anywhere, and it is the one part of the link that says whose server this
 * is. The number is what makes it unique; the name is what makes it legible.
 */
export function servedAt(agentId: string, served: Served): string {
	return `http://${agentId}.localhost:${served.at}`;
}

/** Why a port cannot be served, in the words to answer whoever asked for it. */
export function unservable(port: number): string | undefined {
	if (!Number.isInteger(port) || port <= 0 || port > HIGHEST_PORT) {
		return `"${port}" is not a port. A port is a number from ${LOWEST_PORT} to ${HIGHEST_PORT}.`;
	}
	// Refused at the plane rather than found out at the console, where the failure would be a bind
	// error on a machine nobody was looking at: the console's end of this is an ordinary listener, and
	// an ordinary listener under 1024 needs root.
	if (port < LOWEST_PORT) {
		return `Port ${port} is under ${LOWEST_PORT}, and the console opens it as an ordinary listener on your own machine, which needs root down there. Serve it from a higher port inside the sandbox.`;
	}
	return undefined;
}
