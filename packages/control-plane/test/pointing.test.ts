import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	POINTING_PROVIDERS,
	PointingChoice,
	perPointUsd,
	pointingGrant,
	resolvePointing,
} from "../src/pointing.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "squad-pointing-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("which model points", () => {
	it("fills in the model, the endpoint and the price from the table", () => {
		const resolved = resolvePointing({ provider: "typesafe" });

		expect(resolved).toEqual({
			provider: "typesafe",
			model: "jev-latest",
			endpoint: "https://api.typesafe.ai/v1/systemone",
			keyEnv: "TYPESAFE_API_KEY",
			rate: { input: 0.042, output: 0 },
		});
	});

	it("takes one of the provider's other models", () => {
		const resolved = resolvePointing({ provider: "typesafe", model: "jev-1.12" });

		expect(typeof resolved === "string" ? "" : resolved.model).toBe("jev-1.12");
	});

	/** A name nobody here knows is a sentence to act on rather than a grant nobody can pay. */
	it("says so, in words, about a provider it has never heard of", () => {
		expect(resolvePointing({ provider: "nobody" })).toContain("typesafe");
	});

	/** Of the two ways to be wrong about a bill, overstating it is the one that can be undone. */
	it("prices a model nobody priced at the dearest the provider has", () => {
		const resolved = resolvePointing({ provider: "typesafe", model: "jev-next" });

		expect(typeof resolved === "string" ? undefined : resolved.rate).toEqual({
			input: 0.042,
			output: 0,
		});
	});
});

describe("the grant it derives", () => {
	it("opens that one endpoint, for POST, with the key written on the way out", () => {
		const resolved = resolvePointing({ provider: "typesafe" });
		if (typeof resolved === "string") throw new Error(resolved);

		expect(pointingGrant(resolved)).toEqual({
			id: "pointing:typesafe",
			host: "api.typesafe.ai",
			pathPrefix: "/v1/systemone",
			methods: ["POST"],
			injection: { kind: "bearer", token: { ref: "TYPESAFE_API_KEY" } },
		});
	});

	/** The number the screen shows before anybody turns it on. A page is about 4k tokens. */
	it("costs a fraction of a cent a page", () => {
		const rate = POINTING_PROVIDERS.typesafe?.rates["jev-latest"] ?? { input: 0, output: 0 };

		expect(perPointUsd(rate)).toBeLessThan(0.001);
	});
});

describe("what the operator chose", () => {
	it("is nothing at all until somebody chooses", async () => {
		const choice = new PointingChoice(join(root, "pointing.json"));

		expect(await choice.chosen()).toBeUndefined();
	});

	it("keeps a choice, and reads it back", async () => {
		const choice = new PointingChoice(join(root, "pointing.json"));

		await choice.choose({ provider: "typesafe", model: "jev-1.12" });

		expect(await choice.chosen()).toEqual({ provider: "typesafe", model: "jev-1.12" });
	});

	/** Turning it off is a decision and is written down as one, not a file that went missing. */
	it("reads a turned-off plane as nobody having chosen", async () => {
		const choice = new PointingChoice(join(root, "deep", "pointing.json"));
		await choice.choose({ provider: "typesafe" });

		await choice.choose(null);

		expect(await choice.chosen()).toBeUndefined();
	});
});
