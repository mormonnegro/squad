import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasScreen, ScreenChoices, SignInSites } from "../src/screens.ts";

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

/**
 * The second permission a browser has, and the one that is about somebody's account.
 *
 * Every assertion here is about the same property said a different way: nothing is open until an
 * operator opened it, and nothing stays open for a name that has gone.
 */
describe("what an agent may sign into", () => {
	let sites: SignInSites;

	beforeEach(() => {
		sites = new SignInSites(join(dir, "signins.json"));
	});

	it("opens nothing for an agent nobody has opened anything for", async () => {
		expect(await sites.of("scout")).toEqual([]);
	});

	it("opens one site at a time, and says when a second says nothing new", async () => {
		expect(await sites.add("scout", "github.com")).toBe(true);
		expect(await sites.add("scout", "github.com")).toBe(false);
		expect(await sites.of("scout")).toEqual(["github.com"]);
	});

	it("keeps one agent's list out of another's", async () => {
		await sites.add("scout", "github.com");
		await sites.add("emma", "mail.google.com");

		expect(await sites.of("scout")).toEqual(["github.com"]);
		expect(await sites.of("emma")).toEqual(["mail.google.com"]);
	});

	it("closes one, and says when there was nothing to close", async () => {
		await sites.add("scout", "github.com");
		await sites.add("scout", "mail.google.com");

		expect(await sites.drop("scout", "github.com")).toBe(true);
		expect(await sites.of("scout")).toEqual(["mail.google.com"]);
		expect(await sites.drop("scout", "github.com")).toBe(false);
	});

	it("survives being read back by another plane, because a permission outlives a restart", async () => {
		await sites.add("scout", "github.com");

		expect(await new SignInSites(join(dir, "signins.json")).of("scout")).toEqual(["github.com"]);
	});

	/**
	 * The one that matters most, and the one nothing else would catch.
	 *
	 * A name that was deleted can be made again, and a list left behind would hand whoever makes it
	 * the accounts the last agent of that name was trusted with.
	 */
	it("forgets everything opened for a name that has gone", async () => {
		await sites.add("scout", "github.com");
		await sites.forget("scout");

		expect(await sites.of("scout")).toEqual([]);
		expect(await new SignInSites(join(dir, "signins.json")).of("scout")).toEqual([]);
	});

	it("reads a file somebody edited into nonsense as an empty list rather than throwing", async () => {
		await writeFile(join(dir, "signins.json"), '{"scout":"github.com"}', "utf8");

		expect(await sites.of("scout")).toEqual([]);
	});
});
