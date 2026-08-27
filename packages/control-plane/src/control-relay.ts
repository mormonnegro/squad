import type { Duplex } from "node:stream";
import { DockerEngine } from "@squad/sandbox";
import { controlSocketPath } from "./control-server.ts";
import { ExecStream } from "./exec-stream.ts";

/**
 * Marks the container running a control plane, and says which state directory it serves.
 *
 * Discovery has to be by label rather than by name because the deployment, the demo and a hand
 * written `docker run` all name the container differently, and the state directory is the one thing
 * the operator and the plane already agree on.
 */
export const CONTROL_PLANE_LABEL = "squad.state";

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
	readonly Labels?: Readonly<Record<string, string>>;
}

/**
 * The state directories of every plane running on this machine, read off their containers.
 *
 * So that `squad` typed with nothing after it can answer about the plane that is actually up. A
 * default state directory nobody is using is a worse answer than the truth, and the truth is
 * already labelled on the container.
 */
export async function runningPlanes(engine = new DockerEngine()): Promise<string[]> {
	if (!(await engine.isAvailable())) return [];
	const filters = encodeURIComponent(
		JSON.stringify({ label: [CONTROL_PLANE_LABEL], status: ["running"] }),
	);
	const found = await engine.request<readonly ContainerSummary[]>(
		"GET",
		`/containers/json?filters=${filters}`,
	);
	return found.body
		.map((container) => container.Labels?.[CONTROL_PLANE_LABEL])
		.filter((stateDir): stateDir is string => stateDir !== undefined && stateDir.length > 0);
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
	return new ExecStream(stream);
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
