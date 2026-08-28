import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, ControlServer } from "@squad/control-plane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli.ts";
import { writePlane } from "../src/plane.ts";
import { authorizeKey, planeEnv, remoteInstall, settle } from "../src/setup.ts";

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

	/**
	 * The one command the plane has no version of.
	 *
	 * Everything else here is forwarded to the plane's own CLI, and this cannot be: both halves of
	 * what an update replaces are processes that would be answering it.
	 */
	it("offers the update beside the commands that reach the plane", async () => {
		await writePlane(home, { kind: "server", target: "me@vps" });
		await cli(["help"]);
		expect(out).toContain("squad update");
		expect(out).toContain("your keys stay as they are");
		// Which machines it touches, on the screen that lists what can be typed. An operator who reads
		// only the plane here is one who goes looking for a second command for the console.
		expect(out).toContain("this computer");
	});

	// An update with nowhere to run it is the question `squad` asks on its first run, not an error:
	// nothing was chosen, so there is nothing to say is out of date.
	it("asks where the plane goes rather than failing when none was chosen", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		await cli(["update"]);
		expect(err).toContain("terminal");
		expect(process.exitCode).toBe(1);
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
 * The same script, as this computer is told to run it — on the install and on every update after.
 *
 * The four are what keep a plane living beside its client from stepping on it, and they matter most
 * on the second run: the first one is watched, and an update is the one an operator walks away from.
 */
describe("the install, as this computer is told to run it", () => {
	it("puts the tree beside the client's own directory, and the state where the plane serves it", () => {
		expect(planeEnv("/home/me/.squad", "/home/me/.squad/state")).toMatchObject({
			SQUAD_DIR: "/home/me/.squad/src",
			SQUAD_STATE: "/home/me/.squad/state",
		});
	});

	// `squad` here is the client that is running right now. A shim written over it would take the
	// console away from the thing that opened it — on an update, mid-command.
	it("refuses the shim, because the name is already taken by what ran this", () => {
		expect(planeEnv("/home/me/.squad", "/state").SQUAD_SHIM).toBe("no");
	});

	// The keys have a screen of their own in the console, and an update that stopped to ask for three
	// of them would be an update that hangs on a terminal nobody is watching.
	it("refuses the questions, because the console is where the keys are given", () => {
		expect(planeEnv("/home/me/.squad", "/state").SQUAD_ASK).toBe("no");
	});
});

/**
 * Both halves on one word, and this computer's half last.
 *
 * The console and the plane answer each other, so a new one of either against an old one of the
 * other is a bug that arrives looking like anything but a version. The order is not a preference:
 * the console's own script renames a new tree over the directory this process was loaded from, so
 * whatever an update has left to do after it is asked of a program that is no longer on disk.
 */
describe("the update, which is both halves or neither", () => {
	let home: string;
	let stateDir: string;
	let plane: ControlPlane;
	let server: ControlServer;
	let err: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "squad-update-"));
		stateDir = join(home, "state");
		const deploy = join(home, "deploy");
		await mkdir(deploy, { recursive: true });

		// Stand-ins for the two published scripts: each says its name into one file and stops. What is
		// left there is that both were run, and which of them ran first.
		const ran = join(home, "ran");
		await writeFile(join(deploy, "install.sh"), `printf 'plane\\n' >> "${ran}"\n`);
		await writeFile(join(deploy, "client.sh"), `printf 'console\\n' >> "${ran}"\n`);

		plane = new ControlPlane({ agents: [{ id: "scout" }], stateDir });
		server = new ControlServer({ plane });
		await server.listen();

		vi.stubEnv("SQUAD_HOME", home);
		vi.stubEnv("SQUAD_BASE", deploy);
		err = "";
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			err += chunk.toString();
			return true;
		});
		// Where the scripts come from is read once, as the module loads. So it is said first and the
		// module is imported inside the test rather than at the top of this file.
		vi.resetModules();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.exitCode = 0;
		await server.close();
		await plane.bus.drain();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("puts the latest on the plane, and then over the console that asked for it", async () => {
		await writePlane(home, { kind: "here", stateDir });
		const { cli } = await import("../src/cli.ts");
		await cli(["update"]);
		expect(err).toBe("");
		expect(await readFile(join(home, "ran"), "utf8")).toBe("plane\nconsole\n");
		expect(process.exitCode).toBe(0);
	});
});

/**
 * The one time a password is typed.
 *
 * A server bought this morning has a root password in an email and no key on it. What goes down
 * that connection is this, and it is worth running rather than reading: the file it writes is the
 * one sshd reads, and a mode it gets wrong is a machine that goes on asking for the password.
 */
describe("putting a key on a machine that has none", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "squad-authorized-"));
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	const put = (key: string): Promise<number> =>
		new Promise((resolve, reject) => {
			const child = spawn("sh", ["-s"], {
				env: { ...process.env, HOME: home },
				stdio: ["pipe", "ignore", "ignore"],
			});
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? 1));
			child.stdin?.end(authorizeKey(key));
		});

	const authorized = (): Promise<string> => readFile(join(home, ".ssh/authorized_keys"), "utf8");

	it("writes the key where sshd looks for it, modes and all", async () => {
		expect(await put("ssh-ed25519 AAAAC3Nz me@laptop")).toBe(0);
		expect(await authorized()).toBe("ssh-ed25519 AAAAC3Nz me@laptop\n");
		expect((await stat(join(home, ".ssh"))).mode & 0o777).toBe(0o700);
		expect((await stat(join(home, ".ssh/authorized_keys"))).mode & 0o777).toBe(0o600);
	});

	// Setting up the same machine twice is a thing an operator does, and the second time it should
	// cost a connection and change nothing.
	it("leaves a key that is already up there where it is", async () => {
		await put("ssh-ed25519 AAAAC3Nz me@laptop");
		expect(await put("ssh-ed25519 AAAAC3Nz me@laptop")).toBe(0);
		expect(await authorized()).toBe("ssh-ed25519 AAAAC3Nz me@laptop\n");
	});

	// Somebody else's file, and this has no business rewriting it.
	it("keeps what was already in the file", async () => {
		await mkdir(join(home, ".ssh"), { recursive: true });
		await writeFile(join(home, ".ssh/authorized_keys"), "ssh-rsa AAAAB3 someone@else\n");
		await put("ssh-ed25519 AAAAC3Nz me@laptop");
		expect(await authorized()).toBe(
			"ssh-rsa AAAAB3 someone@else\nssh-ed25519 AAAAC3Nz me@laptop\n",
		);
	});

	// The comment at the end of a public key is whatever ssh-keygen was told, and it is on its way
	// into a shell. One word is what it has to stay.
	it("keeps the key one line, whatever its comment holds", async () => {
		const key = "ssh-ed25519 AAAAC3Nz me@laptop'; rm -rf ~; echo '";
		expect(await put(key)).toBe(0);
		expect(await authorized()).toBe(`${key}\n`);
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
