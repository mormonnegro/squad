import { here as THEIR_HERE, COMMANDS as THEIRS } from "@squad/control-plane";
import { describe, expect, it } from "vitest";
import { completing, completions, isCommand, isShell, COMMANDS as OURS } from "../src/commands.ts";
import { here as OUR_HERE } from "../src/here.ts";

// The browser cannot import the plane's table — it reaches for node:crypto on its first line — so
// the menu is copied, and this is the whole of what stops the copy from drifting. A test in a node
// environment can hold both, which the bundle never can.
describe("the slash menu", () => {
	it("is the plane's own list, row for row", () => {
		expect(OURS).toEqual(THEIRS.map((command) => ({ ...command })));
	});
});

describe("what to offer", () => {
	it("offers every command for a bare slash", () => {
		expect(completions("/")).toHaveLength(OURS.length);
	});

	it("narrows to what has been typed", () => {
		expect(completions("/li").map((one) => one.name)).toEqual(["/limit"]);
	});

	// Past the command's own name the argument is a port, a hostname, a repository — none of which
	// this menu knows anything about, so it gets out of the way rather than guessing.
	it("offers nothing once there is an argument", () => {
		expect(completions("/model sonnet")).toEqual([]);
	});

	it("offers nothing for something that is not a command", () => {
		expect(completions("how is the queue looking")).toEqual([]);
	});

	it("tells a command and a shell line apart", () => {
		expect(isCommand("/limit 5")).toBe(true);
		expect(isShell("!ls")).toBe(true);
		expect(isCommand("!ls")).toBe(false);
		expect(isShell("/limit")).toBe(false);
	});
});

/**
 * Return, with the menu under a slash open.
 *
 * One key does two things and the menu decides which, so the moment the menu is wrong about having
 * something to offer, the key is wrong too: `/clear` matches `/clear`, so every return chose that
 * row again and the line was never sent. Every command that takes no argument was unsendable.
 */
describe("what return does with the menu open", () => {
	const of = (name: string) => OURS.find((one) => one.name === name);

	it("finishes a command that is still half typed", () => {
		expect(completing("/cle", of("/clear"))).toBe("/clear");
	});

	it("sends one that is already whole", () => {
		expect(completing("/clear", of("/clear"))).toBeUndefined();
		expect(completing("/help", of("/help"))).toBeUndefined();
	});

	// The space is the gesture that opens what comes next, so a command that takes an argument is
	// never finished by its own name: the first return writes the space, the second sends.
	it("leaves a space behind a command that takes something", () => {
		expect(completing("/limit", of("/limit"))).toBe("/limit ");
		expect(completing("/model", of("/model"))).toBe("/model ");
	});

	it("sends when the menu is offering nothing at all", () => {
		expect(completing("hola", undefined)).toBeUndefined();
	});
});

/**
 * The prompt of the other console, said the same way.
 *
 * Both boxes have a `!` mode now, and in both the mark is the directory the next command will run
 * in. A person who has read one of those prompts has read the other; two spellings of the same
 * directory would be two modes.
 */
describe("the directory a prompt is standing in", () => {
	const WALKED = [
		"/home/agent",
		"/home/agent/workspace",
		"/home/agent/workspace/test",
		"/home/agent/.self",
		"/tmp",
		"/",
		"/home/agent/workspace/a-repository-with-a-very-long-name/and/a/path/inside/it",
		"/var/lib/something/quite/long/that/is/not/under/the/home/at/all",
	];

	it("says what the terminal console's prompt says", () => {
		for (const cwd of WALKED) expect(OUR_HERE(cwd)).toBe(THEIR_HERE(cwd));
	});

	it("shortens the home to a tilde and takes the front off a long one", () => {
		expect(OUR_HERE("/home/agent")).toBe("~");
		expect(OUR_HERE("/home/agent/workspace/test")).toBe("~/workspace/test");
		expect(OUR_HERE("/tmp")).toBe("/tmp");
		// The end is where you are; the front is the part you already know, and it is what goes.
		expect(OUR_HERE("/home/agent/workspace/one/two/three/four/five")).toBe(
			"…one/two/three/four/five",
		);
	});
});
