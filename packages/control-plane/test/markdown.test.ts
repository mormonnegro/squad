import { describe, expect, it } from "vitest";
import { MarkdownStream, renderInline, safeEnd } from "../src/markdown.ts";

/** Feeds the text one character at a time: the worst granularity a stream can present. */
function stream(deltas: readonly string[], color = true): string {
	let out = "";
	const md = new MarkdownStream({ write: (text) => (out += text), color });
	for (const delta of deltas) md.push(delta);
	md.end();
	return out;
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
