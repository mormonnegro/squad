import { safeEnd as THEIRS } from "@squad/control-plane";
import { describe, expect, it } from "vitest";
import { blocks, inline } from "../src/markdown.tsx";
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

	it("gathers the rows of a table, and drops the row that only says how it leans", () => {
		const [only] = blocks(
			"| Dominio | DR | Ahrefs Rank |\n|---|---|---|\n| **krea.ai** | 76 | 28.910 |\n| artificialstudio.ai | 37 | 2.042.022 |",
		);

		expect(only).toEqual({
			kind: "table",
			head: ["Dominio", "DR", "Ahrefs Rank"],
			rows: [
				["**krea.ai**", "76", "28.910"],
				["artificialstudio.ai", "37", "2.042.022"],
			],
			// Nothing said which way the columns lean, so the columns said it: two of figures, one of
			// prose, and a comparison is read down the last digit.
			leans: ["left", "right", "right"],
		});
	});

	it("takes the lean row over what the figures would have said", () => {
		const [only] = blocks("| a | b |\n|:-:|:--|\n| 1 | 2 |");
		expect(only?.kind === "table" ? only.leans : []).toEqual(["center", "left"]);
	});

	it("squares a row that is short of cells against its header", () => {
		const [only] = blocks("| a | b | c |\n| 1 |");
		expect(only?.kind === "table" ? only.rows : []).toEqual([["1", "", ""]]);
	});

	// One is a line of prose that happens to start with a pipe, which is how the terminal reads it.
	it("does not make a table out of one row", () => {
		expect(blocks("| just a line |")).toEqual([{ kind: "para", text: "| just a line |" }]);
	});

	it("keeps an escaped pipe inside its cell", () => {
		const [only] = blocks("| a | b |\n| one \\| two | three |");
		expect(only?.kind === "table" ? only.rows : []).toEqual([["one | two", "three"]]);
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

describe("an address, which arrives as itself far more often than as a mark", () => {
	/** What the browser would be handed if the node were clicked, or nothing if it cannot be. */
	const clicked = (node: unknown): unknown =>
		(node as { props?: { href?: string } } | null)?.props?.href;

	it("draws a bare address as something to click", () => {
		const [only] = inline("https://squad.dev/docs");
		expect(clicked(only)).toBe("https://squad.dev/docs");
	});

	// The one that started this: a login URL is mostly query string, and every `_` in it used to open
	// an emphasis that closed further down, so what was on screen to copy had `response_type` and
	// `client_id` with their underscores eaten out of them.
	it("keeps a query string whole, underscores and all", () => {
		const url =
			"https://app.ahrefs.com/web/oauth/authorize?response_type=code&client_id=xGt%2F79&state=nf0a";
		expect(inline(url).map(clicked)).toEqual([url]);
	});

	it("leaves the full stop that ended the sentence outside the link", () => {
		const [text, link, stop] = inline("mirá https://squad.dev/docs.");
		expect(text).toBe("mirá ");
		expect(clicked(link)).toBe("https://squad.dev/docs");
		expect(stop).toBe(".");
	});

	// The bracket is the address's own, so dropping it asks for a page that is not there.
	it("keeps a bracket the address opened itself", () => {
		const [open, link, shut] = inline("(https://en.wikipedia.org/wiki/Squad_(band))");
		expect(open).toBe("(");
		expect(clicked(link)).toBe("https://en.wikipedia.org/wiki/Squad_(band)");
		expect(shut).toBe(")");
	});

	it("hands the browser nothing it should not open", () => {
		expect(inline("javascript:alert(1)").map(clicked)).toEqual([undefined]);
	});

	it("still reads an address that was written as a mark", () => {
		const [only] = inline("[el repo](https://example.com)");
		expect(clicked(only)).toBe("https://example.com");
	});

	it("leaves an address inside a code span as the characters it was", () => {
		expect(inline("`https://squad.dev`").map(clicked)).toEqual([undefined]);
	});
});

/*
 * A port an agent opened, which arrives written as a path.
 *
 * `/serve` cannot answer with an address: the plane has no way of knowing which address the console
 * is being read at. This end does, so the path is drawn as the link it means — and until it was, the
 * one thing on that answer a person could click was the other line, which is a port on the machine a
 * terminal console happens to be running on and is nothing the rest of the time.
 */
describe("a port an agent opened, written into what it said", () => {
	/** Whose port a node says it is, or nothing if it is not one. */
	const port = (node: unknown): unknown => {
		const props = (node as { props?: { agentId?: string; port?: number } } | null)?.props;
		return props?.agentId === undefined ? undefined : `${props.agentId}:${props.port}`;
	};

	it("draws the path `/serve` answers with as the port it names", () => {
		const [text, link] = inline("  /at/dev/3101/");
		expect(text).toBe("  ");
		expect(port(link)).toBe("dev:3101");
	});

	it("takes an agent whose name has dashes in it", () => {
		expect(inline("/at/dev-two/8080/").map(port)).toEqual(["dev-two:8080"]);
	});

	it("keeps the page under it, which is what the agent meant", () => {
		const [link] = inline("/at/dev/3101/dashboard");
		expect(port(link)).toBe("dev:3101");
		expect((link as { props: { path: string } }).props.path).toBe("dashboard");
	});

	// The same trimming a bare address gets: the stop belongs to the sentence.
	it("leaves the full stop that ended the sentence outside it", () => {
		const [link, stop] = inline("/at/dev/3101/.");
		expect((link as { props: { path: string } }).props.path).toBe("");
		expect(stop).toBe(".");
	});

	it("leaves a path that is not one alone", () => {
		expect(inline("/at/dev/").map(port)).toEqual([undefined]);
		expect(inline("/atlas/dev/3101/").map(port)).toEqual([undefined]);
	});
});

describe("underscores inside a word", () => {
	/** What the pieces are, so a run that stayed text can be told from one that became a mark. */
	const marks = (text: string): string[] =>
		inline(text).map((one) =>
			typeof one === "string" ? "text" : ((one as { type?: unknown }).type as string) || "node",
		);

	// A Stripe payload is most of a screen of these, and `evt_real_1` drawn as `evt<em>real</em>1`
	// is a page quietly rewriting the identifier somebody is trying to read.
	it("are underscores, not emphasis", () => {
		expect(marks("evt_real_1")).toEqual(["text"]);
		expect(marks('{"id":"evt_real_1"}')).toEqual(["text"]);
		expect(marks("sub_abc__def")).toEqual(["text"]);
	});

	it("still open emphasis at the edge of a word", () => {
		expect(marks("_sí_")).toEqual(["em"]);
		expect(marks("__muy__")).toEqual(["strong"]);
		expect(marks("dice _esto_ acá")).toEqual(["text", "em", "text"]);
	});
});
