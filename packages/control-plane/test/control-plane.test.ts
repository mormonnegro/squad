import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane, carriesEnv, proxyTokenOf, withDefaults } from "../src/control-plane.ts";

describe("ControlPlane", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "agent-dive-plane-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("keeps its certificate authority in the state directory", () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		expect(plane.caCertPath).toBe(join(stateDir, "pki", "ca.crt"));
	});

	it("issues no proxy credential before it starts", () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		expect(plane.proxyToken("scout")).toBeUndefined();
	});

	it("routes replies to the webhook channel it owns", () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		expect(plane.webhooks.name).toBe("webhook");
	});

	it("refuses a name no manifest would accept, before anything is built for it", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		await expect(plane.create("Maxi Rodríguez")).rejects.toThrow(/not a name/);
	});

	it("refuses a name that is already answered to", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		await expect(plane.create("scout")).rejects.toThrow(/already here/);
	});

	it("refuses a hook that claims operator trust", () => {
		expect(
			() =>
				new ControlPlane({
					agents: [{ id: "scout" }],
					stateDir,
					hooks: [{ id: "deploys", agentId: "scout", secret: "s", trust: "operator" }],
				}),
		).toThrow();
	});
});

/**
 * What an agent inherits, and what it does not.
 *
 * The rule these keep honest: a grant is only ever something the operator wrote. Defaults are how
 * that is said once for agents that do not exist yet, which is the only way an agent created from
 * the CLI can reach the model without anyone handing it a capability at the keyboard.
 */
describe("defaults", () => {
	const defaults = {
		model: "claude-opus-4-7",
		env: { ANTHROPIC_API_KEY: "injected-by-the-proxy" },
		grants: [{ id: "model", host: "api.anthropic.com", injection: { kind: "none" } }],
	} as const;

	it("gives an agent that said nothing everything the operator allowed", () => {
		expect(withDefaults({ id: "maxi" }, defaults)).toMatchObject({
			id: "maxi",
			model: "claude-opus-4-7",
			grants: [{ id: "model" }],
		});
	});

	it("adds to what an agent asked for rather than replacing it", () => {
		const agent = withDefaults(
			{ id: "scout", grants: [{ id: "docs", host: "acme.com", injection: { kind: "none" } }] },
			defaults,
		);

		expect(agent.grants?.map((grant) => grant.id)).toEqual(["docs", "model"]);
	});

	// The only way to narrow a default rather than add to it: same id, the agent's terms.
	it("lets an agent redefine a grant by naming it", () => {
		const agent = withDefaults(
			{
				id: "scout",
				grants: [{ id: "model", host: "api.openai.com", injection: { kind: "none" } }],
			},
			defaults,
		);

		expect(agent.grants).toEqual([
			{ id: "model", host: "api.openai.com", injection: { kind: "none" } },
		]);
	});

	it("keeps the agent's own answer to everything else", () => {
		expect(withDefaults({ id: "scout", model: "claude-haiku-4-5" }, defaults).model).toBe(
			"claude-haiku-4-5",
		);
	});

	it("changes nothing when the config declared none", () => {
		expect(withDefaults({ id: "scout" })).toEqual({ id: "scout" });
	});
});

/**
 * Reading the egress credential back off a sandbox, which is what keeps a restart survivable: the
 * container is the only record of what the proxy will actually be shown.
 */
describe("proxyTokenOf", () => {
	const url = (user: string, token: string) => `http://${user}:${token}@egress:8080`;

	it("recovers the token a sandbox was created with", () => {
		expect(proxyTokenOf(url("scout", "s3cret-token"), "scout")).toBe("s3cret-token");
	});

	it("refuses a container carrying another agent's name", () => {
		// The proxy authenticates on the user too, so adopting this token would only move the failure
		// to the agent's first request, where it reads as the model being down.
		expect(proxyTokenOf(url("scribe", "s3cret-token"), "scout")).toBeUndefined();
	});

	it("has nothing to recover from a sandbox with no proxy", () => {
		expect(proxyTokenOf(undefined, "scout")).toBeUndefined();
		expect(proxyTokenOf("http://egress:8080", "scout")).toBeUndefined();
		expect(proxyTokenOf("not a url", "scout")).toBeUndefined();
	});

	it("reads through the escaping the URL was built with", () => {
		expect(proxyTokenOf(url(encodeURIComponent("a.b"), encodeURIComponent("t/k+n=")), "a.b")).toBe(
			"t/k+n=",
		);
	});
});

/**
 * The other half of adopting a sandbox: it is only the agent the operator means if it still holds
 * what the configuration says. Docker freezes an environment at creation, so this is the only place
 * an edited config and a running container can be reconciled.
 */
describe("carriesEnv", () => {
	it("adopts a sandbox holding what the configuration declares", () => {
		expect(
			carriesEnv({ PATH: "/usr/bin", MODEL_KEY: "placeholder" }, { MODEL_KEY: "placeholder" }),
		).toBe(true);
	});

	// The switch this was written for: the provider changed, and the sandbox that is still up has the
	// old provider's variable and not the new one's.
	it("refuses one born before the operator changed providers", () => {
		expect(
			carriesEnv({ ANTHROPIC_API_KEY: "placeholder" }, { DEEPSEEK_API_KEY: "placeholder" }),
		).toBe(false);
	});

	it("refuses one whose value has since been edited", () => {
		expect(carriesEnv({ TZ: "UTC" }, { TZ: "America/Montevideo" })).toBe(false);
	});

	// Everything else in there is the image's and the plane's own, and it changes for reasons that
	// have nothing to do with the agent.
	it("ignores what the container holds beyond what was declared", () => {
		expect(
			carriesEnv({ TZ: "UTC", HOSTNAME: "9f2c", HTTPS_PROXY: "http://a:b@egress" }, { TZ: "UTC" }),
		).toBe(true);
	});

	it("adopts an agent that declared no environment at all", () => {
		expect(carriesEnv({ PATH: "/usr/bin" }, undefined)).toBe(true);
		expect(carriesEnv({}, {})).toBe(true);
	});
});
