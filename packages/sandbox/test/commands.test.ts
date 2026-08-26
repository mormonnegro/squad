import { describe, expect, it } from "vitest";
import { alreadyAsked, askFor, MOST } from "../image/commands.ts";

describe("askFor", () => {
	it("queues the command and says the answer is going to the operator", () => {
		const asked = askFor("/mcp login ahrefs", []);

		expect(asked.asked).toEqual(["/mcp login ahrefs"]);
		expect(asked.text).toContain("Asked for: /mcp login ahrefs");
		expect(asked.text).toContain("goes to your operator");
		expect(asked.text).toContain("the only command you have asked for this turn");
	});

	/** Adding a server and logging into it is two lines and one intent, so the second cannot replace
	 * the first — and the agent, which cannot see the console, is told which of the two this was. */
	it("keeps what the turn asked for before, in the order it was asked", () => {
		const asked = askFor("/mcp login ahrefs", ["/mcp add ahrefs https://ahrefs.example/mcp"]);

		expect(asked.asked).toEqual([
			"/mcp add ahrefs https://ahrefs.example/mcp",
			"/mcp login ahrefs",
		]);
		expect(asked.text).toContain("It is 2 of the commands");
		expect(asked.text).toContain("they run in order");
	});

	it("takes the command as it would be typed, whitespace and all", () => {
		expect(askFor("  /model  ", []).asked).toEqual(["/model"]);
	});

	it("refuses a line that is not a command", () => {
		expect(() => askFor("mcp login ahrefs", [])).toThrow(
			'A command starts with a slash. "mcp login ahrefs" is not one.',
		);
	});

	/**
	 * Refused here as well as at the plane. A newline would put a second command into the conversation
	 * underneath the first one's answer, where nobody reading the console is looking for it.
	 */
	it("refuses two commands smuggled into one line", () => {
		expect(() => askFor("/model\n/limit 100", [])).toThrow("One command to a call.");
		expect(() => askFor("/model\r/limit 100", [])).toThrow("One command to a call.");
	});

	/** So that an agent looping on a refusal finds out inside the turn, rather than filling a console
	 * with the same line forty times. */
	it("refuses more than a turn's worth", () => {
		const full = Array.from({ length: MOST }, (_, n) => `/mcp drop server-${n}`);

		expect(() => askFor("/model", full)).toThrow(
			`You have already asked for ${MOST} commands this turn, which is the most.`,
		);
		expect(askFor("/model", full.slice(1)).asked).toHaveLength(MOST);
	});
});

describe("alreadyAsked", () => {
	it("reads back the queue the turn wrote", () => {
		expect(alreadyAsked('["/model","/limit 5"]\n')).toEqual(["/model", "/limit 5"]);
	});

	it("starts the turn fresh when there is no file", () => {
		expect(alreadyAsked(undefined)).toEqual([]);
	});

	/** A file left half-written and no file at all are the same situation from here: this line is the
	 * turn's first. Failing on it would strand the agent on a file it cannot see to fix. */
	it("starts the turn fresh on anything it cannot read as a list of commands", () => {
		expect(alreadyAsked('["/model"')).toEqual([]);
		expect(alreadyAsked('{"line":"/model"}')).toEqual([]);
		expect(alreadyAsked("")).toEqual([]);
	});

	it("keeps only what could have been a command", () => {
		expect(alreadyAsked('["/model",3,null,"/limit 5"]')).toEqual(["/model", "/limit 5"]);
	});
});
