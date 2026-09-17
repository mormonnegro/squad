import {
	labelOf,
	likely,
	MOST_OPTIONS,
	NONE,
	type Outline,
	type Pointing,
	refOf,
} from "./pointing.ts";

/**
 * Asking the classifier what to do next, as well as what to do it to.
 *
 * The saving this exists for is not tokens, it is turns. Pointing took the reading out of a click:
 * the agent says "the Continue button" and something small and fast finds the row. What it left
 * behind is the expensive half — every step still goes back to the model that thinks, which reads
 * the page it was handed, decides on the next click, and writes a tool call. Measured on this
 * plane: about two seconds of browser and classifier per step, and twenty to fifty seconds of the
 * model in between.
 *
 * So the same request that picks the row picks the move as well. One question asks what should
 * happen on this page — press something, scroll, we are there, we are stuck — and the other asks
 * which row, and the loop that runs them is in this container. A five-step walk across a site stops
 * costing five turns of a model and starts costing five tenths of a second each.
 *
 * Borrowed, openly, from browser-use/jev-ultrafast, which puts it as one request per decision cycle
 * with the operation and the target on the same observed state.
 */

/** What can happen on a page, which is deliberately four things and not a language. */
export type Move = "click" | "scroll" | "done" | "stuck";

/** The four, with the sentence each is offered under. */
const MOVES: Readonly<Record<Move, string>> = {
	click: "Press something on this page that gets closer to the goal.",
	scroll: "What is needed is further down this page, not yet visible.",
	done: "The goal is already met: this page is what was being looked for.",
	stuck: "This page offers no way to get closer to the goal.",
};

/** The two questions, asked under names the answers come back under. */
export const MOVE_KEY = "move";
export const TARGET_KEY = "which";

/**
 * One request that decides the step and its target, over the page as it stands.
 *
 * The trail goes in the instructions rather than into a field of its own: what stops a loop going
 * round in circles is knowing what it already pressed, and the only place this API takes free words
 * is there. Short on purpose — the last few are what matter, and a classifier reading a paragraph
 * of history is a classifier answering a harder question than the one being asked.
 */
export function askedToStep(
	pointing: Pointing,
	goal: string,
	outline: Outline,
	trail: readonly string[] = [],
	asked: ReadonlySet<number> = new Set(),
): string {
	const criteria: Record<string, string> = {};
	for (const row of offered(outline.rows, goal, asked)) {
		const ref = refOf(row);
		if (ref !== undefined) criteria[String(ref)] = labelOf(row);
	}
	/*
	 * A way to say none of them, which this asked for without at first and paid for.
	 *
	 * Sixty options and no escape means the weight has to land somewhere: the first walk across
	 * Wikipedia came back choosing a row at 0.21 — a spread, not a choice — and every step of it was
	 * refused as unsure. With this on the list the same question can answer "none of these" and mean
	 * it, which is what makes the number underneath the choice worth reading at all.
	 */
	criteria[NONE] = "None of these leads any closer to the goal.";
	const been = trail.length === 0 ? "" : ` Already pressed: ${trail.slice(-4).join(", ")}.`;
	return JSON.stringify({
		model: pointing.model,
		state: {
			page: outline.title === "" ? outline.url : `${outline.title} — ${outline.url}`,
			says: outline.text.slice(0, 2000),
		},
		questions: {
			[MOVE_KEY]: {
				type: "choice",
				instructions: `Working towards: ${goal}.${been} What should happen on this page now?`,
				criteria: { ...MOVES },
			},
			[TARGET_KEY]: {
				type: "choice",
				instructions: `Which one gets closest to: ${goal}?${been}`,
				criteria,
			},
		},
	});
}

/**
 * Which rows to put in front of the classifier, and which to save for the next question.
 *
 * A question takes sixty options and a page has two hundred, so the walk asks about a page in
 * windows: the ones whose words match the goal first, because that is the whole question when the
 * goal names what it is after, and then the rest in the order the page is in.
 *
 * This is the thing the first version got wrong in a way that took a measurement to see. It offered
 * the sixty nearest by word overlap and nothing else — and for a goal like "the Rolling Stones page"
 * no link on an article about coffee shares a word with it, so what was offered was the first sixty
 * rows in page order, which on Wikipedia is the menu, the search box and the language list. It was
 * being asked to find a way on out of the site's furniture.
 */
export function offered(
	rows: readonly string[],
	goal: string,
	asked: ReadonlySet<number>,
	most = MOST_OPTIONS,
): readonly string[] {
	const left = rows.filter((row) => {
		const ref = refOf(row);
		return ref !== undefined && !asked.has(ref);
	});
	if (left.length <= most) return left;
	// The nearest by words first, then the page in its own order to fill the window. A goal that
	// names what it wants gets answered on the first question; one that does not walks the page.
	const near = likely(left, goal, most);
	if (near.length >= most) return near;
	const already = new Set(near);
	return [...near, ...left.filter((row) => !already.has(row))].slice(0, most);
}

/**
 * How sure the move has to be before the loop acts on it.
 *
 * Lower than the floor for pressing a named thing, and on purpose: that floor guards against
 * pressing the wrong element, which is a mistake with consequences on the page. This one only
 * decides whether to press, scroll or stop — and stopping when it should have pressed costs a turn
 * of the model, which is the thing this whole loop exists to avoid paying.
 */
export const SURE_ENOUGH_TO_MOVE = 0.4;

/**
 * And how sure the target has to be before the walk presses it.
 *
 * Not the same scale as the one above and not comparable to it: that is a choice of four and this is
 * a choice of sixty, and weight spread over sixty plausible links reads lower for the same certainty.
 * Set from what was measured on real pages — a page with the way on plainly on it answers at 0.84, a
 * page without one answers `none` at 0.66, and a question with no escape offered at all answered
 * 0.21, which is a spread rather than a choice and is what this floor exists to refuse.
 *
 * Lower than the floor for pressing a thing the agent named by its own words, because that question
 * has one right answer on the page and this one is a judgement about where a link leads.
 */
export const SURE_ENOUGH_TO_PRESS = 0.35;

/**
 * How far down a page it may look for the way on before giving up on the page.
 *
 * A reading of a page is what is on the screen: an element that is not drawn is not on the list, so
 * the link in the body of a long article does not exist until it has been scrolled to. The first
 * version allowed two scrolls, which is two screens of a twenty screen article — and what that looks
 * like from the outside is a tool that "only sees the first viewport", which is exactly what the
 * agent using it said.
 *
 * So it scrolls the way a person does, and stops for the reason a person does: the page stopped
 * moving. This is the cap on top of that, for a page that scrolls forever.
 */
export const MOST_SCROLLS = 12;

/** Which of the four it chose, or nothing when it would not commit to one of them. */
export function movedIn(answer: unknown, floor = SURE_ENOUGH_TO_MOVE): Move | undefined {
	const said = answer as {
		answers?: Record<string, { choice?: unknown; confidence?: unknown } | undefined>;
	};
	const choice = said.answers?.[MOVE_KEY]?.choice;
	const confidence = said.answers?.[MOVE_KEY]?.confidence;
	if (typeof choice !== "string" || !(choice in MOVES)) return undefined;
	const sure = typeof confidence === "number" ? confidence : 0;
	return sure >= floor ? (choice as Move) : undefined;
}

/**
 * What the walk is worth telling the agent afterwards, which is where it went and not how.
 *
 * Every step of it happened without the model that thinks, so this is the first time that model
 * hears about any of it — and what it needs is the shape of the walk, not a transcript: where it
 * ended, what was pressed on the way, and why it stopped there.
 */
export function walked(
	trail: readonly string[],
	why: "done" | "stuck" | "most" | "unsure",
	goal: string,
): string {
	const steps =
		trail.length === 0 ? "Nothing was pressed." : `Pressed, in order: ${trail.join(" → ")}.`;
	const ending: Record<typeof why, string> = {
		done: `The page below is where that ended, and it looks like what "${goal}" was after.`,
		stuck: "It stopped because this page offered no way further towards that.",
		most: "It stopped at the step limit rather than because it arrived — say so again to carry on.",
		unsure: "It stopped because it could not tell which of the things on the page leads there.",
	};
	/*
	 * The one ending worth explaining rather than reporting.
	 *
	 * A walk that pressed nothing at all is not a walk that went wrong: it is this tool meeting a
	 * goal it cannot serve. Each step is chosen from what the page says, so "the checkout" works and
	 * "the article about the band that played in Hyde Park" does not — that second one needs knowing
	 * which link leads there, which is the thing the agent has and the classifier does not.
	 */
	const advice =
		trail.length === 0 && why !== "done"
			? " Nothing here looked like a way towards it. This walks by what the page says, so it gets to a checkout or a settings page and not to something only you know the route to — work the route out yourself and screen_open it."
			: "";
	return [steps, ending[why], advice].join(" ").trim();
}
