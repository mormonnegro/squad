import { DockerEngine, DockerError, type HijackedStream } from "./engine.ts";
import { demultiplex } from "./frames.ts";
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
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface ContainerInspect {
	Id: string;
	State: { Running: boolean; StartedAt: string };
}

export function volumeName(agentId: string): string {
	return `agent-dive-${agentId}-self`;
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
