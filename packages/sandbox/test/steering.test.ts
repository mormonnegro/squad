import { describe, expect, it } from "vitest";
import type { Outline, Pointing } from "../image/pointing.ts";
import { MOST_OPTIONS } from "../image/pointing.ts";
import {
	askedToStep,
	MOST_SCROLLS,
	MOVE_KEY,
	movedIn,
	offered,
	SURE_ENOUGH_TO_MOVE,
	SURE_ENOUGH_TO_PRESS,
	TARGET_KEY,
	walked,
	wordsFor,
	wordsIn,
	worthPressing,
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

	it("offers a short list of moves and no others, because this is a list and not a language", () => {
		expect(Object.keys(asked().questions[MOVE_KEY].criteria).sort()).toEqual([
			"click",
			"done",
			"scroll",
			"stuck",
			"type",
		]);
	});

	it("offers the rows of the page as the things to press", () => {
		expect(Object.keys(asked().questions[TARGET_KEY].criteria)).toEqual(["1", "2", "3", "none"]);
	});

	/**
	 * The option that makes the number underneath the answer worth reading.
	 *
	 * Without it, sixty options and no escape mean the weight has to land somewhere: the first walk
	 * across Wikipedia chose a row at 0.21 — a spread, not a choice — and every step was refused as
	 * unsure, so it scrolled twelve times and pressed nothing. With it, the same question answers
	 * "none of these" at 0.66 and the walk stops and says so.
	 */
	it("lets it say that none of them leads anywhere", () => {
		expect(asked().questions[TARGET_KEY].criteria.none).toContain("None of these");
	});

	// What stops a walk going round in circles: the only place this API takes free words is the
	// instructions, so the last few presses go there.
	it("carries what it already pressed, so it does not press it again", () => {
		const body = asked(["Brasil", "Colombia"]);

		expect(body.questions[MOVE_KEY].instructions).toContain("Already pressed: Brasil, Colombia");
	});

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

/**
 * The floor that decides whether a walk goes somewhere or wanders, set from measurement.
 *
 * Not comparable to the floor for the move: that is a choice of four and this is a choice of sixty,
 * and the same certainty reads lower when the weight is spread. The numbers here are the ones seen
 * on real pages — 0.84 where the way on was plainly there, 0.66 for `none` where it was not, and
 * 0.21 back when no `none` was offered and the weight had to land somewhere.
 */
describe("how sure is sure enough to press", () => {
	it("refuses the spread that a question with no escape produces", () => {
		expect(SURE_ENOUGH_TO_PRESS).toBeGreaterThan(0.21);
	});

	// And below what a classifier gives a link it is actually confident about, or the walk would
	// refuse the answers it exists to act on.
	it("takes an answer a page with the way on it actually gives", () => {
		expect(SURE_ENOUGH_TO_PRESS).toBeLessThan(0.66);
	});

	/**
	 * A reading of a page is what is drawn on the screen, so a link in the body of a long article
	 * does not exist until it has been scrolled to. Two screens of a twenty screen page is the tool
	 * "only seeing the first viewport", which is what the agent using it reported.
	 */
	it("looks further down a page than the first screen or two", () => {
		expect(MOST_SCROLLS).toBeGreaterThanOrEqual(8);
	});
});

/**
 * Which rows go in front of the classifier, which is what decided whether the first walk could work.
 *
 * A question takes sixty options and a page is two hundred rows. The first version offered the sixty
 * nearest by word overlap — and for "the Rolling Stones page" on an article about coffee, nothing
 * shares a word, so what it offered was the first sixty in page order: the menu, the search box and
 * the language list. It was being asked to find a way on out of the site's furniture.
 */
describe("which rows are offered", () => {
	const rows = Array.from({ length: 600 }, (_, at) => `[${at + 1}] a "row ${at + 1}"`);

	// As many as the classifier will take and no more: over its ceiling it answers "Too many choices"
	// and nothing else, so a page bigger than one question is asked about in windows.
	it("offers a window of them and not the page", () => {
		expect(offered(rows, "anything", new Set()).length).toBe(MOST_OPTIONS);
	});

	it("offers the rest of the page once a window has been asked about", () => {
		const first = offered(rows, "anything", new Set());
		const asked = new Set(first.map((row) => Number(/\[(\d+)\]/.exec(row)?.[1])));
		const second = offered(rows, "anything", asked);

		expect(second.some((row) => first.includes(row))).toBe(false);
		expect(second.length).toBe(MOST_OPTIONS);
	});

	// A goal that names what it is after is answered on the first question, whatever page order says.
	it("puts what the goal names first, wherever it is on the page", () => {
		const said = offered([...rows, '[601] a "Colombia"'], "the article about Colombia", new Set());

		expect(said.some((row) => row.includes("Colombia"))).toBe(true);
	});

	it("runs out rather than offering the same rows again", () => {
		const all = new Set(rows.map((_, at) => at + 1));

		expect(offered(rows, "anything", all)).toEqual([]);
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
		expect(walked([], "unsure", "x")).toContain("could not tell which");
	});

	it("says plainly when it pressed nothing at all", () => {
		expect(walked([], "stuck", "x")).toContain("Nothing was pressed");
	});
});

/**
 * What goes in a box, which is the one thing a classifier cannot answer.
 *
 * A walk that can see a search field and choose it, and then has nothing to put in it, stops at
 * every site whose way on is a search. The words come from the model that looks at pages — already
 * chosen on this plane, already paid for — asked for one string and nothing else.
 */
describe("what to type into a box", () => {
	const question = wordsFor("la página de Wikipedia sobre la Pachamama", 'input search "Buscar"');

	it("carries the goal and the box it is about", () => {
		expect(question).toContain("Pachamama");
		expect(question).toContain("Buscar");
	});

	// The rules that matter for something typing on a page with nobody watching.
	it("forbids the things it must never type", () => {
		expect(question).toContain("Never a password");
		expect(question).toContain("Never anything invented");
	});

	it("takes the string out of the answer", () => {
		expect(wordsIn('{"text": "Pachamama"}')).toBe("Pachamama");
		expect(wordsIn('Sure! {"text": "Pachamama"} — hope that helps')).toBe("Pachamama");
	});

	// Nothing rather than a guess: a walk that types something invented into a search box goes
	// somewhere nobody asked for, and the next step is chosen from there.
	it("takes nothing when the model would not commit", () => {
		expect(wordsIn('{"text": null}')).toBeUndefined();
		expect(wordsIn("no idea, sorry")).toBeUndefined();
		expect(wordsIn('{"text": "   "}')).toBeUndefined();
	});
});

/**
 * Whether the walk may type, which is the caller's to decide and not the classifier's.
 *
 * "Get from this article to that one" and "find me the cheapest flight" are both walks, and only
 * one of them may use the search box: a walk across an encyclopedia that types the destination into
 * the search field has not walked anywhere. Left off the list rather than forbidden in the rules,
 * because a choice that is not offered cannot be made.
 */
describe("walking by what the pages offer", () => {
	const moves = (typing: boolean) =>
		Object.keys(
			JSON.parse(askedToStep(pointing, "the Pachamama article", page, [], new Set(), typing))
				.questions[MOVE_KEY].criteria,
		).sort();

	it("offers typing when the caller allows it", () => {
		expect(moves(true)).toContain("type");
	});

	it("does not offer it at all when the walk is to follow links", () => {
		expect(moves(false)).not.toContain("type");
		expect(moves(false)).toEqual(["click", "done", "scroll", "stuck"]);
	});

	// The boxes are their own question, asked only when there is a box and permission to type into
	// one. A head with no options is a refusal, and an unused head is a question paid for and unread.
	it("asks about the boxes separately, and only when there are any", () => {
		const withBox = JSON.parse(
			askedToStep(
				pointing,
				"x",
				{ ...page, rows: [...page.rows, '[9] input search "Buscar"'] },
				[],
				new Set(),
				true,
			),
		);
		expect(Object.keys(withBox.questions)).toContain("field");
		expect(Object.keys(withBox.questions.field.criteria)).toEqual(["9", "none"]);

		const noBox = JSON.parse(askedToStep(pointing, "x", page, [], new Set(), true));
		expect(Object.keys(noBox.questions)).not.toContain("field");
	});

	// And a box is never offered as something to press: a walk that presses a text field arrives
	// nowhere, which is what it did on every page with a search box on it.
	it("keeps the boxes out of the things to press", () => {
		const body = JSON.parse(
			askedToStep(pointing, "x", { ...page, rows: [...page.rows, '[9] input search "Buscar"'] }),
		);

		expect(Object.keys(body.questions[TARGET_KEY].criteria)).not.toContain("9");
	});
});

/**
 * What goes in a box, which is the one thing a classifier cannot answer.
 *
 * The words come from the model that looks at pages — already chosen on this plane, already paid
 * for — asked for one string and nothing else.
 */
describe("what to type into a box", () => {
	const question = wordsFor("la página de Wikipedia sobre la Pachamama", 'input search "Buscar"');

	it("carries the goal and the box it is about", () => {
		expect(question).toContain("Pachamama");
		expect(question).toContain("Buscar");
	});

	it("forbids the things it must never type", () => {
		expect(question).toContain("Never a password");
		expect(question).toContain("Never anything invented");
	});

	it("takes the string out of the answer", () => {
		expect(wordsIn('{"text": "Pachamama"}')).toBe("Pachamama");
		expect(wordsIn('Sure! {"text": "Pachamama"} — hope that helps')).toBe("Pachamama");
	});

	// Nothing rather than a guess: a walk that types something invented into a search box goes
	// somewhere nobody asked for, and every step after that is chosen from there.
	it("takes nothing when the model would not commit", () => {
		expect(wordsIn('{"text": null}')).toBeUndefined();
		expect(wordsIn("no idea, sorry")).toBeUndefined();
		expect(wordsIn('{"text": "   "}')).toBeUndefined();
	});
});

/**
 * Whether an answer is worth acting on, judged against its own alternatives rather than a number.
 *
 * Two afternoons went into learning that a fixed floor cannot work here. Confidence spreads over
 * the options offered: the right link for "the article about Colombia" comes back at 0.26 out of
 * two hundred and fifty, and a floor of 0.35 refuses it — while 0.25 lets through a weak answer
 * that sent the walk round a loop, pressing the same link four times. What the number means is only
 * clear beside `none`, the option that says the page has nothing.
 */
describe("whether to press what came back", () => {
	const answered = (choice: string, weights: Record<string, number>) => ({
		answers: { which: { choice, confidence: weights[choice] ?? 0, probabilities: weights } },
	});

	it("presses a thin answer that is clearly over none", () => {
		expect(worthPressing(answered("73", { 73: 0.26, 12: 0.1, none: 0.04 }), "which")).toMatchObject(
			{ ref: 73 },
		);
	});

	it("refuses one that none beats", () => {
		expect(worthPressing(answered("73", { 73: 0.2, none: 0.66 }), "which")).toBeUndefined();
	});

	// Not a rounding away from it either: a link the page cannot tell from nothing is nothing.
	it("refuses one that merely ties with none", () => {
		expect(worthPressing(answered("73", { 73: 0.3, none: 0.28 }), "which")).toBeUndefined();
	});

	it("refuses none itself, however sure of it", () => {
		expect(worthPressing(answered("none", { none: 0.99 }), "which")).toBeUndefined();
		expect(worthPressing({ answers: {} }, "which")).toBeUndefined();
	});
});
