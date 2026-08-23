import { randomBytes } from "node:crypto";
import type { DockerSandboxManager } from "@agent-dive/sandbox";
import { type ByteTransportFactory, createExecTransportFactory } from "./transport.ts";

/** Where the in-container pi server binds. Inside the sandbox only; never published to the host. */
export const PI_SOCKET_PATH = "/home/agent/.run/pi.sock";

export const RELAY_PATH = "/usr/local/lib/agent-dive/relay.mjs";

const TOKEN_PATH = "/home/agent/.run/pi.token";

export interface PiSessionChannelOptions {
	readonly manager: DockerSandboxManager;
	readonly agentId: string;
	/** Argv of the server to run in the sandbox. It must bind socketPath. */
	readonly command: readonly string[];
	readonly socketPath?: string;
	readonly connectTimeoutMs?: number;
	readonly onStderr?: (text: string) => void;
}

/**
 * Runs a socket server inside the sandbox and exposes it to the host as a byte transport.
 *
 * The intended occupant is pi's server, which listens on a unix socket in its own filesystem
 * namespace, so the control plane reaches it by exec'ing a relay rather than by binding a port.
 * The auth token never leaves the container's filesystem: both ends read it from the same path.
 *
 * The command is supplied rather than defaulted because pi 0.84.2, the current release, does not
 * expose a server entry point: `pi experimental server` exists only on pi's main branch. Hosting
 * one on the published @earendil-works/pi-server means implementing PiServerService, since pi
 * ships no production implementation of it.
 */
export class PiSessionChannel {
	readonly #manager: DockerSandboxManager;
	readonly #agentId: string;
	readonly #socketPath: string;
	readonly #command: readonly string[];
	readonly #connectTimeoutMs: number;
	readonly #onStderr: ((text: string) => void) | undefined;

	constructor(options: PiSessionChannelOptions) {
		this.#manager = options.manager;
		this.#agentId = options.agentId;
		this.#socketPath = options.socketPath ?? PI_SOCKET_PATH;
		this.#connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
		this.#onStderr = options.onStderr;
		this.#command = options.command;
	}

	/**
	 * Starts the server if it is not already listening, and returns whether it had to be started.
	 * Detached so the server outlives the exec that spawned it, which is what makes the session
	 * durable across control-plane reconnects.
	 */
	async ensureServer(): Promise<boolean> {
		const probe = await this.#manager.exec(this.#agentId, [
			"sh",
			"-c",
			`test -S ${this.#socketPath} && echo LISTENING || echo ABSENT`,
		]);
		if (probe.stdout.includes("LISTENING")) return false;

		const token = randomBytes(32).toString("hex");
		const quoted = this.#command.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
		await this.#manager.exec(this.#agentId, [
			"sh",
			"-c",
			`umask 077 && printf %s '${token}' > ${TOKEN_PATH} && nohup ${quoted} >/home/agent/.run/pi.log 2>&1 &`,
		]);
		return true;
	}

	/** A transport factory pi's client accepts directly, one fresh exec stream per connection. */
	transportFactory(): ByteTransportFactory {
		return createExecTransportFactory({
			attach: () =>
				this.#manager.attach(this.#agentId, [
					"node",
					RELAY_PATH,
					this.#socketPath,
					String(this.#connectTimeoutMs),
				]),
			...(this.#onStderr !== undefined ? { onStderr: this.#onStderr } : {}),
		});
	}

	/** Reads the token the in-container server was started with, for clients that must authenticate. */
	async authToken(): Promise<string> {
		const result = await this.#manager.exec(this.#agentId, ["cat", TOKEN_PATH]);
		if (result.exitCode !== 0) throw new Error(`No pi auth token in sandbox ${this.#agentId}`);
		return result.stdout.trim();
	}
}
