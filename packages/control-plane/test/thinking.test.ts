import { describe, expect, it } from "vitest";
import type { Model } from "../src/models.ts";
import { thinkingFor } from "../src/thinking.ts";

const model = (provider: string): Model =>
	({
		id: `${provider}-one`,
		provider,
		model: `${provider}-one`,
		host: `api.${provider}.com`,
		keyEnv: `${provider.toUpperCase()}_API_KEY`,
	}) as Model;

/*
 * The address of the model an agent thinks with, for the one thing that has to call it without the
 * agent in the loop. What is written down is where and how, never the key: the request leaves the
 * sandbox bare and is given a credential at the proxy, against a grant this agent already holds.
 */
describe("the model an agent thinks with, as an address", () => {
	it("is nothing at all when the agent has no model", () => {
		expect(thinkingFor(undefined)).toBeUndefined();
	});

	// Not a failure: a plane whose walk cannot ask for a second opinion is the walk there was before.
	it("is nothing for a provider this plane does not know how to speak to", () => {
		expect(thinkingFor(model("somebodyelse"))).toBeUndefined();
	});

	it("is the provider's own path and shape", () => {
		expect(thinkingFor(model("openai"))).toMatchObject({
			endpoint: "https://api.openai.com/v1/chat/completions",
			shape: "chat",
		});
		expect(thinkingFor(model("anthropic"))).toMatchObject({
			endpoint: "https://api.anthropic.com/v1/messages",
			shape: "messages",
		});
	});

	it("carries no key, only the name of the variable the proxy fills", () => {
		const said = JSON.stringify(thinkingFor(model("deepseek")));
		expect(said).toContain("DEEPSEEK_API_KEY");
		expect(said).not.toContain("sk-");
	});

	// Anthropic refuses a request without it, and it is the same header the plane itself sends.
	it("sends the version header anthropic insists on", () => {
		expect(thinkingFor(model("anthropic"))?.headers).toMatchObject({
			"anthropic-version": "2023-06-01",
		});
	});

	/*
	 * Measured rather than guessed. Asked which link on a page leads towards the goal, deepseek-flash
	 * spent fifteen thousand reasoning tokens and between fifty and ninety seconds — inside a loop
	 * whose other steps cost half a second. Told not to think out loud it answered in one, and better.
	 */
	it("tells a reasoner to answer instead of deliberate, where that is a thing it understands", () => {
		expect(thinkingFor(model("deepseek"))?.quietly).toMatchObject({
			thinking: { type: "disabled" },
		});
		expect(thinkingFor(model("openai"))?.quietly).toBeUndefined();
	});
});
