import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A question the agent puts to its operator, and the answers it has written for them to click.
 *
 * Apart from the extension that registers the tool, for the reason the booking rules and the console
 * queue are apart from theirs: that file imports pi and typebox, neither of which exists outside the
 * image, so anything living in it is never typechecked and never run until an operator is watching.
 * What is worth testing is not that a file gets written but what counts as a question — and what an
 * agent is told about one, since being told the wrong thing here is how a turn ends up waiting on
 * something that was never going to arrive inside it.
 *
 * The shape is the whole idea. An agent that needs a decision used to write a paragraph: three
 * fares, what each includes, and a sentence at the bottom asking which one — read minutes later by
 * somebody who then has to type the answer back in their own words, hoping they match. The options
 * are that paragraph turned into things to press, and pressing one *is* the reply: the text of the
 * option is the message the operator sends, so there is nothing to translate at either end.
 */

/**
 * How many one turn may put up at once.
 *
 * Three rather than ten, unlike the console queue, because these are not steps: every one of them
 * stops and waits for a person, and a turn that ends with five questions on the screen is a turn
 * that has handed its work back rather than done any. The cap is in the tool so an agent finds out
 * inside the turn, and again at the plane, which is what actually holds — the agent has a shell.
 */
export const MOST_QUESTIONS = 3;

/**
 * How many answers one question may offer.
 *
 * Six is a column of buttons somebody reads at a glance. More than that is a menu, and a menu is
 * what the message box is for — an agent with eleven things to offer should be offering the five
 * that matter and saying so.
 */
export const MOST_OPTIONS = 6;

/** Long enough for "Comfort $793 — facturado 23 kg, comida, asiento", short enough to be a button. */
export const OPTION_CHARS = 140;

/** Long enough to say what is being decided, short enough that the buttons are still on the screen. */
export const QUESTION_CHARS = 700;

export interface Question {
	/** What is being asked, in the agent's own words and in the language it is being spoken to in. */
	readonly text: string;
	/**
	 * The answers, each one a message the operator sends by pressing it.
	 *
	 * Written as the reply rather than as a label: "Light $683" is what arrives at the next turn, so
	 * an option that reads "option 1" is an agent that will be told "option 1" and no more.
	 */
	readonly options: readonly string[];
	/**
	 * Set when what is needed is the operator's hands rather than their answer: a click the agent
	 * cannot reach, a password, a code out of somebody's phone.
	 *
	 * What it changes is the card: a button that takes the keyboard off the agent and puts the
	 * browser in front of the person, beside the answers. Without it the question is a decision and
	 * the screen is not part of it.
	 */
	readonly hands?: boolean;
}

/** The list to write back, and what to tell the agent about the one it just put up. */
export interface Asked {
	readonly asked: readonly Question[];
	readonly text: string;
}

function readOne(value: unknown): Question | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { text, options, hands } = value as Record<string, unknown>;
	if (typeof text !== "string" || text.trim().length === 0) return undefined;
	if (!Array.isArray(options)) return undefined;
	const kept = options.filter((one): one is string => typeof one === "string" && one.trim() !== "");
	return {
		text,
		options: kept.map((one) => one.trim()),
		...(hands === true ? { hands: true } : {}),
	};
}

/**
 * The questions this turn has already put up, out of whatever the file held.
 *
 * Tolerant on purpose: no file yet and a file left half-written are the same situation from here,
 * and in both the right thing is to treat this call as the turn's first rather than to fail on it.
 */
export function alreadyAsked(raw: string | undefined): Question[] {
	if (raw === undefined) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(readOne)
			.filter((one): one is Question => one !== undefined)
			.slice(0, MOST_QUESTIONS);
	} catch {
		return [];
	}
}

/**
 * Adds one to the list, or says why it is not a question worth putting on somebody's screen.
 *
 * The refusals are all of the same kind: a card that cannot be answered by pressing something is a
 * card that has wasted the one moment the operator was looking at it. Writing no answers is the
 * common way to do that, and it is refused rather than defaulted — a console inventing "done" would
 * be the console answering in a language it guessed at, into a conversation it is not part of. The
 * exception is a card asking for hands, which has the keyboard button on it whatever else was
 * written: that one is let through with a sentence saying which half is missing.
 */
export function askFor(
	question: string,
	options: readonly string[],
	hands: boolean,
	asked: readonly Question[],
): Asked {
	const text = question.trim();
	if (text.length === 0)
		throw new Error("Say what you are asking. An empty question is a card nobody can answer.");
	if (text.length > QUESTION_CHARS) {
		throw new Error(
			`The question is ${text.length} characters and the most is ${QUESTION_CHARS}. What does not fit belongs in your answer, above the card.`,
		);
	}

	const kept = options.map((one) => one.trim()).filter((one) => one !== "");
	// Required, except of a question whose card already has something to press. Asking for hands puts
	// a keyboard button up whatever else is written, so a note with no answers is still answerable —
	// it is just worse, and the sentence says which part is missing rather than refusing the ask.
	if (kept.length === 0 && !hands) {
		throw new Error(
			'Write the answers as well as the question. Each option is the message your operator sends by pressing it, so write them as replies — in the language they are talking to you in — and never as labels like "option 1".',
		);
	}
	if (kept.length > MOST_OPTIONS) {
		throw new Error(
			`${kept.length} options is more than the ${MOST_OPTIONS} that fit. Offer the ones that matter and say in your answer what else there was.`,
		);
	}
	const long = kept.find((one) => one.length > OPTION_CHARS);
	if (long !== undefined) {
		throw new Error(
			`"${long.slice(0, 40)}…" is ${long.length} characters and an option is at most ${OPTION_CHARS}. It is a button, not a paragraph.`,
		);
	}
	// Two buttons that say the same thing are one button and a mistake. Kept in the order written,
	// because the order is the agent's recommendation and the first one is where a thumb lands.
	const distinct = [...new Set(kept)];
	if (asked.length >= MOST_QUESTIONS) {
		throw new Error(
			`You have already asked ${MOST_QUESTIONS} things this turn, which is the most. Every one of them stops and waits for a person.`,
		);
	}

	const queue: Question[] = [
		...asked,
		{ text, options: distinct, ...(hands ? { hands: true } : {}) },
	];
	return {
		asked: queue,
		text: [
			`Asked: ${text}`,
			"",
			`It goes up on your operator's console when this turn ends${where(distinct.length, hands)}.`,
			"",
			"Nothing waits for it. Whichever they press arrives as a message from them, in a turn of its",
			"own — so finish this turn now. If there is work that cannot start until they answer, say so",
			"in your answer and stop; do not book a wakeup to come back and find the same card unanswered.",
			queue.length === 1
				? ""
				: `This is ${queue.length} of the questions you have put up this turn.`,
		]
			.filter((line, index, all) => !(line === "" && all[index - 1] === ""))
			.join("\n")
			.trimEnd(),
	};
}

/** What the card will carry, said back so the agent knows whether it left anything to press. */
function where(options: number, hands: boolean): string {
	const keyboard = hands ? ", and a button that hands them the keyboard on your screen" : "";
	if (options === 0) {
		return " carrying a button that hands them the keyboard on your screen, and nothing else to press — so they will have to type their answer back in their own words. Write the answers next time";
	}
	return `, with ${options === 1 ? "one thing" : `${options} things`} to press${keyboard}`;
}

/** What the file holds now, for a caller that is about to add to it. */
export function holding(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// No file yet: this turn has asked nothing so far, which is what alreadyAsked is about to say.
		return undefined;
	}
}

/** And back, for the plane to find once the turn is over. */
export function keep(path: string, asked: readonly Question[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(asked)}\n`, { encoding: "utf8", mode: 0o600 });
}
