import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpendLedger, today } from "../src/spend.ts";

let dir = "";
let path = "";
let ledger: SpendLedger;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "spend-"));
	path = join(dir, "spend.json");
	ledger = new SpendLedger(path);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const noon = new Date("2026-08-23T12:00:00Z");
const tomorrow = new Date("2026-08-24T09:00:00Z");

describe("today", () => {
	// The plane runs in a container set to UTC and the console runs wherever the operator is. One of
	// the two has to decide when the day rolls over, and the ceiling is enforced on the plane's side.
	it("is the same day whatever hour of it the machine thinks it is", () => {
		expect(today(new Date("2026-08-23T00:00:01Z"))).toBe("2026-08-23");
		expect(today(new Date("2026-08-23T23:59:59Z"))).toBe("2026-08-23");
	});
});

describe("SpendLedger", () => {
	it("starts every agent at nothing spent and no ceiling of its own", async () => {
		expect(await ledger.account("scout")).toEqual({ spentUsd: 0, limitUsd: undefined });
	});

	it("adds up what the turns of one day cost", async () => {
		await ledger.record("scout", 0.4, noon);
		await ledger.record("scout", 0.35, noon);

		expect((await ledger.account("scout", noon)).spentUsd).toBeCloseTo(0.75, 10);
	});

	it("keeps each agent's spending to itself", async () => {
		await ledger.record("scout", 1, noon);
		await ledger.record("scribe", 2, noon);

		expect((await ledger.account("scout", noon)).spentUsd).toBe(1);
		expect((await ledger.account("scribe", noon)).spentUsd).toBe(2);
	});

	/**
	 * A ceiling is a day's worth, so the day turning over is what makes it a ceiling rather than a
	 * budget that runs out once. An agent that stopped at midnight and never started again would be
	 * a limit nobody could tell apart from a broken plane.
	 */
	it("starts the count again the next day", async () => {
		await ledger.record("scout", 5, noon);
		expect((await ledger.account("scout", noon)).spentUsd).toBe(5);

		expect((await ledger.account("scout", tomorrow)).spentUsd).toBe(0);

		await ledger.record("scout", 0.25, tomorrow);
		expect((await ledger.account("scout", tomorrow)).spentUsd).toBe(0.25);
	});

	it("does not spend anything on a turn that cost nothing", async () => {
		await ledger.record("scout", 0, noon);

		// Nothing was spent, so nothing was written: a plane whose model reports no cost should not
		// leave a file full of zeroes behind.
		await expect(readFile(path, "utf8")).rejects.toThrow();
	});

	it("remembers a ceiling past the day it was set on", async () => {
		await ledger.setLimit("scout", 5, noon);
		await ledger.record("scout", 5, noon);

		expect(await ledger.account("scout", tomorrow)).toEqual({ spentUsd: 0, limitUsd: 5 });
	});

	/** Three states: a number, `null` for none, and undefined for an agent nobody has decided about. */
	it("tells a ceiling taken off apart from one never set", async () => {
		expect((await ledger.account("scout", noon)).limitUsd).toBeUndefined();

		await ledger.setLimit("scout", null, noon);

		expect((await ledger.account("scout", noon)).limitUsd).toBeNull();
	});

	it("replaces a ceiling rather than adding to it", async () => {
		await ledger.setLimit("scout", 5, noon);
		await ledger.setLimit("scout", 2, noon);

		expect((await ledger.account("scout", noon)).limitUsd).toBe(2);
	});

	it("keeps what was spent when the ceiling moves", async () => {
		await ledger.record("scout", 3, noon);
		await ledger.setLimit("scout", 10, noon);

		expect(await ledger.account("scout", noon)).toEqual({ spentUsd: 3, limitUsd: 10 });
	});

	it("survives a restart, because the ceiling is the thing that must", async () => {
		await ledger.setLimit("scout", 5, noon);
		await ledger.record("scout", 1.25, noon);

		expect(await new SpendLedger(path).account("scout", noon)).toEqual({
			spentUsd: 1.25,
			limitUsd: 5,
		});
	});

	// A half-written file reads as nobody having spent anything, which hands every agent its ceiling
	// back. Starting over is the only safe reading of a file that cannot be read.
	it("starts over rather than throwing on a file it cannot read", async () => {
		await writeFile(path, "{ this is not json", "utf8");

		expect(await ledger.account("scout", noon)).toEqual({ spentUsd: 0, limitUsd: undefined });
		await ledger.record("scout", 1, noon);
		expect((await ledger.account("scout", noon)).spentUsd).toBe(1);
	});

	it("forgets an agent that was purged", async () => {
		await ledger.setLimit("scout", 5, noon);
		await ledger.record("scribe", 2, noon);

		await ledger.forget("scout");

		expect(await ledger.account("scout", noon)).toEqual({ spentUsd: 0, limitUsd: undefined });
		expect((await ledger.account("scribe", noon)).spentUsd).toBe(2);
	});

	/**
	 * Every agent on the plane shares this object, and a turn ending is when it writes. Two turns
	 * ending together must not read the same total and both write their own on top of it, because
	 * what is lost that way is exactly the spending that a ceiling exists to catch.
	 */
	it("loses nothing when several turns end at once", async () => {
		await Promise.all(Array.from({ length: 20 }, () => ledger.record("scout", 0.05, noon)));

		expect((await ledger.account("scout", noon)).spentUsd).toBeCloseTo(1, 10);
	});
});
