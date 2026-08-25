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
	Record<
		string,
		{
			host: string;
			keyEnv: string;
			header?: string;
			/** Where it will say what it answers to, asked with the key this plane holds for it. */
			catalog?: string;
			catalogHeaders?: Readonly<Record<string, string>>;
		}
	>
> = {
	anthropic: {
		host: "api.anthropic.com",
		keyEnv: "ANTHROPIC_API_KEY",
		header: "x-api-key",
		catalog: "/v1/models",
		catalogHeaders: { "anthropic-version": "2023-06-01" },
	},
	openai: { host: "api.openai.com", keyEnv: "OPENAI_API_KEY", catalog: "/v1/models" },
	deepseek: { host: "api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", catalog: "/v1/models" },
	google: {
		host: "generativelanguage.googleapis.com",
		keyEnv: "GEMINI_API_KEY",
		header: "x-goog-api-key",
		catalog: "/v1beta/models?pageSize=200",
	},
	groq: { host: "api.groq.com", keyEnv: "GROQ_API_KEY", catalog: "/openai/v1/models" },
	mistral: { host: "api.mistral.ai", keyEnv: "MISTRAL_API_KEY", catalog: "/v1/models" },
	openrouter: { host: "openrouter.ai", keyEnv: "OPENROUTER_API_KEY", catalog: "/api/v1/models" },
	xai: { host: "api.x.ai", keyEnv: "XAI_API_KEY", catalog: "/v1/models" },
};

/**
 * A model as somebody said it, before the table filled the rest in.
 *
 * The same shape whether it came out of the operator's file or off the setup screen, so that the one
 * place that knows how a provider name becomes a host and a variable stays one place.
 */
export interface ModelSpec {
	readonly id: string;
	readonly provider: string;
	readonly model?: string;
	readonly host?: string;
	readonly keyEnv?: string;
	readonly header?: string;
}

/**
 * Fills in everything about a model that is a fact rather than a decision, or says what is missing.
 *
 * Returns the reason instead of throwing because both callers want it as words: the config file
 * collects them into the list of everything wrong with it, and the setup screen puts it on the row
 * under the one being typed.
 */
export function resolveModel(spec: ModelSpec): Model | string {
	const id = spec.id.trim();
	const provider = spec.provider.trim();
	if (id.length === 0) return 'a model needs an id: the name to pick it by, e.g. "sonnet"';
	if (provider.length === 0) {
		return `"${id}" needs a provider, e.g. ${Object.keys(PROVIDERS).join(", ")}`;
	}

	const known = PROVIDERS[provider];
	const host = spec.host !== undefined && spec.host.length > 0 ? spec.host : known?.host;
	const keyEnv = spec.keyEnv !== undefined && spec.keyEnv.length > 0 ? spec.keyEnv : known?.keyEnv;
	if (host === undefined || keyEnv === undefined) {
		return `nothing here knows "${provider}", so it needs a host and a keyEnv of its own. Known: ${Object.keys(PROVIDERS).join(", ")}`;
	}

	const header = spec.header !== undefined && spec.header.length > 0 ? spec.header : known?.header;
	return {
		id,
		provider,
		// The id is usually the model's own name, so saying it twice is the common case.
		model: spec.model !== undefined && spec.model.length > 0 ? spec.model : id,
		host,
		keyEnv,
		...(header !== undefined ? { header } : {}),
	};
}

/** A model as the setup screen has it: which of the two lists it is on, and whether it can be paid. */
export interface ModelStanding extends Model {
	/**
	 * Given at a console rather than declared in the operator's file.
	 *
	 * The screen says which, because it decides what can be done to the row: this plane may take back
	 * what it was handed and may not touch what the file declared, and a list that looked uniform
	 * would be one where half the rows silently refuse.
	 */
	readonly added: boolean;
	readonly held: boolean;
}

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

/** One model a provider says it will answer to, offered to be configured under a name. */
export interface ModelOffer {
	readonly provider: string;
	/** The provider's own name for it, which is also the name it gets here unless one is taken. */
	readonly id: string;
}

/**
 * What could be picked, and what could not be asked.
 *
 * The second half matters more than it looks: a key that is wrong, or a provider that is down, both
 * come back as no models, and a list that was empty for a reason nobody said reads as a provider
 * with nothing to offer.
 */
export interface Catalog {
	readonly offers: readonly ModelOffer[];
	readonly trouble: readonly string[];
}

/**
 * The ones that are not something to think with.
 *
 * Every catalog here answers with everything the account can call, which is embeddings and speech
 * and image generation alongside the models. Matched as substrings, and being wrong only hides a
 * row — the name can still be written out by hand, which is the fallback this list is safe because
 * of.
 */
const NOT_FOR_THINKING = [
	"embed",
	"whisper",
	"tts",
	"dall-e",
	"moderation",
	"transcrib",
	"image",
	"imagen",
	"audio",
	"speech",
	"rerank",
	"guard",
	"sora",
	"veo",
	"realtime",
	"aqa",
];

/** Google answers with the resource path; the part after the slash is the name it takes. */
function offered(entry: unknown): { id: string; created?: number } | undefined {
	const named = entry as { id?: unknown; name?: unknown; created?: unknown };
	const raw =
		typeof named.id === "string" ? named.id : typeof named.name === "string" ? named.name : "";
	const id = raw.startsWith("models/") ? raw.slice("models/".length) : raw;
	if (id.length === 0) return undefined;
	return typeof named.created === "number" ? { id, created: named.created } : { id };
}

/**
 * Asks a provider what it will answer to.
 *
 * Because the alternative is knowing the name already. Every one of these serves a list at a path
 * that is a fact about the provider like the host is, so it goes in the table beside it: an
 * operator who has just handed over a key should be choosing from what the key buys, not typing a
 * model name from memory and finding out at the proxy that they got it wrong.
 *
 * Asked by the plane and never by an agent — the plane is the side holding the key, and the request
 * carries it directly rather than through the broker, which exists to keep the key away from the
 * sandbox and there is no sandbox here.
 */
export async function offersOf(provider: string, key: string): Promise<readonly ModelOffer[]> {
	const known = PROVIDERS[provider];
	if (known?.catalog === undefined) return [];
	const headers: Record<string, string> = {
		...known.catalogHeaders,
		...(known.header === undefined ? { authorization: `Bearer ${key}` } : { [known.header]: key }),
	};
	const response = await fetch(`https://${known.host}${known.catalog}`, {
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`answered ${response.status}`);

	const body = (await response.json()) as { data?: unknown; models?: unknown };
	const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
	const all = list.map(offered).filter((entry) => entry !== undefined);
	// Newest first where the provider dates them, because a catalog in the order it was written is a
	// list whose top is the oldest thing on it.
	if (all.length > 0 && all.every((entry) => entry.created !== undefined)) {
		all.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
	}
	return all
		.filter((entry) => !NOT_FOR_THINKING.some((word) => entry.id.toLowerCase().includes(word)))
		.map((entry) => ({ provider, id: entry.id }));
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

/**
 * The variables a sandbox needs for pi to believe every provider is set up.
 *
 * Every provider this knows, not only the ones configured now. A container's environment is set once
 * when it starts, and a model added at the keyboard afterwards would otherwise be a model pi refuses
 * for want of a variable — fixable only by restarting the agent, which is the thing that was not
 * supposed to be needed. There is nothing to spend here: each of these is the same worthless string,
 * and the reach that would make one matter is a grant, which is decided elsewhere and separately.
 */
export function modelEnv(models: readonly Model[]): Record<string, string> {
	const names = [
		...Object.values(PROVIDERS).map((known) => known.keyEnv),
		...models.map((model) => model.keyEnv),
	];
	return Object.fromEntries(names.map((keyEnv) => [keyEnv, KEY_PLACEHOLDER]));
}

/**
 * The models this plane was given at the keyboard, on top of the ones its file declares.
 *
 * Beside the operator's file rather than in it, which is the same answer every other thing decided
 * at a console gets here: the file is theirs, this plane may not rewrite it, and a change that
 * vanished on the next deploy would be worse than one that was never offered. What that costs is
 * that `config.yaml` is no longer the whole list — which is why the setup screen says, for every
 * model on it, which of the two it came from.
 */
export class AddedModels {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** Resolved on the way out, so a provider the table learns about later is filled in correctly. */
	async all(): Promise<readonly Model[]> {
		const specs = await this.#serialize(() => this.#read());
		const models: Model[] = [];
		for (const spec of specs) {
			const model = resolveModel(spec);
			if (typeof model !== "string") models.push(model);
		}
		return models;
	}

	async add(spec: ModelSpec): Promise<void> {
		await this.#serialize(async () => {
			const all = (await this.#read()).filter((other) => other.id !== spec.id);
			all.push(spec);
			await this.#write(all);
		});
	}

	/** True when there was one to drop, so the console can tell a typo from a model that is gone. */
	async drop(id: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const all = await this.#read();
			const left = all.filter((other) => other.id !== id);
			if (left.length === all.length) return false;
			await this.#write(left);
			return true;
		});
	}

	async #read(): Promise<ModelSpec[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(entry): entry is ModelSpec =>
					typeof entry === "object" &&
					entry !== null &&
					typeof (entry as ModelSpec).id === "string" &&
					typeof (entry as ModelSpec).provider === "string",
			);
		} catch {
			return [];
		}
	}

	async #write(all: readonly ModelSpec[]): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(all, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
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
