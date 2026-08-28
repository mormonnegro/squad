import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { ControlClient, ControlError, ControlPlane, ControlServer } from "@squad/control-plane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialCommand, relayOverSsh, shared } from "../src/ssh.ts";

const BIN = fileURLToPath(new URL("../../control-plane/bin/squad.mjs", import.meta.url));

/**
 * The road a console takes to a plane that is not on this computer, walked without an SSH server.
 *
 * SSH is not what makes it work: `squad relay` puts the plane's control socket on a pair of pipes,
 * and anything that carries a pair of pipes to another machine is the same road. So the test runs
 * that command directly, and what it proves — the mark, the protocol behind it, the failures —
 * holds for the SSH connection it is reached through in real life.
 */
describe("reaching a plane by running a relay", () => {
	let stateDir: string;
	let plane: ControlPlane;
	let server: ControlServer;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "squad-relay-"));
		plane = new ControlPlane({ agents: [{ id: "scout" }, { id: "scribe" }], stateDir });
		server = new ControlServer({ plane });
		await server.listen();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await server.close();
		await plane.bus.drain();
		await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	const relay = (...before: string[]) =>
		dialCommand(
			before.length > 0
				? [
						"sh",
						"-c",
						`${before.join("; ")}; exec "$0" "$@"`,
						process.execPath,
						BIN,
						"relay",
						"--state",
						stateDir,
					]
				: [process.execPath, BIN, "relay", "--state", stateDir],
			"root@example.test",
		);

	it("answers the same questions as the socket it stands in front of", async () => {
		const client = new ControlClient(relay());
		await client.connect();
		try {
			expect((await client.agents()).map((agent) => agent.id)).toEqual(["scout", "scribe"]);
		} finally {
			client.close();
		}
	});

	// Every forwarded port is a connection of its own, so the road has to be walkable more than once.
	it("can be walked again for a second connection", async () => {
		const dial = relay();
		const first = new ControlClient(dial);
		const second = new ControlClient(dial);
		await first.connect();
		await second.connect();
		try {
			expect(await first.agents()).toHaveLength(2);
			expect(await second.agents()).toHaveLength(2);
		} finally {
			first.close();
			second.close();
		}
	});

	// A login shell that sources an rc file prints from it, onto the same stdout the protocol is on.
	// The far end cannot know that happened, so the console is the half that skips it.
	it("reads past whatever the far end's shell printed first", async () => {
		const client = new ControlClient(relay("echo 'Welcome to Ubuntu 24.04 LTS'", "echo"));
		await client.connect();
		try {
			expect((await client.agents()).map((agent) => agent.id)).toEqual(["scout", "scribe"]);
		} finally {
			client.close();
		}
	});

	/**
	 * The one thing on this road that is not lines of JSON.
	 *
	 * A page an agent serves reaches a browser here by travelling this, as bytes: a newline in them is
	 * a newline and not a frame boundary, and a zero byte is a zero byte. The relay is the half most
	 * likely to get that wrong, because everything else it carries is text with the newlines meaning
	 * something.
	 */
	it("carries a forwarded port's bytes, newlines and zeroes and all", async () => {
		const echo = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				done(null, chunk);
			},
		});
		vi.spyOn(plane, "forward").mockResolvedValue(echo);

		const client = new ControlClient(relay());
		await client.connect();
		try {
			const stream = await client.forward("scout", 3002);
			const sent = Buffer.from([0x00, 0x0a, 0xff, 0x7b, 0x0a, 0x00, 0x7d]);
			const heard = new Promise<Buffer>((resolve) => {
				let seen = Buffer.alloc(0);
				stream.on("data", (chunk: Buffer) => {
					seen = Buffer.concat([seen, chunk]);
					if (seen.byteLength >= sent.byteLength) resolve(seen);
				});
			});
			// It arrives paused, holding whatever came in behind the answer; piping is what resumes one
			// of these in real life, and a listener on its own does not.
			stream.resume();
			stream.write(sent);
			expect(await heard).toEqual(sent);
			stream.destroy();
		} finally {
			client.close();
		}
	});

	// A connection of its own per forward is what keeps a page from blocking the console, and over
	// this road each one is another relay. So the console has to still answer with one open.
	it("leaves the console's own connection alone while a port is open", async () => {
		vi.spyOn(plane, "forward").mockResolvedValue(
			new Transform({
				transform(chunk: Buffer, _encoding, done) {
					done(null, chunk);
				},
			}),
		);

		const client = new ControlClient(relay());
		await client.connect();
		try {
			const stream = await client.forward("scout", 3002);
			stream.write("hola");
			expect((await client.agents()).map((agent) => agent.id)).toEqual(["scout", "scribe"]);
			stream.destroy();
		} finally {
			client.close();
		}
	});

	// The likeliest real failure: the SSH connection works and the machine has no plane on it.
	it("says what to do when there is no squad at the far end", async () => {
		const dial = dialCommand(
			["sh", "-c", "echo 'sh: 1: squad: not found' >&2; exit 127"],
			"root@example.test",
		);
		await expect(dial()).rejects.toThrow(/no squad on it/);
		await expect(dial()).rejects.toBeInstanceOf(ControlError);
	});

	it("passes ssh's own complaint through, because it is the useful one", async () => {
		const dial = dialCommand(
			["sh", "-c", "echo 'Permission denied (publickey).' >&2; exit 255"],
			"root@example.test",
		);
		await expect(dial()).rejects.toThrow("Permission denied (publickey).");
	});

	it("refuses something that answers but is not a relay", async () => {
		const dial = dialCommand(["sh", "-c", "echo hello"], "root@example.test");
		await expect(dial()).rejects.toThrow(/before the relay answered/);
	});
});

describe("the command that reaches a plane over SSH", () => {
	const argv = relayOverSsh("me@vps", "/home/me/.squad");

	// A pty rewrites the bytes of the protocol on the way past: newlines are the frame boundary.
	it("asks for no terminal", () => {
		expect(argv).toContain("-T");
	});

	// Not an optimisation: a page with six forwarded ports would otherwise be six SSH handshakes.
	it("multiplexes over one connection, kept in the client's own directory", () => {
		expect(argv).toContain("ControlMaster=auto");
		expect(argv).toContainEqual(
			expect.stringMatching(/^ControlPath=\/home\/me\/\.squad\/ssh-[0-9a-f]{12}$/),
		);
	});

	// A unix socket path is capped at a hundred-odd bytes, and ssh refuses the connection rather than
	// truncating. So the length is the client's promise to keep, not something to find out about on a
	// machine with a long name.
	it("keeps the socket short enough to be a socket", () => {
		const path = relayOverSsh("someone@a-very-long-hostname.example.test", "/home/me/.squad")
			.find((argument) => argument.startsWith("ControlPath="))
			?.slice("ControlPath=".length);
		expect(path?.length).toBeLessThan(104);
	});

	it("tells two machines apart", () => {
		const path = (target: string) =>
			relayOverSsh(target, "/h").find((argument) => argument.startsWith("ControlPath="));
		expect(path("me@one")).not.toBe(path("me@two"));
		expect(path("me@one")).toBe(path("me@one"));
	});

	// The install, the update and the console are three connections to one machine, and on a machine
	// that has only a password they cost one prompt each unless they land on the same handshake.
	it("shares its connection with whatever else reaches that machine", () => {
		expect(argv.join(" ")).toContain(shared("me@vps", "/home/me/.squad").join(" "));
	});

	it("runs the plane's own relay, and nothing else", () => {
		expect(argv[0]).toBe("ssh");
		expect(argv.slice(-2)).toEqual(["me@vps", "squad relay"]);
	});
});
