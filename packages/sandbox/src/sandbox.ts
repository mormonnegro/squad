import { StringDecoder } from "node:string_decoder";
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
	/**
	 * The environment the container was created with.
	 *
	 * Docker cannot change it on a container that exists, so this is what the agent will actually be
	 * run with for as long as this container is the agent — whatever the configuration has since been
	 * edited to say.
	 */
	readonly env: Readonly<Record<string, string>>;
	/**
	 * The image the container is actually running, by id rather than by tag.
	 *
	 * A tag is rebuilt in place and keeps its name, so the name says nothing about whether the
	 * container is running what the tag means today.
	 */
	readonly imageId: string;
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
	Image: string;
	State: { Running: boolean; StartedAt: string };
	Config?: { Env?: readonly string[] };
}

export function volumeName(agentId: string): string {
	return `squad-${agentId}-self`;
}

/**
 * The other durable thing an agent has: everything it has built.
 *
 * Two volumes and not one because they are discarded together but read apart — an operator looking
 * at what an agent made should not have to walk past its memory to find it, and a project checked
 * into the repository would arrive in the diff of who the agent is.
 */
export function workspaceVolumeName(agentId: string): string {
	return `squad-${agentId}-work`;
}

/** Docker reports the environment as `NAME=value` strings, where the value may itself hold `=`. */
function readEnv(env: readonly string[] | undefined, name: string): string | undefined {
	const found = env?.find((entry) => entry.startsWith(`${name}=`));
	return found?.slice(name.length + 1);
}

function parseEnv(env: readonly string[] | undefined): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (const entry of env ?? []) {
		const split = entry.indexOf("=");
		if (split > 0) parsed[entry.slice(0, split)] = entry.slice(split + 1);
	}
	return parsed;
}

/**
 * Manages one long-lived container per agent, backed by a named volume that holds the agent
 * repository. Containers are disposable; the volume is the durable state.
 */
export class DockerSandboxManager {
	private readonly engine: DockerEngine;
	private readonly networkName: string;

	constructor(engine: DockerEngine = new DockerEngine(), networkName = "squad-egress") {
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

	async ensureWorkspaceVolume(agentId: string): Promise<string> {
		const name = workspaceVolumeName(agentId);
		await this.engine.request("POST", "/volumes/create", buildVolumeConfig(name, agentId));
		return name;
	}

	async create(
		spec: Omit<SandboxSpec, "volumeName" | "workspaceVolumeName" | "networkName">,
	): Promise<string> {
		await this.ensureNetwork();
		const volume = await this.ensureVolume(spec.agentId);
		const workspace = await this.ensureWorkspaceVolume(spec.agentId);
		const config = buildContainerConfig({
			...spec,
			volumeName: volume,
			workspaceVolumeName: workspace,
			networkName: this.networkName,
		});

		const response = await this.engine.request<{ Id: string }>(
			"POST",
			`/containers/create?name=${encodeURIComponent(containerName(spec.agentId))}`,
			config,
		);
		return response.body.Id;
	}

	/** What a tag points at right now, so a container can be asked whether it is still running it. */
	async imageId(image: string): Promise<string | undefined> {
		try {
			const response = await this.engine.request<{ Id: string }>(
				"GET",
				`/images/${encodeURIComponent(image)}/json`,
			);
			return response.body.Id;
		} catch (error) {
			if (error instanceof DockerError && error.status === 404) return undefined;
			throw error;
		}
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
				env: parseEnv(response.body.Config?.Env),
				imageId: response.body.Image,
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
		options: {
			/** The longest it may run, however busy it looks. For a command nobody can interrupt. */
			timeoutMs?: number;
			/**
			 * The longest it may go without saying anything, restarted by every byte it writes.
			 *
			 * The clock above is the wrong instrument for work whose length is not known in advance: a
			 * turn spent reading a hundred documents is cut off for being long, which is the one thing
			 * it was asked to be. Silence is the thing actually worth giving up on — a command still
			 * printing is a command still working, and one that has said nothing for this long has
			 * either wedged or is waiting for something that is not coming.
			 */
			idleMs?: number;
			workingDir?: string;
			/** Called with stdout as it arrives, for a caller that cannot wait for the exit. */
			onStdout?: (chunk: string) => void;
			/** Stops the command where it stands. Whatever it wrote before that is still returned. */
			signal?: AbortSignal;
		} = {},
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
		// One decoder per stream rather than a decode per frame: a frame boundary lands wherever the
		// daemon's writes happen to land, and decoding each in isolation turns any multibyte character
		// unlucky enough to straddle one into two replacement characters.
		const outDecoder = new StringDecoder("utf8");
		const errDecoder = new StringDecoder("utf8");
		/** Set while there is a silence to break. Anything arriving at all is proof of life. */
		let spoke: (() => void) | undefined;
		const collect = (chunk: Buffer): void => {
			spoke?.();
			for (const frame of splitter.push(chunk)) {
				if (frame.stream === STDERR) stderr.push(errDecoder.write(frame.payload));
				else {
					const text = outDecoder.write(frame.payload);
					stdout.push(text);
					if (text.length > 0) options.onStdout?.(text);
				}
			}
		};

		collect(stream.head);
		let timer: NodeJS.Timeout | undefined;
		let silence: NodeJS.Timeout | undefined;
		// Killed inside the container, and not merely disconnected from. Dropping our end of the pipe
		// takes the output away from us and leaves the process running on the other side of it — which,
		// when the process is a model taking a turn, means it goes on thinking and goes on being paid
		// for, invisibly, after somebody has been told it stopped. The command line is what identifies
		// it, because the pid Docker reports for an exec is the host's and means nothing in here;
		// `pkill` never matches itself.
		// The socket goes after the kill, not instead of it: returning the moment we stop listening
		// would report a stop while the process was still running, and whoever acted on that would go
		// looking and find it alive. Usually the socket is closed by then anyway, by the process ending.
		const abort = (): void => {
			void this.exec(agentId, ["pkill", "-TERM", "-f", cmd.join(" ")])
				.catch(() => {})
				.finally(() => stream.socket.destroy());
		};
		try {
			await new Promise<void>((resolve, reject) => {
				// Through the same kill as a stop, and not merely by dropping the socket, for the reason
				// written above it: giving up on a turn while leaving the model running is how a command
				// somebody was told had ended goes on thinking and goes on being paid for.
				const giveUp = (why: string): void => {
					abort();
					reject(new SandboxTimeoutError(why));
				};
				if (options.timeoutMs !== undefined) {
					timer = setTimeout(
						() => giveUp(`Command timed out after ${options.timeoutMs}ms`),
						options.timeoutMs,
					);
				}
				const idleMs = options.idleMs;
				if (idleMs !== undefined) {
					const wait = (): void => {
						clearTimeout(silence);
						silence = setTimeout(
							() => giveUp(`Command said nothing for ${Math.round(idleMs / 1000)}s`),
							idleMs,
						);
					};
					spoke = wait;
					wait();
				}

				stream.socket.on("data", collect);
				stream.socket.once("error", reject);
				stream.socket.once("close", resolve);
				// Half-closing is the EOF the command waits for; without it a reader never returns.
				stream.socket.end(input);

				// Checked as well as listened for: the signal may already have been raised while the exec
				// was being created, and a listener alone would wait out a turn nobody is waiting for.
				if (options.signal?.aborted === true) abort();
				else options.signal?.addEventListener("abort", abort, { once: true });
			});
		} finally {
			if (timer) clearTimeout(timer);
			if (silence) clearTimeout(silence);
			spoke = undefined;
			options.signal?.removeEventListener("abort", abort);
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

	/** Removes the container. The volumes are kept unless explicitly discarded, since they are the agent. */
	async destroy(agentId: string, options: { discardState?: boolean } = {}): Promise<void> {
		try {
			await this.engine.request("DELETE", `/containers/${containerName(agentId)}?force=true`);
		} catch (error) {
			if (!(error instanceof DockerError && error.status === 404)) throw error;
		}

		if (options.discardState === true) {
			// Both, because discarding the agent and leaving its work behind would leave a volume nothing
			// names: the next agent of that name adopts it and inherits a workspace it never built.
			for (const volume of [volumeName(agentId), workspaceVolumeName(agentId)]) {
				try {
					await this.engine.request("DELETE", `/volumes/${volume}`);
				} catch (error) {
					if (!(error instanceof DockerError && error.status === 404)) throw error;
				}
			}
		}
	}
}
