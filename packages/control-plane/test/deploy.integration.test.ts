import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerEngine, DockerSandboxManager } from "@agent-dive/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control-client.ts";
import { CONTROL_PLANE_LABEL } from "../src/control-relay.ts";

const CONTROL_PLANE_IMAGE = "agent-dive/control-plane:dev";
const AGENT_ID = "deploy-itest";
const EGRESS_NETWORK = "agent-dive-itest-egress";
const UPLINK_NETWORK = "agent-dive-itest-uplink";
const PLANE_CONTAINER = "agent-dive-itest-plane";

const engine = new DockerEngine();
const dockerUp = await engine.isAvailable();
const imageBuilt =
	dockerUp &&
	(await engine
		.request("GET", `/images/${encodeURIComponent(CONTROL_PLANE_IMAGE)}/json`)
		.then(() => true)
		.catch(() => false));
const suite = imageBuilt ? describe : describe.skip;

// The daemon resolves bind sources on the host, so the state directory has to answer to the same
// path inside the control plane as it does outside. Anything under the working tree is a path both
// sides already agree on.
const stateRoot = join(process.cwd(), ".deploy-itest");

/**
 * Proves the deployment topology, which no unit test can: the agents sit on an unrouted network and
 * the only thing on it besides them is the proxy. If the control plane ran on the host instead, as
 * it does in every other test here, the sandbox would have no way to reach it at all.
 */
suite("a control plane deployed inside the sandbox network", () => {
	const manager = new DockerSandboxManager(engine, EGRESS_NETWORK);

	const curl = (url: string) =>
		manager.run(
			AGENT_ID,
			[
				"curl",
				"-sS",
				"--cacert",
				"/etc/agent-dive/ca.crt",
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				url,
			],
			"",
			{ timeoutMs: 30_000 },
		);

	/** Brings up a plane container against $stateRoot and waits for its agent's sandbox to run. */
	const startPlane = async (): Promise<void> => {
		const created = await engine.request<{ Id: string }>(
			"POST",
			`/containers/create?name=${PLANE_CONTAINER}`,
			{
				Image: CONTROL_PLANE_IMAGE,
				Cmd: ["run", join(stateRoot, "config.yaml")],
				Labels: { [CONTROL_PLANE_LABEL]: stateRoot },
				HostConfig: {
					Binds: [`${stateRoot}:${stateRoot}`, "/var/run/docker.sock:/var/run/docker.sock"],
					NetworkMode: EGRESS_NETWORK,
				},
				NetworkingConfig: {
					EndpointsConfig: { [EGRESS_NETWORK]: { Aliases: ["egress"] } },
				},
			},
		);
		await engine.request("POST", `/networks/${UPLINK_NETWORK}/connect`, {
			Container: created.body.Id,
		});
		await engine.request("POST", `/containers/${PLANE_CONTAINER}/start`);

		// The sandbox is created by the control plane, not by this test, so wait for it to appear.
		for (let attempt = 0; attempt < 60; attempt++) {
			if ((await manager.status(AGENT_ID))?.running) return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error("the control plane never started its agent's sandbox");
	};

	beforeAll(async () => {
		await rm(stateRoot, { recursive: true, force: true });
		await mkdir(stateRoot, { recursive: true });
		await writeFile(
			join(stateRoot, "config.yaml"),
			`stateDir: ${stateRoot}\nnetworkName: ${EGRESS_NETWORK}\nagents:\n  - id: ${AGENT_ID}\n    grants:\n      - id: example\n        host: example.com\n        methods: [GET]\n        injection: { kind: none }\n`,
		);

		for (const [name, internal] of [
			[EGRESS_NETWORK, true],
			[UPLINK_NETWORK, false],
		] as const) {
			await engine
				.request("POST", "/networks/create", { Name: name, Driver: "bridge", Internal: internal })
				.catch(() => {});
		}
		await engine.request("DELETE", `/containers/${PLANE_CONTAINER}?force=true`).catch(() => {});
		await manager.destroy(AGENT_ID, { discardState: true });
		await startPlane();
	}, 180_000);

	afterAll(async () => {
		await engine.request("DELETE", `/containers/${PLANE_CONTAINER}?force=true`).catch(() => {});
		await manager.destroy(AGENT_ID, { discardState: true });
		for (const name of [EGRESS_NETWORK, UPLINK_NETWORK]) {
			await engine.request("DELETE", `/networks/${name}`).catch(() => {});
		}
		await rm(stateRoot, { recursive: true, force: true });
	}, 120_000);

	it("reaches a granted host through the proxy on the network they share", async () => {
		expect((await curl("https://example.com/")).stdout.trim()).toBe("200");
	}, 90_000);

	it("is refused everywhere the operator did not grant", async () => {
		// The refusal lands on CONNECT, before any tunnel exists, so the agent never gets to speak
		// TLS to a host it was not granted.
		expect((await curl("https://api.github.com/")).stderr).toContain("CONNECT tunnel failed");
	}, 90_000);

	it("gave the agent its repository, from a control plane that is itself in a container", async () => {
		const manifest = await manager.exec(AGENT_ID, ["cat", "/home/agent/.self/agent.yaml"]);
		expect(manifest.stdout).toContain(`name: ${AGENT_ID}`);
	}, 90_000);

	it("answers the operator on the host, over the socket in the shared state directory", async () => {
		// The whole control surface rests on this: the plane is in a container, the operator is not,
		// and the only thing between them is a socket file both sides see at the same path.
		const client = new ControlClient(stateRoot);
		await client.connect();
		try {
			expect((await client.agents()).map((agent) => agent.id)).toEqual([AGENT_ID]);
		} finally {
			client.close();
		}
	}, 90_000);

	/**
	 * A deploy, a crash and a reboot all look like this, and the agent is meant not to notice.
	 *
	 * The credential the sandbox presents is baked into it at creation and the sandbox outlives the
	 * plane, so a plane that decides the token afresh comes back not recognising its own agents —
	 * every request denied, the model included, with the sandbox looking perfectly healthy. Curling
	 * afterwards is the assertion that matters: the container being adopted rather than replaced is
	 * only how it is achieved.
	 */
	it("adopts the sandbox it left running, and its egress still works", async () => {
		const before = await manager.status(AGENT_ID);

		await engine.request("DELETE", `/containers/${PLANE_CONTAINER}?force=true`);
		await startPlane();

		expect((await manager.status(AGENT_ID))?.containerId).toBe(before?.containerId);

		// Retried because a plane that has only just bound its port refuses exactly as one that never
		// recognised the agent does, and the difference between them is a second. A plane that truly
		// failed to adopt never starts answering, so this ends in the same assertion either way.
		let last = await curl("https://example.com/");
		for (let attempt = 0; attempt < 30 && last.stdout.trim() !== "200"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			last = await curl("https://example.com/");
		}
		expect(`${last.stdout.trim()} ${last.stderr}`.trim()).toBe("200");
	}, 180_000);

	it("has no route off the network except the proxy", async () => {
		const result = await manager.run(
			AGENT_ID,
			["curl", "-sS", "--noproxy", "*", "-m", "5", "-o", "/dev/null", "https://example.com/"],
			"",
			{ timeoutMs: 30_000 },
		);
		expect(result.exitCode).not.toBe(0);
	}, 90_000);
});
