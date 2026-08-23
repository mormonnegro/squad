import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.ts";

const MINIMAL = `
stateDir: /var/lib/agent-dive
agents:
  - id: scout
`;

describe("parseConfig", () => {
	it("reads the agents an operator declared", () => {
		const config = parseConfig(MINIMAL, {});

		expect(config.stateDir).toBe("/var/lib/agent-dive");
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
			/agents\[0\]\.id is required/,
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
