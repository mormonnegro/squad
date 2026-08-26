import { describe, expect, it } from "vitest";
import { asHtml } from "../src/markup.ts";

/**
 * What an agent writes is markdown, and a mailbox is not a terminal.
 *
 * The bug these exist for is one anybody can see: an answer arrives reading `**Chiste #1:**`, with a
 * row of dashes under it, because the punctuation of the format went out as text.
 */
describe("asHtml", () => {
	it("draws what the asterisks were for", () => {
		expect(asHtml("**Chiste #1:**")).toContain("<strong>Chiste #1:</strong>");
		expect(asHtml("un _detalle_ menor")).toContain("<em>detalle</em>");
		expect(asHtml("y ~~no~~ esto")).toContain("<del>no</del>");
	});

	it("makes a rule out of a row of dashes, rather than a row of dashes", () => {
		expect(asHtml("antes\n\n---\n\ndespués")).toContain("<hr");
		expect(asHtml("antes\n\n---\n\ndespués")).not.toContain("---");
	});

	it("keeps a heading a heading, at the size it was asked for", () => {
		expect(asHtml("### Resumen")).toContain("<h3");
		expect(asHtml("### Resumen")).toContain("Resumen</h3>");
	});

	it("makes a list out of a list, of either kind", () => {
		expect(asHtml("- uno\n- dos")).toContain("<ul");
		expect(asHtml("- uno\n- dos")).toContain("<li>uno</li><li>dos</li>");
		expect(asHtml("1. uno\n2. dos")).toContain("<ol");
	});

	// The agent this was written for answers questions about SEO, and answers them in tables.
	it("makes a table out of a table", () => {
		const html = asHtml("| Dominio | DR |\n| --- | --- |\n| example.com | 12 |");

		expect(html).toContain("<table");
		expect(html).toContain(">Dominio</th>");
		expect(html).toContain(">example.com</td>");
	});

	// A sentence is not a spreadsheet. The rule under the first row is the only thing that says so.
	it("leaves a line with pipes in it alone when no rule follows it", () => {
		const html = asHtml("corré `a | b` y mirá");

		expect(html).not.toContain("<table");
	});

	it("keeps the line breaks inside a paragraph, because they were meant", () => {
		expect(asHtml("una\notra")).toContain("una<br>otra");
	});

	it("leaves code as it was written, markup and all", () => {
		expect(asHtml("mirá `a **b** c`")).toContain(">a **b** c</code>");
		expect(asHtml("```\nrm -rf <dir>\n```")).toContain("rm -rf &lt;dir&gt;");
	});

	/**
	 * The bug this exists to prevent, and the reason this is written here rather than handed to a
	 * parser that lets HTML through: an agent reads its mail, and a mail can tell it to write anything.
	 * A message that could put a form of its choosing in front of the operator has phished them with
	 * their own agent's face on it.
	 */
	it("says what an agent wrote as markup, rather than doing it", () => {
		const html = asHtml('<script>alert(1)</script> y <a href="http://x">click</a>');

		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('href="http://x"');
	});

	// The one thing in a message that acts when it is read, written by something that reads its mail.
	it("makes a link of the schemes a mail client should follow, and only those", () => {
		expect(asHtml("[el panel](https://example.com)")).toContain('<a href="https://example.com">');
		expect(asHtml("[click](javascript:alert(1))")).not.toContain("<a href");
		expect(asHtml("[click](javascript:alert(1))")).toContain("click (javascript:alert(1))");
	});

	it("has nothing to say about nothing", () => {
		expect(asHtml("")).toBe(
			'<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5"></div>',
		);
	});
});
