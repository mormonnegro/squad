import { describe, expect, it } from "vitest";
import { hostOf, named, plainly, sourcesIn } from "../src/plainly.ts";

describe("plainly", () => {
	it("says what a tool call is for, rather than what it is", () => {
		expect(plainly("read", { path: "/home/agent/.self/memory/lessons.md" }).say).toBe(
			"reading lessons.md",
		);
		expect(plainly("web_search", { query: "how often does a webhook retry" }).say).toBe(
			"searching the web for “how often does a webhook retry”",
		);
		expect(plainly("send_to", { to: "maxi", note: "…" }).say).toBe("writing to maxi");
		expect(plainly("console_command", { line: "/mcp login ahrefs" }).say).toBe(
			"asking for /mcp login",
		);
	});

	/**
	 * The browser, where the words are the whole of what a person watching can see — and where they
	 * also say which way the agent worked, by being different rather than by explaining.
	 */
	it("says what the browser is doing, and whether it named the thing or counted to it", () => {
		expect(plainly("screen_open", { url: "https://www.google.com/travel/flights" }).say).toBe(
			"opening google.com",
		);
		expect(plainly("screen_read", {}).say).toBe("reading the page");
		expect(plainly("screen_click", { what: "the Continue button" }).say).toBe(
			"clicking “the Continue button”",
		);
		expect(plainly("screen_click", { ref: 7 }).say).toBe("clicking [7]");
		expect(plainly("screen_type", { what: "the search box", text: "Madrid" }).say).toBe(
			"typing into “the search box”: “Madrid”",
		);
		expect(plainly("screen_type", { ref: 3, text: "Madrid" }).say).toBe(
			"typing into [3]: “Madrid”",
		);
		expect(plainly("screen_ask", { note: "…" }).say).toBe("asking you to take the keyboard");
	});

	it("reads a shell line for what it does, past what it says", () => {
		// `cd /tmp && node …` is a turn spent running node. A phrase about changing directory would be
		// the one true thing on the row and also the only useless one.
		expect(plainly("bash", { command: 'cd /tmp && node -e "console.log(1)"' }).say).toBe(
			"running a script",
		);
		expect(plainly("bash", { command: "pnpm -r test" }).say).toBe("running the tests");
		expect(plainly("bash", { command: "git commit -m 'done'" }).say).toBe("saving its work");
	});

	it("finds the file a command was pointed at, past the argument in front of it", () => {
		expect(plainly("bash", { command: "sed -n '1,50p' /home/agent/notes.md" }).say).toBe(
			"reading notes.md",
		);
		expect(plainly("bash", { command: "ls -la /home/agent/.self/memory/" }).say).toBe(
			"looking through memory",
		);
		expect(plainly("bash", { command: 'grep -rn "TurnError" packages' }).say).toBe(
			"looking for “TurnError”",
		);
	});

	it("takes a loop full of URLs for the pages it is", () => {
		// The shape is a for loop and the intent is reading a newspaper, and the intent is what
		// somebody watching wants to be told.
		const step = plainly("bash", {
			command:
				'for u in "https://www.infobae.com/arc/outboundfeeds/rss/category/argentina/" "https://www.infobae.com/arc/outboundfeeds/rss/category/economia/"; do curl -s "$u"; done',
		});

		expect(step.say).toBe("reading infobae.com");
		expect(step.sources).toHaveLength(2);
	});

	it("names several sites without becoming the list of them", () => {
		expect(named(["https://www.infobae.com/a"])).toBe("infobae.com");
		expect(named(["https://infobae.com/a", "https://lanacion.com.ar/b"])).toBe(
			"infobae.com and lanacion.com.ar",
		);
		expect(named(["https://a.com/1", "https://b.com/2", "https://c.com/3"])).toBe(
			"a.com and 2 others",
		);
	});

	it("still says something about a tool nobody here has heard of", () => {
		expect(plainly("notion_search_pages", { what: "roadmap" }).say).toBe(
			"using notion search pages",
		);
		expect(plainly("some_fetcher", { url: "https://example.com/page" })).toEqual({
			say: "reading example.com",
			sources: ["https://example.com/page"],
		});
	});

	it("says how far off a wakeup is in the units somebody would have said it in", () => {
		expect(plainly("wake_me", { afterSeconds: 60, note: "…" }).say).toBe(
			"asking for another turn in a minute",
		);
		expect(plainly("wake_me", { afterSeconds: 1200, note: "…" }).say).toBe(
			"asking for another turn in 20 minutes",
		);
		expect(plainly("wake_me", { afterSeconds: 86400, note: "…" }).say).toBe(
			"asking for another turn in 24 hours",
		);
	});

	it("finds the pages an answer was written from", () => {
		const answer = [
			"Buenos Aires had a heat warning on Tuesday.",
			"",
			"Sources:",
			"[1] https://www.infobae.com/sociedad/2026/09/12/ola-de-calor/",
			"[2] https://www.lanacion.com.ar/clima/alerta-roja/",
		].join("\n");

		expect(sourcesIn(answer)).toEqual([
			"https://www.infobae.com/sociedad/2026/09/12/ola-de-calor/",
			"https://www.lanacion.com.ar/clima/alerta-roja/",
		]);
	});

	it("keeps the punctuation around a link out of the address", () => {
		// A URL at the end of a sentence takes the full stop with it, and one in a markdown link takes
		// the bracket. Neither is part of the address, and both are a broken mark on screen.
		expect(sourcesIn("as [the paper](https://example.com/one) said.")).toEqual([
			"https://example.com/one",
		]);
	});

	it("has no host for something that is not an address", () => {
		expect(hostOf("not a url")).toBe("");
	});
});
