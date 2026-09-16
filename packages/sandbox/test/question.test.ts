import { describe, expect, it } from "vitest";
import {
	alreadyAsked,
	askFor,
	MOST_OPTIONS,
	MOST_QUESTIONS,
	OPTION_CHARS,
	QUESTION_CHARS,
} from "../image/question.ts";

const plain = (question: string, options: readonly string[], hands = false) =>
	askFor(question, options, hands, []);

describe("what counts as a question", () => {
	it("keeps the words as written, because the words are the message", () => {
		const asked = plain("¿Qué tarifa?", ["Light $683", "Comfort $793"]);

		expect(asked.asked).toEqual([
			{ text: "¿Qué tarifa?", options: ["Light $683", "Comfort $793"] },
		]);
	});

	it("refuses a card with nothing to press", () => {
		// The whole point is that the answer is a press rather than a paragraph typed back. A question
		// with no options is the paragraph again, with a box drawn round it.
		expect(() => plain("¿Cuál?", [])).toThrow(/Write the answers/);
		expect(() => plain("¿Cuál?", ["  ", ""])).toThrow(/Write the answers/);
	});

	it("allows one with no options when it is asking for hands", () => {
		// That card already has a button on it — the one that takes the keyboard — so it is answerable
		// without any of the agent's own. Worse, and not broken, which is the difference between a
		// refusal and a nudge.
		const asked = plain("Necesito un clic en Continuar", [], true);

		expect(asked.asked).toEqual([{ text: "Necesito un clic en Continuar", options: [], hands: true }]);
		expect(asked.text).toContain("type their answer back");
	});

	it("says a card is going up, and that nothing will wait for it", () => {
		const asked = plain("¿Sigo al checkout?", ["Sí, seguí", "No, pará acá"]);

		expect(asked.text).toContain("2 things to press");
		expect(asked.text).toContain("Nothing waits for it");
		// The failure this sentence exists to prevent: an agent that books a wakeup to come back and
		// look at its own unanswered question, then does it again, forever.
		expect(asked.text).toContain("do not book a wakeup");
	});

	it("says the keyboard button is coming when hands were asked for", () => {
		expect(plain("Firmá acá", ["Listo", "No pude"], true).text).toContain("keyboard on your screen");
		expect(plain("¿Cuál?", ["A", "B"]).text).not.toContain("keyboard");
	});

	it("takes two of the same answer as one", () => {
		// Two buttons that send the same message are one button and a mistake.
		expect(plain("¿Cuál?", ["Sí", "Sí", "No"]).asked[0]?.options).toEqual(["Sí", "No"]);
	});

	it("refuses more options than fit on a card", () => {
		const many = Array.from({ length: MOST_OPTIONS + 1 }, (_, index) => `answer ${index}`);

		expect(() => plain("¿Cuál?", many)).toThrow(new RegExp(`${MOST_OPTIONS}`));
	});

	it("refuses an option that is a paragraph", () => {
		expect(() => plain("¿Cuál?", ["a".repeat(OPTION_CHARS + 1)])).toThrow(/button, not a paragraph/);
	});

	it("refuses a question longer than the card it goes on", () => {
		expect(() => plain("q".repeat(QUESTION_CHARS + 1), ["Sí"])).toThrow(/belongs in your answer/);
	});

	it("refuses an empty question", () => {
		expect(() => plain("   ", ["Sí"])).toThrow(/An empty question/);
	});
});

describe("more than one in a turn", () => {
	it("appends, and counts them out loud", () => {
		const first = plain("¿Cuál?", ["A", "B"]);
		const second = askFor("¿Y la vuelta?", ["Sí", "No"], false, first.asked);

		expect(second.asked).toHaveLength(2);
		expect(second.text).toContain("This is 2 of the questions");
	});

	it("stops at the most a turn may put up", () => {
		let asked = plain("one", ["A"]).asked;
		for (let i = 1; i < MOST_QUESTIONS; i++) asked = askFor(`q${i}`, ["A"], false, asked).asked;

		expect(asked).toHaveLength(MOST_QUESTIONS);
		expect(() => askFor("one more", ["A"], false, asked)).toThrow(/stops and waits for a person/);
	});
});

describe("the file as the next call finds it", () => {
	it("reads back what was written", () => {
		const asked = plain("¿Cuál?", ["A", "B"]).asked;

		expect(alreadyAsked(JSON.stringify(asked))).toEqual(asked);
	});

	it("treats no file and a half-written one as a turn that has asked nothing", () => {
		expect(alreadyAsked(undefined)).toEqual([]);
		expect(alreadyAsked("[{\"text\":")).toEqual([]);
		expect(alreadyAsked("{}")).toEqual([]);
	});

	it("drops entries that are not questions rather than failing on them", () => {
		const raw = JSON.stringify([{ text: "ok", options: ["A"] }, 7, { options: ["A"] }, { text: "x" }]);

		expect(alreadyAsked(raw)).toEqual([{ text: "ok", options: ["A"] }]);
	});
});
