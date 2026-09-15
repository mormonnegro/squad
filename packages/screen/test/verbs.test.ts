import { describe, expect, it } from "vitest";
import { presented, tokenIn } from "../image/token.ts";
import { needsTheKeyboard, readAsked, readUrl } from "../image/verbs.ts";

describe("what the browser will open", () => {
	it("opens http and https", () => {
		expect(readUrl("https://example.com/x")).toEqual({ url: "https://example.com/x" });
	});

	it("refuses file://, which is the profile this whole arrangement keeps out of reach", () => {
		// The cookie jar is a file on a volume the agent cannot mount. A browser that would open a
		// file:// URL is a way to read it back as a document, which is the same thing by another road.
		const refused = readUrl("file:///home/screen/profile/Default/Cookies");
		expect(refused).toHaveProperty("refused");
		expect(String((refused as { refused: string }).refused)).toContain("file://");
	});

	it("refuses the browser's own insides", () => {
		expect(readUrl("chrome://settings")).toHaveProperty("refused");
		expect(readUrl("devtools://devtools/bundled/inspector.html")).toHaveProperty("refused");
	});

	it("says what to send instead when it is not an address at all", () => {
		expect(readUrl("example.com")).toHaveProperty("refused");
	});
});

describe("reading what the agent asked for", () => {
	it("takes the verbs on the list and refuses anything else by name", () => {
		expect(readAsked({ verb: "read" })).toEqual({ verb: "read" });
		expect(readAsked({ verb: "evaluate", expression: "document.cookie" })).toHaveProperty(
			"refused",
		);
	});

	it("wants a ref to click, and says where refs come from", () => {
		expect(readAsked({ verb: "click", ref: 3 })).toEqual({ verb: "click", ref: 3 });
		const refused = readAsked({ verb: "click" }) as { refused: string };
		expect(refused.refused).toContain("read");
	});

	it("types into a field, or into whatever has the cursor", () => {
		expect(readAsked({ verb: "type", text: "hello", ref: 2, enter: true })).toEqual({
			verb: "type",
			text: "hello",
			ref: 2,
			enter: true,
		});
		expect(readAsked({ verb: "type", text: "hello" })).toEqual({ verb: "type", text: "hello" });
	});

	it("presses only the keys that do something", () => {
		expect(readAsked({ verb: "key", key: "Enter" })).toEqual({ verb: "key", key: "Enter" });
		expect(readAsked({ verb: "key", key: "a" })).toHaveProperty("refused");
	});

	it("scrolls in four directions and no others", () => {
		expect(readAsked({ verb: "scroll", to: "bottom" })).toEqual({ verb: "scroll", to: "bottom" });
		expect(readAsked({ verb: "scroll", to: "sideways" })).toHaveProperty("refused");
	});

	it("wants a sentence to put in front of the operator", () => {
		expect(readAsked({ verb: "ask", note: "sign me in" })).toEqual({
			verb: "ask",
			note: "sign me in",
		});
		expect(readAsked({ verb: "ask", note: "  " })).toHaveProperty("refused");
	});

	it("refuses anything that is not an object, rather than reading a string as a verb", () => {
		expect(readAsked("read")).toHaveProperty("refused");
		expect(readAsked(null)).toHaveProperty("refused");
	});
});

describe("which verbs the keyboard stands in the way of", () => {
	it("lets the agent go on watching while somebody else drives", () => {
		// Watching is exactly what it should be doing while an operator signs in, so that the turn
		// after they let go starts from where they left the page.
		expect(needsTheKeyboard("read")).toBe(false);
		expect(needsTheKeyboard("look")).toBe(false);
		expect(needsTheKeyboard("ask")).toBe(false);
	});

	it("stops everything that touches the page", () => {
		expect(needsTheKeyboard("open")).toBe(true);
		expect(needsTheKeyboard("click")).toBe(true);
		expect(needsTheKeyboard("type")).toBe(true);
		expect(needsTheKeyboard("key")).toBe(true);
		expect(needsTheKeyboard("scroll")).toBe(true);
		expect(needsTheKeyboard("back")).toBe(true);
	});
});

describe("whose screen this is", () => {
	it("takes the agent's own egress token out of its proxy URL", () => {
		expect(tokenIn("http://scout:s3cret@egress:8080")).toBe("s3cret");
		expect(tokenIn("http://scout:a%2Fb@egress:8080")).toBe("a/b");
	});

	it("has no token when there is no proxy to take one from", () => {
		expect(tokenIn(undefined)).toBeUndefined();
		expect(tokenIn("http://egress:8080")).toBeUndefined();
		expect(tokenIn("nonsense")).toBeUndefined();
	});

	it("lets the agent in and keeps every other sandbox out", () => {
		// The door is on the network every sandbox shares. Being asked is not evidence of being asked
		// by the agent whose signed-in browser this is.
		expect(presented("Bearer s3cret", "s3cret")).toBe(true);
		expect(presented("Bearer someone-elses", "s3cret")).toBe(false);
		expect(presented("s3cret", "s3cret")).toBe(false);
		expect(presented(undefined, "s3cret")).toBe(false);
	});

	it("refuses everyone when it has no secret of its own", () => {
		// Fails closed. A screen that cannot tell its agent from anybody else's should refuse both.
		expect(presented("Bearer anything", undefined)).toBe(false);
	});
});
