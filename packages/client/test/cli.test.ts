import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, ControlServer } from "@agent-dive/control-plane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli.ts";
import { writePlane } from "../src/plane.ts";
import { settle } from "../src/setup.ts";

describe("the console, driving the plane this operator chose", () => {
	let home: string;
	let stateDir: string;
	let plane: ControlPlane;
	let server: ControlServer;
	let out: string;
	let err: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "agent-dive-console-"));
		stateDir = join(home, "state");
		plane = new ControlPlane({ agents: [{ id: "scout" }, { id: "scribe" }], stateDir });
		server = new ControlServer({ plane });
		await server.listen();

		vi.stubEnv("AGENT_DIVE_HOME", home);
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
		vi.unstubAllEnvs();
		process.exitCode = 0;
		await server.close();
		await plane.bus.drain();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("reaches a plane on this computer without being told where it is", async () => {
		await writePlane(home, { kind: "here", stateDir });
		await cli(["ls"]);
		expect(out).toContain("scout");
		expect(out).toContain("scribe");
		expect(process.exitCode).toBe(0);
	});

	// The commands are the plane's, so the help has to be the client's own: `run` and `relay` are
	// things a machine does to host a plane, and typing either here reaches nothing.
	it("offers the commands an operator has, and not the ones a host has", async () => {
		await writePlane(home, { kind: "server", target: "me@vps" });
		await cli(["help"]);
		expect(out).toContain("agent chat");
		expect(out).toContain("agent connect");
		expect(out).not.toMatch(/^\s+agent (run|relay)\b/m);
	});

	// Which machine, on the screen that lists what can be done to it.
	it("says where the agents live, or that nowhere is the answer yet", async () => {
		await cli(["help"]);
		expect(out).toContain("the first `agent` asks where");

		out = "";
		await writePlane(home, { kind: "server", target: "me@vps" });
		await cli(["help"]);
		expect(out).toContain("me@vps");
	});

	/**
	 * A first run with nothing to ask on.
	 *
	 * `agent ls | tee` and a cron line both arrive here, and the question they would be asked has no
	 * terminal to be asked on. Saying which command has none beats a raw-mode error from a stream.
	 */
	it("says to come back to a terminal rather than asking a pipe", async () => {
		// Stated rather than assumed: the runner's stdin is already a pipe, and a suite that passes
		// because of where it happens to be run is not testing the branch it names.
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		await cli(["ls"]);
		expect(err).toContain("terminal");
		expect(process.exitCode).toBe(1);
	});
});

/**
 * The wait between building a plane and being in front of it.
 *
 * `docker compose up -d` comes back when the container has started, which is a moment before the
 * process inside it is listening — so without this the first console after an install is told there
 * is no plane, seconds after watching one being built.
 */
describe("holding the door open until the plane answers", () => {
	it("goes on as soon as something opens, and lets go of what it opened", async () => {
		const opened: { destroyed: boolean }[] = [];
		let attempts = 0;
		await settle(async () => {
			attempts += 1;
			if (attempts < 2) throw new Error("nothing listening yet");
			const socket = { destroy: () => (socket.destroyed = true), destroyed: false };
			opened.push(socket);
			// biome-ignore lint/suspicious/noExplicitAny: a socket is more than this test needs to be one
			return socket as any;
		});
		expect(attempts).toBe(2);
		expect(opened.every((socket) => socket.destroyed)).toBe(true);
	});

	// A plane that never comes up is a thing to be told about, not a console that never opens.
	it("gives up rather than waiting forever", async () => {
		await expect(
			settle(async () => {
				throw new Error("nothing listening, ever");
			}, 0),
		).resolves.toBeUndefined();
	});
});
