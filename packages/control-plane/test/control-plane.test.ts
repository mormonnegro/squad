import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewAgentEvent } from "@squad/events";
import { EnvSecretStore } from "@squad/proxy";
import type { ExecResult } from "@squad/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentConfig,
	ControlPlane,
	carriesEnv,
	endpointPath,
	MAX_WAKE_SECONDS,
	MIN_WAKE_SECONDS,
	proxyTokenOf,
	troubledServers,
	withDefaults,
} from "../src/control-plane.ts";
import { ProviderKeys } from "../src/keys.ts";
import type { TurnResult, TurnRunner, WakeChange } from "../src/turn.ts";

describe("ControlPlane", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-plane-"));
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
 * The seam `/model` turns on. The command writes a name beside the config it may not edit, and
 * everything that asks what an agent thinks with has to read that first — otherwise the answer says
 * it moved and every turn after it goes on being answered by the model it was moved off.
 */
describe("the model an agent was moved onto", () => {
	let stateDir: string;
	const models = [
		{
			id: "flash",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			host: "api.deepseek.com",
			keyEnv: "DEEPSEEK_API_KEY",
		},
		{
			id: "sonnet",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			host: "api.anthropic.com",
			keyEnv: "ANTHROPIC_API_KEY",
			header: "x-api-key",
		},
	];
	const planeWith = () =>
		new ControlPlane({ agents: [{ id: "scout", model: "flash" }], stateDir, models });

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-model-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("starts on the one the configuration named", async () => {
		expect((await planeWith().agents())[0]?.model).toBe("flash");
	});

	it("is the one the console shows after the move", async () => {
		const plane = planeWith();

		await plane.command("scout", "/model sonnet");

		expect((await plane.agents())[0]?.model).toBe("sonnet");
	});

	// The config file is the operator's and no plane may write it, so a choice made at the keyboard
	// has to live beside it. One that only lived in memory would be undone by the next deploy.
	it("outlives the plane it was chosen on", async () => {
		await planeWith().command("scout", "/model sonnet");

		expect((await planeWith().agents())[0]?.model).toBe("sonnet");
	});

	// The name can be created again, and the next agent to hold it is not the one that was moved.
	it("goes back to the configuration when the agent is purged", async () => {
		const plane = planeWith();
		await plane.command("scout", "/model sonnet");

		await plane.remove("scout", { purge: true });

		expect((await planeWith().agents())[0]?.model).toBe("flash");
	});
});

/**
 * The keys a console can fill in.
 *
 * The plane's half of the config screen: what it is willing to be told, and what it refuses to be
 * told at a keyboard no matter who is holding it.
 */
describe("provider keys", () => {
	let stateDir: string;
	const models = [
		{
			id: "flash",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			host: "api.deepseek.com",
			keyEnv: "DEEPSEEK_API_KEY",
		},
	];
	const planeWith = () =>
		new ControlPlane({
			agents: [{ id: "scout", model: "flash" }],
			stateDir,
			models,
			secrets: new EnvSecretStore({ OPENAI_API_KEY: "from-the-machine" }),
		});

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-keys-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const standing = async (keyEnv: string) =>
		(await planeWith().providers()).find((provider) => provider.keyEnv === keyEnv);

	it("says a configured provider is waiting on its key", async () => {
		expect(await standing("DEEPSEEK_API_KEY")).toMatchObject({ models: ["flash"], held: false });
	});

	it("says a key the machine exported is already there", async () => {
		expect(await standing("OPENAI_API_KEY")).toMatchObject({ held: true, here: false });
	});

	it("holds a key it was given, so the next turn is paid for", async () => {
		const plane = planeWith();

		await plane.setKey("DEEPSEEK_API_KEY", "sk-typed");

		expect(await standing("DEEPSEEK_API_KEY")).toMatchObject({ held: true, here: true });
	});

	// Whatever a terminal adds to a pasted key is not part of the key, and a trailing newline is the
	// difference between a working plane and every turn refused with no visible reason.
	it("takes what was pasted rather than what the terminal added to it", async () => {
		await planeWith().setKey("DEEPSEEK_API_KEY", "  sk-typed\n");

		const kept = new ProviderKeys(join(stateDir, "keys.json"), new EnvSecretStore());
		expect(await kept.resolve({ ref: "DEEPSEEK_API_KEY" })).toBe("sk-typed");
	});

	/**
	 * The boundary this screen lives inside. Every other secret the plane resolves is one a grant in
	 * the operator's file named, and filling those in at a keyboard would be handing out exactly the
	 * credentials that file was careful to only name.
	 */
	it("refuses a secret that is not a provider's, however it is spelled", async () => {
		await expect(planeWith().setKey("GITHUB_TOKEN", "ghp-typed")).rejects.toThrow(
			/not a provider key/,
		);
	});

	it("hands the provider back to the machine when the key is taken away", async () => {
		const plane = planeWith();
		await plane.setKey("OPENAI_API_KEY", "sk-typed");

		await plane.setKey("OPENAI_API_KEY", "");

		expect(await standing("OPENAI_API_KEY")).toMatchObject({ held: true, here: false });
	});

	it("outlives the plane it was typed at", async () => {
		await planeWith().setKey("DEEPSEEK_API_KEY", "sk-typed");

		expect(await standing("DEEPSEEK_API_KEY")).toMatchObject({ held: true, here: true });
	});
});

/**
 * The other half of a plane you do not have to redeploy to change. A key is no use without a model to
 * spend it on, and until this the list of models was the file and only the file — so trying a second
 * provider meant editing YAML over SSH and restarting the thing.
 */
describe("a model added at the console", () => {
	let stateDir: string;
	const declared = [
		{
			id: "flash",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			host: "api.deepseek.com",
			keyEnv: "DEEPSEEK_API_KEY",
		},
	];
	const planeWith = () =>
		new ControlPlane({
			agents: [{ id: "scout", model: "flash" }],
			stateDir,
			models: declared,
			secrets: new EnvSecretStore({ ANTHROPIC_API_KEY: "from-the-machine" }),
		});

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-models-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const named = async (plane: ControlPlane, id: string) =>
		(await plane.models()).find((model) => model.id === id);

	it("joins the ones the file declared", async () => {
		const plane = planeWith();

		await plane.addModel({ id: "sonnet", provider: "anthropic", model: "claude-sonnet-4-6" });

		expect((await plane.models()).map((model) => model.id)).toEqual(["flash", "sonnet"]);
	});

	// Naming the provider is the whole of configuring it here too, which is the point: the console
	// asks for the two things that are decisions and fills in the four that are facts.
	it("fills in the host and the variable from the provider's name", async () => {
		const plane = planeWith();

		await plane.addModel({ id: "sonnet", provider: "anthropic", model: "claude-sonnet-4-6" });

		expect(await named(plane, "sonnet")).toMatchObject({
			host: "api.anthropic.com",
			keyEnv: "ANTHROPIC_API_KEY",
			header: "x-api-key",
		});
	});

	it("says which of the two lists a model is on, so the screen knows what it may do to it", async () => {
		const plane = planeWith();
		await plane.addModel({ id: "sonnet", provider: "anthropic" });

		expect(await named(plane, "flash")).toMatchObject({ added: false });
		expect(await named(plane, "sonnet")).toMatchObject({ added: true });
	});

	it("says whether this plane can pay for it", async () => {
		const plane = planeWith();

		await plane.addModel({ id: "sonnet", provider: "anthropic" });

		expect(await named(plane, "sonnet")).toMatchObject({ held: true });
		expect(await named(plane, "flash")).toMatchObject({ held: false });
	});

	// The whole reason this is worth doing at the console: a model that needed a restart to become
	// usable would be a model you may as well have added to the file.
	it("is something the agents may reach, without anything being restarted", async () => {
		const plane = planeWith();
		const before = (await plane.agents()).find((agent) => agent.id === "scout")?.grants ?? 0;

		await plane.addModel({ id: "sonnet", provider: "anthropic" });

		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(before + 1);
	});

	it("outlives the plane it was typed at", async () => {
		await planeWith().addModel({ id: "sonnet", provider: "anthropic" });

		expect((await planeWith().models()).map((model) => model.id)).toContain("sonnet");
	});

	it("goes away again, and takes the reach with it", async () => {
		const plane = planeWith();
		await plane.addModel({ id: "sonnet", provider: "anthropic" });

		const reaching = (await plane.agents()).find((agent) => agent.id === "scout")?.grants ?? 0;

		await plane.dropModel("sonnet");

		expect((await plane.models()).map((model) => model.id)).toEqual(["flash"]);
		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(reaching - 1);
	});

	it("says so rather than pretending, when there was no such model", async () => {
		await expect(planeWith().dropModel("sonnet")).rejects.toThrow(/No model "sonnet"/);
	});

	/**
	 * The file stays the operator's. A console that could overwrite a declaration would make the file
	 * a suggestion, and the point of writing these somewhere else is that both are still readable.
	 */
	it("will not stand in for one the file declared, or take it away", async () => {
		const plane = planeWith();

		await expect(plane.addModel({ id: "flash", provider: "anthropic" })).rejects.toThrow(
			/declared in the config file/,
		);
		await expect(plane.dropModel("flash")).rejects.toThrow(/declared in the config file/);
	});

	it("refuses a provider nothing here knows, and says which it does", async () => {
		await expect(planeWith().addModel({ id: "local", provider: "my-gateway" })).rejects.toThrow(
			/nothing here knows "my-gateway"/,
		);
	});

	// Written out, it works — which is what keeps the table a convenience rather than the boundary.
	it("takes a provider nothing knows when it is told where it lives", async () => {
		const plane = planeWith();

		await plane.addModel({
			id: "local",
			provider: "my-gateway",
			model: "llama-4-70b",
			host: "models.acme.internal",
			keyEnv: "GATEWAY_TOKEN",
		});

		expect(await named(plane, "local")).toMatchObject({ host: "models.acme.internal" });
	});

	/**
	 * What the key just bought the ability to look up.
	 *
	 * Only anthropic has a key in this fixture, so this is also the rule: a provider this plane cannot
	 * pay is not asked, because the request would be a 401 in exchange for nothing.
	 */
	describe("and the list it is picked from", () => {
		afterEach(() => vi.unstubAllGlobals());

		const answering = (each: (host: string) => { ok: boolean; body: unknown }) => {
			const asked: string[] = [];
			vi.stubGlobal("fetch", async (url: string) => {
				asked.push(new URL(url).host);
				const { ok, body } = each(new URL(url).host);
				return { ok, status: ok ? 200 : 401, json: async () => body } as Response;
			});
			return asked;
		};

		it("asks only the providers this plane holds a key for", async () => {
			const asked = answering(() => ({ ok: true, body: { data: [{ id: "claude-opus-4-7" }] } }));

			const catalog = await planeWith().offers();

			expect(asked).toEqual(["api.anthropic.com"]);
			expect(catalog.offers).toEqual([{ provider: "anthropic", id: "claude-opus-4-7" }]);
		});

		// The point of the list is what is not on the screen behind it yet, and picking one already
		// configured would be an id collision rather than a model.
		it("leaves out what is configured already", async () => {
			answering(() => ({ ok: true, body: { data: [{ id: "claude-opus-4-7" }] } }));
			const plane = planeWith();
			await plane.addModel({ id: "opus", provider: "anthropic", model: "claude-opus-4-7" });

			expect((await plane.offers()).offers).toEqual([]);
		});

		it("says which provider would not answer, rather than offering nothing", async () => {
			answering(() => ({ ok: false, body: {} }));

			const catalog = await planeWith().offers();

			expect(catalog.offers).toEqual([]);
			expect(catalog.trouble).toEqual(["anthropic answered 401"]);
		});
	});
});

/**
 * A host opened at the console, which is the one grant this plane will write for itself.
 *
 * The boundary these keep honest: what the console adds is reach and never spend. There is no field
 * to put a credential in and no store to keep one, so the rule holds by shape rather than by check.
 */
describe("a host opened at the console", () => {
	let stateDir: string;
	const defaults = {
		grants: [
			{
				id: "github",
				host: "api.github.com",
				injection: { kind: "bearer", token: { ref: "GITHUB_TOKEN" } },
			},
		],
	} as const;
	const planeWith = () => new ControlPlane({ agents: [{ id: "scout" }], stateDir, defaults });

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-grants-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const listed = async (plane: ControlPlane, host: string) =>
		(await plane.grants()).find((grant) => grant.host === host);

	it("joins the ones the file declared, on one list", async () => {
		const plane = planeWith();

		await plane.addGrant("api.chess.com");

		expect((await plane.grants()).map((grant) => grant.host)).toContain("api.github.com");
		expect((await plane.grants()).map((grant) => grant.host)).toContain("api.chess.com");
	});

	/**
	 * Last, behind everything carrying a credential. These are the only grants here with no key on
	 * them, and the proxy hands a tie to whichever came first — so a tie one of these won would be a
	 * request going out bare to a host something of the operator's was meant to be attached for.
	 */
	it("goes behind the grants that carry something", async () => {
		const plane = planeWith();

		// The search's own grant is narrower than the host, so opening the host is not a second way of
		// saying the same thing — it is a wider one, and the narrow one has to keep going first.
		await plane.addGrant("api.openai.com");

		const both = (await plane.grants()).filter((grant) => grant.host === "api.openai.com");
		expect(both.map((grant) => grant.origin)).toEqual(["search", "here"]);
	});

	it("says which list each came off, so the screen knows what it may do to it", async () => {
		const plane = planeWith();
		await plane.addGrant("api.chess.com");

		expect(await listed(plane, "api.github.com")).toMatchObject({ origin: "file" });
		expect(await listed(plane, "api.chess.com")).toMatchObject({ origin: "here" });
	});

	// Named rather than counted, because a row that said "carries a credential" is a row you have to
	// go and look something up about.
	it("names what rides along, and says when nothing does", async () => {
		const plane = planeWith();
		await plane.addGrant("api.chess.com");

		expect(await listed(plane, "api.github.com")).toMatchObject({ carries: "GITHUB_TOKEN" });
		expect(await listed(plane, "api.chess.com")).not.toHaveProperty("carries");
	});

	it("reads the host out of whatever was pasted, because a refusal shows a URL", async () => {
		const plane = planeWith();

		expect(await plane.addGrant("https://api.chess.com/pub/player/x")).toBe("api.chess.com");
		expect(await listed(plane, "api.chess.com")).toBeDefined();
	});

	it("says what was wrong with a line rather than opening something", async () => {
		await expect(planeWith().addGrant("api.chess.com and the rest")).rejects.toThrow(
			/more than one word/,
		);
	});

	// The whole reason this is worth doing at the console: a host that needed a redeploy to be
	// reachable is a host you may as well have written into the file.
	it("is something the agents may reach, without anything being restarted", async () => {
		const plane = planeWith();
		const before = (await plane.agents()).find((agent) => agent.id === "scout")?.grants ?? 0;

		await plane.addGrant("api.chess.com");

		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(before + 1);
	});

	it("outlives the plane it was typed at", async () => {
		await planeWith().addGrant("api.chess.com");

		expect((await planeWith().grants()).map((grant) => grant.host)).toContain("api.chess.com");
	});

	it("goes away again, and takes the reach with it", async () => {
		const plane = planeWith();
		await plane.addGrant("api.chess.com");
		const reaching = (await plane.agents()).find((agent) => agent.id === "scout")?.grants ?? 0;

		await plane.dropGrant("api.chess.com");

		expect((await plane.grants()).map((grant) => grant.host)).not.toContain("api.chess.com");
		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(reaching - 1);
	});

	it("says so rather than pretending, when no such host was opened here", async () => {
		await expect(planeWith().dropGrant("api.chess.com")).rejects.toThrow(/No host "api.chess.com"/);
	});

	/**
	 * The file stays the operator's, the same way it does for models. A second row for a host it
	 * already grants would be a row that changes nothing and can be closed at the keyboard, which
	 * reads as taking away a grant that is still in force.
	 */
	it("will not stand in for one the file declared, or take it away", async () => {
		const plane = new ControlPlane({
			agents: [{ id: "scout" }],
			stateDir,
			defaults: {
				grants: [{ id: "reach:api.chess.com", host: "api.chess.com", injection: { kind: "none" } }],
			},
		});

		await expect(plane.addGrant("api.chess.com")).rejects.toThrow(/already open, from the config/);
		await expect(plane.dropGrant("api.chess.com")).rejects.toThrow(/not ours to change/);
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

/**
 * A server that will not connect does not fail the turn, and a turn that succeeds throws its stderr
 * away — so this is the whole of how the operator ever hears that the thing they just added is not
 * answering.
 */
describe("troubledServers", () => {
	it("picks the servers out of everything else a turn complained about", () => {
		expect(
			troubledServers(
				["node:23 experimental type stripping", "[mcp] ahrefs: HTTP 401: unauthorized", ""].join(
					"\n",
				),
			),
		).toEqual(["ahrefs: HTTP 401: unauthorized"]);
	});

	it("reports every one of them, not only the last to fail", () => {
		expect(
			troubledServers(
				["[mcp] notion: No answer after 20s.", '[mcp] files: "mcp-files" exited 1'].join("\n"),
			),
		).toEqual(["notion: No answer after 20s.", 'files: "mcp-files" exited 1']);
	});

	it("says nothing about a turn where every server answered", () => {
		expect(troubledServers("")).toEqual([]);
		expect(troubledServers("pi: something else entirely")).toEqual([]);
	});
});

/**
 * An agent booking its own next turn. The plane checks the request rather than trusting the tool
 * that produced it: the tool lives in a sandbox where the agent also has a shell, so the file it
 * writes is a file anything in there could have written.
 */
describe("a turn that asked for another turn", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-wake-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const asking = (wake?: WakeChange): TurnRunner => ({
		async run() {
			return {
				text: "",
				exitCode: 0,
				stderr: "",
				ms: 1,
				tokens: 0,
				costUsd: 0,
				...(wake !== undefined ? { wake } : {}),
			};
		},
	});

	const takeTurn = async (
		plane: ControlPlane,
		wake?: WakeChange,
		from = "cli:test",
	): Promise<void> => {
		await plane.attach("scout", asking(wake));
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: from,
			body: "have a look at the queue",
		});
		await plane.bus.drain();
	};

	it("books what the agent asked for, with an authority the agent cannot raise", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane, { afterSeconds: 900, note: "keep reading the queue" });

		const [schedule] = await plane.scheduler.list("scout");
		expect(schedule?.kind).toBe("once");
		expect(schedule?.body).toBe("keep reading the queue");
		expect(schedule?.createdBy).toBe("agent");
		// The whole reason an agent may schedule itself at all: a turn taken over by something it read
		// would otherwise book itself operator authority and keep it for good.
		expect(schedule?.trust).toBe("participant");
	});

	/**
	 * The bug this exists to prevent: somebody asked by mail for a joke every minute and got one.
	 *
	 * The first joke was mailed, because that turn was answering the mail. Every joke after it came
	 * from a wakeup, and a wakeup used to arrive on a channel of the agent's own that absorbs whatever
	 * it is handed — so the answers were written, paid for, and said to nobody.
	 */
	it("books the next turn on the channel this one was asked for on", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(
			plane,
			{ afterSeconds: 60, note: "el chiste que sigue" },
			"email:vos@example.com",
		);

		const [schedule] = await plane.scheduler.list("scout");
		expect(schedule?.channel).toBe("email:vos@example.com");
		// Inheriting where to answer is not inheriting what the answer may do.
		expect(schedule?.trust).toBe("participant");
	});

	// A cycle is a chain of turns, each one booking the next, and it stays where it began only if every
	// link keeps the channel. Dropping it on the second turn is the same joke lost, one minute later.
	it("keeps a cycle on the channel it began on", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await plane.attach("scout", asking({ afterSeconds: 60, note: "y otro" }));
		await plane.bus.publish({
			agentId: "scout",
			source: "schedule",
			trust: "participant",
			channel: "email:vos@example.com",
			body: "el chiste que sigue",
			metadata: { createdBy: "agent" },
		});
		await plane.bus.drain();

		expect((await plane.scheduler.list("scout"))[0]?.channel).toBe("email:vos@example.com");
	});

	it("books nothing for a turn that asked for nothing", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane);

		expect(await plane.scheduler.list("scout")).toEqual([]);
	});

	// Asking again is asking for the same one at a different time. Without this an agent that asks
	// every turn is woken once per turn it ever took.
	it("moves the appointment rather than adding to it", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane, { afterSeconds: 900, note: "first" });
		await takeTurn(plane, { afterSeconds: 3600, note: "second" });

		const schedules = await plane.scheduler.list("scout");
		expect(schedules).toHaveLength(1);
		expect(schedules[0]?.body).toBe("second");
	});

	// A wakeup with no wait is a turn that never ends, taken by an agent that cannot see it looping.
	it("holds a request for no wait at all to the soonest it may be", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const asked = Date.now();
		await takeTurn(plane, { afterSeconds: 0, note: "right away" });

		const [schedule] = await plane.scheduler.list("scout");
		const wait = Date.parse(schedule?.nextRunAt ?? "") - asked;
		expect(wait).toBeGreaterThanOrEqual(MIN_WAKE_SECONDS * 1000);
	});

	it("holds a request for a year to the furthest it may be", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const asked = Date.now();
		await takeTurn(plane, { afterSeconds: 365 * 24 * 60 * 60, note: "eventually" });

		const [schedule] = await plane.scheduler.list("scout");
		const wait = Date.parse(schedule?.nextRunAt ?? "") - asked;
		expect(wait).toBeLessThanOrEqual(MAX_WAKE_SECONDS * 1000 + 1000);
	});

	// Pushing the wakeup a month out is not calling it off, and no number of seconds means never: every
	// one of them is clamped into the range the plane can honour. Without this an agent that decides
	// its errand is over has no way to say so, and comes back to find nothing left to do.
	it("drops the appointment when the agent calls it off", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane, { afterSeconds: 900, note: "seguir con la cola" });
		await takeTurn(plane, { cancel: true });

		expect(await plane.scheduler.list("scout")).toEqual([]);
	});

	// Cancelling is an agent dropping its own appointment, not clearing the calendar: the schedules an
	// operator wrote in the config are not the agent's to take out of it.
	it("calls off only what the agent booked itself", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await plane.scheduler.add({
			agentId: "scout",
			kind: "cron",
			expression: "0 9 * * *",
			channel: "wake",
			body: "el reporte de la mañana",
			trust: "operator",
			createdBy: "operator",
		});
		await takeTurn(plane, { cancel: true });

		expect((await plane.scheduler.list("scout")).map((schedule) => schedule.body)).toEqual([
			"el reporte de la mañana",
		]);
	});

	// The wait is the only sign an operator gets that an agent is going to act unwatched, so it comes
	// from the scheduler that will actually do the waking, not from the config it was not written in.
	it("shows the wait beside the agent it belongs to", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane, { afterSeconds: 900, note: "keep reading the queue" });

		const [summary] = await plane.agents();
		expect(summary?.wakeAt).toBeDefined();
		expect(summary?.schedules).toBe(1);
	});

	/**
	 * An appointment that has already come due is no longer only an appointment.
	 *
	 * A wakeup that fires while the agent is mid-turn queues behind that turn — and the turn it is
	 * waiting on is the one that decides it should not happen. Unbooking the appointment and leaving
	 * what it already produced is how an agent calls off its wakeup and is woken by it anyway,
	 * carrying a note it wrote to a self it has stopped being.
	 */
	describe("with its own wakeup already come due behind it", () => {
		/** The agent's own ten-second wakeup, landing in the queue of a turn that takes longer than ten. */
		const ownNote: NewAgentEvent = {
			agentId: "scout",
			source: "schedule",
			trust: "participant",
			channel: "wake",
			body: "contá el chiste noventa y cuatro",
			metadata: { createdBy: "agent" },
		};

		/**
		 * Runs one turn that is interrupted by `arrives` while it runs, and answers every prompt the
		 * agent was given — so the ghost turn shows up as a second one rather than not at all.
		 */
		const interrupted = async (
			plane: ControlPlane,
			arrives: NewAgentEvent,
			wake: WakeChange,
		): Promise<readonly string[]> => {
			const heard: string[] = [];
			await plane.attach("scout", {
				async run(_agentId, prompt) {
					heard.push(prompt);
					if (heard.length === 1) await plane.bus.publish(arrives);
					return { text: "", exitCode: 0, stderr: "", ms: 1, tokens: 0, costUsd: 0, wake };
				},
			});
			await plane.bus.publish({
				agentId: "scout",
				source: "channel",
				trust: "operator",
				channel: "cli:test",
				body: "dejá los chistes y hacé el informe",
			});
			await plane.bus.drain();
			return heard;
		};

		it("does not wake the agent that just called it off", async () => {
			const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
			const heard = await interrupted(plane, ownNote, { cancel: true });

			expect(heard).toHaveLength(1);
			expect(await plane.scheduler.list("scout")).toEqual([]);
		});

		// Moving the appointment is the same act: the note the agent replaced is the one it no longer
		// means, and delivering it hands the agent back the intention it just spent a turn dropping.
		it("does not wake it with the note it just replaced", async () => {
			const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
			const heard = await interrupted(plane, ownNote, {
				afterSeconds: 60,
				note: "seguí el informe",
			});

			expect(heard).toHaveLength(1);
			expect((await plane.scheduler.list("scout")).map((one) => one.body)).toEqual([
				"seguí el informe",
			]);
		});

		// The line this must not cross. Whoever spoke to a busy agent is owed an answer whatever the
		// agent decided while their message sat in the queue, and an agent dropping its own wakeup is
		// not a reason for somebody else's message to disappear with it.
		it("still answers what somebody said to it while it was busy", async () => {
			const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
			const heard = await interrupted(
				plane,
				{
					agentId: "scout",
					source: "channel",
					trust: "operator",
					channel: "cli:test",
					body: "y de paso fijate el changelog",
				},
				{ cancel: true },
			);

			expect(heard).toHaveLength(2);
			expect(heard[1]).toContain("changelog");
		});
	});
});

/**
 * An agent asking for the commands its operator would otherwise have to type.
 *
 * The thing it replaces is an agent writing a paragraph explaining which line of YAML somebody has
 * to go and add, and then sitting there until somebody reads the paragraph. So the ones that widen
 * nothing run, and the ones that widen anything come back as the exact line to type — in the
 * console, where the person who can type it is already looking.
 */
/**
 * An answer, and whether the operator watching it can tell that it also left.
 *
 * They asked by mail, and what they saw was the agent answering in the pane — the same picture as an
 * agent that answered and sent nothing. The words are not the evidence; where they went is.
 */
describe("an answer that went somewhere", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-sent-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const answering: TurnRunner = {
		async run() {
			return { text: "**Chiste #1:**", exitCode: 0, stderr: "", ms: 1, tokens: 0, costUsd: 0 };
		},
	};

	const takeTurn = async (plane: ControlPlane, from: string): Promise<void> => {
		await plane.attach("scout", answering);
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: from,
			body: "contame un chiste",
		});
		await plane.bus.drain();
	};

	it("writes down the channel it left on", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane, "email:vos@example.com");

		expect(((await plane.transcripts()).scout ?? []).at(-1)).toMatchObject({
			from: "agent",
			to: "email",
		});
	});

	// An answer to a line typed into the console arrives in the console. Marking that marks every
	// line most agents ever say, which is the same as marking none of them.
	it("says nothing about an answer that arrived where it was asked for", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane, "cli:test");

		expect(((await plane.transcripts()).scout ?? []).at(-1)?.to).toBeUndefined();
	});
});

describe("a turn that asked for a console command", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-asked-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	/** Granted the host on purpose, so that connecting to it asks the server nothing over the wire. */
	const scout: AgentConfig = {
		id: "scout",
		limitUsd: 5,
		grants: [{ id: "ahrefs", host: "mcp.ahrefs.test", injection: { kind: "none" } }],
	};

	const asking = (...asked: readonly string[]): TurnRunner => ({
		async run() {
			return { text: "listo", exitCode: 0, stderr: "", ms: 1, tokens: 0, costUsd: 0, asked };
		},
	});

	const takeTurn = async (plane: ControlPlane, ...asked: readonly string[]): Promise<void> => {
		await plane.attach("scout", asking(...asked));
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "conectate a ahrefs",
		});
		await plane.bus.drain();
	};

	it("connects the agent to the server it asked for", async () => {
		const plane = new ControlPlane({ agents: [scout], stateDir });
		await takeTurn(plane, "/mcp add ahrefs https://mcp.ahrefs.test/mcp");

		expect(await plane.command("scout", "/mcp")).toContain("ahrefs");
	});

	// Written down as the agent's, because it was the agent's. A transcript that showed it as the
	// operator's is one you cannot read back to find out who asked for the server. The mark is what
	// holds it apart from the agent merely answering, which is drawn with no mark at all.
	it("puts both halves in the conversation, under the name of whoever said them", async () => {
		const plane = new ControlPlane({ agents: [scout], stateDir });
		await takeTurn(plane, "/mcp add ahrefs https://mcp.ahrefs.test/mcp");

		const said = (await plane.transcripts()).scout ?? [];
		expect(said).toMatchObject([
			{ from: "operator", text: "conectate a ahrefs" },
			{ from: "agent", text: "listo" },
			{ from: "agent", via: "ask", text: "/mcp add ahrefs https://mcp.ahrefs.test/mcp" },
			{ from: "plane" },
		]);
		expect(said[1]?.via).toBeUndefined();
	});

	// Adding a server and then doing something with it is one intention and two lines, and the second
	// one is only true if the first has already happened.
	it("runs them in the order the turn asked", async () => {
		const plane = new ControlPlane({ agents: [scout], stateDir });
		await takeTurn(
			plane,
			"/mcp add ahrefs https://mcp.ahrefs.test/mcp",
			"/mcp drop ahrefs",
			"/mcp ahrefs",
		);

		const said = (await plane.transcripts()).scout ?? [];
		expect(said.at(-1)?.text).toContain('This agent has "ahrefs"');
	});

	it("moves the agent onto a model it was configured with", async () => {
		const plane = new ControlPlane({
			agents: [{ id: "scout", model: "flash" }],
			stateDir,
			models: [
				{
					id: "flash",
					provider: "deepseek",
					model: "deepseek-v4-flash",
					host: "api.deepseek.com",
					keyEnv: "DEEPSEEK_API_KEY",
				},
				{
					id: "sonnet",
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					host: "api.anthropic.com",
					keyEnv: "ANTHROPIC_API_KEY",
					header: "x-api-key",
				},
			],
		});
		await takeTurn(plane, "/model sonnet");

		expect((await plane.agents())[0]?.model).toBe("sonnet");
	});

	it("lets it be held to less than it was", async () => {
		const plane = new ControlPlane({ agents: [scout], stateDir });
		await takeTurn(plane, "/limit 2");

		expect(await plane.command("scout", "/limit")).toContain("$2.00 a day");
	});

	// The refusal is the whole feature working, not the feature failing: the operator learns the
	// command exists by being handed it, which is the part they were never going to look up.
	it("refuses a ceiling above the one it has, and leaves the ceiling where it was", async () => {
		const plane = new ControlPlane({ agents: [scout], stateDir });
		await takeTurn(plane, "/limit 50");

		const said = (await plane.transcripts()).scout ?? [];
		expect(said.at(-1)).toMatchObject({ from: "plane", tone: "bad" });
		expect(said.at(-1)?.text).toContain("/limit $50.00");
		expect(await plane.command("scout", "/limit")).toContain("of $5.00 a day");
	});

	it("refuses to delete the agent that asked, and the agent is still there", async () => {
		const plane = new ControlPlane({ agents: [scout], stateDir });
		await takeTurn(plane, "/delete scout");

		expect((await plane.agents()).map((agent) => agent.id)).toEqual(["scout"]);
		const said = (await plane.transcripts()).scout ?? [];
		expect(said.at(-1)?.text).toContain("/delete scout");
	});

	it("says nothing extra for a turn that asked for nothing", async () => {
		const plane = new ControlPlane({ agents: [scout], stateDir });
		await takeTurn(plane);

		expect((await plane.transcripts()).scout).toHaveLength(2);
	});
});

/**
 * The conversation, which belongs to the plane and not to whoever happens to be watching.
 *
 * A console is a window onto it. Closing one used to be the same as ending it, and a turn nobody at
 * a keyboard started — a schedule, a webhook — went by without appearing in it at all.
 */
describe("what an agent was told, and what it said", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-talk-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const answering = (text: string): TurnRunner => ({
		async run() {
			return { text, exitCode: 0, stderr: "", ms: 1, tokens: 0, costUsd: 0 };
		},
	});

	it("keeps both halves of a turn, in the order they happened", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await plane.attach("scout", answering("la cola está vacía"));
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "mirá la cola",
		});
		await plane.bus.drain();

		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "operator", text: "mirá la cola" },
			{ from: "agent", text: "la cola está vacía" },
		]);
	});

	// The complaint this exists for: the wakeup landed, the turn ran, and the console showed nothing,
	// because the only thing that ever wrote to it was the prompt.
	it("keeps a turn nobody at a keyboard started", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await plane.attach("scout", answering("sigue arriba"));
		await plane.scheduler.add({
			agentId: "scout",
			kind: "once",
			runAt: new Date(Date.now() - 1000).toISOString(),
			channel: "wake",
			body: "volver a chequear el sitio",
			trust: "participant",
			createdBy: "agent",
		});
		await plane.scheduler.tick();
		await plane.bus.drain();

		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "agent", via: "wake" },
			{ from: "agent", text: "sigue arriba" },
		]);
	});

	// A failed turn said nothing. Without this the person who asked watches a spinner stop and is
	// told why only in a log they are not reading.
	it("says why a turn had no answer, where the question was asked", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await plane.attach("scout", {
			async run() {
				throw new Error("exited 1: no model");
			},
		});
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "mirá la cola",
		});
		await plane.bus.drain();

		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "operator", text: "mirá la cola" },
			{ from: "plane", text: "exited 1: no model" },
		]);
	});

	it("shows a line to whoever is watching before it writes it down", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const seen: string[] = [];
		plane.observe((event) => {
			if (event.kind === "said") seen.push(event.said.from);
		});

		await plane.attach("scout", answering("listo"));
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "dale",
		});
		await plane.bus.drain();

		expect(seen).toEqual(["operator", "agent"]);
	});

	// What someone typed at an agent that was already thinking. It is queued and answered by the turn
	// after this one, which is right — but it was said now, and a console that showed it only when the
	// turn got to it would look, to the person who typed it, like one that had thrown it away.
	it("puts a message in the conversation when it arrives, not when it is answered", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const answer = { text: "listo", exitCode: 0, stderr: "", ms: 0, tokens: 0, costUsd: 0 };
		let end: () => void = () => {};
		let holding = false;
		// Only the first turn is held. The second is the one that answers what was queued behind it,
		// and it has to be allowed to finish for this to be a test of two turns rather than of a hang.
		await plane.attach("scout", {
			run: async () => {
				if (holding) return answer;
				holding = true;
				return new Promise((resolve) => {
					end = () => resolve(answer);
				});
			},
		});

		const speak = async (body: string): Promise<void> => {
			await plane.bus.publish({
				agentId: "scout",
				source: "channel",
				trust: "operator",
				channel: "cli:test",
				body,
			});
		};
		await speak("lo primero");
		await speak("y esto también");

		// While the first turn is still running: both lines are there, and neither has been answered.
		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "operator", text: "lo primero" },
			{ from: "operator", text: "y esto también" },
		]);

		end();
		await plane.bus.drain();
		expect((await plane.transcripts()).scout).toHaveLength(4);
	});

	// The other half of recording on arrival: the turn boundary is no longer a line of conversation,
	// and the console draws its spinner off this rather than off somebody having spoken.
	it("says a turn started, however few or many messages started it", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		let starts = 0;
		plane.observe((event) => {
			if (event.kind === "thinking") starts += 1;
		});

		await plane.attach("scout", answering("listo"));
		await plane.bus.publish({
			agentId: "scout",
			source: "schedule",
			trust: "participant",
			channel: "wake",
			body: "revisá",
		});
		await plane.bus.drain();

		expect(starts).toBe(1);
	});
});

/**
 * Stopping a turn, which is what an operator wants the moment an agent goes off doing the wrong
 * thing expensively. It has to reach a turn already in flight, and it has to end it rather than
 * interrupt it: an interrupted turn is queued and taken again, which is what was being prevented.
 */
describe("a turn that was stopped", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-stop-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	/** A turn that goes on thinking until something stops it, which is the only kind worth stopping. */
	const thinking = (): { runner: TurnRunner; started: Promise<void> } => {
		let running: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			running = resolve;
		});
		let end: (result: TurnResult) => void = () => {};
		return {
			started,
			runner: {
				async run() {
					running();
					return new Promise<TurnResult>((resolve) => {
						end = resolve;
					});
				},
				stop() {
					end({
						text: "iba por la mit",
						exitCode: 137,
						stderr: "",
						ms: 1,
						tokens: 0,
						costUsd: 0,
						stopped: true,
					});
					return true;
				},
			},
		};
	};

	it("keeps the half it got, and says where it ends", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const { runner, started } = thinking();
		await plane.attach("scout", runner);
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "escribime algo largo",
		});
		await started;

		expect(plane.stopTurn("scout")).toBe(true);
		await plane.bus.drain();

		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "operator", text: "escribime algo largo" },
			{ from: "agent", text: "iba por la mit" },
			{ from: "plane", text: "stopped" },
		]);
	});

	it("says there was nothing to stop when the agent is not taking a turn", () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		expect(plane.stopTurn("scout")).toBe(false);
	});
});

/**
 * Throwing the conversation away, which is one thing to a person and three to the plane: what the
 * model is shown next turn, the transcript that outlives the console, and the pane displaying it.
 * Clearing fewer than all three is worse than clearing none.
 */
describe("a conversation thrown away", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-clear-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	/** A runner that remembers between turns, which is the only kind with anything to forget. */
	const remembering = (): { runner: TurnRunner; forgotten: string[] } => {
		const forgotten: string[] = [];
		return {
			forgotten,
			runner: {
				async run() {
					return { text: "listo", exitCode: 0, stderr: "", ms: 1, tokens: 0, costUsd: 0 };
				},
				async forget(agentId: string) {
					forgotten.push(agentId);
					return true;
				},
			},
		};
	};

	const said = async (plane: ControlPlane, body: string): Promise<void> => {
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body,
		});
		await plane.bus.drain();
	};

	it("forgets it in all three places at once", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const { runner, forgotten } = remembering();
		const cleared: string[] = [];
		plane.observe((event) => {
			if (event.kind === "cleared") cleared.push(event.agentId);
		});
		await plane.attach("scout", runner);
		await said(plane, "hola");

		expect(await plane.clear("scout")).toEqual({ stopped: false, remembered: true });
		expect((await plane.transcripts()).scout ?? []).toEqual([]);
		expect(forgotten).toEqual(["scout"]);
		expect(cleared).toEqual(["scout"]);
	});

	// pi holds the session open for the length of a turn and writes it out at the end, so a file
	// deleted underneath a running one comes straight back with everything in it. The clear would
	// appear to work and be undone a minute later.
	it("stops the turn in flight, so the clearing sticks", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const { runner, forgotten } = remembering();
		let running: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			running = resolve;
		});
		let end: (result: TurnResult) => void = () => {};
		await plane.attach("scout", {
			...runner,
			async run() {
				running();
				return new Promise<TurnResult>((resolve) => {
					end = resolve;
				});
			},
			stop() {
				end({ text: "", exitCode: 137, stderr: "", ms: 1, tokens: 0, costUsd: 0, stopped: true });
				return true;
			},
		});
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "escribime algo largo",
		});
		await started;

		expect(await plane.clear("scout")).toMatchObject({ stopped: true });
		expect(forgotten).toEqual(["scout"]);
	});

	// The half-answer a stopped turn hands in on its way out, which arrives after the clearing and
	// would otherwise be the whole of what a cleared agent remembers.
	it("keeps nothing the stopped turn had left to say", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const seen: string[] = [];
		plane.observe((event) => {
			if (event.kind === "said") seen.push(event.said.text);
		});
		let running: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			running = resolve;
		});
		let end: (result: TurnResult) => void = () => {};
		await plane.attach("scout", {
			async run() {
				running();
				return new Promise<TurnResult>((resolve) => {
					end = resolve;
				});
			},
			// Hands the half in a tick later, the way a killed process does rather than a stub.
			stop() {
				setTimeout(() => {
					end({
						text: "iba por la mit",
						exitCode: 137,
						stderr: "",
						ms: 1,
						tokens: 0,
						costUsd: 0,
						stopped: true,
					});
				}, 0);
				return true;
			},
			async forget() {
				return true;
			},
		});
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "escribime algo largo",
		});
		await started;
		await plane.clear("scout");
		await plane.bus.drain();

		expect((await plane.transcripts()).scout ?? []).toEqual([]);
		expect(seen).toEqual(["escribime algo largo"]);
	});

	// Typed at an agent that was thinking, which is when it is typed. What the command answers is the
	// first line of the conversation that starts here, and is not the stopped turn's to take with it.
	it("keeps what it answered, though the stopped turn is still handing itself in", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		let running: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			running = resolve;
		});
		let end: (result: TurnResult) => void = () => {};
		await plane.attach("scout", {
			async run() {
				running();
				return new Promise<TurnResult>((resolve) => {
					end = resolve;
				});
			},
			stop() {
				setTimeout(() => {
					end({
						text: "iba por la mit",
						exitCode: 137,
						stderr: "",
						ms: 1,
						tokens: 0,
						costUsd: 0,
						stopped: true,
					});
				}, 0);
				return true;
			},
			async forget() {
				return true;
			},
		});
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body: "escribime algo largo",
		});
		await started;

		expect(await plane.command("scout", "/clear")).toContain("Stopped the turn scout was taking");
		await plane.bus.drain();

		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "plane", text: expect.stringContaining("Stopped the turn scout was taking") },
		]);
	});

	it("says there was nothing to forget", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await plane.attach("scout", {
			async run() {
				return { text: "", exitCode: 0, stderr: "", ms: 1, tokens: 0, costUsd: 0 };
			},
			async forget() {
				return false;
			},
		});

		expect(await plane.clear("scout")).toEqual({ stopped: false, remembered: false });
	});

	// The agent is what the repository is, and a conversation is what it was doing lately. Losing one
	// is not losing the other, which is the whole reason this is not /delete.
	it("leaves the agent where it was", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const { runner } = remembering();
		await plane.attach("scout", runner);
		await plane.clear("scout");
		await said(plane, "de nuevo");

		expect((await plane.agents()).map((agent) => agent.id)).toEqual(["scout"]);
		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "operator", text: "de nuevo" },
			{ from: "agent", text: "listo" },
		]);
	});

	it("refuses an agent that is not in the plane", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await expect(plane.clear("nadie")).rejects.toThrow('No agent "nadie"');
	});
});

/**
 * The ceiling, which exists because an agent that books its own next turn spends all night whether
 * or not anyone is awake. Cost was reported per turn and added up nowhere, so the first anyone knew
 * of a loop was the bill.
 */
describe("what an agent may spend", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-spend-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const costing = (costUsd: number): TurnRunner => ({
		async run() {
			return { text: "listo", exitCode: 0, stderr: "", ms: 1, tokens: 100, costUsd };
		},
	});

	const say = (plane: ControlPlane, body: string) =>
		plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
			body,
		});

	it("adds up what the turns cost", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await plane.attach("scout", costing(0.3));
		await say(plane, "una");
		await plane.bus.drain();
		await say(plane, "otra");
		await plane.bus.drain();

		expect((await plane.agents()).find((a) => a.id === "scout")?.spentUsd).toBeCloseTo(0.6, 10);
	});

	/**
	 * Refused at the start of the turn rather than inside it: the point is not to stop a turn but not
	 * to start one, and a turn stopped halfway has already been paid for.
	 */
	it("stops taking turns once the ceiling is reached", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout", limitUsd: 1 }], stateDir });
		let turns = 0;
		await plane.attach("scout", {
			async run() {
				turns += 1;
				return { text: "listo", exitCode: 0, stderr: "", ms: 1, tokens: 100, costUsd: 0.8 };
			},
		});

		await say(plane, "una");
		await plane.bus.drain();
		await say(plane, "otra");
		await plane.bus.drain();
		await say(plane, "y otra");
		await plane.bus.drain();

		// Two turns: the second one crossed the ceiling, and the third never started.
		expect(turns).toBe(2);
	});

	/**
	 * Said in the conversation, because a plane that silently stops answering is indistinguishable
	 * from a broken one. The message it refused is already there — it was written down when it
	 * arrived — so what is missing without this is the reason, not the question.
	 */
	it("says in the conversation why it is not answering", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout", limitUsd: 0.5 }], stateDir });
		await plane.attach("scout", costing(0.6));
		await say(plane, "una");
		await plane.bus.drain();
		await say(plane, "otra");
		await plane.bus.drain();

		const said = (await plane.transcripts()).scout ?? [];
		expect(said.at(-2)).toMatchObject({ from: "operator", text: "otra" });
		expect(said.at(-1)?.from).toBe("plane");
		expect(said.at(-1)?.text).toContain("spending limit reached");
		expect(said.at(-1)?.text).toContain("$0.50");
	});

	it("takes the ceiling from the config when nobody has set one at the keyboard", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout", limitUsd: 5 }], stateDir });

		expect((await plane.agents()).find((a) => a.id === "scout")?.limitUsd).toBe(5);
	});

	it("prefers the ceiling set at the keyboard over the one in the file", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout", limitUsd: 5 }], stateDir });

		await plane.command("scout", "/limit 2");

		expect((await plane.agents()).find((a) => a.id === "scout")?.limitUsd).toBe(2);
	});

	/**
	 * `/limit off` means no ceiling, not "forget I said anything". Falling back to the config here
	 * would quietly reinstate the very ceiling the operator was taking off, and the only way to find
	 * out would be to hit it.
	 */
	it("does not hand back the config's ceiling when the operator takes one off", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout", limitUsd: 5 }], stateDir });

		await plane.command("scout", "/limit off");

		expect((await plane.agents()).find((a) => a.id === "scout")?.limitUsd).toBeUndefined();
	});

	it("takes turns again once the ceiling moves", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout", limitUsd: 0.5 }], stateDir });
		let turns = 0;
		await plane.attach("scout", {
			async run() {
				turns += 1;
				return { text: "listo", exitCode: 0, stderr: "", ms: 1, tokens: 100, costUsd: 0.6 };
			},
		});
		await say(plane, "una");
		await plane.bus.drain();
		await say(plane, "otra");
		await plane.bus.drain();
		expect(turns).toBe(1);

		await plane.command("scout", "/limit 10");
		await say(plane, "y ahora");
		await plane.bus.drain();

		expect(turns).toBe(2);
	});

	/**
	 * A command is the operator talking about the agent, not to it. Waking the agent to tell it its
	 * own ceiling changed would spend money to answer a question about spending money.
	 */
	it("answers a command without waking the agent", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		let turns = 0;
		await plane.attach("scout", {
			async run() {
				turns += 1;
				return { text: "listo", exitCode: 0, stderr: "", ms: 1, tokens: 0, costUsd: 0 };
			},
		});

		const answer = await plane.command("scout", "/limit 5");
		await plane.bus.drain();

		expect(turns).toBe(0);
		expect(answer).toContain("$5.00");
	});

	/** Both halves, because a ceiling that changed with nothing to show for it has no reason on record. */
	it("keeps the command and its answer in the conversation", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		await plane.command("scout", "/limit 5");

		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "operator", text: "/limit 5" },
			{ from: "plane" },
		]);
	});

	it("refuses a command for an agent that is not here", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		await expect(plane.command("ghost", "/limit 5")).rejects.toThrow(/No agent/);
	});
});

/**
 * `!`, which runs where the agent runs. It grants nothing — whoever reaches the control socket
 * already holds the Docker socket the plane runs on — and saves leaving the console to ask the one
 * question that comes up constantly while an agent works: what does it actually look like in there.
 */
describe("a command run in the agent's box", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-shell-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	/**
	 * Stands in for the sandbox, answering the way one would: whatever it was told to print, and
	 * after it the directory the script asked for, which is what the plane reads the `cd` out of.
	 */
	function box(plane: ControlPlane, result: Partial<ExecResult> & { endsIn?: string } = {}) {
		const scripts: string[] = [];
		plane.sandboxes.run = async (_agentId, _cmd, input, _options = {}) => {
			scripts.push(input);
			const mark = /cwd-[0-9a-f]{16}/.exec(input)?.[0] ?? "";
			const at = /^cd '(.*)' 2>/m.exec(input)?.[1] ?? "";
			return {
				stdout: `${result.stdout ?? ""}${mark}\n${result.endsIn ?? at}`,
				stderr: result.stderr ?? "",
				exitCode: result.exitCode ?? 0,
			};
		};
		return scripts;
	}

	it("answers with what the command printed", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		box(plane, { stdout: "README.md\nsrc\n" });

		expect((await plane.shell("scout", "ls")).text).toBe("README.md\nsrc");
	});

	/**
	 * On stdin, because arguments are visible to every process in the container and the other process
	 * in there is the agent. The line goes in whole: a script, not a command with arguments.
	 */
	it("runs the line as a script, standing where the agent works", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const scripts = box(plane);

		await plane.shell("scout", "echo hola");

		expect(scripts[0]).toContain("cd '/home/agent/.self'");
		expect(scripts[0]).toContain("echo hola");
	});

	/**
	 * The whole of what makes it a place rather than a command: every `!` is a new `sh`, so a `cd`
	 * that moved only its own shell would leave the operator back at the door a second later.
	 */
	it("stays where a cd left it", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const scripts = box(plane, { endsIn: "/home/agent/.self/packages" });

		expect((await plane.shell("scout", "cd packages")).cwd).toBe("/home/agent/.self/packages");

		await plane.shell("scout", "ls");
		expect(scripts[1]).toContain("cd '/home/agent/.self/packages'");
	});

	// It printed nothing, so there is nothing to show for it but the one thing it did.
	it("says where a cd landed, rather than that it printed nothing", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		box(plane, { endsIn: "/tmp" });

		expect((await plane.shell("scout", "cd /tmp")).text).toBe("/tmp");
	});

	// The mark is the plane talking to itself, and a console that showed it would be showing a bug.
	it("keeps the directory it asked for out of what it shows", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		box(plane, { stdout: "hola\n", endsIn: "/tmp" });

		const ran = await plane.shell("scout", "echo hola");

		expect(ran.text).toBe("hola");
		expect(ran.text).not.toContain("cwd-");
	});

	/** Both halves, because output with nothing above it does not say what was asked. */
	it("keeps the command and what it printed in the conversation", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		box(plane, { stdout: "hola\n" });

		await plane.shell("scout", "echo hola");

		expect((await plane.transcripts()).scout).toMatchObject([
			{ from: "operator", text: "!echo hola" },
			{ from: "shell", text: "hola" },
		]);
	});

	/**
	 * Its own kind, not `plane`. That one means the plane explaining a failure and is drawn as one,
	 * and thirty lines of build log in the colour reserved for errors reads as thirty things wrong.
	 */
	it("is the sandbox talking, not the plane", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		box(plane, { stderr: "sh: nope: not found", exitCode: 127 });

		await plane.shell("scout", "nope");

		expect((await plane.transcripts()).scout?.at(-1)).toMatchObject({ from: "shell" });
	});

	// A stopped sandbox and a command that exits 1 are the same kind of news to whoever typed it.
	it("says a command that could not run at all, rather than throwing", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		plane.sandboxes.run = async () => {
			throw new Error("No such container: squad-scout");
		};

		expect((await plane.shell("scout", "ls")).text).toContain("No such container");
	});

	it("refuses a box for an agent that is not here", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });

		await expect(plane.shell("ghost", "ls")).rejects.toThrow(/No agent/);
	});
});

/**
 * The one capability in this system that does not come out of the operator's config file.
 *
 * It is allowed because a login is a person on a consent screen with the host name in front of them,
 * which is a stronger act of approval than a line of YAML rather than a weaker one. What makes that
 * safe is how narrow it is, and that is what these are about: one host, the server's own path, and
 * only for as long as the agent is holding the server it was made for.
 */
describe("what a login lets an agent reach", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-login-grant-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const model = { id: "model", host: "api.anthropic.com", injection: { kind: "none" } } as const;

	/**
	 * What this agent reaches before anything is logged into: the grant declared below, and the one
	 * every agent gets for searching — which is derived from the config screen's choice, not declared.
	 */
	const DECLARED = 2;

	/** State as a login and an attachment would have left it, written before the plane reads it. */
	async function held(over: { url?: string; transport?: "http" | "sse"; login?: boolean } = {}) {
		await writeFile(
			join(stateDir, "mcp.json"),
			JSON.stringify({
				servers: {
					notion: {
						transport: over.transport ?? "http",
						url: over.url ?? "https://mcp.notion.com/mcp",
					},
				},
				attached: { scout: ["notion"] },
			}),
		);
		if (over.login !== false) {
			await writeFile(
				join(stateDir, "oauth.json"),
				JSON.stringify({
					notion: {
						host: "mcp.notion.com",
						endpoints: {
							authorizationUrl: "https://notion.so/authorize",
							tokenUrl: "https://notion.so/token",
							resource: "https://mcp.notion.com/mcp",
						},
						client: { clientId: "c1", redirectUri: "http://localhost:8788/callback" },
						accessToken: "at-live",
						at: new Date().toISOString(),
					},
				}),
			);
		}
		return new ControlPlane({ agents: [{ id: "scout", grants: [model] }], stateDir });
	}

	it("adds a grant for the server it was logged in to, on top of the declared ones", async () => {
		const plane = await held();

		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(DECLARED + 1);
		expect(await plane.command("scout", "/mcp")).toContain("(logged in)");
	});

	/**
	 * Narrow where it can be and honest where it cannot.
	 *
	 * A streamable server is one URL and every message goes to it, so the grant is that path and
	 * nothing else on the host. An SSE server names its own posting address in the first event it
	 * sends, at a path this plane has not seen — scoping to the stream would grant the one request
	 * that carries nothing and deny the rest.
	 */
	it("scopes to the server's own path, and admits when it cannot", () => {
		expect(endpointPath({ transport: "http", url: "https://mcp.notion.com/mcp" })).toBe("/mcp");
		expect(endpointPath({ transport: "sse", url: "https://mcp.notion.com/sse" })).toBeUndefined();
		expect(endpointPath({ transport: "stdio", command: "mcp-files", args: [] })).toBeUndefined();
	});

	it("gives nothing to an agent that never logged in", async () => {
		const plane = await held({ login: false });

		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(DECLARED);
	});

	// The reach was for the server, so taking the server away takes the reach with it.
	it("takes the reach back when the agent no longer holds the server", async () => {
		const plane = await held();

		await plane.command("scout", "/mcp drop notion");

		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(DECLARED);
	});

	it("takes it back when the operator logs out, and says the reach went too", async () => {
		const plane = await held();

		const answer = await plane.command("scout", "/mcp logout notion");

		expect(answer).toContain("Logged out of mcp.notion.com");
		expect((await plane.agents()).find((agent) => agent.id === "scout")?.grants).toBe(DECLARED);
	});

	/**
	 * Asked of whoever is watching rather than opened here.
	 *
	 * In the deployment the plane is a container with no desktop, and the console is the thing on
	 * the machine with the browser. A plane that shelled out to `open` itself would be opening a
	 * consent screen where nobody can see it, and the operator would be copying a hundred-character
	 * URL out of a pane that had to wrap it.
	 */
	it("asks whoever is watching to open the consent screen, rather than opening it itself", async () => {
		const server = await authorizationServer();
		await writeFile(
			join(stateDir, "mcp.json"),
			JSON.stringify({
				servers: { notion: { transport: "http", url: `${server.url}/mcp` } },
				attached: { scout: ["notion"] },
			}),
		);
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		const opened: string[] = [];
		plane.observe((event) => {
			if (event.kind === "open") opened.push(event.url);
		});

		const answer = await plane.command("scout", "/mcp login notion");

		expect(opened).toHaveLength(1);
		expect(answer).toContain(opened[0] ?? "");
		expect(new URL(opened[0] ?? "").searchParams.get("client_id")).toBe("registered-client");

		// The login is still holding a port open for a browser that is never coming.
		await plane.command("scout", "/mcp logout notion");
	});
});

/** A server that publishes metadata and registers clients, which is all a login needs to start. */
async function authorizationServer(): Promise<{ url: string }> {
	let origin = "";
	const server = createServer((request, response) => {
		const asked = new URL(request.url ?? "/", origin);
		const answer = (body: unknown): void => {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		};
		if (asked.pathname === "/.well-known/oauth-protected-resource/mcp") {
			answer({ authorization_servers: [origin] });
		} else if (asked.pathname === "/.well-known/oauth-authorization-server") {
			answer({
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
			});
		} else if (asked.pathname === "/register") {
			answer({ client_id: "registered-client" });
		} else {
			response.writeHead(401).end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	server.unref();
	return { url: origin };
}
