import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/control-plane.ts";

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
