import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, ControlServer } from "@squad/control-plane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli.ts";
import { writePlane } from "../src/plane.ts";
import { remoteInstall, settle } from "../src/setup.ts";

describe("the console, driving the plane this operator chose", () => {
	let home: string;
	let stateDir: string;
	let plane: ControlPlane;
	let server: ControlServer;
	let out: string;
	let err: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "squad-console-"));
		stateDir = join(home, "state");
		plane = new ControlPlane({ agents: [{ id: "scout" }, { id: "scribe" }], stateDir });
		server = new ControlServer({ plane });
		await server.listen();

		vi.stubEnv("SQUAD_HOME", home);
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
		expect(out).toContain("squad chat");
		expect(out).toContain("squad connect");
		expect(out).not.toMatch(/^\s+squad (run|relay)\b/m);
	});

	// Which machine, on the screen that lists what can be done to it.
	it("says where the agents live, or that nowhere is the answer yet", async () => {
		await cli(["help"]);
		expect(out).toContain("the first `squad` asks where");

		out = "";
		await writePlane(home, { kind: "server", target: "me@vps" });
		await cli(["help"]);
		expect(out).toContain("me@vps");
	});

	/**
	 * A first run with nothing to ask on.
	 *
	 * `squad ls | tee` and a cron line both arrive here, and the question they would be asked has no
	 * terminal to be asked on. Saying which command has none beats a raw-mode error from a stream —
	 * and it is said instead of the question, not after it.
	 */
	it("says to come back to a terminal rather than asking a pipe", async () => {
		// Stated rather than assumed: the runner's stdin is already a pipe, and a suite that passes
		// because of where it happens to be run is not testing the branch it names.
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		await cli(["ls"]);
		expect(err).toContain("terminal");
		expect(out).not.toContain("Where should your agents live?");
		expect(process.exitCode).toBe(1);
	});
});

/**
 * What the far end is told to run.
 *
 * The script goes down stdin, but the tree it installs is cloned there — and `ssh host sh` carries
 * no environment, so without this a machine reached over SSH could only ever be given the published
 * main. Which is also what makes a fork, or a branch, installable on a server at all.
 */
describe("the install, as the far end is told to run it", () => {
	it("is the script on stdin and nothing else, by default", () => {
		expect(remoteInstall({})).toBe("sh -s");
	});

	it("carries where the tree comes from, when this machine was told", () => {
		expect(remoteInstall({ SQUAD_REPO: "https://example.test/fork.git" })).toBe(
			"SQUAD_REPO='https://example.test/fork.git' sh -s",
		);
		expect(remoteInstall({ SQUAD_BRANCH: "next" })).toBe("SQUAD_BRANCH='next' sh -s");
	});

	// It is the operator's own environment and not a stranger's, but it is still a string on its way
	// into a shell, and one word is what it has to stay.
	it("keeps a value one word, whatever is in it", () => {
		expect(remoteInstall({ SQUAD_BRANCH: "a branch'; rm -rf /" })).toBe(
			`SQUAD_BRANCH='a branch'\\''; rm -rf /' sh -s`,
		);
	});

	// Where things go is the server's own business: a state directory that suits this laptop is the
	// wrong one there, and the script's defaults are the right ones.
	it("says nothing about where things go on that machine", () => {
		const said = remoteInstall({ SQUAD_DIR: "/tmp/here", SQUAD_STATE: "/tmp/state" });
		expect(said).toBe("sh -s");
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
