import { describe, expect, it } from "vitest";
import { answerOf, unreachable } from "../image/screen-answer.ts";

describe("what comes back from the screen", () => {
	it("passes a page through as text", () => {
		expect(answerOf({ text: "Example — https://example.com/" })).toEqual([
			{ type: "text", text: "Example — https://example.com/" },
		]);
	});

	it("puts a picture beside a line about it, never alone", () => {
		// An image with no words says nothing in a transcript being read back a week later, and the
		// line is where the address of the page goes.
		expect(answerOf({ text: "Example — https://example.com/", image: "AAA" })).toEqual([
			{ type: "text", text: "Example — https://example.com/" },
			{ type: "image", data: "AAA", mimeType: "image/png" },
		]);
	});

	it("hands a refusal back as the sentence it is", () => {
		expect(answerOf({ refused: "The operator has the keyboard." })).toEqual([
			{ type: "text", text: "The operator has the keyboard." },
		]);
	});

	it("always says something, so a tool call never comes back empty", () => {
		expect(answerOf({})).toEqual([{ type: "text", text: "Done." }]);
		expect(answerOf("nonsense")[0]?.type).toBe("text");
	});
});

describe("when there is no screen at all", () => {
	it("says whose problem it is and stops the agent retrying", () => {
		const said = unreachable("scout", "getaddrinfo ENOTFOUND scout-screen");
		expect(said).toContain("Do not retry");
		// The cure is at a console, typed by somebody who is not the agent. Saying which words leaves
		// the agent something useful to put in its answer instead of a diagnosis it invented.
		expect(said).toContain("/screen on");
	});
});
