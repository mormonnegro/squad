import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DockerEngine, DockerSandboxManager } from "@agent-dive/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/control-plane.ts";

const AGENT_ID = "created-itest";
const DECLARED_ID = "declared-itest";
const NETWORK = "agent-dive-created-itest";

const engine = new DockerEngine();
// The image the plane puts an agent in when it is not told otherwise, and one that is built by
// hand — so a daemon being up is not enough to run these.
const IMAGE = "agent-dive/sandbox:dev";
const suite =
	(await engine.isAvailable()) &&
	(await new DockerSandboxManager(engine).imageId(IMAGE)) !== undefined
		? describe
		: describe.skip;

/** Under the working tree, because the daemon resolves the CA's bind source on the host. */
const stateDir = join(process.cwd(), ".created-itest");

/** Ports the tests do not use, so a demo plane on the usual ones is not in the way. */
const quiet = { proxyPort: 0, webhookPort: 0, networkName: NETWORK } as const;

const defaults = {
	env: { ANTHROPIC_API_KEY: "injected-by-the-proxy" },
	grants: [{ id: "model", host: "api.anthropic.com", injection: { kind: "none" } }],
} as const;

/** The one grant above, and the one every agent gets for searching, which the plane derives. */
const DEFAULT_GRANTS = 2;

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

			expect(created).toMatchObject({
				id: AGENT_ID,
				running: true,
				created: true,
				grants: DEFAULT_GRANTS,
			});
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

	/**
	 * Deletion from the console, which is `/delete` and not the method under it.
	 *
	 * Worth driving through the command because the ordering only exists there: the line typed is
	 * written into the conversation, the agent goes, and then the answer is written — and an answer
	 * written after the deletion would put back the conversation the deletion just took away.
	 */
	it("is forgotten when it is deleted, and takes its repository and conversation along", async () => {
		const third = plane();
		await third.start();
		try {
			const asked = await third.command(AGENT_ID, "/delete");
			expect(asked).toContain("Nothing has been deleted yet");
			expect((await third.agents()).map((agent) => agent.id)).toContain(AGENT_ID);

			const gone = await third.command(AGENT_ID, `/delete ${AGENT_ID}`);
			expect(gone).toContain("the last of it");
			expect((await third.agents()).map((agent) => agent.id)).toEqual([DECLARED_ID]);
			expect(JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8"))).toEqual([]);
			expect(await third.transcripts()).not.toHaveProperty(AGENT_ID);
			await expect(
				readFile(join(stateDir, "transcript", `${AGENT_ID}.json`), "utf8"),
			).rejects.toThrow();
		} finally {
			await third.stop();
		}
	}, 120_000);

	/**
	 * The agent that is written into the operator's own config, deleted anyway.
	 *
	 * This is the one that kept coming back. The plane may not edit the config file, so for a long
	 * while a declared agent was only stopped: the row stayed in the column and the answer explained,
	 * truthfully and uselessly, that it would return. Two people in a row read that as a bug, and
	 * they were right — a delete that leaves the thing there is not a delete.
	 *
	 * So the deletion is what gets written down. The config still declares the name and always will;
	 * every start from here on reads this file and skips it, which is what makes the second half of
	 * this test the real one.
	 */
	it("deletes a declared agent for good, by writing down the deletion the config cannot hold", async () => {
		const fourth = plane();
		await fourth.start();
		try {
			const gone = await fourth.command(DECLARED_ID, `/delete ${DECLARED_ID}`);

			expect(gone).toContain("stays gone across restarts");
			expect(await fourth.agents()).toEqual([]);
			expect(JSON.parse(await readFile(join(stateDir, "deleted.json"), "utf8"))).toEqual([
				{ id: DECLARED_ID, deletedAt: expect.any(String) },
			]);
		} finally {
			await fourth.stop();
		}

		// The same config as before, declaring the same agent, and it stays gone.
		const fifth = plane();
		await fifth.start();
		try {
			expect(await fifth.agents()).toEqual([]);
		} finally {
			await fifth.stop();
		}
	}, 120_000);

	// Deleting is not banishing the name: the config still says what this agent is, so making it
	// again brings back the operator's agent rather than a stranger wearing its id.
	it("brings a deleted declaration back when the name is created again", async () => {
		const sixth = plane();
		await sixth.start();
		try {
			const back = await sixth.create(DECLARED_ID);

			expect(back).toMatchObject({
				id: DECLARED_ID,
				running: true,
				created: false,
				grants: DEFAULT_GRANTS,
			});
			expect(JSON.parse(await readFile(join(stateDir, "deleted.json"), "utf8"))).toEqual([]);
			expect(JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8"))).toEqual([]);
		} finally {
			await sixth.stop();
		}
	}, 120_000);
});
