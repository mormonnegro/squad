import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretRef, SecretStore } from "@squad/proxy";

/**
 * The provider keys typed at the console, over the ones the plane was started with.
 *
 * A key here is not a capability. Which hosts an agent may reach is the operator's file, and a model
 * became reachable by every agent the moment it was configured there — what was missing was the
 * credential to fill that grant with, and it lived in an `.env` beside the compose file. So the one
 * thing an operator does most often, giving this plane a provider it can pay for, was the one thing
 * that meant editing a file on the host and restarting. This is that half, kept where the plane can
 * write it.
 *
 * Layered over the environment rather than replacing it: a machine that exports its keys goes on
 * working exactly as it did, and what is typed here wins, because it is the more recent answer to
 * the same question.
 */
export class ProviderKeys implements SecretStore {
	readonly #path: string;
	readonly #beneath: SecretStore;
	/** Read once and kept, because the proxy asks this on every request and nothing else writes it. */
	#held: Promise<Map<string, string>> | undefined;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string, beneath: SecretStore) {
		this.#path = path;
		this.#beneath = beneath;
	}

	async resolve(ref: SecretRef): Promise<string | undefined> {
		const kept = (await this.#load()).get(ref.ref);
		// An empty string is not a key, and treating it as one would let a slip of the keyboard shadow
		// a working key in the environment with nothing at all.
		return kept !== undefined && kept.length > 0 ? kept : this.#beneath.resolve(ref);
	}

	/** Which names this file is the answer for, so a screen can say where a key came from. */
	async here(): Promise<ReadonlySet<string>> {
		return new Set((await this.#load()).keys());
	}

	async keep(name: string, value: string): Promise<void> {
		await this.#serialize(async () => {
			const held = await this.#load();
			if (value.length === 0) held.delete(name);
			else held.set(name, value);
			await this.#write(held);
		});
	}

	#load(): Promise<Map<string, string>> {
		this.#held ??= this.#read();
		return this.#held;
	}

	async #read(): Promise<Map<string, string>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
			return new Map(
				Object.entries(parsed as Record<string, unknown>).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			);
		} catch {
			return new Map();
		}
	}

	async #write(held: Map<string, string>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the old file rather than
		// half of a new one — which would read as a plane that had forgotten every key it was given.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		// Only the owner, and from the moment it exists: this is the one file in the state directory
		// holding secrets rather than names of secrets.
		await writeFile(temporary, `${JSON.stringify(Object.fromEntries(held), null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic and two keys can be pasted in the same breath.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
