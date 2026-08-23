import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerEngine, DockerSandboxManager, SandboxTimeoutError } from "@agent-dive/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSelfRepo } from "../src/self.ts";
import { PiTurnRunner, TurnError } from "../src/turn.ts";

const IMAGE = "agent-dive/sandbox:dev";
const AGENT_ID = "turn-itest";
const TEST_NETWORK = "agent-dive-test-turn";

const engine = new DockerEngine();
const dockerUp = await engine.isAvailable();
const suite = dockerUp ? describe : describe.skip;

const pkiDir = join(process.cwd(), ".pki");
const caPath = join(pkiDir, "turn-itest-ca.crt");

suite("taking a turn in a live sandbox", () => {
	const manager = new DockerSandboxManager(engine, TEST_NETWORK);

	beforeAll(async () => {
		await mkdir(pkiDir, { recursive: true });
		await writeFile(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
		await manager.destroy(AGENT_ID, { discardState: true });
		await manager.create({
			agentId: AGENT_ID,
			image: IMAGE,
			proxyUrl: "http://turn-itest:token@egress:8080",
			caCertHostPath: caPath,
		});
		await manager.start(AGENT_ID);
	}, 120_000);

	afterAll(async () => {
		await manager.destroy(AGENT_ID, { discardState: true });
		await engine.request("DELETE", `/networks/${TEST_NETWORK}`).catch(() => {});
		await rm(caPath, { force: true });
	}, 60_000);

	it("delivers stdin to the command and collects its output", async () => {
		const result = await manager.run(AGENT_ID, ["cat"], "the deploy failed");
		expect(result.stdout).toBe("the deploy failed");
		expect(result.exitCode).toBe(0);
	}, 60_000);

	it("keeps a prompt larger than one socket read intact", async () => {
		const prompt = "x".repeat(256 * 1024);
		const result = await manager.run(AGENT_ID, ["cat"], prompt);
		expect(result.stdout.length).toBe(prompt.length);
	}, 60_000);

	it("separates stderr from the answer", async () => {
		const result = await manager.run(AGENT_ID, ["sh", "-c", "cat; echo warning >&2; exit 3"], "hi");
		expect(result.stdout).toBe("hi");
		expect(result.stderr).toBe("warning\n");
		expect(result.exitCode).toBe(3);
	}, 60_000);

	it("gives up on a command that never exits", async () => {
		await expect(manager.run(AGENT_ID, ["sleep", "60"], "", { timeoutMs: 500 })).rejects.toThrow(
			SandboxTimeoutError,
		);
	}, 60_000);

	it("has pi installed and answering in the sandbox", async () => {
		const result = await manager.exec(AGENT_ID, ["pi", "--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	}, 60_000);

	it("runs a turn through pi and surfaces its refusal rather than a blank answer", async () => {
		// No provider credentials in the test sandbox, so the turn must fail loudly. That is the
		// property under test: a turn that could not reach a model is not an agent that said nothing.
		const runner = new PiTurnRunner({
			sandbox: manager,
			provider: "anthropic",
			timeoutMs: 60_000,
		});

		await expect(runner.run(AGENT_ID, "say hi")).rejects.toThrow(TurnError);
	}, 120_000);

	it("scaffolds the agent's repository in the volume, as a git repository it can commit to", async () => {
		expect(
			await ensureSelfRepo({
				sandbox: manager,
				agentId: AGENT_ID,
				description: "an agent with 'quotes' and $(danger) in its description",
			}),
		).toBe(true);

		const manifest = await manager.exec(AGENT_ID, ["cat", "/home/agent/.self/agent.yaml"]);
		expect(manifest.stdout).toContain(`name: ${AGENT_ID}`);
		expect(manifest.stdout).toContain("$(danger)");

		const log = await manager.exec(AGENT_ID, [
			"git",
			"-C",
			"/home/agent/.self",
			"log",
			"--oneline",
		]);
		expect(log.exitCode).toBe(0);
		expect(log.stdout).toContain("scaffold");

		// Second boot: the agent owns these files now, so nothing may be written over them.
		await manager.exec(AGENT_ID, ["sh", "-c", "echo mine > /home/agent/.self/soul.md"]);
		expect(await ensureSelfRepo({ sandbox: manager, agentId: AGENT_ID })).toBe(false);
		const soul = await manager.exec(AGENT_ID, ["cat", "/home/agent/.self/soul.md"]);
		expect(soul.stdout.trim()).toBe("mine");
	}, 120_000);

	it("writes pi's session onto the agent's own volume", async () => {
		const runner = new PiTurnRunner({ sandbox: manager, provider: "anthropic" });
		expect(runner.commandFor(AGENT_ID)).toContain("/home/agent/.self/.sessions");

		const writable = await manager.exec(AGENT_ID, [
			"sh",
			"-c",
			"mkdir -p /home/agent/.self/.sessions && touch /home/agent/.self/.sessions/probe && echo OK",
		]);
		expect(writable.stdout).toContain("OK");
	}, 60_000);
});
