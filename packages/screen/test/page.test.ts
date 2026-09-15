import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { viewPage } from "../image/page.ts";

/** The page's own script, which is a string in a template literal and so is checked by nothing. */
function script(html: string): string {
	const opened = html.indexOf("<script>");
	const closed = html.indexOf("</script>");
	expect(opened).toBeGreaterThan(-1);
	expect(closed).toBeGreaterThan(opened);
	return html.slice(opened + "<script>".length, closed);
}

const page = viewPage("scout");

/*
 * The bug this file exists for, which cost an evening and looked like nothing.
 *
 * A line in here shipped as `/^https?:///i` — the backslashes were eaten on the way through the
 * template literal, leaving a regex that ends early and a `//` that comments out the rest of the
 * line. One syntax error anywhere in this script means the whole thing fails to parse, so not one
 * handler is attached: the page draws perfectly, the header is right, the button is there, and
 * clicking it does nothing at all. Nothing in a type checker or a linter looks inside a string.
 */
describe("the page's script", () => {
	it("parses, which is the whole of what it needs from anybody here", () => {
		expect(() => new vm.Script(script(page))).not.toThrow();
	});

	it("attaches the handlers the operator's whole use of this depends on", () => {
		const source = script(page);
		for (const handler of ["keyboard", "mousedown", "mouseup", "wheel", "keydown", "submit"]) {
			expect(source).toContain(handler);
		}
	});

	it("goes to the routes the screen serves, by the names it serves them under", () => {
		const source = script(page);
		// Relative, with no leading slash: this page is reached through a tunnel and served at the
		// root of an origin of its own, and an absolute path would be a guess about both.
		for (const route of ['"state"', '"keyboard"', '"input"', '"open"', '"frames"']) {
			expect(source).toContain(route);
		}
		// The picture is pointed at from the script rather than written into the tag, because the key
		// it has to carry is only known once the page is running. A static src would fire first, with
		// no key on it, and the frame would be refused before anything else had a chance to happen.
		expect(page).not.toContain('src="frames"');
		expect(source).toContain('screen.src = to("frames")');
	});
});

describe("what the page says before anything happens", () => {
	it("names whose screen it is", () => {
		expect(page).toContain("scout");
	});

	it("starts with the agent driving and the page veiled", () => {
		// The state an operator arrives to. A page that opened with the keyboard already taken would
		// be one that quietly stopped the agent the moment somebody looked at it.
		expect(page).toContain("Take the keyboard");
		expect(page).toContain("the agent is driving");
	});
});
