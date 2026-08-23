import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerEngine } from "../src/engine.ts";
import { DockerSandboxManager, volumeName } from "../src/sandbox.ts";
import { containerName } from "../src/spec.ts";

const IMAGE = "agent-dive/sandbox:dev";
const AGENT_ID = "itest";
const CONTROL_CONTAINER = "agent-dive-itest-control";
const TEST_NETWORK = "agent-dive-test-egress";
/** Dialled by IP so a failure means "no route", not "no DNS". */
const PUBLIC_IP = "1.1.1.1";
const REACH_CMD = `curl -sS --max-time 4 -o /dev/null http://${PUBLIC_IP}/ && echo REACHED || echo BLOCKED`;

const engine = new DockerEngine();
const dockerUp = await engine.isAvailable();
const suite = dockerUp ? describe : describe.skip;

/** Host directory for the mounted CA. Kept inside the repo because Docker Desktop shares /Users. */
const pkiDir = join(process.cwd(), ".pki");
const caPath = join(pkiDir, "itest-ca.crt");

async function reachesInternet(manager: DockerSandboxManager, agentId: string): Promise<boolean> {
	const result = await manager.exec(agentId, ["sh", "-c", REACH_CMD]);
	return result.stdout.includes("REACHED");
}

suite("Docker sandbox against a live daemon", () => {
	const manager = new DockerSandboxManager(engine, TEST_NETWORK);

	beforeAll(async () => {
		await mkdir(pkiDir, { recursive: true });
		await writeFile(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
		await manager.destroy(AGENT_ID, { discardState: true });
		await engine.request("DELETE", `/containers/${CONTROL_CONTAINER}?force=true`).catch(() => {});
	}, 60_000);

	afterAll(async () => {
		await manager.destroy(AGENT_ID, { discardState: true });
		await engine.request("DELETE", `/containers/${CONTROL_CONTAINER}?force=true`).catch(() => {});
		await engine.request("DELETE", `/networks/${TEST_NETWORK}`).catch(() => {});
		await rm(caPath, { force: true });
	}, 60_000);

	it("creates, starts and reports a sandbox", async () => {
		const containerId = await manager.create({
			agentId: AGENT_ID,
			image: IMAGE,
			proxyUrl: "http://itest:token@egress:8080",
			caCertHostPath: caPath,
		});
		expect(containerId).toMatch(/^[0-9a-f]{12,}$/);

		await manager.start(AGENT_ID);
		const status = await manager.status(AGENT_ID);
		expect(status?.running).toBe(true);
		expect(status?.startedAt).toBeDefined();
	}, 60_000);

	it("mounts the agent repository volume and the CA", async () => {
		const mounted = await manager.exec(AGENT_ID, [
			"sh",
			"-c",
			"test -d /home/agent/.self && echo OK",
		]);
		expect(mounted.stdout).toContain("OK");

		const ca = await manager.exec(AGENT_ID, ["cat", "/etc/agent-dive/ca.crt"]);
		expect(ca.stdout).toContain("BEGIN CERTIFICATE");
	}, 30_000);

	it("runs as the non-root sandbox user", async () => {
		const result = await manager.exec(AGENT_ID, ["id", "-u"]);
		expect(result.stdout.trim()).toBe("1000");
	}, 30_000);

	it("exposes the agent identity to the process", async () => {
		const result = await manager.exec(AGENT_ID, ["sh", "-c", "echo $AGENT_DIVE_AGENT_ID"]);
		expect(result.stdout.trim()).toBe(AGENT_ID);
	}, 30_000);

	it("reports a non-zero exit code from a failing command", async () => {
		const result = await manager.exec(AGENT_ID, ["sh", "-c", "exit 3"]);
		expect(result.exitCode).toBe(3);
	}, 30_000);

	it("cannot reach the internet directly, because the network is internal", async () => {
		expect(await reachesInternet(manager, AGENT_ID)).toBe(false);
	}, 60_000);

	it("control: the same image on the default bridge does reach the internet", async () => {
		// Without this the containment assertion above would also pass if wget were simply broken.
		await engine.request("POST", `/containers/create?name=${CONTROL_CONTAINER}`, {
			Image: IMAGE,
			HostConfig: { NetworkMode: "bridge" },
		});
		await engine.request("POST", `/containers/${CONTROL_CONTAINER}/start`);

		const created = await engine.request<{ Id: string }>(
			"POST",
			`/containers/${CONTROL_CONTAINER}/exec`,
			{ AttachStdout: true, AttachStderr: true, Cmd: ["sh", "-c", REACH_CMD] },
		);
		const raw = await engine.requestRaw("POST", `/exec/${created.body.Id}/start`, {
			Detach: false,
			Tty: false,
		});
		expect(raw.toString("utf8")).toContain("REACHED");
	}, 60_000);

	it("keeps the volume when the container is replaced", async () => {
		await manager.exec(AGENT_ID, ["sh", "-c", "echo persisted > /home/agent/.self/marker"]);
		await manager.destroy(AGENT_ID);
		expect(await manager.status(AGENT_ID)).toBeUndefined();

		await manager.create({
			agentId: AGENT_ID,
			image: IMAGE,
			proxyUrl: "http://itest:token@egress:8080",
			caCertHostPath: caPath,
		});
		await manager.start(AGENT_ID);

		const result = await manager.exec(AGENT_ID, ["cat", "/home/agent/.self/marker"]);
		expect(result.stdout.trim()).toBe("persisted");
	}, 90_000);

	it("removes the volume only when state is explicitly discarded", async () => {
		await manager.destroy(AGENT_ID, { discardState: true });
		await expect(engine.request("GET", `/volumes/${volumeName(AGENT_ID)}`)).rejects.toMatchObject({
			status: 404,
		});
		await expect(
			engine.request("GET", `/containers/${containerName(AGENT_ID)}/json`),
		).rejects.toMatchObject({ status: 404 });
	}, 60_000);
});
