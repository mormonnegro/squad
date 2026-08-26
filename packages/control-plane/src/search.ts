import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Grant } from "@agent-dive/proxy";

/**
 * How the answer comes back, which is the one thing about a search provider that is not a string.
 *
 * `responses` is OpenAI's, where the searching and the reading are steps in an output list. `chat` is
 * the shape everyone else settled on, where the answer is a message and the pages it read are beside
 * it. Two shapes rather than one adapter each, because these are the two every provider here speaks.
 */
export type SearchShape = "responses" | "chat";

/** US dollars per million tokens, in and out. */
export interface Rate {
	readonly input: number;
	readonly output: number;
}

/**
 * A provider that will search the web, read what it finds and answer in prose.
 *
 * The same table idea as the model providers: naming one is the whole of configuring it, because
 * where it lives, what its key is called and what it charges are facts about the provider rather
 * than decisions an operator gets to make. What is theirs is which one, and which model it drives.
 */
export interface SearchProvider {
	readonly host: string;
	readonly path: string;
	readonly shape: SearchShape;
	readonly keyEnv: string;
	/** What it will drive the search with. The first is what naming the provider alone means. */
	readonly models: readonly string[];
	/**
	 * What one search costs before a single token is read.
	 *
	 * The number that makes this tool worth counting separately from the turn that asked for it: it
	 * is charged for asking rather than for anything read or written, and it dwarfs its own tokens.
	 */
	readonly perSearchUsd: number;
	readonly rates: Readonly<Record<string, Rate>>;
}

export const SEARCH_PROVIDERS: Readonly<Record<string, SearchProvider>> = {
	openai: {
		host: "api.openai.com",
		path: "/v1/responses",
		shape: "responses",
		keyEnv: "OPENAI_API_KEY",
		models: ["gpt-5-mini", "gpt-5", "gpt-5-nano"],
		perSearchUsd: 0.01,
		rates: {
			"gpt-5": { input: 1.25, output: 10 },
			"gpt-5-mini": { input: 0.25, output: 2 },
			"gpt-5-nano": { input: 0.05, output: 0.4 },
		},
	},
	perplexity: {
		host: "api.perplexity.ai",
		path: "/chat/completions",
		shape: "chat",
		keyEnv: "PERPLEXITY_API_KEY",
		models: ["sonar", "sonar-pro", "sonar-reasoning"],
		perSearchUsd: 0.005,
		rates: {
			sonar: { input: 1, output: 1 },
			"sonar-pro": { input: 3, output: 15 },
			"sonar-reasoning": { input: 1, output: 5 },
		},
	},
};

/** Which provider searches, and what it drives. An id off the table, and one of that provider's models. */
export interface SearchSpec {
	readonly provider: string;
	readonly model?: string;
}

/** A search as everything downstream needs it, with the table's half filled in. */
export interface Search {
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
	readonly shape: SearchShape;
	readonly keyEnv: string;
	readonly perSearchUsd: number;
	/**
	 * What the chosen model costs, resolved here rather than in the sandbox.
	 *
	 * The extension used to hold its own price list, which put the one number that decides whether a
	 * ceiling means anything two packages away from the table it belongs in — and made a model nobody
	 * had priced count as free. The dearest of the provider's own is the fallback, because of the two
	 * ways to be wrong about a bill, overstating it is the one that can be undone.
	 */
	readonly rate: Rate;
}

/** The provider this plane searches with when nobody has said, and the only one this started with. */
export const DEFAULT_SEARCH_PROVIDER = "openai";

export function resolveSearch(spec: SearchSpec): Search | string {
	const provider = spec.provider.trim();
	const known = SEARCH_PROVIDERS[provider];
	if (known === undefined) {
		return `nothing here knows how to search with "${provider}". Known: ${Object.keys(SEARCH_PROVIDERS).join(", ")}`;
	}
	const model = spec.model !== undefined && spec.model.length > 0 ? spec.model : known.models[0];
	if (model === undefined) return `"${provider}" has no model to search with`;

	const dearest = Object.values(known.rates).reduce(
		(worst, rate) => (rate.output > worst.output ? rate : worst),
		{ input: 0, output: 0 },
	);
	return {
		provider,
		model,
		endpoint: `https://${known.host}${known.path}`,
		shape: known.shape,
		keyEnv: known.keyEnv,
		perSearchUsd: known.perSearchUsd,
		rate: known.rates[model] ?? dearest,
	};
}

/**
 * The one grant the search tool needs, derived rather than written down.
 *
 * Scoped to the endpoint that searches and to POST, because the same key against the rest of that API
 * is a second model to think with, bought by whoever talks the agent into asking for it. Derived here
 * so that choosing a search provider at the console is the whole of setting one up — before this, the
 * key was on the config screen and the grant that spends it was a paragraph of YAML on the host.
 */
export function searchGrant(search: Search): Grant {
	const { host, pathname } = new URL(search.endpoint);
	return {
		id: `search:${search.provider}`,
		host,
		pathPrefix: pathname,
		methods: ["POST"],
		injection: { kind: "bearer", token: { ref: search.keyEnv } },
	};
}

/** A search as the config screen has it: what it would be, and whether this plane can pay for it. */
export interface SearchStanding extends Search {
	/** Chosen at the console, rather than being what this plane does when nobody has said. */
	readonly chosen: boolean;
	readonly held: boolean;
	/** Whether the key is this plane's own file rather than the environment it was started with. */
	readonly here: boolean;
}

/**
 * Which provider this plane searches with, kept beside the operator's file rather than in it.
 *
 * The same answer every other thing decided at a console gets here. What it holds is a name off the
 * table above and a model off that provider's own list, which is what keeps this from being a way to
 * point the search tool at a host nobody approved.
 */
export class SearchChoice {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** What was chosen, or nothing at all — which is a plane searching the way it always has. */
	async chosen(): Promise<SearchSpec | undefined> {
		return this.#serialize(() => this.#read());
	}

	async choose(spec: SearchSpec): Promise<void> {
		await this.#serialize(async () => {
			await mkdir(dirname(this.#path), { recursive: true });
			const temporary = `${this.#path}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(spec, null, "\t")}\n`, "utf8");
			await rename(temporary, this.#path);
		});
	}

	async #read(): Promise<SearchSpec | undefined> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
			const { provider, model } = parsed as Partial<SearchSpec>;
			if (typeof provider !== "string") return undefined;
			return typeof model === "string" ? { provider, model } : { provider };
		} catch {
			return undefined;
		}
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
