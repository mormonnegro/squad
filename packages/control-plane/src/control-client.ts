import net from "node:net";
import type { AgentSummary, PlaneEvent } from "./control-plane.ts";
import { type ControlResponse, controlSocketPath } from "./control-server.ts";

export class ControlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControlError";
	}
}

/**
 * Talks to a running control plane over its unix socket.
 *
 * Requests are numbered because `logs` streams: responses for it keep arriving while another
 * request is answered, and the id is what tells them apart.
 */
export class ControlClient {
	readonly #socketPath: string;
	#socket: net.Socket | undefined;
	#nextId = 1;
	readonly #handlers = new Map<string, (response: ControlResponse) => void>();

	constructor(stateDir: string) {
		this.#socketPath = controlSocketPath(stateDir);
	}

	async connect(): Promise<void> {
		const socket = net.createConnection(this.#socketPath);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", (error: NodeJS.ErrnoException) => {
				reject(
					error.code === "ENOENT" || error.code === "ECONNREFUSED"
						? new ControlError(`No control plane is listening at ${this.#socketPath}`)
						: error,
				);
			});
		});

		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.trim().length === 0) continue;
				const response = JSON.parse(line) as ControlResponse;
				this.#handlers.get(response.id)?.(response);
			}
		});
		this.#socket = socket;
	}

	close(): void {
		this.#socket?.end();
		this.#socket = undefined;
	}

	async agents(): Promise<readonly AgentSummary[]> {
		const response = await this.#once({ op: "agents" });
		if ("agents" in response) return response.agents;
		throw new ControlError("unexpected answer to agents");
	}

	async wake(agentId: string, body: string): Promise<string> {
		const response = await this.#once({ op: "wake", agentId, body });
		if ("text" in response) return response.text;
		throw new ControlError("unexpected answer to wake");
	}

	/** Streams until the connection is closed. */
	logs(onEvent: (event: PlaneEvent) => void): void {
		const id = String(this.#nextId++);
		this.#handlers.set(id, (response) => {
			if ("event" in response) onEvent(response.event);
		});
		this.#send({ id, op: "logs" });
	}

	async #once(request: Record<string, unknown>): Promise<ControlResponse> {
		const id = String(this.#nextId++);
		const answer = new Promise<ControlResponse>((resolve, reject) => {
			this.#handlers.set(id, (response) => {
				this.#handlers.delete(id);
				if ("ok" in response && !response.ok) reject(new ControlError(response.error));
				else resolve(response);
			});
		});
		this.#send({ ...request, id });
		return answer;
	}

	#send(request: Record<string, unknown>): void {
		if (!this.#socket) throw new ControlError("not connected");
		this.#socket.write(`${JSON.stringify(request)}\n`);
	}
}
