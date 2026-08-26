import net from "node:net";
import type { Duplex } from "node:stream";
import type { AgentSummary, PlaneEvent } from "./control-plane.ts";
import { relayToPlane } from "./control-relay.ts";
import { type ControlResponse, controlSocketPath } from "./control-server.ts";
import type { Catalog, ModelSpec, ModelStanding, ProviderStanding } from "./models.ts";
import type { Utterance } from "./transcript.ts";

export class ControlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControlError";
	}
}

/**
 * Everything read off a stream up to and including its first newline, leaving it paused.
 *
 * Paused, and not one byte further: what follows the newline is somebody else's, and a reader still
 * flowing would deliver it to a listener that has already gone.
 */
function firstLine(stream: Duplex): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const done = (): void => {
			stream.off("data", onData);
			stream.off("error", onError);
			stream.off("end", onEnd);
		};
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.indexOf(0x0a) === -1) return;
			done();
			stream.pause();
			resolve(buffer);
		};
		const onError = (error: Error): void => {
			done();
			reject(error);
		};
		const onEnd = (): void => {
			done();
			reject(new Error("the plane closed the connection without answering"));
		};
		stream.on("data", onData);
		stream.once("error", onError);
		stream.once("end", onEnd);
	});
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

	/** Every conversation the plane has kept, so a console that opens is not a conversation that starts. */
	async transcripts(): Promise<Record<string, readonly Utterance[]>> {
		const response = await this.#once({ op: "transcripts" });
		if ("transcripts" in response) return response.transcripts;
		throw new ControlError("unexpected answer to transcripts");
	}

	/** Makes an agent that was not in the config, and waits for its sandbox to be up. */
	async create(agentId: string): Promise<AgentSummary> {
		const response = await this.#once({ op: "create", agentId });
		if ("agent" in response) return response.agent;
		throw new ControlError("unexpected answer to create");
	}

	/** Every provider a key could be given to, and whether this plane already holds one. */
	async providers(): Promise<readonly ProviderStanding[]> {
		const response = await this.#once({ op: "providers" });
		if ("providers" in response) return response.providers;
		throw new ControlError("unexpected answer to providers");
	}

	/** Gives the plane a provider's key, or takes back the one it was keeping when `value` is empty. */
	async setKey(keyEnv: string, value: string): Promise<void> {
		await this.#once({ op: "key", keyEnv, value });
	}

	async models(): Promise<readonly ModelStanding[]> {
		const response = await this.#once({ op: "models" });
		if ("models" in response) return response.models;
		throw new ControlError("unexpected answer to models");
	}

	/** Gives the plane somewhere new to think, from the next turn, with nothing restarted. */
	async addModel(spec: ModelSpec): Promise<void> {
		await this.#once({ op: "add-model", spec });
	}

	async dropModel(modelId: string): Promise<void> {
		await this.#once({ op: "drop-model", modelId });
	}

	/** What the providers this plane can pay say they answer to, minus what is configured already. */
	async offers(): Promise<Catalog> {
		const response = await this.#once({ op: "offers" });
		if ("catalog" in response) return response.catalog;
		throw new ControlError("unexpected answer to offers");
	}

	/** Takes one turn. `onText` is called with the answer as it is written, before it is returned. */
	async wake(agentId: string, body: string, onText?: (text: string) => void): Promise<string> {
		const response = await this.#once({ op: "wake", agentId, body }, onText);
		if ("text" in response) return response.text;
		throw new ControlError("unexpected answer to wake");
	}

	/** Runs a slash command against an agent, and answers with what it said about it. */
	async command(agentId: string, line: string): Promise<string> {
		const response = await this.#once({ op: "command", agentId, line });
		if ("text" in response) return response.text;
		throw new ControlError("unexpected answer to command");
	}

	/**
	 * Runs a command inside the agent's sandbox, and answers with what it printed and where it left
	 * off — the directory is the prompt's, so it is drawn before the next command is typed.
	 */
	async shell(agentId: string, line: string): Promise<{ text: string; cwd: string }> {
		const response = await this.#once({ op: "shell", agentId, line });
		if ("text" in response && "cwd" in response) return { text: response.text, cwd: response.cwd };
		throw new ControlError("unexpected answer to shell");
	}

	/**
	 * What a half-typed path inside the agent's sandbox could still become.
	 *
	 * Its own request rather than a `shell` that lists a directory, because a shell writes both
	 * halves of itself into the conversation: a tab pressed four times looking for a directory would
	 * leave four `ls` and four listings in the record of what the operator said to this agent.
	 */
	async complete(agentId: string, word: string): Promise<readonly string[]> {
		const response = await this.#once({ op: "complete", agentId, word });
		if ("options" in response) return response.options;
		throw new ControlError("unexpected answer to complete");
	}

	/** Stops the turn an agent is taking. Answers whether there was one to stop. */
	async stop(agentId: string): Promise<boolean> {
		const response = await this.#once({ op: "stop", agentId });
		if ("text" in response) return response.text.length > 0;
		throw new ControlError("unexpected answer to stop");
	}

	async remove(agentId: string, purge: boolean): Promise<void> {
		await this.#once({ op: "remove", agentId, purge });
	}

	/**
	 * A byte channel to a port inside an agent's sandbox, on a connection of its own.
	 *
	 * Its own because the rest of this class multiplexes lines of JSON over one socket, and what
	 * comes down a forwarded port is neither lines nor JSON. So the request is written, the one
	 * answer is read, and everything after it on that connection is the stream — which also means a
	 * browser opening six connections at once costs six sockets and blocks none of the others.
	 *
	 * It comes back paused, holding anything that arrived behind the answer. Piping it is what
	 * resumes it, and piping is what a caller does with one of these.
	 */
	async forward(agentId: string, port: number): Promise<Duplex> {
		const socket = await this.#open();
		let answered: Buffer;
		try {
			socket.write(`${JSON.stringify({ id: "forward", op: "forward", agentId, port })}\n`);
			answered = await firstLine(socket);
		} catch (error) {
			socket.destroy();
			throw new ControlError((error as Error).message);
		}

		const newline = answered.indexOf(0x0a);
		const response = JSON.parse(answered.subarray(0, newline).toString("utf8")) as ControlResponse;
		if ("ok" in response && !response.ok) {
			socket.destroy();
			throw new ControlError(response.error);
		}
		// Anything that came in behind the answer is already the stream, and is put back so that the
		// first thing read off this is the first byte the port sent rather than the second.
		const rest = answered.subarray(newline + 1);
		if (rest.byteLength > 0) socket.unshift(rest);
		return socket;
	}

	/** Streams until the connection is closed. */
	logs(onEvent: (event: PlaneEvent) => void): void {
		const id = String(this.#nextId++);
		this.#handlers.set(id, (response) => {
			if ("event" in response) onEvent(response.event);
		});
		this.#send({ id, op: "logs" });
	}

	async #once(
		request: Record<string, unknown>,
		onChunk?: (text: string) => void,
	): Promise<ControlResponse> {
		const id = String(this.#nextId++);
		const answer = new Promise<ControlResponse>((resolve, reject) => {
			this.#handlers.set(id, (response) => {
				// A chunk is the answer arriving in pieces, so the request is not over until the rest of
				// it: the handler stays, and the promise waits for the response that settles it.
				if ("chunk" in response) {
					onChunk?.(response.chunk);
					return;
				}
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
