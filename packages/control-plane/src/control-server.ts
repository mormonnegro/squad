import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import type { Channel, Reply } from "@agent-dive/channels";
import type { AgentSummary, ControlPlane, PlaneEvent } from "./control-plane.ts";
import type { Utterance } from "./transcript.ts";

export const CONTROL_SOCKET_FILE = "control.sock";

export function controlSocketPath(stateDir: string): string {
	return join(stateDir, CONTROL_SOCKET_FILE);
}

export type ControlRequest =
	| { readonly id: string; readonly op: "agents" }
	| { readonly id: string; readonly op: "wake"; readonly agentId: string; readonly body: string }
	| {
			readonly id: string;
			readonly op: "remove";
			readonly agentId: string;
			readonly purge: boolean;
	  }
	| { readonly id: string; readonly op: "create"; readonly agentId: string }
	| { readonly id: string; readonly op: "stop"; readonly agentId: string }
	/** A line the operator typed at an agent that is about it rather than to it. */
	| { readonly id: string; readonly op: "command"; readonly agentId: string; readonly line: string }
	/**
	 * A command to run inside an agent's sandbox. It arrives here and nowhere else: this socket is
	 * the only surface carrying operator trust, and a webhook that reached it would be a stranger
	 * with a URL holding a shell inside the box.
	 */
	| { readonly id: string; readonly op: "shell"; readonly agentId: string; readonly line: string }
	| { readonly id: string; readonly op: "logs" }
	| { readonly id: string; readonly op: "transcripts" };

export type ControlResponse =
	| { readonly id: string; readonly ok: true; readonly agents: readonly AgentSummary[] }
	| { readonly id: string; readonly ok: true; readonly agent: AgentSummary }
	| {
			readonly id: string;
			readonly ok: true;
			readonly transcripts: Record<string, readonly Utterance[]>;
	  }
	| { readonly id: string; readonly ok: true; readonly text: string }
	/** What a `!` printed, and the directory it left the next one standing in. */
	| { readonly id: string; readonly ok: true; readonly text: string; readonly cwd: string }
	| { readonly id: string; readonly ok: false; readonly error: string }
	| { readonly id: string; readonly event: PlaneEvent }
	/** Part of an answer to a wake still being written. The request is unfinished until `ok`. */
	| { readonly id: string; readonly chunk: string };

/** Where a reply to `wake` goes. The suffix is the request it answers. */
export const CLI_CHANNEL = "cli";

/**
 * Routes an answer back to the operator who asked for it.
 *
 * Each wake gets its own channel suffix, so two operators waking the same agent do not read each
 * other's replies, and a turn woken by something else never lands in a terminal.
 */
class CliChannel implements Channel {
	readonly name = CLI_CHANNEL;
	readonly #waiting = new Map<string, (text: string) => void>();

	expect(requestId: string, resolve: (text: string) => void): () => void {
		this.#waiting.set(requestId, resolve);
		return () => this.#waiting.delete(requestId);
	}

	async send(reply: Reply): Promise<void> {
		this.#waiting.get(reply.channel.slice(`${CLI_CHANNEL}:`.length))?.(reply.body);
	}
}

export interface ControlServerOptions {
	readonly plane: ControlPlane;
	readonly socketPath?: string;
	/** How long `wake` waits for the agent before answering without its text. */
	readonly waitMs?: number;
}

const DEFAULT_WAIT_MS = 15 * 60_000;

/**
 * A control surface for the operator, on a unix socket beside the rest of the state.
 *
 * A socket rather than a port because it needs no authentication of its own: reaching it already
 * means holding a file the operator owns. That also decides where it lives — the state directory
 * is bind-mounted at the same path on the host, so a CLI outside the container can open it.
 */
export class ControlServer {
	readonly socketPath: string;

	readonly #plane: ControlPlane;
	readonly #waitMs: number;
	readonly #cli = new CliChannel();
	readonly #server: net.Server;
	readonly #sockets = new Set<net.Socket>();

	constructor(options: ControlServerOptions) {
		this.#plane = options.plane;
		this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
		this.socketPath = options.socketPath ?? controlSocketPath(options.plane.stateDir);
		this.#plane.router.register(this.#cli);
		this.#server = net.createServer((socket) => this.#accept(socket));
	}

	async listen(): Promise<void> {
		// A socket left by a killed process would refuse the bind; nothing else may hold this path.
		await unlink(this.socketPath).catch(() => {});
		await new Promise<void>((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(this.socketPath, () => {
				this.#server.removeListener("error", reject);
				resolve();
			});
		});
		// Only the owner. The socket is the authority, so its permissions are the access control.
		//
		// A directory shared into a VM, which is how Docker Desktop does bind mounts, refuses chmod
		// on a socket outright. There the mode is the mount's to decide and not this process's, and
		// failing to start over it would be refusing to run on every machine that is not Linux.
		await chmod(this.socketPath, 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EINVAL" && error.code !== "ENOTSUP") throw error;
		});
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
		await unlink(this.socketPath).catch(() => {});
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => this.#sockets.delete(socket));

		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.trim().length > 0) void this.#dispatch(socket, line);
			}
		});
	}

	async #dispatch(socket: net.Socket, line: string): Promise<void> {
		let request: ControlRequest;
		try {
			request = JSON.parse(line) as ControlRequest;
		} catch {
			this.#write(socket, { id: "?", ok: false, error: "malformed request" });
			return;
		}

		try {
			if (request.op === "agents") {
				this.#write(socket, { id: request.id, ok: true, agents: await this.#plane.agents() });
			} else if (request.op === "transcripts") {
				this.#write(socket, {
					id: request.id,
					ok: true,
					transcripts: await this.#plane.transcripts(),
				});
			} else if (request.op === "logs") {
				// Everything, including the answer as it is being written. A subscriber reading a log
				// wants the finished turn and drops the rest; a subscriber showing a conversation cannot
				// wait for it, and used to see nothing at all from a turn it had not asked for itself.
				const stop = this.#plane.observe((event) => this.#write(socket, { id: request.id, event }));
				socket.once("close", stop);
			} else if (request.op === "wake") {
				this.#write(socket, {
					id: request.id,
					ok: true,
					text: await this.#wake(request.agentId, request.body, (chunk) =>
						this.#write(socket, { id: request.id, chunk }),
					),
				});
			} else if (request.op === "stop") {
				// Answered with what there was to stop rather than with nothing, so that a key pressed at
				// an agent that had already finished can be told apart from one that did something.
				this.#write(socket, {
					id: request.id,
					ok: true,
					text: this.#plane.stopTurn(request.agentId) ? "stopped" : "",
				});
			} else if (request.op === "command") {
				// The answer is written into the conversation as well as returned, so a console shows it
				// without knowing what any command means, and a second console shows it too.
				this.#write(socket, {
					id: request.id,
					ok: true,
					text: await this.#plane.command(request.agentId, request.line),
				});
			} else if (request.op === "shell") {
				const ran = await this.#plane.shell(request.agentId, request.line);
				this.#write(socket, { id: request.id, ok: true, text: ran.text, cwd: ran.cwd });
			} else if (request.op === "create") {
				this.#write(socket, {
					id: request.id,
					ok: true,
					agent: await this.#plane.create(request.agentId),
				});
			} else if (request.op === "remove") {
				await this.#plane.remove(request.agentId, { purge: request.purge });
				this.#write(socket, { id: request.id, ok: true, text: "" });
			} else {
				this.#write(socket, { id: "?", ok: false, error: "unknown operation" });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#write(socket, { id: request.id ?? "?", ok: false, error: message });
		}
	}

	/**
	 * Wakes an agent on the operator's behalf.
	 *
	 * This is the only path into the system that carries operator trust, and it is deliberately the
	 * one that requires already holding the socket. The same words arriving by webhook are data.
	 */
	async #wake(agentId: string, body: string, onChunk: (text: string) => void): Promise<string> {
		const requestId = randomUUID();
		let answered: (text: string) => void = () => {};
		let failed: (error: Error) => void = () => {};
		const reply = new Promise<string>((resolve, reject) => {
			answered = resolve;
			failed = reject;
		});
		const stop = this.#cli.expect(requestId, answered);

		// A turn that throws is left queued for another attempt, which is right for durability and
		// silent for whoever is standing at a terminal: they would wait out the timeout and be told
		// the agent said nothing. Turns are serialised per agent and this one's event is folded into
		// whatever batch is running, so a failure reported while this call waits is this call's.
		// The same reasoning carries the answer as it is written: turns are serialised per agent and
		// this call's event is folded into whichever batch is running, so what that agent is saying
		// while this call waits is what it is saying to this call.
		const unobserve = this.#plane.observe((event) => {
			if (event.kind === "error" && event.context === agentId) failed(new Error(event.message));
			if (event.kind === "say" && event.agentId === agentId) onChunk(event.text);
		});

		try {
			await this.#plane.bus.publish({
				agentId,
				source: "channel",
				trust: "operator",
				channel: `${CLI_CHANNEL}:${requestId}`,
				body,
			});
			const timeout = new Promise<string>((resolve) =>
				setTimeout(() => resolve(""), this.#waitMs).unref?.(),
			);
			return await Promise.race([reply, timeout]);
		} finally {
			stop();
			unobserve();
		}
	}

	#write(socket: net.Socket, response: ControlResponse): void {
		if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
	}
}
