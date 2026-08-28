/**
 * What an agent writes down after getting something wrong, and the rules that keep the list short.
 *
 * Apart from the extension that registers the tool, for the same reason the booking rules are apart
 * from wake.ts: that file imports pi and typebox, neither of which is installed outside the image, so
 * nothing living in it is ever typechecked or run until an operator is watching. What is worth
 * testing here is not that a file gets written. It is what happens when the list is full, which is
 * the whole design.
 *
 * Nothing here reads or writes anything. The caller hands in what the file said and puts back what
 * comes out.
 */

/**
 * How many lessons an agent carries.
 *
 * A cap rather than a file that grows, because every line of this is read back on every turn the
 * agent ever takes: a list that only grows is an agent that pays more to think the longer it has
 * been alive, and pays most of all for the lessons it has held longest and needs least.
 *
 * Small enough to hurt, on purpose. Nothing consolidates a list nobody is ever made to consolidate,
 * and an agent that has to merge two lessons before it can write a third is an agent whose twentieth
 * lesson is worth more than its first one was.
 */
export const MOST_LESSONS = 20;

/** One line each. A lesson that needs a paragraph is a note about a project, not a thing learned. */
export const LESSON_CHARS = 200;

export interface Recorded {
	/** The list to write back, whether or not it differs from the one handed in. */
	readonly lessons: readonly string[];
	/** False when the lesson was already held, which is not a failure and not a write either. */
	readonly changed: boolean;
	readonly text: string;
}

/**
 * The lessons out of the file, one per line.
 *
 * Tolerant of the markdown it is written in and of the agent having edited it by hand, which it is
 * expected to do: consolidating the list is the only way past a full one, and it happens in an
 * editor rather than through this tool. A line that is only a bullet or only a blank is not a
 * lesson, and the heading somebody adds one day is dropped along with it.
 */
export function heldLessons(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	return raw
		.split("\n")
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The file as it goes back to disk. Markdown, because the agent reads and edits it as a file too. */
export function lessonsFile(lessons: readonly string[]): string {
	return lessons.map((lesson) => `- ${lesson}`).join("\n") + (lessons.length > 0 ? "\n" : "");
}

/**
 * Adds one lesson, or says why it cannot be added.
 *
 * Refusing rather than dropping the oldest, which is the one decision here worth arguing about. A
 * ring would never bother the agent and would quietly throw away the lesson learned on the first day
 * — which, being the first, is the one most likely to be about this machine rather than about
 * yesterday's task. Refusing puts the choice of what to forget in front of whoever knows what the
 * lessons mean, and costs a minute of a turn that has just finished being wrong about something.
 */
export function record(lesson: string, holding: readonly string[], where: string): Recorded {
	// Folded onto one line rather than refused for having two: an agent that wrote a lesson with a
	// newline in it meant the lesson, and spending a turn teaching it about newlines teaches nothing.
	const one = lesson.replace(/\s+/g, " ").trim();

	if (one.length === 0) {
		throw new Error("A lesson with nothing in it teaches nothing. Say what to do differently.");
	}
	if (one.length > LESSON_CHARS) {
		throw new Error(
			`That is ${one.length} characters and a lesson may be ${LESSON_CHARS}. This gets read back` +
				" to you at the start of every turn you ever take, so write the rule and not the story of" +
				" how you found it out.",
		);
	}

	// Case-insensitively, because the same lesson learned twice is usually the same sentence twice
	// with a different capital at the front, and two of them cost what two lessons cost.
	if (holding.some((held) => held.toLowerCase() === one.toLowerCase())) {
		return {
			lessons: holding,
			changed: false,
			text: "You had written that one down already. Nothing changed.",
		};
	}

	if (holding.length >= MOST_LESSONS) {
		throw new Error(
			`You are holding ${MOST_LESSONS} lessons, which is all you may hold, and nothing is dropped` +
				` for you. Open ${where}, merge two lines that turned out to be the same lesson or delete` +
				" one you have outgrown, and then write this one again. Choosing what to stop carrying is" +
				" the point: this list goes with you into every turn.",
		);
	}

	const lessons = [...holding, one];
	return {
		lessons,
		changed: true,
		text: `Written down. You are carrying ${lessons.length} of ${MOST_LESSONS} lessons.`,
	};
}
