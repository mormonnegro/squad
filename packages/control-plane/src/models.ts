import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Grant, Injection } from "@agent-dive/proxy";

/** What pi is told to think with: whose API to go through, and which model to ask it for. */
export interface ModelChoice {
	readonly provider?: string;
	readonly model?: string;
}

/**
 * A model the operator has configured, with everything needed to reach it filled in.
 *
 * The four facts are always the same four — who serves it, where they serve it, what the key is
 * called and how it is attached — which is why most of this is a table rather than something an
 * operator writes out. What they should have to say is which models they want.
 */
export interface Model extends ModelChoice {
	/** What `/model` takes and what the agents column shows. Unique across the configuration. */
	readonly id: string;
	readonly provider: string;
	readonly model: string;
	readonly host: string;
	/** The plane's own environment variable holding the key. The agent never sees its value. */
	readonly keyEnv: string;
	/** The header the key goes in, when the provider does not take a bearer token. */
	readonly header?: string;
}

/**
 * The providers whose details are known, so that naming one is the whole of configuring it.
 *
 * A model is the one capability every agent needs and the one nobody thinks of as a capability, so
 * the four lines it took to grant were four lines to get wrong — and a wrong one is not found until
 * an agent is mid-turn, refused at the proxy, complaining about something the operator never typed.
 * Anything not in here is still configurable, by writing out the host and the key's variable.
 */
export const PROVIDERS: Readonly<
	Record<string, { host: string; keyEnv: string; header?: string }>
> = {
	anthropic: { host: "api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", header: "x-api-key" },
	openai: { host: "api.openai.com", keyEnv: "OPENAI_API_KEY" },
	deepseek: { host: "api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY" },
	google: {
		host: "generativelanguage.googleapis.com",
		keyEnv: "GEMINI_API_KEY",
		header: "x-goog-api-key",
	},
	groq: { host: "api.groq.com", keyEnv: "GROQ_API_KEY" },
	mistral: { host: "api.mistral.ai", keyEnv: "MISTRAL_API_KEY" },
	openrouter: { host: "openrouter.ai", keyEnv: "OPENROUTER_API_KEY" },
	xai: { host: "api.x.ai", keyEnv: "XAI_API_KEY" },
};

/** A key this plane could be given, named after the provider that spends it. */
export interface Provider {
	/** What the provider is called, which is what the configuration names to get the rest. */
	readonly id: string;
	readonly keyEnv: string;
	/** The configured models that think through it, in the order the file declared them. */
	readonly models: readonly string[];
}

/** A provider as the configuration screen has it: the key, and whether this plane is holding one. */
export interface ProviderStanding extends Provider {
	readonly held: boolean;
	/** Held because somebody typed it at the console, rather than because the machine exported it. */
	readonly here: boolean;
}

/**
 * Every key this plane could be given: the ones its models need, and then the rest of the ones this
 * knows how to reach.
 *
 * A row is a key rather than a provider name, which is the same thing until an operator writes out a
 * second `keyEnv` for a provider already in the table. Then it is two keys, and a screen that showed
 * one row would be a screen where filling it in leaves half the models still refused at the proxy.
 *
 * The configured ones come first because they are the ones this plane is actually waiting on. The
 * others are on the list at all so that setting a provider up is something you can find rather than
 * something you have to already know the name of.
 */
export function providersOf(models: readonly Model[]): readonly Provider[] {
	const found = new Map<string, { id: string; keyEnv: string; models: string[] }>();
	for (const model of models) {
		const at = found.get(model.keyEnv) ?? { id: model.provider, keyEnv: model.keyEnv, models: [] };
		at.models.push(model.id);
		found.set(model.keyEnv, at);
	}
	for (const [id, known] of Object.entries(PROVIDERS)) {
		if (!found.has(known.keyEnv)) found.set(known.keyEnv, { id, keyEnv: known.keyEnv, models: [] });
	}
	return [...found.values()];
}

/**
 * What the container is given in place of the key.
 *
 * pi refuses to start on a provider it cannot see a key for, and the whole design here is that the
 * key is not in the container. So it is shown a value that is the right shape and worth nothing:
 * the request goes out, the proxy throws this away and writes the real one on the wire.
 */
export const KEY_PLACEHOLDER = "injected-by-the-proxy";

function injection(model: Model): Injection {
	const token = { ref: model.keyEnv };
	return model.header === undefined
		? { kind: "bearer", token }
		: { kind: "header", name: model.header, value: token };
}

/**
 * The grants that let an agent think, one per configured model.
 *
 * Every agent gets every one of them, rather than only the grant for the model it is set to. That
 * is what makes `/model` possible without the keyboard granting anything: the reach is decided in
 * the operator's file, by the act of configuring the model at all, and the command only chooses
 * among what is already there. What stops one agent from thinking expensively is its ceiling,
 * which is per agent and already exists.
 */
export function modelGrants(models: readonly Model[]): readonly Grant[] {
	return models.map((model) => ({
		id: `model:${model.id}`,
		host: model.host,
		injection: injection(model),
	}));
}

/** The variables a sandbox needs for pi to believe every configured provider is set up. */
export function modelEnv(models: readonly Model[]): Record<string, string> {
	return Object.fromEntries(models.map((model) => [model.keyEnv, KEY_PLACEHOLDER]));
}

/**
 * Which model each agent was put on at the keyboard.
 *
 * The same shape of decision as a spending ceiling, and here for the same reason: the file that
 * declares the model is the operator's and this plane may not write it, so a choice made at the
 * console is written down beside it instead. It holds an id and nothing else — a name from the
 * configuration, which is what keeps `/model` from being a way to introduce a model nobody
 * approved.
 */
export class ModelChoices {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async chosen(agentId: string): Promise<string | undefined> {
		return (await this.#serialize(() => this.#read()))[agentId];
	}

	async choose(agentId: string, id: string): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			all[agentId] = id;
			await this.#write(all);
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

	async #read(): Promise<Record<string, string>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			return Object.fromEntries(
				Object.entries(parsed as Record<string, unknown>).filter(
					([, id]) => typeof id === "string",
				),
			) as Record<string, string>;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, string>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed: a plane killed mid-write would otherwise leave half a file,
		// which reads as nobody having chosen anything and puts every agent back on the config's model.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(all, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic, and every agent on the plane shares this object.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
