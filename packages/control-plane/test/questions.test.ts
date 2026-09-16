import { describe, expect, it } from "vitest";
import {
	MOST_OPTIONS,
	MOST_QUESTIONS,
	OPTION_CHARS,
	parseQuestions,
	QUESTION_CHARS,
} from "../src/questions.ts";

/*
 * What the plane will act on, read out of a file the agent could have written by hand.
 *
 * The tool that writes it refuses most of this already, and that is not the boundary: the agent has
 * a shell in the container the file lives in. So the rules are here too, and here they are the ones
 * that hold.
 */
describe("reading what a turn left behind", () => {
	it("reads a question and the answers it wrote", () => {
		const read = parseQuestions(
			JSON.stringify([{ text: "¿Qué tarifa?", options: ["Light $683", "Comfort $793"] }]),
		);

		expect(read).toEqual([{ text: "¿Qué tarifa?", options: ["Light $683", "Comfort $793"] }]);
	});

	it("is nothing at all when the file is not a list", () => {
		// Nothing rather than an empty list, because the two mean different things upstream: a turn
		// that asked nothing leaves whatever card was already up standing.
		expect(parseQuestions("not json")).toBeUndefined();
		expect(parseQuestions(JSON.stringify({ text: "x", options: ["a"] }))).toBeUndefined();
	});

	it("drops a card with nothing to press", () => {
		expect(parseQuestions(JSON.stringify([{ text: "¿Cuál?", options: [] }]))).toEqual([]);
		expect(parseQuestions(JSON.stringify([{ text: "¿Cuál?" }]))).toEqual([]);
	});

	it("keeps one with nothing to press when it is asking for hands", () => {
		// That card has the keyboard button on it, which is something to press.
		expect(parseQuestions(JSON.stringify([{ text: "Firmá acá", hands: true }]))).toEqual([
			{ text: "Firmá acá", options: [], hands: true },
		]);
	});

	it("drops the entries that are not questions and keeps the ones that are", () => {
		// One at a time rather than all or nothing, on the console queue's terms: an agent that got its
		// second card wrong should still have its first one put up.
		const read = parseQuestions(
			JSON.stringify([{ text: "ok", options: ["A"] }, 7, null, { text: "   ", options: ["A"] }]),
		);

		expect(read).toEqual([{ text: "ok", options: ["A"] }]);
	});

	it("holds the caps itself, whatever the file says", () => {
		const read = parseQuestions(
			JSON.stringify(
				Array.from({ length: MOST_QUESTIONS + 2 }, () => ({
					text: "q".repeat(QUESTION_CHARS + 50),
					options: Array.from({ length: MOST_OPTIONS + 3 }, (_, index) => `answer ${index}`),
				})),
			),
		);

		expect(read).toHaveLength(MOST_QUESTIONS);
		expect(read?.[0]?.text).toHaveLength(QUESTION_CHARS);
		expect(read?.[0]?.options).toHaveLength(MOST_OPTIONS);
	});

	it("drops an option too long to be a button rather than cutting it", () => {
		// Cut, it would be a message that says something the agent never wrote — and the option text
		// is the message. Better one fewer button.
		const read = parseQuestions(
			JSON.stringify([{ text: "¿Cuál?", options: ["A", "b".repeat(OPTION_CHARS + 1)] }]),
		);

		expect(read).toEqual([{ text: "¿Cuál?", options: ["A"] }]);
	});

	it("takes two of the same answer as one", () => {
		expect(parseQuestions(JSON.stringify([{ text: "¿Cuál?", options: ["Sí", "Sí"] }]))).toEqual([
			{ text: "¿Cuál?", options: ["Sí"] },
		]);
	});
});
