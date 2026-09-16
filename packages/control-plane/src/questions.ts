/**
 * A question an agent has put to its operator, and the answers it wrote for them to press.
 *
 * The thing this replaces is a paragraph. An agent one decision from carrying on — which of these
 * three fares, which of the two readings of what you asked for, shall I go on to the checkout —
 * used to end its turn by writing the decision out and putting a question mark on the end of it.
 * That is read twenty minutes later by somebody who then has to type an answer precise enough to
 * act on, and who quite often answers a different question from the one asked.
 *
 * So the answers come with it. Each option is the message it sends: pressing "Comfort $793" puts
 * exactly that line into the conversation as the operator's, in a turn of its own, and there is no
 * translation step at either end. Which is also why the plane keeps almost nothing of its own here
 * — the words are the agent's, the click is the operator's, and this is the shape they meet in.
 */
export interface Question {
	readonly text: string;
	readonly options: readonly string[];
	/**
	 * Set when what is wanted is the operator's hands rather than their answer.
	 *
	 * The console draws one more thing on a card that says so: the button that takes the keyboard off
	 * the agent and puts its browser in front of the person. It is not an answer and does not close
	 * the question — somebody who takes the keyboard to sign in has not yet said whether it worked.
	 */
	readonly hands?: boolean;
}

/**
 * How many an agent may have standing at once.
 *
 * Three, and hard, because every one of them is a stop. A turn that ended with five cards on the
 * screen is a turn that handed its work back rather than did any, and the console that has to draw
 * them is the conversation itself — five is a pane with no conversation left in it.
 */
export const MOST_QUESTIONS = 3;

/** How many answers one question may offer: a column read at a glance, and not a menu. */
export const MOST_OPTIONS = 6;

/** A button, not a paragraph. */
export const OPTION_CHARS = 140;

/** Enough to say what is being decided, with the buttons still on the screen under it. */
export const QUESTION_CHARS = 700;

function readOne(value: unknown): Question | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { text, options, hands } = value as Record<string, unknown>;
	if (typeof text !== "string") return undefined;
	const asked = text.trim();
	if (asked.length === 0) return undefined;
	const offered = Array.isArray(options) ? options : [];
	const kept = offered
		.filter((one): one is string => typeof one === "string")
		.map((one) => one.trim())
		.filter((one) => one !== "" && one.length <= OPTION_CHARS);
	// A card with nothing to press is a paragraph again, and the one exception is the card that
	// already has a button on it: asking for hands puts the keyboard where the operator can take it,
	// whatever else was written.
	if (kept.length === 0 && hands !== true) return undefined;
	return {
		text: asked.slice(0, QUESTION_CHARS),
		options: [...new Set(kept)].slice(0, MOST_OPTIONS),
		...(hands === true ? { hands: true } : {}),
	};
}

/**
 * Reads the questions a turn left behind, dropping anything that does not read as one.
 *
 * Read here as well as written by a tool, because the tool is a convenience inside a sandbox where
 * the agent has a shell and could write this file by hand. One at a time rather than all or nothing,
 * on the console queue's terms: an agent that got its second card wrong should still have its first
 * one put up.
 */
export function parseQuestions(text: string): readonly Question[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	return parsed
		.map(readOne)
		.filter((one): one is Question => one !== undefined)
		.slice(0, MOST_QUESTIONS);
}
