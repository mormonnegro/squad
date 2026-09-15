import { describe, expect, it } from "vitest";
import { boxScript, pageForAgent, readOutline } from "../image/reading.ts";

describe("reading a page back", () => {
	it("takes what the page said about itself", () => {
		const outline = readOutline(
			JSON.stringify({
				url: "https://example.com/",
				title: "Example",
				rows: ['[1] button "Sign in"'],
				text: "Hello",
			}),
		);
		expect(outline?.title).toBe("Example");
		expect(outline?.rows).toEqual(['[1] button "Sign in"']);
	});

	it("survives a page that answers with nonsense", () => {
		// The script runs inside somebody else's page. A site that has replaced JSON.stringify should
		// cost the agent one refusal, not a crash in the screen everyone else is sharing.
		expect(readOutline("not json")).toBeUndefined();
		expect(readOutline(undefined)).toBeUndefined();
		expect(readOutline(JSON.stringify({ url: 4, rows: [1, "[1] a"] }))?.rows).toEqual(["[1] a"]);
	});
});

describe("what the agent is handed", () => {
	const outline = {
		url: "https://example.com/",
		title: "Example",
		rows: ['[1] button "Sign in"'],
		text: "Welcome",
	};

	it("puts what can be acted on before what is merely said", () => {
		const page = pageForAgent(outline);
		expect(page.indexOf("Sign in")).toBeLessThan(page.indexOf("Welcome"));
	});

	it("says every time that the numbers belong to this read", () => {
		// The one thing an agent gets wrong here is holding a ref across a click, so the reminder is
		// on every page rather than in the tool description alone.
		expect(pageForAgent(outline)).toContain("Refs belong to this read");
	});

	it("says so plainly when there is nothing to click", () => {
		expect(pageForAgent({ ...outline, rows: [] })).toContain("Nothing on this page");
	});
});

describe("finding a numbered element", () => {
	it("asks the page for the one it numbered, counting from zero as the array does", () => {
		expect(boxScript(1)).toContain("__squadRefs || [])[0]");
		expect(boxScript(7)).toContain("__squadRefs || [])[6]");
	});

	it("scrolls it into view first, because an element off screen has no place to be clicked", () => {
		expect(boxScript(1)).toContain("scrollIntoView");
	});
});
