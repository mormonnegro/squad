import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Grant } from "@squad/proxy";
import type { Rate } from "./search.ts";

/**
 * Pointing at a thing on a page instead of counting to it.
 *
 * The third of these, and the one that is about time rather than about sight. An agent works a page
 * by reading it — a numbered list of everything on it that can be pressed — and then naming a
 * number. That reading is most of what a browsing turn costs: two hundred rows of button, link and
 * input, in the transcript from the moment it arrives, sent again with every later call in the turn.
 * A booking that takes eight steps pays for eight of them, and the eighth is paid eight times.
 *
 * What is actually being asked at each step is a question with one right answer already written
 * down: which of these rows is the sign-in button. That is not thinking, and it does not need the
 * model that thinks: a classifier that answers in a tenth of a second, priced at four cents a
 * million tokens, picks the row and hands back a number with a probability on it.
 *
 * So the agent says what it wants — "the Continue button", "the search box" — and this answers with
 * the ref. It never sees the list, which is the saving: the page it gets back is where it is and
 * what it says, and nothing it is not going to use.
 *
 * When the answer comes back unsure, nothing is pressed. The agent is handed the page it would have
 * read anyway and picks a number itself, which is the turn there was before this existed.
 *
 * It is on when the key is there and off when it is not, and there is nothing else to set. The two
 * abilities beside this one are a choice between providers, so they have a screen to choose on; this
 * is one provider answering one kind of question, and an operator who pasted the key has already
 * said everything there was to say. Taking the key out is how it goes off again.
 */

export interface PointingProvider {
	readonly host: string;
	readonly path: string;
	readonly keyEnv: string;
	/** What it points with. The first is what naming the provider alone means. */
	readonly models: readonly string[];
	readonly rates: Readonly<Record<string, Rate>>;
}

/**
 * Who can be asked a question with a small set of right answers.
 *
 * One, for now, and it is the only kind of provider that fits: what this needs is a model that
 * answers in a calibrated distribution over options given, in a tenth of a second, for about
 * nothing. A chat model asked to pick a number is none of those three — it costs more than the
 * saving, takes longer than the click, and answers with a sentence that has to be parsed.
 */
export const POINTING_PROVIDERS: Readonly<Record<string, PointingProvider>> = {
	typesafe: {
		host: "api.typesafe.ai",
		path: "/v1/systemone",
		keyEnv: "TYPESAFE_API_KEY",
		models: ["jev-latest", "jev-1.12"],
		// Output is free at this provider and the input is four cents a million, which is why a page
		// can be handed over whole rather than trimmed to fit a budget.
		rates: { "jev-latest": { input: 0.042, output: 0 }, "jev-1.12": { input: 0.042, output: 0 } },
	},
};

/** Which provider points, and what it points with. An id off the table and one of its models. */
export interface PointingSpec {
	readonly provider: string;
	readonly model?: string;
}

/**
 * The one that is used when nobody said which, which is every plane that has the key.
 *
 * There is no choosing here and that is the design: one provider answers this kind of question at
 * this price, and a screen that made an operator pick it out of a list of one would be a screen
 * asking a question to look like the two above it.
 */
export const DEFAULT_POINTING: PointingSpec = { provider: "typesafe" };

/** A pointing model as everything downstream needs it, with the table's half filled in. */
export interface Pointing {
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
	readonly keyEnv: string;
	readonly rate: Rate;
}

export function resolvePointing(spec: PointingSpec): Pointing | string {
	const provider = spec.provider.trim();
	const known = POINTING_PROVIDERS[provider];
	if (known === undefined) {
		return `nothing here knows how to point with "${provider}". Known: ${Object.keys(POINTING_PROVIDERS).join(", ")}`;
	}
	const model = spec.model !== undefined && spec.model.length > 0 ? spec.model : known.models[0];
	if (model === undefined) return `"${provider}" has no model to point with`;
	// The dearest of its own for a model nobody priced, because of the two ways to be wrong about a
	// bill, overstating it is the one that can be undone.
	const dearest = Object.values(known.rates).reduce(
		(worst, rate) => (rate.input > worst.input ? rate : worst),
		{ input: 0, output: 0 },
	);
	return {
		provider,
		model,
		endpoint: `https://${known.host}${known.path}`,
		keyEnv: known.keyEnv,
		rate: known.rates[model] ?? dearest,
	};
}

/**
 * The one grant pointing needs, derived rather than written down.
 *
 * Scoped to the endpoint and to POST, on the looking grant's terms: the same key against the rest of
 * that API is something else bought by whoever talks an agent into asking for it. Derived here so
 * that choosing a provider at the console is the whole of setting one up.
 */
export function pointingGrant(pointing: Pointing): Grant {
	const { host, pathname } = new URL(pointing.endpoint);
	return {
		id: `pointing:${pointing.provider}`,
		host,
		pathPrefix: pathname,
		methods: ["POST"],
		injection: { kind: "bearer", token: { ref: pointing.keyEnv } },
	};
}

/**
 * Pointing as the abilities screen has it: what it would be, and whether this plane holds the key.
 *
 * `held` is the whole of whether it is on. Unlike looking, there is nothing else to decide — a key
 * for this API buys one thing, and an operator who has pasted it has said what they wanted. So the
 * switch is the key, and turning it off is taking the key back out.
 */
export interface PointingStanding extends Pointing {
	readonly held: boolean;
	/** Whether the key is this plane's own file rather than the environment it was started with. */
	readonly here: boolean;
}

/** One model that could do the pointing, and whether this plane holds the key that pays for it. */
export interface PointingOffer {
	readonly provider: string;
	readonly model: string;
	readonly keyEnv: string;
	readonly held: boolean;
	readonly rate: Rate;
	/** Whether this is the one doing the pointing right now. */
	readonly using: boolean;
}

/**
 * Roughly what one point costs, for a screen that has to say so before anybody turns it on.
 *
 * A page handed over whole — its address, what it says, and every row that can be pressed — is
 * about four thousand tokens, and what comes back is a number. Rounded up and rounded hard: the
 * number is here to say "this is not what makes your bill", which is the decision being made.
 */
export function perPointUsd(rate: Rate): number {
	return (4000 * rate.input) / 1e6 + (20 * rate.output) / 1e6;
}
