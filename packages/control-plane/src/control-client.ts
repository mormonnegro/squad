import net from "node:net";
import type { Duplex } from "node:stream";
import type { AgentSummary, PlaneEvent } from "./control-plane.ts";
import { relayToPlane } from "./control-relay.ts";
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
	readonly #stateDir: string;
	readonly #socketPath: string;
	#socket: Duplex | undefined;
	#nextId = 1;
	readonly #handlers = new Map<string, (response: ControlResponse) => void>();

	constructor(stateDir: string) {
		this.#stateDir = stateDir;
		this.#socketPath = controlSocketPath(stateDir);
	}

	async connect(): Promise<void> {
		const socket = await this.#open();

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
		// A connection that breaks mid-request is an answer that will never come, so it is reported
		// as that request failing rather than left to take the process down as an unhandled error.
		socket.on("error", (error: Error) => {
			for (const [id, handler] of this.#handlers) {
				this.#handlers.delete(id);
				handler({ id, ok: false, error: error.message });
			}
		});
		this.#socket = socket;
	}

	close(): void {
		this.#socket?.end();
		this.#socket = undefined;
	}

	/**
	 * Opens the socket, and failing that reaches the same socket from inside the plane's container.
	 *
	 * Both are the one control surface. Which one works is a property of the machine, not of the
	 * deployment: on Linux the bind-mounted socket opens, and on Docker Desktop it is visible in the
	 * directory but unreachable across the VM boundary.
	 */
	async #open(): Promise<Duplex> {
		try {
			const socket = net.createConnection(this.#socketPath);
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			return socket;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
			return relayToPlane(this.#stateDir).catch((relayError: Error) => {
				throw new ControlError(relayError.message);
			});
		}
	}

	async agents(): Promise<readonly AgentSummary[]> {
		const response = await this.#once({ op: "agents" });
		if ("agents" in response) return response.agents;
		throw new ControlError("unexpected answer to agents");
	}

	/** Makes an agent that was not in the config, and waits for its sandbox to be up. */
	async create(agentId: string): Promise<AgentSummary> {
		const response = await this.#once({ op: "create", agentId });
		if ("agent" in response) return response.agent;
		throw new ControlError("unexpected answer to create");
	}

	async wake(agentId: string, body: string): Promise<string> {
		const response = await this.#once({ op: "wake", agentId, body });
		if ("text" in response) return response.text;
		throw new ControlError("unexpected answer to wake");
	}

	async remove(agentId: string, purge: boolean): Promise<void> {
		await this.#once({ op: "remove", agentId, purge });
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
