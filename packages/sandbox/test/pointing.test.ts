import { describe, expect, it } from "vitest";
import {
	askedAbout,
	labelOf,
	likely,
	MOST_OPTIONS,
	NONE,
	type Outline,
	type Pointing,
	pickedIn,
	readOutline,
	readPointing,
	refOf,
	SURE_ENOUGH,
	spentOn,
} from "../image/pointing.ts";

const POINTING: Pointing = {
	endpoint: "https://api.typesafe.ai/v1/systemone",
	model: "jev-latest",
	rate: { input: 0.042, output: 0 },
};

const PAGE: Outline = {
	url: "https://shop.test/checkout",
	title: "Checkout",
	rows: ['[1] a "Back to basket"', '[2] input email "Email"', '[3] button "Continue to payment"'],
	text: "Step 2 of 3. Enter your email to continue.",
};

describe("what the plane chose", () => {
	it("reads the file the plane wrote", () => {
		expect(readPointing(JSON.stringify(POINTING))).toEqual(POINTING);
	});

	it("is nothing at all when the file is not one", () => {
		expect(readPointing("{")).toBeUndefined();
		expect(readPointing(JSON.stringify({ model: "jev-latest" }))).toBeUndefined();
	});

	/** A plane that knew about the model before it knew what it cost still has to work. */
	it("counts a model nobody priced as free rather than refusing it", () => {
		const read = readPointing(JSON.stringify({ endpoint: "https://x.test", model: "m" }));
		expect(read?.rate).toEqual({ input: 0, output: 0 });
	});
});

describe("the page as options", () => {
	it("reads the outline the browser handed over", () => {
		expect(readOutline(JSON.stringify(PAGE))).toEqual(PAGE);
	});

	it("is nothing when what came back is not a page", () => {
		expect(readOutline(undefined)).toBeUndefined();
		expect(readOutline("not json")).toBeUndefined();
		expect(readOutline(JSON.stringify({ url: "x" }))).toBeUndefined();
	});

	it("takes a row apart into the number and the words", () => {
		expect(refOf('[3] button "Continue to payment"')).toBe(3);
		expect(labelOf('[3] button "Continue to payment"')).toBe('button "Continue to payment"');
		expect(refOf("no number here")).toBeUndefined();
	});

	it("offers every row when there are few enough of them", () => {
		expect(likely(PAGE.rows, "the continue button")).toEqual(PAGE.rows);
	});

	/** What gets cut is what shares nothing with the request, and the page's order is kept. */
	it("keeps the rows that share a word with what was asked for", () => {
		const rows = [
			...Array.from({ length: MOST_OPTIONS }, (_, at) => `[${at + 1}] a "Article ${at + 1}"`),
			`[${MOST_OPTIONS + 1}] button "Continue to payment"`,
		];

		const offered = likely(rows, "the continue button");

		expect(offered).toHaveLength(MOST_OPTIONS);
		expect(offered).toContain(`[${MOST_OPTIONS + 1}] button "Continue to payment"`);
		expect(offered[0]).toBe('[1] a "Article 1"');
	});
});

describe("the question", () => {
	it("asks one choice over the rows, by their numbers, with a way out", () => {
		const asked = JSON.parse(askedAbout(POINTING, "the continue button", PAGE)) as {
			model: string;
			state: { page: string; says: string };
			questions: {
				which: { type: string; instructions: string; criteria: Record<string, string> };
			};
		};

		expect(asked.model).toBe("jev-latest");
		expect(asked.state.page).toBe("Checkout — https://shop.test/checkout");
		expect(asked.questions.which.type).toBe("choice");
		// Short on purpose: the long version of this line halved the confidence on an obvious answer.
		expect(asked.questions.which.instructions).toBe("Which one is: the continue button?");
		expect(Object.keys(asked.questions.which.criteria)).toEqual(["1", "2", "3", NONE]);
		expect(asked.questions.which.criteria["3"]).toBe('button "Continue to payment"');
	});

	/** An article is not what is being decided, and a whole one would cost more than the answer. */
	it("carries only the top of what the page says", () => {
		const asked = JSON.parse(
			askedAbout(POINTING, "anything", { ...PAGE, text: "x".repeat(9000) }),
		) as { state: { says: string } };

		expect(asked.state.says).toHaveLength(2000);
	});
});

describe("the answer", () => {
	const answered = (choice: string, confidence: number): unknown => ({
		answers: { which: { type: "choice", choice, confidence } },
		usage: { input_tokens: 1000, output_tokens: 10 },
	});

	it("is the row it picked, when it is sure enough to press it", () => {
		expect(pickedIn(answered("3", 0.91))).toEqual({ ref: 3, confidence: 0.91 });
	});

	/** Below the floor the agent reads the page and picks for itself, which is the old turn. */
	it("is nothing when it is not sure", () => {
		expect(pickedIn(answered("3", SURE_ENOUGH - 0.01))).toBeUndefined();
	});

	it("is nothing when none of them was it", () => {
		expect(pickedIn(answered(NONE, 0.99))).toBeUndefined();
	});

	it("is nothing when the answer is not a row at all", () => {
		expect(pickedIn(answered("the third one", 0.99))).toBeUndefined();
		expect(pickedIn({})).toBeUndefined();
	});

	it("counts what it cost, which is a fraction of a cent and is still counted", () => {
		const usage = spentOn(POINTING, answered("3", 0.9));

		expect(usage.input).toBe(1000);
		expect(usage.totalTokens).toBe(1010);
		expect(usage.cost.total).toBeCloseTo(0.000042, 9);
	});
});
