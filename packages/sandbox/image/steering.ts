import { labelOf, likely, type Outline, type Pointing, refOf } from "./pointing.ts";

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
): string {
	const criteria: Record<string, string> = {};
	for (const row of likely(outline.rows, goal)) {
		const ref = refOf(row);
		if (ref !== undefined) criteria[String(ref)] = labelOf(row);
	}
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
 * How sure the move has to be before the loop acts on it.
 *
 * Lower than the floor for pressing a named thing, and on purpose: that floor guards against
 * pressing the wrong element, which is a mistake with consequences on the page. This one only
 * decides whether to press, scroll or stop — and stopping when it should have pressed costs a turn
 * of the model, which is the thing this whole loop exists to avoid paying.
 */
export const SURE_ENOUGH_TO_MOVE = 0.4;

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
		unsure: "It stopped because it was no longer sure what to do next. Carry on by hand from here.",
	};
	return [steps, ending[why]].join(" ");
}
