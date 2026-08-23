import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The credential a sandbox presents to the egress proxy, kept across restarts.
 *
 * It is baked into the sandbox's environment when the container is created, and the container is
 * not recreated while it exists — so a plane that minted a new token on every start came back
 * unable to recognise the agents it had left running. Every request they made was denied at the
 * proxy, the model included, and the only cure was destroying the sandbox that holds the agent.
 *
 * It lives beside the CA's private key, which is by far the more sensitive of the two, so the
 * state directory's permissions are already the ones this needs.
 */
export class ProxyTokenStore {
	readonly #path: string;
	#tokens: Record<string, string> | undefined;

	constructor(path: string) {
		this.#path = path;
	}

	/** The agent's token, minted and written down the first time it is asked for. */
	async ensure(agentId: string): Promise<string> {
		const tokens = await this.#load();
		const existing = tokens[agentId];
		if (existing !== undefined) return existing;

		tokens[agentId] = randomBytes(24).toString("base64url");
		await this.#write(tokens);
		return tokens[agentId];
	}

	/**
	 * Drops an agent's token, so the next sandbox gets a new one.
	 *
	 * Called when the container is destroyed, which is the moment the old token stops being baked
	 * into anything. Keeping it would mean a replaced sandbox inherits the credential of the one it
	 * replaced, for no benefit: the environment is written afresh either way.
	 */
	async forget(agentId: string): Promise<void> {
		const tokens = await this.#load();
		if (!(agentId in tokens)) return;
		delete tokens[agentId];
		await this.#write(tokens);
	}

	async #load(): Promise<Record<string, string>> {
		this.#tokens ??= await this.#read();
		return this.#tokens;
	}

	async #read(): Promise<Record<string, string>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return {};
			return Object.fromEntries(
				Object.entries(parsed as Record<string, unknown>).filter(
					([, token]) => typeof token === "string",
				),
			) as Record<string, string>;
		} catch {
			return {};
		}
	}

	async #write(tokens: Record<string, string>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the old file rather than
		// half of a new one. A truncated file here reads as "no tokens", which is the bug this fixes.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, JSON.stringify(tokens), { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.#path);
	}
}
