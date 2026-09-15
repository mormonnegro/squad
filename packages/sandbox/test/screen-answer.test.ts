import { describe, expect, it } from "vitest";
import { answerOf, unreachable } from "../image/screen-answer.ts";

const page = JSON.stringify({ text: "Example — https://example.com/" });

describe("what comes back from the screen", () => {
	it("passes a page through as text", () => {
		expect(answerOf(200, page)).toEqual([
			{ type: "text", text: "Example — https://example.com/" },
		]);
	});

	it("puts a picture beside a line about it, never alone", () => {
		expect(answerOf(200, JSON.stringify({ text: "Example", image: "AAA" }))).toEqual([
			{ type: "text", text: "Example" },
			{ type: "image", data: "AAA", mimeType: "image/png" },
		]);
	});

	it("hands a refusal back as the sentence it is", () => {
		expect(answerOf(409, JSON.stringify({ refused: "The operator has the keyboard." }))).toEqual([
			{ type: "text", text: "The operator has the keyboard." },
		]);
	});
});

/*
 * The afternoon this cost. An earlier version looked only for the fields it hoped for and said
 * "Done." when it found none — so a 403 from the egress proxy, which is a perfectly good JSON
 * object with `error` in it, arrived at the model as a success with nothing in it. Two agents spent
 * a turn each reporting that their browser opened pages and showed them nothing, which is a
 * sentence with no failure anywhere in it for anybody to go and look at.
 */
describe("an answer that is not the one expected", () => {
	it("reads a refusal nobody here wrote as a refusal", () => {
		const said = answerOf(
			403,
			JSON.stringify({ error: "egress_denied", reason: "no_matching_host" }),
		);
		expect(said[0]?.type).toBe("text");
		const text = (said[0] as { text: string }).text;
		expect(text).toContain("403");
		// Quoted rather than summarised: whoever reads this next knows more about that body than
		// this code does.
		expect(text).toContain("egress_denied");
	});

	it("says so when the answer was not JSON at all", () => {
		const text = (answerOf(502, "<html>bad gateway</html>")[0] as { text: string }).text;
		expect(text).toContain("502");
		expect(text).toContain("bad gateway");
	});

	it("never turns an empty success into a cheerful nothing", () => {
		const text = (answerOf(200, "{}")[0] as { text: string }).text;
		expect(text).not.toBe("Done.");
		expect(text).toContain("said nothing");
	});
});

describe("when there is no screen at all", () => {
	it("says whose problem it is and stops the agent retrying", () => {
		const said = unreachable("scout", "getaddrinfo ENOTFOUND scout-screen");
		expect(said).toContain("Do not retry");
		expect(said).toContain("/screen on");
	});
});
