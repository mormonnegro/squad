import type { Usage } from "./looking.ts";

/**
 * Asking something small and fast which thing on the page is the one that was named.
 *
 * Its own file for the reason the looking is: this is the part worth testing without a browser, a
 * network or a provider — a page turned into options, an answer turned into a number, and the cost
 * of having asked.
 *
 * Why it is worth asking at all: an agent works a page by reading it, which is a numbered list of
 * every button, link and box on it, and then naming a number. The list is most of what a browsing
 * turn costs and it is in the transcript for the rest of that turn, sent again with every later
 * call. The question being asked at each step — which of these rows is the sign-in button — is a
 * classification with a right answer, not a thought, and a classifier answers it in a tenth of a
 * second for four cents a million tokens.
 *
 * So the agent names the thing. If the answer comes back unsure, nothing is pressed: the agent gets
 * the page it would have read anyway, and picks a number itself.
 */

export interface Pointing {
	readonly endpoint: string;
	readonly model: string;
	readonly rate: { readonly input: number; readonly output: number };
}

export function readPointing(raw: string): Pointing | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<Pointing>;
		if (typeof parsed.endpoint !== "string" || typeof parsed.model !== "string") return undefined;
		return {
			endpoint: parsed.endpoint,
			model: parsed.model,
			rate: parsed.rate ?? { input: 0, output: 0 },
		};
	} catch {
		return undefined;
	}
}

/** The page as the screen hands it over when it is asked for data rather than for prose. */
export interface Outline {
	readonly url: string;
	readonly title: string;
	readonly rows: readonly string[];
	readonly text: string;
}

export function readOutline(raw: string | undefined): Outline | undefined {
	if (raw === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { url, title, rows, text } = parsed as Record<string, unknown>;
		if (!Array.isArray(rows)) return undefined;
		return {
			url: typeof url === "string" ? url : "",
			title: typeof title === "string" ? title : "",
			rows: rows.filter((row): row is string => typeof row === "string"),
			text: typeof text === "string" ? text : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * How many rows are offered as answers.
 *
 * Not a money limit — a page whole is four thousand tokens and costs a fiftieth of a cent. It is
 * that a question with two hundred answers is a harder question than one with sixty, and the rows
 * that get cut are the ones with nothing in common with what was asked for. A page with more than
 * this on it is a page where the words in the request are doing the work anyway.
 */
export const MOST_OPTIONS = 60;

/** The word this row is offered under: what the read said about it, without its number. */
export function labelOf(row: string): string {
	return row.replace(/^\[\d+\]\s*/, "").trim();
}

export function refOf(row: string): number | undefined {
	const found = /^\[(\d+)\]/.exec(row);
	const ref = found?.[1];
	return ref === undefined ? undefined : Number(ref);
}

/**
 * The rows worth offering, nearest first when there are too many of them.
 *
 * Nearest by words shared with what was asked for, which is the cheapest thing that works and is
 * not trying to be the answer: it decides what stays on the list, and the model decides which of
 * them it is. Ties keep the order the page is in, because that is the order a person reads it.
 */
export function likely(
	rows: readonly string[],
	what: string,
	most = MOST_OPTIONS,
): readonly string[] {
	if (rows.length <= most) return rows;
	const words = new Set(
		what
			.toLowerCase()
			.split(/[^a-z0-9áéíóúñü]+/i)
			.filter((word) => word.length > 2),
	);
	const scored = rows.map((row, at) => {
		const label = labelOf(row).toLowerCase();
		let score = 0;
		for (const word of words) if (label.includes(word)) score += 1;
		return { row, at, score };
	});
	return scored
		.sort((a, b) => (b.score === a.score ? a.at - b.at : b.score - a.score))
		.slice(0, most)
		.sort((a, b) => a.at - b.at)
		.map((one) => one.row);
}

/** What none of them being it is called, which has to be a name no row can have. */
export const NONE = "none";

/**
 * The question, which is the page as options and the sentence the agent used as the instruction.
 *
 * `none` is on the list on purpose. A choice between things that are all wrong is answered with
 * whichever is least wrong, at a confidence that says nothing about whether it is right — and the
 * thing it presses is then a button somebody did not ask for. With an out, being wrong is an answer
 * rather than a click.
 */
export function askedAbout(pointing: Pointing, what: string, outline: Outline): string {
	const rows = likely(outline.rows, what);
	const criteria: Record<string, string> = {};
	for (const row of rows) {
		const ref = refOf(row);
		if (ref !== undefined) criteria[String(ref)] = labelOf(row);
	}
	criteria[NONE] = "None of these is the thing being described.";
	return JSON.stringify({
		model: pointing.model,
		state: {
			page: outline.title === "" ? outline.url : `${outline.title} — ${outline.url}`,
			// Enough of what the page says to tell two rows with the same label apart, and not the
			// whole article: what is being decided is which row, not what the page is about.
			says: outline.text.slice(0, 2000),
		},
		questions: {
			which: {
				type: "choice",
				/*
				 * Short, and measured rather than written.
				 *
				 * The first version of this line explained the situation — somebody is working this page,
				 * each option is an element of it, answer none if none of them is it — and asking for a
				 * button that was plainly on the list came back at 0.35, with half the weight on none.
				 * The same page and the same options under `Which one is: X?` came back at 0.88, and the
				 * thing that is genuinely absent still answers none at 0.99. What a classifier wants is
				 * the question; the explaining was noise in front of it.
				 */
				instructions: `Which one is: ${what}?`,
				criteria,
			},
		},
	});
}

/** Where a choice lands: the row it picked and how sure it was, or nothing it would stand behind. */
export interface Picked {
	readonly ref: number;
	readonly confidence: number;
}

/**
 * How sure is sure enough to press something.
 *
 * The answers come back calibrated, which is the whole reason a number here means anything: at a
 * half, one in two of these is the wrong element. Below it the agent is handed the page and picks
 * for itself, which costs a read and is what every turn cost before this existed — so the floor is
 * set where being wrong is dearer than being slow.
 */
export const SURE_ENOUGH = 0.55;

export function pickedIn(answer: unknown, floor = SURE_ENOUGH): Picked | undefined {
	const said = answer as {
		answers?: { which?: { choice?: unknown; confidence?: unknown } };
	};
	const choice = said.answers?.which?.choice;
	const confidence = said.answers?.which?.confidence;
	if (typeof choice !== "string" || choice === NONE) return undefined;
	const ref = Number(choice);
	if (!Number.isInteger(ref) || ref < 1) return undefined;
	const sure = typeof confidence === "number" ? confidence : 0;
	return sure >= floor ? { ref, confidence: sure } : undefined;
}

/** Whatever the provider said went wrong, for a status that was not a success. */
export function refusedBy(answer: unknown, body: string): string {
	const said = answer as { error?: { message?: string } };
	return said?.error?.message ?? body.slice(0, 400);
}

/**
 * What the pointing cost, counted here because here is the only place that knows.
 *
 * On the looking tool's terms: a call to another provider, on another account, that the model
 * driving the turn never sees a token of. It is a fraction of a cent and it is still counted —
 * money an agent spends that appears in no total is the thing that makes a total worthless.
 */
export function spentOn(pointing: Pointing, answer: unknown): Usage {
	const said = answer as { usage?: { input_tokens?: number; output_tokens?: number } };
	const input = said.usage?.input_tokens ?? 0;
	const output = said.usage?.output_tokens ?? 0;
	const read = (input * pointing.rate.input) / 1e6;
	const written = (output * pointing.rate.output) / 1e6;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: read, output: written, cacheRead: 0, cacheWrite: 0, total: read + written },
	};
}
