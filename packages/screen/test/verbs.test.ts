import { describe, expect, it } from "vitest";
import { presented, tokenIn } from "../image/token.ts";
import { MOST_TABS, needsTheKeyboard, readAsked, readUrl, tooManyTabs } from "../image/verbs.ts";

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

describe("tabs", () => {
	it("opens one at an address, checked like any other", () => {
		expect(readAsked({ verb: "tab_open", url: "https://example.com/" })).toEqual({
			verb: "tab_open",
			url: "https://example.com/",
		});
		// The same door as `open`, and the same thing behind it: a new tab at a file:// URL would read
		// the profile this whole arrangement keeps out of reach.
		expect(readAsked({ verb: "tab_open", url: "file:///etc/passwd" })).toHaveProperty("refused");
	});

	it("goes to one by its number, and says where the numbers come from", () => {
		expect(readAsked({ verb: "tab", tab: 2 })).toEqual({ verb: "tab", tab: 2 });
		const refused = readAsked({ verb: "tab" }) as { refused: string };
		expect(refused.refused).toContain("tabs");
	});

	it("closes one by its number", () => {
		expect(readAsked({ verb: "tab_close", tab: 3 })).toEqual({ verb: "tab_close", tab: 3 });
		expect(readAsked({ verb: "tab_close", tab: 0 })).toHaveProperty("refused");
	});
});

describe("how many tabs a browser will hold", () => {
	/*
	 * A number rather than a sentence in a tool description, because a description is advice and this
	 * is memory: a tab is a renderer process holding a whole page, and a measured one runs to about
	 * half a gigabyte. An agent that opened one per thing it wondered about would take the machine
	 * down rather than work slowly.
	 */
	it("holds enough for the shape of the work and not more", () => {
		// The page being worked on, something a site opened by itself, and one to look something up
		// in. A fourth is not a different kind of work — it is the last one not having been closed.
		expect(MOST_TABS).toBe(3);
	});

	it("names what is open and what to do about it, rather than only refusing", () => {
		const said = tooManyTabs([
			{ number: 1, url: "https://example.com/checkout" },
			{ number: 2, url: "https://example.com/terms" },
			{ number: 3, url: "https://example.com/help" },
		]);
		// Whoever reads this can act on it: which tabs there are, and the words that close one.
		expect(said).toContain("https://example.com/terms");
		expect(said).toContain("screen_tab_close");
		expect(said).toContain("memory");
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

	it("lets the agent see which tabs are open while somebody else drives", () => {
		// Listing them changes nothing and says where things are, like reading a page. Going to one,
		// opening one and closing one are the browser moving under somebody's hands.
		expect(needsTheKeyboard("tabs")).toBe(false);
		expect(needsTheKeyboard("tab")).toBe(true);
		expect(needsTheKeyboard("tab_open")).toBe(true);
		expect(needsTheKeyboard("tab_close")).toBe(true);
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
