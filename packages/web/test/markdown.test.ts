import { safeEnd as THEIRS } from "@squad/control-plane";
import { describe, expect, it } from "vitest";
import { blocks } from "../src/markdown.tsx";
import { safeEnd as OURS } from "../src/safe-end.ts";

describe("cutting the text into what it is made of", () => {
	it("keeps a paragraph a paragraph", () => {
		expect(blocks("hola\nque tal")).toEqual([{ kind: "para", text: "hola\nque tal" }]);
	});

	it("splits paragraphs on a blank line", () => {
		expect(blocks("uno\n\ndos").map((b) => b.kind)).toEqual(["para", "para"]);
	});

	// Inside a fence a `#` is code and a blank line is a blank line. Treating them as marks is how a
	// shell script becomes six headings.
	it("lets a fence swallow everything up to its close", () => {
		const [only] = blocks("```sh\n# not a heading\n\nls -la\n```");
		expect(only).toEqual({ kind: "fence", language: "sh", code: "# not a heading\n\nls -la" });
	});

	// Which is what one looks like while it is still arriving a piece at a time.
	it("runs an unclosed fence to the end", () => {
		const [only] = blocks("```\nhalf of it");
		expect(only).toEqual({ kind: "fence", language: "", code: "half of it" });
	});

	it("gathers the lines of a list into one", () => {
		const [only] = blocks("- uno\n- dos\n- tres");
		expect(only).toEqual({ kind: "list", ordered: false, items: ["uno", "dos", "tres"] });
	});

	it("tells a numbered list from a bulleted one", () => {
		expect(blocks("1. uno\n2. dos")[0]).toEqual({
			kind: "list",
			ordered: true,
			items: ["uno", "dos"],
		});
	});

	it("reads a heading and how deep it is", () => {
		expect(blocks("### tres")[0]).toEqual({ kind: "heading", depth: 3, text: "tres" });
	});

	it("leaves text that is not a mark alone", () => {
		expect(blocks("2026-09-10 fue un jueves")[0]).toEqual({
			kind: "para",
			text: "2026-09-10 fue un jueves",
		});
	});
});

describe("how much of a half-written line to draw", () => {
	// The browser cannot import the plane's copy, so this is what stops the two from drifting and
	// showing the same delta two different ways in two windows onto one plane.
	it("stops exactly where the plane stops", () => {
		for (const half of [
			"todo listo",
			"esto es **impor",
			"esto es **importante** y",
			"un `coman",
			"un `comando` y",
			"mirá [el repo](https://exa",
			"mirá [el repo](https://example.com) ahí",
			"*",
			"**",
			"a * b",
		]) {
			expect(OURS(half)).toBe(THEIRS(half));
		}
	});

	it("holds back an unclosed marker and everything after it", () => {
		expect("esto es **impor".slice(0, OURS("esto es **impor"))).toBe("esto es ");
	});

	it("lets a settled line through whole", () => {
		const done = "esto es **importante**";
		expect(OURS(done)).toBe(done.length);
	});
});
