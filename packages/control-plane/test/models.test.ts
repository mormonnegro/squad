import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_PLACEHOLDER, type Model, ModelChoices, modelEnv, modelGrants } from "../src/models.ts";

const deepseek: Model = {
	id: "flash",
	provider: "deepseek",
	model: "deepseek-v4-flash",
	host: "api.deepseek.com",
	keyEnv: "DEEPSEEK_API_KEY",
};

const anthropic: Model = {
	id: "sonnet",
	provider: "anthropic",
	model: "claude-sonnet-4-6",
	host: "api.anthropic.com",
	keyEnv: "ANTHROPIC_API_KEY",
	header: "x-api-key",
};

describe("modelGrants", () => {
	it("attaches the key as a bearer token by default", () => {
		expect(modelGrants([deepseek])).toEqual([
			{
				id: "model:flash",
				host: "api.deepseek.com",
				injection: { kind: "bearer", token: { ref: "DEEPSEEK_API_KEY" } },
			},
		]);
	});

	// Anthropic refuses a bearer token, so a table that only knew hosts would produce a grant that
	// matches, injects, and is then turned away by the provider as unauthenticated.
	it("puts it in the provider's own header when that is how the provider takes it", () => {
		expect(modelGrants([anthropic])[0]?.injection).toEqual({
			kind: "header",
			name: "x-api-key",
			value: { ref: "ANTHROPIC_API_KEY" },
		});
	});

	/**
	 * The reason `/model` is allowed to be a command at all. If an agent only held the grant for the
	 * model it is on, moving it would be granting it a host it could not reach a moment earlier —
	 * which is the one thing the keyboard may never do.
	 */
	it("gives one agent every configured model, not just the one it is on", () => {
		expect(modelGrants([deepseek, anthropic]).map((grant) => grant.host)).toEqual([
			"api.deepseek.com",
			"api.anthropic.com",
		]);
	});

	// The grant is the only thing that names a host, and two grants with one id is one grant.
	it("names each grant after the model, so two models are two grants", () => {
		expect(modelGrants([deepseek, anthropic]).map((grant) => grant.id)).toEqual([
			"model:flash",
			"model:sonnet",
		]);
	});
});

describe("modelEnv", () => {
	/**
	 * pi will not start on a provider it cannot see a key for, and the key is deliberately not in the
	 * container. Every configured model's variable is set, not just the current one's, because the
	 * container outlives a `/model` and recreating it to change a model would make the command a
	 * restart.
	 */
	it("gives the container a worthless value under every configured model's variable", () => {
		expect(modelEnv([deepseek, anthropic])).toEqual({
			DEEPSEEK_API_KEY: KEY_PLACEHOLDER,
			ANTHROPIC_API_KEY: KEY_PLACEHOLDER,
		});
	});

	it("says nothing when nothing is configured", () => {
		expect(modelEnv([])).toEqual({});
	});
});

describe("ModelChoices", () => {
	let dir = "";
	let choices: ModelChoices;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "models-"));
		choices = new ModelChoices(join(dir, "models.json"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("has no opinion until somebody chooses, so the configuration decides", async () => {
		expect(await choices.chosen("scout")).toBeUndefined();
	});

	it("remembers what one agent was moved onto", async () => {
		await choices.choose("scout", "sonnet");

		expect(await choices.chosen("scout")).toBe("sonnet");
	});

	it("keeps each agent's choice to itself", async () => {
		await choices.choose("scout", "sonnet");

		expect(await choices.chosen("scribe")).toBeUndefined();
	});

	it("replaces the choice rather than keeping both", async () => {
		await choices.choose("scout", "sonnet");
		await choices.choose("scout", "flash");

		expect(await choices.chosen("scout")).toBe("flash");
	});

	// A plane restarts more often than an agent changes its mind, so a choice that lived in memory
	// would quietly put every agent back on the configured model at the next deploy.
	it("survives the plane it was made on", async () => {
		await choices.choose("scout", "sonnet");

		expect(await new ModelChoices(join(dir, "models.json")).chosen("scout")).toBe("sonnet");
	});

	/**
	 * Every agent on the plane shares one of these, and read-modify-write is not atomic: two agents
	 * moved at once would otherwise leave whichever wrote last as the only one that happened.
	 */
	it("keeps choices made at the same moment", async () => {
		await Promise.all([choices.choose("a", "flash"), choices.choose("b", "sonnet")]);

		expect([await choices.chosen("a"), await choices.chosen("b")]).toEqual(["flash", "sonnet"]);
	});

	it("puts an agent back on the configured model when it is forgotten", async () => {
		await choices.choose("scout", "sonnet");
		await choices.forget("scout");

		expect(await choices.chosen("scout")).toBeUndefined();
	});

	it("forgets an agent that never chose without complaining", async () => {
		await expect(choices.forget("scout")).resolves.toBeUndefined();
	});
});
