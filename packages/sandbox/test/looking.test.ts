import { describe, expect, it } from "vitest";
import {
	askedOf,
	type Looking,
	readLooking,
	refusedBy,
	saidBy,
	spentOn,
	WHAT_IS_ON_IT,
} from "../image/looking.ts";

const PNG = "AAAA";
const of = (shape: Looking["shape"], model = "m"): Looking => ({
	endpoint: "https://example.test/v1",
	model,
	shape,
	rate: { input: 1, output: 10 },
});

describe("what the plane chose", () => {
	it("takes a choice written by the plane", () => {
		expect(
			readLooking(
				JSON.stringify({
					endpoint: "https://api.openai.com/v1/responses",
					model: "gpt-5-mini",
					shape: "responses",
					rate: { input: 0.25, output: 2 },
				}),
			),
		).toMatchObject({ model: "gpt-5-mini", shape: "responses" });
	});

	it("reads a file written by an older plane as a file missing one thing", () => {
		// Field by field rather than wholesale, on the search tool's terms: a plane that wrote this
		// before there were three shapes should leave a working tool rather than a refusing one.
		expect(readLooking(JSON.stringify({ endpoint: "https://x/y", model: "m" }))).toMatchObject({
			shape: "responses",
			rate: { input: 0, output: 0 },
		});
	});

	it("says nothing at all for a file that is not one", () => {
		expect(readLooking("not json")).toBeUndefined();
		expect(readLooking(JSON.stringify({ model: "m" }))).toBeUndefined();
	});
});

/*
 * Three envelopes for one picture and one question. Written out rather than adapted from a library,
 * and checked here, because the way this fails at a provider is a 400 with a sentence about a field
 * nobody in this repository has ever named.
 */
describe("the request each provider wants", () => {
	it("puts the picture where OpenAI's responses API looks for it", () => {
		const body = JSON.parse(askedOf(of("responses"), "what is this?", PNG));
		expect(body.input[0].content).toEqual([
			{ type: "input_text", text: "what is this?" },
			{ type: "input_image", image_url: `data:image/png;base64,${PNG}` },
		]);
	});

	it("gives Anthropic the base64 on its own, and a ceiling it has no default for", () => {
		const body = JSON.parse(askedOf(of("messages"), "what is this?", PNG));
		expect(body.messages[0].content[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: PNG },
		});
		expect(body.max_tokens).toBeGreaterThan(0);
	});

	it("uses the shape everyone else settled on for the rest", () => {
		const body = JSON.parse(askedOf(of("chat"), "what is this?", PNG));
		expect(body.messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${PNG}`);
	});

	it("asks something useful when the agent asked nothing", () => {
		const body = JSON.parse(askedOf(of("chat"), "   ", PNG));
		expect(body.messages[0].content[0].text).toBe(WHAT_IS_ON_IT);
	});
});

describe("where each provider keeps the answer", () => {
	it("finds it in an output list", () => {
		expect(
			saidBy(of("responses"), {
				output: [
					{ type: "reasoning" },
					{ type: "message", content: [{ type: "output_text", text: "a login page" }] },
				],
			}),
		).toBe("a login page");
	});

	it("finds it in a content list", () => {
		expect(saidBy(of("messages"), { content: [{ type: "text", text: "a login page" }] })).toBe(
			"a login page",
		);
	});

	it("finds it in a choice", () => {
		expect(saidBy(of("chat"), { choices: [{ message: { content: "a login page" } }] })).toBe(
			"a login page",
		);
	});

	it("hands back what the provider said went wrong, or the body when it said nothing", () => {
		expect(refusedBy({ error: { message: "no such model" } }, "{}")).toBe("no such model");
		expect(refusedBy(undefined, "egress_denied")).toBe("egress_denied");
	});
});

/*
 * Counted because a look is a call to another provider on another account, which the model driving
 * the turn never sees a token of. Unreported it would be the second thing an agent can do that costs
 * money and appears in no total — and a picture is not cheap.
 */
describe("what a look cost", () => {
	it("counts both namings of the same two numbers", () => {
		expect(
			spentOn(of("responses"), { usage: { input_tokens: 1000, output_tokens: 100 } }),
		).toMatchObject({ input: 1000, output: 100, totalTokens: 1100 });
		expect(
			spentOn(of("chat"), { usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
		).toMatchObject({ input: 1000, output: 100 });
	});

	it("prices it with the rate the plane sent, not one of its own", () => {
		const spent = spentOn(of("chat"), {
			usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
		});
		expect(spent.cost.total).toBeCloseTo(1);
	});

	it("counts nothing when the provider said nothing about it", () => {
		expect(spentOn(of("chat"), {}).cost.total).toBe(0);
	});
});
