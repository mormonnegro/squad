import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Grant } from "@squad/proxy";
import type { Rate } from "./search.ts";

/**
 * Looking at a picture is a thing an agent asks for, not a thing its own model has to be able to do.
 *
 * The same shape as searching, and for the same reason. An agent thinks with whatever it thinks with
 * — a small, cheap model, most of the time — and there is no sense in choosing that model for the
 * one turn a month where something has to be looked at. So the picture goes to a model that can see,
 * with the question, and what comes back is prose. The agent never holds an image.
 *
 * That it comes back as words rather than as pixels is the whole of why this is worth doing:
 *
 *  - It works with an agent whose model cannot see at all, which is most of them and all of the
 *    cheap ones. Before this, `screen_look` on such an agent was a silent no-op — the picture went
 *    out, nothing read it, and the agent believed it had looked.
 *  - It is paid for once. An image in a tool result goes into the session and is sent again with
 *    every later call in that turn, so one screenshot early in a long turn is billed a dozen times.
 *    A paragraph of text is not.
 */

/** How a provider takes an image, which is the one thing the three of them disagree about. */
export type VisionShape = "responses" | "messages" | "chat";

export interface VisionProvider {
	readonly host: string;
	readonly path: string;
	readonly shape: VisionShape;
	readonly keyEnv: string;
	/** What it will look with. The first is what naming the provider alone means. */
	readonly models: readonly string[];
	readonly rates: Readonly<Record<string, Rate>>;
	/** Anything the provider wants on every request that is not the key. */
	readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The providers that can be handed a screenshot and a question.
 *
 * Deliberately short, and every one of them is a provider this plane already knows how to pay: the
 * point of a second table is not a second account, it is that a key an operator already holds turns
 * into a capability without them writing a line of YAML.
 */
export const VISION_PROVIDERS: Readonly<Record<string, VisionProvider>> = {
	openai: {
		host: "api.openai.com",
		path: "/v1/responses",
		shape: "responses",
		keyEnv: "OPENAI_API_KEY",
		models: ["gpt-5-mini", "gpt-5", "gpt-5-nano"],
		rates: {
			"gpt-5": { input: 1.25, output: 10 },
			"gpt-5-mini": { input: 0.25, output: 2 },
			"gpt-5-nano": { input: 0.05, output: 0.4 },
		},
	},
	anthropic: {
		host: "api.anthropic.com",
		path: "/v1/messages",
		shape: "messages",
		keyEnv: "ANTHROPIC_API_KEY",
		models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
		headers: { "anthropic-version": "2023-06-01" },
		rates: {
			"claude-sonnet-4-6": { input: 3, output: 15 },
			"claude-haiku-4-5": { input: 1, output: 5 },
		},
	},
	google: {
		host: "generativelanguage.googleapis.com",
		path: "/v1beta/openai/chat/completions",
		shape: "chat",
		keyEnv: "GEMINI_API_KEY",
		models: ["gemini-2.5-flash", "gemini-2.5-pro"],
		rates: {
			"gemini-2.5-flash": { input: 0.3, output: 2.5 },
			"gemini-2.5-pro": { input: 1.25, output: 10 },
		},
	},
};

/** Which provider looks, and what it looks with. An id off the table and one of its models. */
export interface VisionSpec {
	readonly provider: string;
	readonly model?: string;
}

/** A vision model as everything downstream needs it, with the table's half filled in. */
export interface Vision {
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
	readonly shape: VisionShape;
	readonly keyEnv: string;
	readonly headers: Readonly<Record<string, string>>;
	/**
	 * What the chosen model costs, resolved here rather than in the sandbox — for the reason the
	 * search rates are: the one number that decides whether a ceiling means anything belongs in the
	 * table that knows it, and a model nobody priced would otherwise count as free.
	 */
	readonly rate: Rate;
}

export function resolveVision(spec: VisionSpec): Vision | string {
	const provider = spec.provider.trim();
	const known = VISION_PROVIDERS[provider];
	if (known === undefined) {
		return `nothing here knows how to look with "${provider}". Known: ${Object.keys(VISION_PROVIDERS).join(", ")}`;
	}
	const model = spec.model !== undefined && spec.model.length > 0 ? spec.model : known.models[0];
	if (model === undefined) return `"${provider}" has no model to look with`;

	// The dearest of the provider's own when the model is one nobody priced, because of the two ways
	// to be wrong about a bill, overstating it is the one that can be undone.
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
		headers: known.headers ?? {},
		rate: known.rates[model] ?? dearest,
	};
}

/**
 * The one grant looking needs, derived rather than written down.
 *
 * Scoped to the endpoint and to POST, on the search grant's terms: the same key against the rest of
 * that API is a second model to think with, bought by whoever talks the agent into asking for it.
 * Derived here so that choosing a provider at the console is the whole of setting one up.
 */
export function visionGrant(vision: Vision): Grant {
	const { host, pathname } = new URL(vision.endpoint);
	return {
		id: `vision:${vision.provider}`,
		host,
		pathPrefix: pathname,
		methods: ["POST"],
		// Anthropic takes its key in a header of its own rather than as a bearer, which is the one
		// thing about paying a provider that this table cannot flatten.
		injection:
			vision.provider === "anthropic"
				? { kind: "header", name: "x-api-key", value: { ref: vision.keyEnv } }
				: { kind: "bearer", token: { ref: vision.keyEnv } },
	};
}

/** Vision as the config screen has it: what it would be, and whether this plane can pay for it. */
export interface VisionStanding extends Vision {
	/** Whether anybody chose it. Unlike searching, looking is off until somebody turns it on. */
	readonly chosen: boolean;
	readonly held: boolean;
	/** Whether the key is this plane's own file rather than the environment it was started with. */
	readonly here: boolean;
}

/** One model that could do the looking, and whether this plane holds the key that pays for it. */
export interface VisionOffer {
	readonly provider: string;
	readonly model: string;
	readonly keyEnv: string;
	readonly held: boolean;
	readonly rate: Rate;
	/** Whether this is the one doing the looking right now. */
	readonly using: boolean;
}

/**
 * Roughly what one look costs, for a screen that has to say so before anybody turns it on.
 *
 * A screenshot of this browser is 1280×800, which every provider prices at about the same seventeen
 * hundred tokens however it counts them, and a few sentences back is a few hundred. Rough on
 * purpose and rounded up: the number is here to tell a tenth of a cent from three cents, which is
 * the decision somebody is actually making, and not to reconcile a bill.
 */
export function perLookUsd(rate: Rate): number {
	return (1700 * rate.input) / 1e6 + (300 * rate.output) / 1e6;
}

/**
 * Which model this plane looks with, kept beside the operator's file rather than in it.
 *
 * Off until somebody chooses, which is the difference from searching: every plane searches, and a
 * plane that looks is one whose operator decided that looking is worth what it costs.
 */
export class VisionChoice {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async chosen(): Promise<VisionSpec | undefined> {
		return this.#serialize(() => this.#read());
	}

	async choose(spec: VisionSpec | null): Promise<void> {
		await this.#serialize(async () => {
			await mkdir(dirname(this.#path), { recursive: true });
			const temporary = `${this.#path}.${process.pid}.tmp`;
			// `null` is looking turned off, which is a decision and is written down as one: a file that
			// is simply absent is a plane nobody has asked yet.
			await writeFile(temporary, `${JSON.stringify(spec, null, "\t")}\n`, "utf8");
			await rename(temporary, this.#path);
		});
	}

	async #read(): Promise<VisionSpec | undefined> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
			const { provider, model } = parsed as Partial<VisionSpec>;
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
