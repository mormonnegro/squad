import type { SecretRef } from "./grants.ts";

/**
 * Resolves secret references to values. Implementations live in the broker process only;
 * a value returned here must never be written to a transcript, log or the agent's disk.
 */
export interface SecretStore {
	resolve(ref: SecretRef): Promise<string | undefined>;
}

export class MemorySecretStore implements SecretStore {
	private readonly values: Map<string, string>;

	constructor(values: Readonly<Record<string, string>> = {}) {
		this.values = new Map(Object.entries(values));
	}

	set(ref: string, value: string): void {
		this.values.set(ref, value);
	}

	delete(ref: string): void {
		this.values.delete(ref);
	}

	async resolve(ref: SecretRef): Promise<string | undefined> {
		return this.values.get(ref.ref);
	}
}

/** Reads secrets from the broker process environment, e.g. { ref: "GITHUB_TOKEN" }. */
export class EnvSecretStore implements SecretStore {
	private readonly env: Readonly<Record<string, string | undefined>>;

	constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
		this.env = env;
	}

	async resolve(ref: SecretRef): Promise<string | undefined> {
		return this.env[ref.ref];
	}
}

export class MissingSecretError extends Error {
	readonly ref: string;

	constructor(ref: string) {
		super(`No value for secret ref "${ref}"`);
		this.name = "MissingSecretError";
		this.ref = ref;
	}
}

export async function requireSecret(store: SecretStore, ref: SecretRef): Promise<string> {
	const value = await store.resolve(ref);
	if (value === undefined) throw new MissingSecretError(ref.ref);
	return value;
}
