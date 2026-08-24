import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ControlPlane,
	carriesEnv,
	MAX_WAKE_SECONDS,
	MIN_WAKE_SECONDS,
	proxyTokenOf,
	withDefaults,
} from "../src/control-plane.ts";
import type { TurnRunner, WakeRequest } from "../src/turn.ts";

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

/**
 * An agent booking its own next turn. The plane checks the request rather than trusting the tool
 * that produced it: the tool lives in a sandbox where the agent also has a shell, so the file it
 * writes is a file anything in there could have written.
 */
describe("a turn that asked for another turn", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "agent-dive-wake-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	const asking = (wake?: WakeRequest): TurnRunner => ({
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

	const takeTurn = async (plane: ControlPlane, wake?: WakeRequest): Promise<void> => {
		await plane.attach("scout", asking(wake));
		await plane.bus.publish({
			agentId: "scout",
			source: "channel",
			trust: "operator",
			channel: "cli:test",
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

	// The wait is the only sign an operator gets that an agent is going to act unwatched, so it comes
	// from the scheduler that will actually do the waking, not from the config it was not written in.
	it("shows the wait beside the agent it belongs to", async () => {
		const plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		await takeTurn(plane, { afterSeconds: 900, note: "keep reading the queue" });

		const [summary] = await plane.agents();
		expect(summary?.wakeAt).toBeDefined();
		expect(summary?.schedules).toBe(1);
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
		stateDir = await mkdtemp(join(tmpdir(), "agent-dive-talk-"));
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
			if (event.kind === "said") seen.push(`${event.said.from}:${event.heard}`);
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

		expect(seen).toEqual(["operator:true", "agent:false"]);
	});
});
