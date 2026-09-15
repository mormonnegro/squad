import { describe, expect, it } from "vitest";
import { shown } from "../src/Logs.tsx";

/** The escape a terminal reads, written here the way it arrives rather than as a literal. */
const esc = String.fromCharCode(27);

describe("a log as a terminal would have shown it", () => {
	it("leaves plain output exactly as it is", () => {
		expect(shown("ready in 312 ms\nGET / 200\n")).toBe("ready in 312 ms\nGET / 200\n");
	});

	it("takes the colours off and keeps the words", () => {
		expect(shown(`${esc}[32mready${esc}[39m in 312 ms\n`)).toBe("ready in 312 ms\n");
	});

	it("drops a cursor move, which is an instruction and not a word", () => {
		expect(shown(`${esc}[2K${esc}[1Gbuilding\n`)).toBe("building\n");
	});

	it("drops a window title, bell and all", () => {
		expect(shown(`${esc}]0;vite${String.fromCharCode(7)}ready\n`)).toBe("ready\n");
	});

	/*
	 * A progress line is one line written twenty times, each rewrite announced by returning to the
	 * start of it. Drawn as they arrive it is twenty lines of a log; what the person at the terminal
	 * actually saw is the last one.
	 */
	it("shows a line rewritten in place as the last thing it was rewritten to", () => {
		expect(shown("10%\r50%\r100%\ndone\n")).toBe("100%\ndone\n");
	});

	it("keeps an empty line, which is how output is spaced", () => {
		expect(shown("one\n\ntwo\n")).toBe("one\n\ntwo\n");
	});
});
