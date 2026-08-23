import { Duplex } from "node:stream";
import { DockerEngine, FrameSplitter, type HijackedStream, STDERR } from "@agent-dive/sandbox";
import { controlSocketPath } from "./control-server.ts";

/**
 * Marks the container running a control plane, and says which state directory it serves.
 *
 * Discovery has to be by label rather than by name because the deployment, the demo and a hand
 * written `docker run` all name the container differently, and the state directory is the one thing
 * the operator and the plane already agree on.
 */
export const CONTROL_PLANE_LABEL = "agent-dive.state";

/**
 * Connects to the plane's socket from inside its own container and pipes it to this process.
 *
 * Written as source rather than shipped as a file because the image has no copy of it, and the only
 * thing guaranteed to be in there is the node that runs the plane.
 */
const RELAY = `const net = require("node:net");
const socket = net.connect(process.argv[1]);
socket.on("error", (error) => { process.stderr.write(error.message); process.exit(1); });
socket.on("close", () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);`;

interface ContainerSummary {
	readonly Id: string;
}

/**
 * Reaches a containerised control plane over a Docker exec stream.
 *
 * The socket in the state directory is the control surface, and on Linux opening it directly is
 * enough. Docker Desktop shares the directory through a VM, where the socket file appears but
 * connecting to it does not work — the same reason the pi transport is an exec stream. So when the
 * socket will not open, the operator is on the outside of that boundary, and the way in is to run
 * the connect on the other side of it.
 */
export async function relayToPlane(stateDir: string, engine = new DockerEngine()): Promise<Duplex> {
	const containerId = await findPlaneContainer(stateDir, engine);
	const exec = await engine.request<{ Id: string }>("POST", `/containers/${containerId}/exec`, {
		AttachStdin: true,
		AttachStdout: true,
		AttachStderr: true,
		Tty: false,
		Cmd: ["node", "-e", RELAY, controlSocketPath(stateDir)],
	});
	const stream = await engine.hijack("POST", `/exec/${exec.body.Id}/start`, {
		Detach: false,
		Tty: false,
	});
	return new RelayStream(stream);
}

async function findPlaneContainer(stateDir: string, engine: DockerEngine): Promise<string> {
	const missing = `No control plane is listening at ${controlSocketPath(stateDir)}`;
	if (!(await engine.isAvailable())) throw new Error(missing);

	const filters = encodeURIComponent(
		JSON.stringify({ label: [`${CONTROL_PLANE_LABEL}=${stateDir}`], status: ["running"] }),
	);
	const found = await engine.request<readonly ContainerSummary[]>(
		"GET",
		`/containers/json?filters=${filters}`,
	);

	const container = found.body[0];
	if (container === undefined) {
		throw new Error(`${missing}, and no running container is labelled ${label(stateDir)}`);
	}
	return container.Id;
}

function label(stateDir: string): string {
	return `${CONTROL_PLANE_LABEL}=${stateDir}`;
}

/** The exec stream, with the daemon's framing removed in the reading direction only. */
class RelayStream extends Duplex {
	readonly #stream: HijackedStream;
	readonly #splitter = new FrameSplitter();

	#done = false;

	constructor(stream: HijackedStream) {
		super();
		this.#stream = stream;

		stream.socket.on("data", (chunk: Buffer) => this.#consume(chunk));
		stream.socket.once("error", (error: Error) => this.#fail(error));
		stream.socket.once("close", () => this.#finish());
		if (stream.head.byteLength > 0) this.#consume(stream.head);
	}

	override _read(): void {}

	/** Ends the relay's stdin, so it exits and the daemon lets go of the connection. */
	override _final(callback: (error?: Error | null) => void): void {
		this.#stream.socket.end(() => callback());
	}

	override _write(
		chunk: Buffer,
		_encoding: string,
		callback: (error?: Error | null) => void,
	): void {
		// Only the reply direction is multiplexed; the relay reads its stdin unframed.
		this.#stream.socket.write(chunk, callback);
	}

	override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this.#stream.socket.destroy();
		callback(error);
	}

	#consume(chunk: Buffer): void {
		if (this.#done) return;
		for (const frame of this.#splitter.push(chunk)) {
			if (frame.stream === STDERR) this.#fail(new Error(frame.payload.toString("utf8")));
			else if (frame.payload.byteLength > 0) this.push(frame.payload);
		}
	}

	#fail(error: Error): void {
		if (this.#done) return;
		this.#done = true;
		this.destroy(error);
	}

	/**
	 * The relay exits when its socket closes, and the exec stream closes behind it. Whoever hung up
	 * first, an ended conversation is not a failure — the caller already has its answer.
	 */
	#finish(): void {
		if (this.#done) return;
		this.#done = true;
		this.push(null);
	}
}
