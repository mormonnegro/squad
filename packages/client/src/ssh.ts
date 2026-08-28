import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Duplex, type Readable } from "node:stream";
import { ControlError, type Dial, RELAY_HELLO } from "@squad/control-plane";

const MARK = Buffer.from(`${RELAY_HELLO}\n`);

/** Enough of a chatty login shell to find the mark behind, and not enough to be a leak. */
const PATIENCE = 64 * 1024;

/**
 * The options that put every connection to one machine on a single handshake.
 *
 * Multiplexing is not an optimisation here, it is what makes the console usable: every forwarded
 * port opens a connection of its own, and six of them behind one page load would otherwise be six
 * SSH handshakes and, on a key with a passphrase, six prompts fighting the screen for the terminal.
 * The install and the update ride it too, so the console they end on costs nothing to open.
 */
export function shared(target: string, home: string): string[] {
	return [
		"-o",
		"ControlMaster=auto",
		// Hashed here rather than left to ssh's own %C, which expands to forty hex characters and
		// pushes the whole path past the hundred-odd bytes a unix socket name is allowed to be. Twelve
		// is plenty to tell two machines apart, and the length is then something this can promise.
		"-o",
		`ControlPath=${join(home, `ssh-${createHash("sha256").update(target).digest("hex").slice(0, 12)}`)}`,
		// Long enough that a handful of commands typed one after another are one connection. On a
		// machine that answers to a password this is the difference between being asked once and being
		// asked per command, so it is measured in how long an operator stays at a keyboard.
		"-o",
		"ControlPersist=600",
		// What keeps that from becoming a hang. A master held open across a closed lid or a change of
		// network is a socket that still looks alive, and the next command would wait on it; this way
		// it is noticed in under a minute and the connection is made again.
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
	];
}

/**
 * Opens the connection everything else will ride, at a moment when it can be answered.
 *
 * A password is a fine way to reach a machine; it is only ever asked at the wrong time. ssh reads
 * one from /dev/tty, and the console is a full-screen UI holding that same terminal, so a prompt
 * that arrives once it is drawn lands under it. This runs first and does nothing — the point is the
 * handshake, on a bare terminal, with the operator looking at it. Every connection after this one
 * finds the master and authenticates not at all.
 */
export async function warm(target: string, home: string): Promise<void> {
	const child = spawn("ssh", [...shared(target, home), target, "true"], { stdio: "inherit" });
	const code = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status) => resolve(status ?? 1));
	});
	if (code !== 0) {
		throw new ControlError(
			`Could not open an SSH connection to ${target}. What ssh said is above.`,
		);
	}
}

/**
 * The command that opens a plane's control socket on a machine this computer has SSH to.
 *
 * `-T` because a pty would rewrite the bytes of the protocol on the way past: newlines are the
 * frame boundary and a terminal line discipline turns them into something else.
 *
 * `BatchMode` because this one may not ask a human anything: it is opened behind a drawn console,
 * and once per forwarded port while the operator is looking at a browser. It rides the master that
 * `warm` opened — where there is one, no question arises, and where there is not, an error the
 * console can print beats a prompt nobody can see.
 */
export function relayOverSsh(target: string, home: string): string[] {
	return ["ssh", "-o", "BatchMode=yes", ...shared(target, home), "-T", target, "squad relay"];
}

/**
 * The way to a plane on a machine this computer has SSH to.
 *
 * `squad relay` at the far end is the plane's own control socket on a pair of pipes, so what
 * travels this is byte for byte what travels the socket when the plane is here. Nothing is opened
 * on the server and nothing new is logged into: the authentication is the SSH connection the
 * operator already has, and the authorisation is that reaching the socket means holding a file on
 * that machine.
 */
export function dialOverSsh(target: string, home: string): Dial {
	return dialCommand(relayOverSsh(target, home), target);
}

/**
 * The way to a plane reached by running something that puts its control socket on a pair of pipes.
 *
 * SSH is the one that matters, and it is not special: what makes this work is that the far end
 * speaks the protocol on stdout and nothing else, so any command that arranges for that is a road
 * to a plane. `at` names the far end, and is only ever printed.
 */
export function dialCommand(argv: readonly string[], at: string): Dial {
	const [program, ...rest] = argv as string[];
	return async () => {
		const child = spawn(program as string, rest, { stdio: ["pipe", "pipe", "pipe"] });

		let complaint = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			if (complaint.length < PATIENCE) complaint += text;
		});

		try {
			const head = await greeting(child);
			return new RelayStream(child, head, () => complaint);
		} catch (error) {
			child.kill();
			throw trouble(at, complaint, error as Error);
		}
	};
}

/**
 * Reads past whatever else is on that stdout, up to the mark, and answers with what came after it.
 *
 * There is something else on it more often than not. A shell that sources an rc file on
 * non-interactive sessions prints from it, and the far end has no way to know it happened — so the
 * console is the half that has to skip it, and the mark is what it skips to.
 */
function greeting(child: ChildProcessWithoutNullStreams): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const stdout: Readable = child.stdout;
		let buffer = Buffer.alloc(0);

		const done = (): void => {
			stdout.off("data", onData);
			stdout.off("end", onEnd);
			child.off("error", onError);
			child.off("close", onEnd);
		};
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			const mark = buffer.indexOf(MARK);
			if (mark === -1) {
				if (buffer.byteLength <= PATIENCE) return;
				done();
				stdout.pause();
				reject(new Error("it answered, but never said it was the relay"));
				return;
			}
			done();
			// Paused and not one byte further: what follows is the plane's, and a stream still flowing
			// would deliver it to a listener that does not exist yet.
			stdout.pause();
			resolve(buffer.subarray(mark + MARK.byteLength));
		};
		const onEnd = (): void => {
			done();
			reject(new Error("the connection closed before the relay answered"));
		};
		const onError = (error: Error): void => {
			done();
			reject(error);
		};

		stdout.on("data", onData);
		stdout.once("end", onEnd);
		child.once("error", onError);
		child.once("close", onEnd);
	});
}

/**
 * What went wrong, said as the thing to do about it.
 *
 * ssh's own complaint is the useful one nearly every time — a key that is not on the machine, a
 * host that has moved — so it is passed through rather than summarised. The one it cannot phrase is
 * the one where the connection worked and there is no plane at the other end, which reads as a
 * shell not finding a command and means the machine still needs the server half.
 */
function trouble(target: string, complaint: string, error: Error): ControlError {
	const said = complaint.trim();
	if (/not found|No such file/.test(said)) {
		return new ControlError(
			`${target} answered, but has no squad on it.\n\n` +
				"  squad connect             put a plane there, or point this somewhere else\n",
		);
	}
	// This connection is not allowed to ask, so a machine that wants to be asked something reads as a
	// refusal here. Both ways out are a connection opened where there is somebody to answer it.
	if (/Permission denied|Host key verification/.test(said)) {
		return new ControlError(
			`${target} wants something typed, and this connection cannot ask for it.\n${said}\n\n` +
				"  squad                     opens the connection first, where you can answer it\n" +
				"  squad connect             puts your key up, so nothing asks again\n",
		);
	}
	if (said.length > 0) return new ControlError(said);
	if (error.message.length > 0) return new ControlError(`${target}: ${error.message}`);
	return new ControlError(`Could not reach ${target}.`);
}

/**
 * The relaying process as an ordinary duplex, so everything above it is unaware of the trip.
 *
 * stderr is the failure channel and stays out of the stream: ssh writes its own troubles there, and
 * so does the relay when it cannot reach the plane. It is kept rather than printed, because the
 * console owns the screen by then and a line from ssh in the middle of it is damage — it comes back
 * as the error on whichever request was in flight.
 */
class RelayStream extends Duplex {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #complaint: () => string;

	#done = false;

	constructor(child: ChildProcessWithoutNullStreams, head: Buffer, complaint: () => string) {
		super();
		this.#child = child;
		this.#complaint = complaint;

		child.stdout.on("data", (chunk: Buffer) => {
			if (!this.#done) this.push(chunk);
		});
		child.stdout.once("end", () => this.#finish());
		child.once("error", (error: Error) => this.#fail(error));
		child.once("close", (code) => this.#closed(code));

		if (head.byteLength > 0) this.push(head);
		// Explicitly, because the handshake paused it and adding a listener does not undo that.
		child.stdout.resume();
	}

	override _read(): void {}

	/** Ends the relay's stdin, so it lets go of the socket and the connection closes behind it. */
	override _final(callback: (error?: Error | null) => void): void {
		this.#child.stdin.end(() => callback());
	}

	override _write(
		chunk: Buffer,
		_encoding: string,
		callback: (error?: Error | null) => void,
	): void {
		this.#child.stdin.write(chunk, callback);
	}

	override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this.#child.kill();
		callback(error);
	}

	#closed(code: number | null): void {
		if (code === 0 || code === null) this.#finish();
		else this.#fail(new ControlError(this.#complaint().trim() || `ssh exited ${code}`));
	}

	#fail(error: Error): void {
		if (this.#done) return;
		this.#done = true;
		this.destroy(error);
	}

	/** Whoever hung up first, an ended conversation is not a failure. */
	#finish(): void {
		if (this.#done) return;
		this.#done = true;
		this.push(null);
	}
}
