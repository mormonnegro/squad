import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { MarkdownStream, renderInline, renderTable, safeEnd } from "../src/markdown.ts";

/** Feeds the text one character at a time: the worst granularity a stream can present. */
function stream(deltas: readonly string[], color = true, width = 80): string {
	let out = "";
	const md = new MarkdownStream({ write: (text) => (out += text), color, width });
	for (const delta of deltas) md.push(delta);
	md.end();
	return out;
}

/** The lines as a reader sees them: the decoration counted for nothing, which is what it occupies. */
function plain(text: string): readonly string[] {
	return text.split("\n").map(stripVTControlCharacters);
}

const chars = (text: string): readonly string[] => [...text];

describe("safeEnd", () => {
	it("holds back an unclosed marker, which is not yet emphasis", () => {
		expect(safeEnd("un **compil")).toBe(3);
		expect(safeEnd("un *compil")).toBe(3);
		expect(safeEnd("un `sess")).toBe(3);
		expect(safeEnd("ver [la doc")).toBe(4);
	});

	it("lets a closed span through", () => {
		expect(safeEnd("un **compilador** es")).toBe("un **compilador** es".length);
		expect(safeEnd("ver [doc](http://x) y")).toBe("ver [doc](http://x) y".length);
	});

	it("does not mistake the inside of a span for a new one", () => {
		// The `*` inside the bold is the closer's first half, not an italic that never closes.
		expect(safeEnd("**a *b* c** d")).toBe("**a *b* c** d".length);
	});
});

describe("renderInline", () => {
	it("renders bold, italic, code and links", () => {
		expect(renderInline("un **fuerte**")).toBe("un \u001b[1mfuerte\u001b[22m");
		expect(renderInline("un *suave*")).toBe("un \u001b[3msuave\u001b[23m");
		expect(renderInline("un `código`")).toBe("un \u001b[36mcódigo\u001b[39m");
		expect(renderInline("[doc](http://x)")).toBe(
			"\u001b[4mdoc\u001b[24m\u001b[2m http://x\u001b[22m",
		);
	});

	it("leaves an underscore alone, because identifiers are full of them", () => {
		expect(renderInline("el campo session_id de la fila")).toBe("el campo session_id de la fila");
	});

	it("leaves an unclosed marker as the text it still is", () => {
		expect(renderInline("2 * 3 = 6")).toBe("2 * 3 = 6");
	});

	it("is prefix-stable, which is what makes it safe to stream", () => {
		// Rendering a safe prefix must produce a prefix of the finished line, or something already on
		// screen would have to be taken back — and a terminal cannot take back what has scrolled.
		const line = "un **compilador** traduce `código` a [máquina](http://x) sin *pausa*";
		const whole = renderInline(line);
		for (let index = 0; index <= line.length; index++) {
			const safe = safeEnd(line.slice(0, index));
			expect(whole.startsWith(renderInline(line.slice(0, safe)))).toBe(true);
		}
	});
});

describe("MarkdownStream", () => {
	it("streams a line before it is finished", () => {
		// The point of the whole thing: the words before an open marker are already settled, and
		// holding them until the line ends is what makes an answer arrive a paragraph at a time.
		let out = "";
		const md = new MarkdownStream({ write: (text) => (out += text), color: true });

		md.push("Un compilador es ");

		expect(out).toBe("Un compilador es ");
	});

	it("holds back a marker that has not closed yet", () => {
		let out = "";
		const md = new MarkdownStream({ write: (text) => (out += text), color: true });

		md.push("Un **compil");
		expect(out).toBe("Un ");

		md.push("ador** traduce");
		expect(out).toBe("Un \u001b[1mcompilador\u001b[22m traduce");
	});

	it("renders the same whether it arrives whole or a character at a time", () => {
		const text = "Un **compilador** traduce `código` a máquina.\n\n- **Léxico**: tokeniza\n";

		expect(stream(chars(text))).toBe(stream([text]));
	});

	it("marks a heading without printing its hashes", () => {
		expect(stream(chars("## Un título\n"))).toBe("\u001b[1mUn título\u001b[22m\n");
	});

	it("turns a bullet into a bullet", () => {
		expect(stream(chars("- primero\n"))).toBe("  • primero\n");
		expect(stream(chars("1. primero\n"))).toBe("  1. primero\n");
	});

	it("keeps a nested list nested", () => {
		expect(stream(chars("  - anidado\n"))).toBe("    • anidado\n");
	});

	it("shows code as typed, markers and all", () => {
		const out = stream(chars('```c\nprintf("**hola**");\n```\n'));

		expect(out).toBe(`\u001b[2m  printf("**hola**");\u001b[22m\n`);
	});

	it("does not read a heading inside a fence, because a fence is not markdown", () => {
		const out = stream(chars("```sh\n# un comentario\n```\n"));

		expect(out).toBe("\u001b[2m  # un comentario\u001b[22m\n");
	});

	it("does not take a paragraph that opens with a hash for a heading", () => {
		expect(stream(chars("#1 de la lista\n"))).toBe("#1 de la lista\n");
	});

	it("closes the last line when the stream stops mid-sentence", () => {
		expect(stream(["- a medias"])).toBe("  • a medias\n");
	});

	it("passes the markdown through untouched when nobody is watching a terminal", () => {
		// Redirected into a file or piped into another program, markdown is the format that was asked
		// for, and escape codes would be damage.
		const text = "Un **compilador**\n\n- uno\n";

		expect(stream(chars(text), false)).toBe(text);
	});

	it("ends piped output on a newline, so the next prompt starts where prompts start", () => {
		expect(stream(["sin salto"], false)).toBe("sin salto\n");
		expect(stream(["con salto\n"], false)).toBe("con salto\n");
	});

	it("writes nothing at all when the agent said nothing", () => {
		expect(stream([], true)).toBe("");
		expect(stream([], false)).toBe("");
	});
});

/**
 * A table is a shape before it is words: the eye reads down a column to compare. Pipes that do not
 * line up are worse than none, because the shape is there promising something the rows do not keep.
 */
describe("renderTable", () => {
	const rows = [
		"| Keyword | Pos | Vol |",
		"|---|---|---|",
		"| album cover maker | 19 | 13.000 |",
		"| ai influencer | 7 | 8.800 |",
	];

	it("lines the columns up, whatever length the cells are", () => {
		const [head, rule, first, second] = plain(renderTable(rows, 60).join("\n"));

		expect(head).toBe("Keyword           │ Pos │    Vol");
		expect(rule).toBe("──────────────────┼─────┼───────");
		expect(first).toBe("album cover maker │  19 │ 13.000");
		expect(second).toBe("ai influencer     │   7 │  8.800");
	});

	it("spends the row that only said where the columns are", () => {
		// A header, the rule under it and the two rows that carry data. The dashes were markdown talking
		// to the renderer, and a renderer that prints them is passing the note along to the reader.
		expect(renderTable(rows, 60)).toHaveLength(4);
	});

	it("reads a column of figures down its last digit, because that is how it is compared", () => {
		// Nobody wrote `---:` — plenty of agents never do — and a column of numbers ragged on the right
		// is a column you have to read one cell at a time.
		expect(plain(renderTable(rows, 60).join("\n"))[2]?.endsWith("13.000")).toBe(true);
	});

	it("obeys the alignment when the markdown does say", () => {
		const said = ["| a | b |", "| ---: | :--- |", "| 1 | 2 |"];

		expect(plain(renderTable(said, 40).join("\n"))[2]).toBe("1 │ 2");
	});

	it("folds a long cell inside its own column rather than off the pane", () => {
		const long = [...rows.slice(0, 2), "| a very long keyword indeed | 1 | 2 |"];
		const drawn = plain(renderTable(long, 24).join("\n"));

		for (const line of drawn) expect(stringWidth(line)).toBeLessThanOrEqual(24);
		expect(drawn.length).toBeGreaterThan(3);
	});

	it("counts what an emoji occupies, not what it is stored as", () => {
		const wide = ["| a | b |", "|---|---|", "| 🎯 | x |", "| ab | y |"];
		const drawn = plain(renderTable(wide, 40).join("\n"));

		expect(stringWidth(drawn[2] ?? "")).toBe(stringWidth(drawn[3] ?? ""));
	});
});

describe("a table in a stream", () => {
	const table = "| a | b |\n|---|---|\n| 1 | 2 |\n";

	it("is drawn once its last row is in, which is the one thing here that cannot stream", () => {
		expect(plain(stream(chars(table)))).toEqual(["a │ b", "──┼──", "1 │ 2", ""]);
	});

	it("is drawn the same whether it arrives whole or a character at a time", () => {
		expect(stream(chars(table))).toBe(stream([table]));
	});

	it("ends where the table ends, and takes the paragraph under it as a paragraph", () => {
		expect(plain(stream(chars(`${table}\nLuego.\n`)))).toEqual([
			"a │ b",
			"──┼──",
			"1 │ 2",
			"",
			"Luego.",
			"",
		]);
	});

	it("draws a table the stream stopped in the middle of", () => {
		expect(plain(stream(chars("| a | b |\n|---|---|\n| 1 | 2 |")))).toEqual([
			"a │ b",
			"──┼──",
			"1 │ 2",
			"",
		]);
	});

	it("leaves a lone line that opens with a pipe as the line it is", () => {
		expect(stream(chars("| no es una tabla\n"))).toBe("| no es una tabla\n");
	});

	it("does not read a table inside a fence, because a fence is not markdown", () => {
		const out = stream(chars("```\n| a | b |\n|---|---|\n```\n"));

		expect(plain(out)).toEqual(["  | a | b |", "  |---|---|", ""]);
	});

	it("leaves the pipes alone for whoever asked for markdown", () => {
		expect(stream(chars(table), false)).toBe(table);
	});
});
