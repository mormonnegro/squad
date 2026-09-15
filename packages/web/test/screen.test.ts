import { SCREEN_VIEW_PORT as THEIRS } from "@squad/screen";
import { describe, expect, it } from "vitest";
import { hasScreen, SCREEN_VIEW_PORT as OURS } from "../src/Screen.tsx";

// The browser cannot import the package that owns this number — it reaches for node:http on its
// first line — so the number is copied, and this is the whole of what stops the copy from drifting.
// A test in a node environment can hold both, which the bundle never can.
describe("where a screen is watched", () => {
	it("is the port the plane opens it on", () => {
		expect(OURS).toBe(THEIRS);
	});
});

describe("whether an agent has one", () => {
	const agent = (ports: readonly number[]) =>
		({ served: ports.map((port) => ({ port, at: port })) }) as unknown as Parameters<
			typeof hasScreen
		>[0];

	it("reads it off the ports the plane says it is serving", () => {
		expect(hasScreen(agent([OURS]))).toBe(true);
		expect(hasScreen(agent([]))).toBe(false);
	});

	it("is not confused by an ordinary port the agent opened itself", () => {
		expect(hasScreen(agent([3000, 8080]))).toBe(false);
		expect(hasScreen(agent([3000, OURS]))).toBe(true);
	});
});
