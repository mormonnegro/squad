import { describe, expect, it } from "vitest";
import type { Outline, Pointing } from "../image/pointing.ts";
import {
	askedToStep,
	MOVE_KEY,
	movedIn,
	SURE_ENOUGH_TO_MOVE,
	TARGET_KEY,
	walked,
} from "../image/steering.ts";

const pointing: Pointing = {
	endpoint: "https://api.typesafe.ai/v1/systemone",
	model: "jev-latest",
	rate: { input: 0.042, output: 0 },
};

const page: Outline = {
	url: "https://es.wikipedia.org/wiki/Caf%C3%A9",
	title: "Café",
	text: "El café es una bebida que se obtiene del grano tostado.",
	rows: ['[1] a "Brasil"', '[2] a "Colombia"', '[3] a "Historia"'],
};

/**
 * The request that decides a step, which is the whole of why a walk costs no turn of the model.
 *
 * Two questions over one observation: what should happen here, and to what. Asked separately they
 * would be two round trips and two answers about two different readings of the page — and the
 * second one would have been asked after the first had already been acted on.
 */
describe("asking what to do next", () => {
	const asked = (trail: readonly string[] = []) =>
		JSON.parse(askedToStep(pointing, "la página de los Rolling Stones", page, trail));

	it("asks the move and the target in one request", () => {
		const body = asked();

		expect(Object.keys(body.questions)).toEqual([MOVE_KEY, TARGET_KEY]);
	});

	it("offers four moves and no others, because this is a list and not a language", () => {
		expect(Object.keys(asked().questions[MOVE_KEY].criteria).sort()).toEqual([
			"click",
			"done",
			"scroll",
			"stuck",
		]);
	});

	it("offers the rows of the page as the things to press", () => {
		expect(Object.keys(asked().questions[TARGET_KEY].criteria)).toEqual(["1", "2", "3"]);
	});

	// What stops a walk going round in circles: the only place this API takes free words is the
	// instructions, so what was already pressed goes there.
	it("carries what it already pressed, so it does not press it again", () => {
		const body = asked(["Brasil", "Colombia"]);

		expect(body.questions[MOVE_KEY].instructions).toContain("Already pressed: Brasil, Colombia");
		expect(body.questions[TARGET_KEY].instructions).toContain("Already pressed");
	});

	// The last few and not the whole history: a classifier reading a paragraph of it is answering a
	// harder question than the one being asked.
	it("carries the last few rather than everything it ever did", () => {
		const body = asked(["uno", "dos", "tres", "cuatro", "cinco"]);

		expect(body.questions[MOVE_KEY].instructions).not.toContain("uno");
		expect(body.questions[MOVE_KEY].instructions).toContain("cinco");
	});

	it("hands over where it is and a little of what the page says", () => {
		const body = asked();

		expect(body.state.page).toContain("Café");
		expect(body.state.says).toContain("El café es una bebida");
	});
});

describe("reading the move back", () => {
	const answered = (choice: string, confidence: number) => ({
		answers: { [MOVE_KEY]: { choice, confidence } },
	});

	it("takes the four it offered", () => {
		expect(movedIn(answered("click", 0.9))).toBe("click");
		expect(movedIn(answered("scroll", 0.9))).toBe("scroll");
		expect(movedIn(answered("done", 0.9))).toBe("done");
		expect(movedIn(answered("stuck", 0.9))).toBe("stuck");
	});

	/**
	 * Unsure stops the walk and hands the page back, which is the right way round: being wrong here
	 * costs a press on the wrong thing, and being cautious costs one turn of the model — the thing
	 * the walk was saving in the first place, and worth spending when it does not know.
	 */
	it("commits to nothing it is unsure of", () => {
		expect(movedIn(answered("click", SURE_ENOUGH_TO_MOVE - 0.01))).toBeUndefined();
		expect(movedIn(answered("click", SURE_ENOUGH_TO_MOVE))).toBe("click");
	});

	it("refuses a word it never offered", () => {
		expect(movedIn(answered("navigate", 0.99))).toBeUndefined();
		expect(movedIn({ answers: {} })).toBeUndefined();
		expect(movedIn({})).toBeUndefined();
	});
});

/**
 * What the model that thinks is told afterwards, which is the first it hears of any of it.
 *
 * A walk that stopped for a different reason than it looks like is a walk an agent runs again
 * expecting a different answer, so each ending says which it was in words.
 */
describe("what the walk says it did", () => {
	it("says where it went, in order", () => {
		expect(walked(["Brasil", "Café de Brasil"], "done", "el café brasileño")).toContain(
			"Brasil → Café de Brasil",
		);
	});

	it("says it arrived", () => {
		expect(walked(["Brasil"], "done", "el café brasileño")).toContain("el café brasileño");
	});

	it("tells running out of steps from having nowhere to go", () => {
		expect(walked([], "most", "x")).toContain("step limit");
		expect(walked([], "stuck", "x")).toContain("no way further");
		expect(walked([], "unsure", "x")).toContain("no longer sure");
	});

	it("says plainly when it pressed nothing at all", () => {
		expect(walked([], "stuck", "x")).toContain("Nothing was pressed");
	});
});
