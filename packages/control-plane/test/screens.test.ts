import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasScreen, ScreenChoices } from "../src/screens.ts";

let dir = "";
let choices: ScreenChoices;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "squad-screens-"));
	choices = new ScreenChoices(join(dir, "screens.json"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("what the console decided", () => {
	it("says nothing about an agent nobody has decided about", async () => {
		expect(await choices.of("scout")).toBeUndefined();
	});

	it("remembers on and off apart, because off is a decision too", async () => {
		await choices.set("scout", true);
		expect(await choices.of("scout")).toBe(true);
		await choices.set("scout", false);
		expect(await choices.of("scout")).toBe(false);
	});

	it("forgets on null, which hands the question back to the file", async () => {
		await choices.set("scout", false);
		await choices.set("scout", null);
		expect(await choices.of("scout")).toBeUndefined();
	});

	it("survives being read back by another plane", async () => {
		await choices.set("scout", true);
		expect(await new ScreenChoices(join(dir, "screens.json")).of("scout")).toBe(true);
	});

	it("reads a file somebody damaged as nobody having decided anything", async () => {
		// Rather than throwing on the way up. A broken file here should cost the screens, not the
		// plane: every agent still starts, and the worst case is a browser to turn back on.
		await writeFile(join(dir, "screens.json"), "{ not json", "utf8");
		expect(await choices.of("scout")).toBeUndefined();
	});

	it("ignores entries that are not yes or no", async () => {
		await writeFile(join(dir, "screens.json"), JSON.stringify({ scout: "yes" }), "utf8");
		expect(await choices.of("scout")).toBeUndefined();
	});

	it("writes whole files, so a plane killed mid-write does not turn every screen off", async () => {
		await choices.set("scout", true);
		await choices.set("emma", false);
		expect(JSON.parse(await readFile(join(dir, "screens.json"), "utf8"))).toEqual({
			scout: true,
			emma: false,
		});
	});
});

describe("who wins", () => {
	it("gives an agent a screen when the file says so", () => {
		expect(hasScreen(true, undefined)).toBe(true);
	});

	it("lets the console overrule the file in both directions", () => {
		expect(hasScreen(true, false)).toBe(false);
		expect(hasScreen(false, true)).toBe(true);
	});

	it("has no screen when nobody ever said anything", () => {
		expect(hasScreen(undefined, undefined)).toBe(false);
	});
});
