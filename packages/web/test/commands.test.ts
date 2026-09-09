import { COMMANDS as THEIRS } from "@squad/control-plane";
import { describe, expect, it } from "vitest";
import { completions, isCommand, isShell, COMMANDS as OURS } from "../src/commands.ts";

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
