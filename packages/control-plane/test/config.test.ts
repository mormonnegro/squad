import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.ts";
import { withDefaults } from "../src/control-plane.ts";

const EXAMPLE = fileURLToPath(new URL("../../../deploy/config.example.yaml", import.meta.url));

const MINIMAL = `
stateDir: /var/lib/squad
agents:
  - id: scout
`;

describe("parseConfig", () => {
	it("reads the agents an operator declared", () => {
		const config = parseConfig(MINIMAL, {});

		expect(config.stateDir).toBe("/var/lib/squad");
		expect(config.agents.map((agent) => agent.id)).toEqual(["scout"]);
	});

	it("keeps grants and schedules for the proxy and scheduler to check", () => {
		const config = parseConfig(
			`
stateDir: /state
agents:
  - id: scout
    grants:
      - id: github-read
        host: api.github.com
        methods: [GET]
        injection:
          kind: bearer
          token: { ref: GITHUB_TOKEN }
    schedules:
      - kind: cron
        expression: "0 9 * * *"
        channel: cron:daily
        body: check the queue
        trust: operator
        createdBy: operator
`,
			{},
		);

		expect(config.agents[0]?.grants).toEqual([
			{
				id: "github-read",
				host: "api.github.com",
				methods: ["GET"],
				injection: { kind: "bearer", token: { ref: "GITHUB_TOKEN" } },
			},
		]);
		expect(config.agents[0]?.schedules).toHaveLength(1);
	});

	it("puts named environment values into the sandbox without writing them down", () => {
		const config = parseConfig(
			`
stateDir: /state
agents:
  - id: scout
    envFrom:
      ANTHROPIC_API_KEY: SCOUT_KEY
`,
			{ SCOUT_KEY: "sk-live" },
		);

		expect(config.agents[0]?.env).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
	});

	it("refuses to start when an agent's named value is missing", () => {
		expect(() =>
			parseConfig("stateDir: /s\nagents:\n  - id: scout\n    envFrom:\n      KEY: SCOUT_KEY\n", {}),
		).toThrow(/agents\[0\]\.envFrom\.KEY reads SCOUT_KEY/);
	});

	it("keeps literal env alongside named values", () => {
		const config = parseConfig(
			`
stateDir: /state
agents:
  - id: scout
    env:
      TZ: UTC
    envFrom:
      KEY: SCOUT_KEY
`,
			{ SCOUT_KEY: "sk-live" },
		);

		expect(config.agents[0]?.env).toEqual({ TZ: "UTC", KEY: "sk-live" });
	});

	it("refuses a configuration without a state directory", () => {
		expect(() => parseConfig("agents:\n  - id: scout\n", {})).toThrow(ConfigError);
	});

	it("refuses a configuration with no agents", () => {
		expect(() => parseConfig("stateDir: /state\nagents: []\n", {})).toThrow(
			/agents must be a non-empty list/,
		);
	});

	it("refuses an agent without an id", () => {
		expect(() => parseConfig("stateDir: /state\nagents:\n  - model: opus\n", {})).toThrow(
			/agents\[0\]\.id/,
		);
	});

	it("refuses an id the agent's own manifest could not carry as its name", () => {
		expect(() => parseConfig("stateDir: /state\nagents:\n  - id: Scout Bot\n", {})).toThrow(
			/lowercase alphanumeric/,
		);
	});

	it("reports every problem at once rather than one per run", () => {
		try {
			parseConfig("agents: []\n", {});
			expect.unreachable();
		} catch (error) {
			expect((error as ConfigError).issues).toHaveLength(2);
		}
	});

	/**
	 * The road may be open; the keys are given to somewhere by name. A grant on every host carrying a
	 * credential would put that secret on every server the agent is ever talked into touching, which
	 * is the one thing this whole proxy exists so that a leaked transcript cannot do.
	 */
	it("refuses a grant on every host that carries a credential", () => {
		expect(() =>
			parseConfig(
				`
stateDir: /state
defaults:
  grants:
    - id: everything
      host: "*"
      injection:
        kind: bearer
        token: { ref: OPENAI_API_KEY }
agents:
  - id: scout
`,
				{},
			),
		).toThrow(/host "\*" with a bearer credential/);
	});

	it("takes a grant on every host that carries nothing", () => {
		const config = parseConfig(
			`
stateDir: /state
defaults:
  grants:
    - id: web
      host: "*"
      injection: { kind: none }
agents:
  - id: scout
`,
			{},
		);

		expect(config.defaults?.grants?.[0]).toEqual({
			id: "web",
			host: "*",
			injection: { kind: "none" },
		});
	});

	it("refuses anything that is not a mapping", () => {
		expect(() => parseConfig("- scout\n", {})).toThrow(/must be a YAML mapping/);
	});

	it("reports a YAML syntax error as a configuration problem", () => {
		expect(() => parseConfig("stateDir: [\n", {})).toThrow(ConfigError);
	});
});

describe("parseConfig hooks", () => {
	const withHook = (extra: string) => `
stateDir: /state
agents:
  - id: scout
hooks:
  - id: deploys
    agentId: scout
    secretEnv: DEPLOY_SECRET
${extra}`;

	it("takes hook secrets from the environment, not the file", () => {
		const config = parseConfig(withHook(""), { DEPLOY_SECRET: "s3cret" });

		expect(config.hooks?.[0]).toMatchObject({ id: "deploys", agentId: "scout", secret: "s3cret" });
	});

	it("refuses to start when a named secret is missing", () => {
		expect(() => parseConfig(withHook(""), {})).toThrow(/DEPLOY_SECRET from the environment/);
	});

	it("treats an empty secret as missing", () => {
		expect(() => parseConfig(withHook(""), { DEPLOY_SECRET: "" })).toThrow(ConfigError);
	});

	it("refuses a hook that claims operator trust", () => {
		expect(() => parseConfig(withHook("    trust: operator\n"), { DEPLOY_SECRET: "s" })).toThrow(
			/proves the sender, not the intent/,
		);
	});

	it("carries the trust an operator did allow", () => {
		const config = parseConfig(withHook("    trust: participant\n"), { DEPLOY_SECRET: "s" });

		expect(config.hooks?.[0]?.trust).toBe("participant");
	});

	it("refuses a hook pointing at an agent that does not exist", () => {
		expect(() =>
			parseConfig(
				`
stateDir: /state
agents:
  - id: scout
hooks:
  - id: deploys
    agentId: ghost
    secretEnv: DEPLOY_SECRET
`,
				{ DEPLOY_SECRET: "s" },
			),
		).toThrow(/unknown agent "ghost"/);
	});

	it("refuses hooks that are not a list", () => {
		expect(() => parseConfig("stateDir: /s\nagents:\n  - id: a\nhooks: {}\n", {})).toThrow(
			/hooks must be a list/,
		);
	});

	it("leaves hooks empty when none are declared", () => {
		expect(parseConfig(MINIMAL, {}).hooks).toEqual([]);
	});
});

/**
 * What an agent nobody wrote down is made of. It is the operator's answer, given in advance, to a
 * name typed months later — so it lives in the file the agent cannot reach, like every other grant.
 */
describe("defaults", () => {
	const WITH_DEFAULTS = `
stateDir: /state
defaults:
  model: claude-opus-4-7
  envFrom:
    ANTHROPIC_API_KEY: MODEL_KEY
  grants:
    - id: model
      host: api.anthropic.com
      injection: { kind: none }
agents:
  - id: scout
`;

	it("resolves its secrets from the environment, like an agent's own", () => {
		const config = parseConfig(WITH_DEFAULTS, { MODEL_KEY: "sk-live" });

		expect(config.defaults?.env).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
		expect(config.defaults?.grants?.[0]?.host).toBe("api.anthropic.com");
	});

	it("refuses to start when the environment does not hold what they name", () => {
		expect(() => parseConfig(WITH_DEFAULTS, {})).toThrow(ConfigError);
	});

	it("refuses a default that names an agent, since they describe every agent", () => {
		expect(() =>
			parseConfig(`stateDir: /state\ndefaults:\n  id: scout\nagents:\n  - id: scout\n`, {}),
		).toThrow(ConfigError);
	});

	it("refuses anything that is not a mapping", () => {
		expect(() =>
			parseConfig(`stateDir: /state\ndefaults: [1, 2]\nagents:\n  - id: scout\n`, {}),
		).toThrow(ConfigError);
	});

	it("leaves them undefined when the file says nothing", () => {
		expect(parseConfig(MINIMAL, {}).defaults).toBeUndefined();
	});
});

/**
 * The one capability every agent needs and the one nobody thinks of as a capability. Configuring it
 * by hand meant four coupled lines — provider, model, a placeholder key, a grant naming the host —
 * and any one of them wrong is not a startup error but a turn that dies at the proxy.
 */
describe("models", () => {
	const CONFIGURED = `
stateDir: /state
models:
  - id: flash
    provider: deepseek
  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6
defaults:
  model: flash
agents:
  - id: scout
`;

	it("fills in what is known about a provider from its name alone", () => {
		const config = parseConfig(CONFIGURED, {});

		expect(config.models[0]).toEqual({
			id: "flash",
			provider: "deepseek",
			// Said once: an id that is already the model's name is the common case.
			model: "flash",
			host: "api.deepseek.com",
			keyEnv: "DEEPSEEK_API_KEY",
		});
	});

	it("takes the model's real name when the id is only a nickname", () => {
		expect(parseConfig(CONFIGURED, {}).models[1]?.model).toBe("claude-sonnet-4-6");
	});

	/**
	 * The grant and the placeholder are derived rather than written, so they cannot disagree with the
	 * model they were written for. Every agent gets every model's, which is what lets `/model` choose
	 * without granting.
	 */
	it("grants every agent every configured model, keys and all", () => {
		const config = parseConfig(CONFIGURED, {});
		const agent = withDefaults({ id: "made-later" }, config.defaults);

		expect(agent.grants?.map((grant) => grant.host)).toEqual([
			"api.deepseek.com",
			"api.anthropic.com",
		]);
		// The variables go wider than the grants on purpose: a placeholder is worth nothing and a
		// container's environment is set once, while what it may actually reach is the grant list.
		expect(agent.env).toMatchObject({
			DEEPSEEK_API_KEY: "injected-by-the-proxy",
			ANTHROPIC_API_KEY: "injected-by-the-proxy",
		});
	});

	// An operator who wrote their own grant for the same host meant that one: it is more specific
	// than anything derived here, and the proxy matches in order.
	it("leaves the operator's own grants in front of the derived ones", () => {
		const config = parseConfig(
			`
stateDir: /state
models:
  - id: flash
    provider: deepseek
defaults:
  model: flash
  grants:
    - id: mine
      host: api.deepseek.com
      injection: { kind: none }
agents:
  - id: scout
`,
			{},
		);

		expect(config.defaults?.grants?.map((grant) => grant.id)).toEqual(["mine", "model:flash"]);
	});

	/**
	 * The whole point of the block is that a name is enough. A provider nobody has heard of is still
	 * configurable, but then the two facts the table would have supplied have to be said.
	 */
	it("takes a provider nothing knows when it says where it lives and what its key is called", () => {
		const config = parseConfig(
			`
stateDir: /state
models:
  - id: local
    provider: my-gateway
    model: llama-4-70b
    host: models.acme.internal
    keyEnv: GATEWAY_TOKEN
agents:
  - id: scout
`,
			{},
		);

		expect(config.models[0]?.host).toBe("models.acme.internal");
		expect(config.models[0]?.keyEnv).toBe("GATEWAY_TOKEN");
	});

	it("refuses a provider nothing knows and that says neither", () => {
		expect(() =>
			parseConfig(`stateDir: /state\nmodels:\n  - id: local\n    provider: my-gateway\n`, {}),
		).toThrow(/nothing here knows "my-gateway"/);
	});

	// Two models under one name is one model to `/model` and to the proxy, and which one it is
	// depends on the order they were written in.
	it("refuses two models called the same thing", () => {
		expect(() =>
			parseConfig(
				`stateDir: /state\nmodels:\n  - id: flash\n    provider: deepseek\n  - id: flash\n    provider: groq\n`,
				{},
			),
		).toThrow(/there is already a model called "flash"/);
	});

	/**
	 * A default naming a model that is not on the list would deploy, and then every agent would start
	 * on a name pi does not know with no grant for wherever it went looking.
	 */
	it("refuses a default on a model nobody configured", () => {
		expect(() =>
			parseConfig(
				`stateDir: /state\nmodels:\n  - id: flash\n    provider: deepseek\ndefaults:\n  model: ghost\nagents:\n  - id: scout\n`,
				{},
			),
		).toThrow(/not one of the models configured: flash/);
	});

	it("refuses an agent on a model nobody configured", () => {
		expect(() =>
			parseConfig(
				`stateDir: /state\nmodels:\n  - id: flash\n    provider: deepseek\nagents:\n  - id: scout\n    model: ghost\n`,
				{},
			),
		).toThrow(/agent "scout".model is "ghost"/);
	});

	// Both said, and they can disagree: the model already names its provider, so the loose one is
	// either redundant or wrong, and there is no way to tell which from here.
	it("refuses a provider written beside a configured model", () => {
		expect(() =>
			parseConfig(
				`stateDir: /state\nmodels:\n  - id: flash\n    provider: deepseek\ndefaults:\n  model: flash\n  provider: groq\nagents:\n  - id: scout\n`,
				{},
			),
		).toThrow(/the provider comes from the model/);
	});

	/**
	 * The one thing a missing key must not do. `deploy/install.sh` writes the variable through empty
	 * if the operator has not exported one yet, and refusing to start there would make the first run
	 * a configuration exercise instead of a working plane. `/model` says it where it can be fixed.
	 */
	it("starts with a model whose key nobody has exported yet", () => {
		expect(() => parseConfig(CONFIGURED, {})).not.toThrow();
	});

	it("refuses models that are not a list", () => {
		expect(() => parseConfig("stateDir: /s\nmodels: {}\nagents:\n  - id: a\n", {})).toThrow(
			/models must be a list/,
		);
	});

	// Without a block, provider and model are whatever the file said and go to pi untouched. This is
	// every configuration written before the block existed.
	it("leaves a file with no models saying exactly what it said", () => {
		const config = parseConfig(
			`stateDir: /state\ndefaults:\n  provider: anthropic\n  model: claude-opus-4-7\nagents:\n  - id: scout\n`,
			{},
		);

		expect(config.models).toEqual([]);
		expect(config.defaults?.provider).toBe("anthropic");
		expect(config.defaults?.model).toBe("claude-opus-4-7");
		expect(config.defaults?.grants).toBeUndefined();
	});
});

/**
 * The example is the only documentation of the configuration, and documentation drifts silently.
 * It once shipped without a grant for the model, which parses, deploys and then cannot think.
 */
describe("the example configuration", () => {
	it("parses, and grants its agents the one host without which no turn can finish", async () => {
		const config = parseConfig(await readFile(EXAMPLE, "utf8"), {
			DEEPSEEK_API_KEY: "sk-live",
			GITHUB_TOKEN: "ghp-live",
			DEPLOY_HOOK_SECRET: "s3cret",
		});

		// Wherever the file chose to say it: the declared agent and one created later are the same
		// agent to the proxy, and an example that can only think in the first case is a broken one.
		const agent = withDefaults(config.agents[0] ?? { id: "none" }, config.defaults);
		const made = withDefaults({ id: "made-later" }, config.defaults);
		for (const each of [agent, made]) {
			expect(each.grants?.map((grant) => grant.host)).toContain("api.deepseek.com");
			// And it holds no key of its own, because the grant writes the real one on the way out.
			expect(each.env?.DEEPSEEK_API_KEY).not.toBe("sk-live");
		}
	});

	it("starts its agents on a model it configured, rather than leaving pi to pick one", async () => {
		// Said nowhere, pi falls back to its own default provider, and the grant is then for a host
		// the agent never calls: every turn dies at the proxy against a perfectly correct config.
		const config = parseConfig(await readFile(EXAMPLE, "utf8"), {
			DEEPSEEK_API_KEY: "sk-live",
			GITHUB_TOKEN: "ghp-live",
			DEPLOY_HOOK_SECRET: "s3cret",
		});

		const chosen = config.models.find((model) => model.id === config.defaults?.model);
		expect(chosen?.provider).toBeDefined();
		expect(chosen?.host).toBe("api.deepseek.com");
	});
});

/**
 * The one setting whose failure mode is a bill. A ceiling that silently did nothing because it was
 * written as `"5"` would be discovered by exceeding it, which is the thing it was written to prevent.
 */
describe("limitUsd", () => {
	it("reads a ceiling in US dollars a day", () => {
		const config = parseConfig(
			`
stateDir: /state
agents:
  - id: scout
    limitUsd: 5
`,
			{},
		);

		expect(config.agents[0]).toMatchObject({ limitUsd: 5 });
	});

	it("says so rather than ignoring a ceiling it cannot read", () => {
		for (const written of ['"5"', "0", "-1", "5 dollars"]) {
			expect(() =>
				parseConfig(`stateDir: /state\nagents:\n  - id: scout\n    limitUsd: ${written}\n`, {}),
			).toThrow(ConfigError);
		}
	});

	it("checks the one in defaults too, since it is the one that covers every agent", () => {
		expect(() =>
			parseConfig(`stateDir: /state\ndefaults:\n  limitUsd: "5"\nagents:\n  - id: scout\n`, {}),
		).toThrow(/limitUsd/);
	});

	// The reason for having it in defaults: an agent created from the CLI a month from now is the
	// one nobody is going to remember to put a ceiling on.
	it("gives an agent that named no ceiling the one from defaults", () => {
		const config = parseConfig(
			`stateDir: /state\ndefaults:\n  limitUsd: 2\nagents:\n  - id: scout\n`,
			{},
		);

		expect(withDefaults({ id: "scout" }, config.defaults)).toMatchObject({ limitUsd: 2 });
	});
});
