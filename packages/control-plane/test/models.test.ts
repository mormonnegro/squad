import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	KEY_PLACEHOLDER,
	type Model,
	ModelChoices,
	modelEnv,
	modelGrants,
	PROVIDERS,
	providersOf,
} from "../src/models.ts";

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

describe("providersOf", () => {
	const listed = (models: readonly Model[]) => providersOf(models).map((provider) => provider.id);

	// The screen is for filling in the keys this plane is waiting on, so those are the rows that
	// should be reachable without scrolling past every provider anybody ever heard of.
	it("puts the configured providers before the rest", () => {
		expect(listed([deepseek, anthropic]).slice(0, 2)).toEqual(["deepseek", "anthropic"]);
	});

	it("says which models are waiting on each key, so a row explains itself", () => {
		expect(providersOf([deepseek, anthropic])[0]).toEqual({
			id: "deepseek",
			keyEnv: "DEEPSEEK_API_KEY",
			models: ["flash"],
		});
	});

	it("gathers the models of one provider into its one row", () => {
		const pro: Model = { ...deepseek, id: "pro", model: "deepseek-v4" };

		expect(providersOf([deepseek, pro])[0]?.models).toEqual(["flash", "pro"]);
	});

	/**
	 * A row is a key rather than a provider name. An operator who writes a second `keyEnv` out by hand
	 * has two keys to give, and one row would leave half their models refused at the proxy by a screen
	 * that said the provider was set up.
	 */
	it("makes a second row for a second key on the same provider", () => {
		const second: Model = { ...deepseek, id: "cheap", keyEnv: "DEEPSEEK_OTHER_KEY" };

		expect(providersOf([deepseek, second]).map((provider) => provider.keyEnv)).toEqual([
			"DEEPSEEK_API_KEY",
			"DEEPSEEK_OTHER_KEY",
			...Object.values(PROVIDERS)
				.map((known) => known.keyEnv)
				.filter((keyEnv) => keyEnv !== "DEEPSEEK_API_KEY"),
		]);
	});

	// Setting a provider up should be something you can find rather than something you have to
	// already know the name of, so the known ones are offered before any model names them.
	it("offers the providers nothing is configured on yet", () => {
		expect(listed([])).toEqual(Object.keys(PROVIDERS));
	});

	it("does not offer a configured provider twice", () => {
		expect(listed([anthropic]).filter((id) => id === "anthropic")).toEqual(["anthropic"]);
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
