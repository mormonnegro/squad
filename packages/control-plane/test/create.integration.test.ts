import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DockerEngine, DockerSandboxManager } from "@agent-dive/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/control-plane.ts";

const AGENT_ID = "created-itest";
const DECLARED_ID = "declared-itest";
const NETWORK = "agent-dive-created-itest";

const engine = new DockerEngine();
const suite = (await engine.isAvailable()) ? describe : describe.skip;

/** Under the working tree, because the daemon resolves the CA's bind source on the host. */
const stateDir = join(process.cwd(), ".created-itest");

/** Ports the tests do not use, so a demo plane on the usual ones is not in the way. */
const quiet = { proxyPort: 0, webhookPort: 0, networkName: NETWORK } as const;

const defaults = {
	env: { ANTHROPIC_API_KEY: "injected-by-the-proxy" },
	grants: [{ id: "model", host: "api.anthropic.com", injection: { kind: "none" } }],
} as const;

/**
 * An agent that nobody wrote down, made while the plane was running.
 *
 * The parts that only a live daemon can show: that it gets a container and a scaffolded repository
 * like any other, that its capabilities are the operator's defaults rather than none, and that it
 * is still there after the process that made it is gone — which is the whole difference between
 * creating an agent and creating one until the next deploy.
 */
suite("an agent created while the plane runs", () => {
	const manager = new DockerSandboxManager(engine, NETWORK);
	const plane = () =>
		new ControlPlane({ agents: [{ id: DECLARED_ID }], defaults, stateDir, ...quiet });

	beforeAll(async () => {
		await rm(stateDir, { recursive: true, force: true });
		await mkdir(stateDir, { recursive: true });
		for (const id of [AGENT_ID, DECLARED_ID]) {
			await manager.destroy(id, { discardState: true }).catch(() => {});
		}
	}, 60_000);

	afterAll(async () => {
		for (const id of [AGENT_ID, DECLARED_ID]) {
			await manager.destroy(id, { discardState: true }).catch(() => {});
		}
		await rm(stateDir, { recursive: true, force: true });
	}, 60_000);

	it("gets a sandbox, the defaults' grants, and a repository of its own", async () => {
		const first = plane();
		await first.start();
		try {
			const created = await first.create(AGENT_ID);

			expect(created).toMatchObject({ id: AGENT_ID, running: true, created: true, grants: 1 });
			const manifest = await manager.run(AGENT_ID, ["cat", "/home/agent/.self/agent.yaml"], "", {
				timeoutMs: 30_000,
			});
			expect(manifest.stdout).toContain(AGENT_ID);
		} finally {
			await first.stop();
		}
	}, 120_000);

	it("is written down where the config cannot be, so a restart brings it back", async () => {
		expect(JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8"))).toEqual([
			{ id: AGENT_ID, createdAt: expect.any(String) },
		]);

		const second = plane();
		await second.start();
		try {
			expect((await second.agents()).map((agent) => agent.id)).toEqual([DECLARED_ID, AGENT_ID]);
		} finally {
			await second.stop();
		}
	}, 120_000);

	it("is forgotten only when its repository goes with it", async () => {
		const third = plane();
		await third.start();
		try {
			await third.remove(AGENT_ID, { purge: false });
			expect((await third.agents()).map((agent) => agent.id)).toContain(AGENT_ID);

			await third.remove(AGENT_ID, { purge: true });
			expect((await third.agents()).map((agent) => agent.id)).toEqual([DECLARED_ID]);
			expect(JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8"))).toEqual([]);
		} finally {
			await third.stop();
		}
	}, 120_000);
});
