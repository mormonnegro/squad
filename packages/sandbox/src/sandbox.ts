import { DockerEngine, DockerError, type HijackedStream } from "./engine.ts";
import { demultiplex, FrameSplitter, STDERR } from "./frames.ts";
import {
	buildContainerConfig,
	buildNetworkConfig,
	buildVolumeConfig,
	containerName,
	type SandboxSpec,
} from "./spec.ts";

export interface SandboxStatus {
	readonly agentId: string;
	readonly containerId: string;
	readonly running: boolean;
	readonly startedAt: string | undefined;
	/**
	 * The proxy the container was created with, read back off it.
	 *
	 * A sandbox outlives the process that made it, and its egress credential is in this URL, so the
	 * container is the record of what that credential is. Undefined means the container predates the
	 * environment being set, and there is nothing to recover.
	 */
	readonly proxyUrl: string | undefined;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export class SandboxTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxTimeoutError";
	}
}

interface ContainerInspect {
	Id: string;
	State: { Running: boolean; StartedAt: string };
	Config?: { Env?: readonly string[] };
}

export function volumeName(agentId: string): string {
	return `agent-dive-${agentId}-self`;
}

/** Docker reports the environment as `NAME=value` strings, where the value may itself hold `=`. */
function readEnv(env: readonly string[] | undefined, name: string): string | undefined {
	const found = env?.find((entry) => entry.startsWith(`${name}=`));
	return found?.slice(name.length + 1);
}

/**
 * Manages one long-lived container per agent, backed by a named volume that holds the agent
 * repository. Containers are disposable; the volume is the durable state.
 */
export class DockerSandboxManager {
	private readonly engine: DockerEngine;
	private readonly networkName: string;

	constructor(engine: DockerEngine = new DockerEngine(), networkName = "agent-dive-egress") {
		this.engine = engine;
		this.networkName = networkName;
	}

	async isAvailable(): Promise<boolean> {
		return this.engine.isAvailable();
	}

	/** Creates the internal network if absent. Internal means no route off-host but the proxy. */
	async ensureNetwork(): Promise<void> {
		try {
			await this.engine.request("POST", "/networks/create", buildNetworkConfig(this.networkName));
		} catch (error) {
			// 409 means another caller created it first, which is the desired end state anyway.
			if (error instanceof DockerError && error.status === 409) return;
			throw error;
		}
	}

	async ensureVolume(agentId: string): Promise<string> {
		const name = volumeName(agentId);
		await this.engine.request("POST", "/volumes/create", buildVolumeConfig(name, agentId));
		return name;
	}

	async create(spec: Omit<SandboxSpec, "volumeName" | "networkName">): Promise<string> {
		await this.ensureNetwork();
		const volume = await this.ensureVolume(spec.agentId);
		const config = buildContainerConfig({
			...spec,
			volumeName: volume,
			networkName: this.networkName,
		});

		const response = await this.engine.request<{ Id: string }>(
			"POST",
			`/containers/create?name=${encodeURIComponent(containerName(spec.agentId))}`,
			config,
		);
		return response.body.Id;
	}

	async start(agentId: string): Promise<void> {
		await this.engine.request("POST", `/containers/${containerName(agentId)}/start`);
	}

	async stop(agentId: string, timeoutSeconds = 10): Promise<void> {
		try {
			await this.engine.request(
				"POST",
				`/containers/${containerName(agentId)}/stop?t=${timeoutSeconds}`,
			);
		} catch (error) {
			// 304 is "already stopped", 404 is "already gone".
			if (error instanceof DockerError && (error.status === 304 || error.status === 404)) return;
			throw error;
		}
	}

	async status(agentId: string): Promise<SandboxStatus | undefined> {
		try {
			const response = await this.engine.request<ContainerInspect>(
				"GET",
				`/containers/${containerName(agentId)}/json`,
			);
			return {
				agentId,
				containerId: response.body.Id,
				running: response.body.State.Running,
				startedAt: response.body.State.Running ? response.body.State.StartedAt : undefined,
				proxyUrl: readEnv(response.body.Config?.Env, "HTTPS_PROXY"),
			};
		} catch (error) {
			if (error instanceof DockerError && error.status === 404) return undefined;
			throw error;
		}
	}

	async exec(agentId: string, cmd: readonly string[]): Promise<ExecResult> {
		const created = await this.engine.request<{ Id: string }>(
			"POST",
			`/containers/${containerName(agentId)}/exec`,
			{ AttachStdout: true, AttachStderr: true, Cmd: cmd },
		);

		const raw = await this.engine.requestRaw("POST", `/exec/${created.body.Id}/start`, {
			Detach: false,
			Tty: false,
		});
		const { stdout, stderr } = demultiplex(raw);

		const inspected = await this.engine.request<{ ExitCode: number | null }>(
			"GET",
			`/exec/${created.body.Id}/json`,
		);
		return { exitCode: inspected.body.ExitCode ?? -1, stdout, stderr };
	}

	/**
	 * Runs a command with `input` on its stdin and waits for it to exit.
	 *
	 * The input goes over stdin rather than in the command line because it carries a wakeup prompt:
	 * arguments are visible to every process in the container and are bounded by ARG_MAX, and
	 * neither is a property one wants attached to whatever a stranger wrote into a webhook.
	 */
	async run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options: { timeoutMs?: number; workingDir?: string } = {},
	): Promise<ExecResult> {
		const created = await this.engine.request<{ Id: string }>(
			"POST",
			`/containers/${containerName(agentId)}/exec`,
			{
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false,
				Cmd: cmd,
				...(options.workingDir !== undefined ? { WorkingDir: options.workingDir } : {}),
			},
		);

		const stream = await this.engine.hijack("POST", `/exec/${created.body.Id}/start`, {
			Detach: false,
			Tty: false,
		});

		const splitter = new FrameSplitter();
		const stdout: string[] = [];
		const stderr: string[] = [];
		const collect = (chunk: Buffer): void => {
			for (const frame of splitter.push(chunk)) {
				(frame.stream === STDERR ? stderr : stdout).push(frame.payload.toString("utf8"));
			}
		};

		collect(stream.head);
		let timer: NodeJS.Timeout | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				if (options.timeoutMs !== undefined) {
					timer = setTimeout(() => {
						stream.socket.destroy();
						reject(new SandboxTimeoutError(`Command timed out after ${options.timeoutMs}ms`));
					}, options.timeoutMs);
				}

				stream.socket.on("data", collect);
				stream.socket.once("error", reject);
				stream.socket.once("close", resolve);
				// Half-closing is the EOF the command waits for; without it a reader never returns.
				stream.socket.end(input);
			});
		} finally {
			if (timer) clearTimeout(timer);
			stream.socket.removeListener("data", collect);
		}

		const inspected = await this.engine.request<{ ExitCode: number | null }>(
			"GET",
			`/exec/${created.body.Id}/json`,
		);
		return {
			exitCode: inspected.body.ExitCode ?? -1,
			stdout: stdout.join(""),
			stderr: stderr.join(""),
		};
	}

	/**
	 * Starts a command with stdin attached and returns the hijacked socket. Unlike exec, this does
	 * not wait for the process: it is the duplex byte channel a long-lived session speaks over.
	 */
	async attach(agentId: string, cmd: readonly string[]): Promise<HijackedStream> {
		const created = await this.engine.request<{ Id: string }>(
			"POST",
			`/containers/${containerName(agentId)}/exec`,
			{
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false,
				Cmd: cmd,
			},
		);

		return this.engine.hijack("POST", `/exec/${created.body.Id}/start`, {
			Detach: false,
			Tty: false,
		});
	}

	/** Removes the container. The volume is kept unless explicitly discarded, since it is the agent. */
	async destroy(agentId: string, options: { discardState?: boolean } = {}): Promise<void> {
		try {
			await this.engine.request("DELETE", `/containers/${containerName(agentId)}?force=true`);
		} catch (error) {
			if (!(error instanceof DockerError && error.status === 404)) throw error;
		}

		if (options.discardState === true) {
			try {
				await this.engine.request("DELETE", `/volumes/${volumeName(agentId)}`);
			} catch (error) {
				if (!(error instanceof DockerError && error.status === 404)) throw error;
			}
		}
	}
}
