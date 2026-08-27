import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSecretStore } from "@agent-dive/proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, type Remote } from "../src/cli.ts";
import { type Dial, dialLocal } from "../src/control-client.ts";
import { ControlPlane } from "../src/control-plane.ts";
import { ControlServer } from "../src/control-server.ts";

/**
 * The same commands, pointed at a plane that is not on this machine.
 *
 * The console the operator installs runs here and the agents run there, so every command in this
 * process has to work against a plane it was handed rather than one it went looking for. The dial
 * below is a local socket because what makes it remote is that the CLI was given it: over SSH the
 * only difference is which pipes the bytes are on, and that road has tests of its own.
 */
describe("the CLI given somewhere else to talk to", () => {
	let stateDir: string;
	let plane: ControlPlane;
	let server: ControlServer;
	let out: string;
	let err: string;

	const remote = (dial: Dial): Remote => ({ at: "root@example.test", dial });

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "agent-dive-remote-"));
		plane = new ControlPlane({
			agents: [{ id: "scout" }, { id: "scribe" }],
			stateDir,
			secrets: new EnvSecretStore({}),
		});
		server = new ControlServer({ plane });
		await server.listen();

		out = "";
		err = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			out += chunk.toString();
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			err += chunk.toString();
			return true;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.exitCode = 0;
		await server.close();
		await plane.bus.drain();
		await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("asks the plane it was handed, not the directory it is standing in", async () => {
		await cli(["ls"], remote(dialLocal(stateDir)));
		expect(out).toContain("scout");
		expect(out).toContain("scribe");
		expect(process.exitCode).toBe(0);
	});

	// The first line of `agent` alone, because every line under it is about another computer.
	it("names the machine before saying anything about it", async () => {
		await cli([], remote(dialLocal(stateDir)));
		expect(out.split("\n")[0]).toBe("at      root@example.test");
		expect(out).toContain("plane   running");
		expect(out).not.toContain(stateDir);
	});

	// Told to start one here, the operator would be starting a second plane on the wrong machine.
	it("offers a machine to fix rather than a plane to start", async () => {
		const nowhere = await mkdtemp(join(tmpdir(), "agent-dive-empty-"));
		try {
			await cli([], remote(dialLocal(nowhere)));
			expect(out).toContain("plane   not running");
			expect(out).toContain("agent connect");
			expect(out).not.toContain("agent run");
			expect(process.exitCode).toBe(1);
		} finally {
			await rm(nowhere, { recursive: true, force: true });
		}
	});

	// Held open from here it would relay this machine's plane, which is not the one the operator has.
	it("will not open a relay on somebody else's behalf", async () => {
		await cli(["relay"], remote(dialLocal(stateDir)));
		expect(err).toContain("root@example.test");
		expect(process.exitCode).toBe(1);
	});
});
