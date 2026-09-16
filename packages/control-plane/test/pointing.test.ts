import { describe, expect, it } from "vitest";
import {
	DEFAULT_POINTING,
	POINTING_PROVIDERS,
	perPointUsd,
	pointingGrant,
	resolvePointing,
} from "../src/pointing.ts";

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

describe("what turns it on", () => {
	/** The key is the switch, so what it points with has to be settled without anybody choosing. */
	it("points with the one provider there is, without being asked", () => {
		const resolved = resolvePointing(DEFAULT_POINTING);

		expect(typeof resolved === "string" ? "" : resolved.provider).toBe("typesafe");
		expect(typeof resolved === "string" ? "" : resolved.keyEnv).toBe("TYPESAFE_API_KEY");
	});
});
