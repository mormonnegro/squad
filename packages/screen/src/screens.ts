import {
	buildVolumeConfig,
	DEFAULT_DEPLOYMENT,
	DockerEngine,
	DockerError,
	demultiplex,
	type ExecResult,
	type HijackedStream,
} from "@squad/sandbox";
import {
	buildScreenConfig,
	DEFAULT_SCREEN_IMAGE,
	type ScreenSpec,
	screenContainerName,
	screenVolumeName,
} from "./spec.ts";

export interface ScreenStatus {
	readonly agentId: string;
	readonly containerId: string;
	readonly running: boolean;
	/** The image by id, so a container running last week's build can be told from one running today's. */
	readonly imageId: string;
	/** The proxy it was created with, which is the record of the egress credential it presents. */
	readonly proxyUrl: string | undefined;
}

interface ContainerInspect {
	Id: string;
	Image: string;
	State: { Running: boolean };
	Config?: { Env?: readonly string[] };
}

function readEnv(env: readonly string[] | undefined, name: string): string | undefined {
	return env?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
}

/**
 * One browser container per agent that has been given a screen, beside the sandbox rather than
 * inside it.
 *
 * A manager of its own rather than a role on the sandbox manager, because almost nothing they do is
 * the same. A sandbox is created once and then lived in — exec'd into every turn, written to, its
 * repository scaffolded. A screen is started and stopped and otherwise left alone: nothing here
 * runs a command in it on the agent's behalf, and that absence is a property worth keeping visible
 * rather than one method away.
 */
export class DockerScreens {
	readonly #engine: DockerEngine;
	readonly #networkName: string;
	readonly #deployment: string;
	readonly #image: string;

	constructor(
		engine: DockerEngine = new DockerEngine(),
		networkName = `${DEFAULT_DEPLOYMENT}-egress`,
		deployment = DEFAULT_DEPLOYMENT,
		image = DEFAULT_SCREEN_IMAGE,
	) {
		this.#engine = engine;
		this.#networkName = networkName;
		this.#deployment = deployment;
		this.#image = image;
	}

	get image(): string {
		return this.#image;
	}

	async ensureVolume(agentId: string): Promise<string> {
		const name = screenVolumeName(agentId, this.#deployment);
		await this.#engine.request("POST", "/volumes/create", buildVolumeConfig(name, agentId));
		return name;
	}

	/** What a tag points at right now, so a container can be asked whether it still runs it. */
	async imageId(image = this.#image): Promise<string | undefined> {
		try {
			const response = await this.#engine.request<{ Id: string }>(
				"GET",
				`/images/${encodeURIComponent(image)}/json`,
			);
			return response.body.Id;
		} catch (error) {
			if (error instanceof DockerError && error.status === 404) return undefined;
			throw error;
		}
	}

	async create(spec: Omit<ScreenSpec, "volumeName" | "networkName" | "image">): Promise<string> {
		const volume = await this.ensureVolume(spec.agentId);
		const config = buildScreenConfig({
			...spec,
			image: this.#image,
			volumeName: volume,
			networkName: this.#networkName,
		});
		const response = await this.#engine.request<{ Id: string }>(
			"POST",
			`/containers/create?name=${encodeURIComponent(screenContainerName(spec.agentId, this.#deployment))}`,
			config,
		);
		return response.body.Id;
	}

	async start(agentId: string): Promise<void> {
		try {
			await this.#engine.request(
				"POST",
				`/containers/${screenContainerName(agentId, this.#deployment)}/start`,
			);
		} catch (error) {
			// 304 is already running, which is what this asked for. Settling a screen happens on every
			// start of the plane and on every `/screen on`, and most of those find it already up.
			if (error instanceof DockerError && error.status === 304) return;
			throw error;
		}
	}

	async stop(agentId: string, timeoutSeconds = 10): Promise<void> {
		try {
			await this.#engine.request(
				"POST",
				`/containers/${screenContainerName(agentId, this.#deployment)}/stop?t=${timeoutSeconds}`,
			);
		} catch (error) {
			// 304 is already stopped, 404 is already gone. Both are the end state this asked for.
			if (error instanceof DockerError && (error.status === 304 || error.status === 404)) return;
			throw error;
		}
	}

	async status(agentId: string): Promise<ScreenStatus | undefined> {
		try {
			const response = await this.#engine.request<ContainerInspect>(
				"GET",
				`/containers/${screenContainerName(agentId, this.#deployment)}/json`,
			);
			return {
				agentId,
				containerId: response.body.Id,
				running: response.body.State.Running,
				imageId: response.body.Image,
				proxyUrl: readEnv(response.body.Config?.Env, "SQUAD_EGRESS_PROXY"),
			};
		} catch (error) {
			if (error instanceof DockerError && error.status === 404) return undefined;
			throw error;
		}
	}

	/**
	 * Removes the container. The volume is kept unless asked for, because the volume is the login.
	 *
	 * Turning a screen off and turning it on again is a thing an operator will do to fix something,
	 * and doing it should not cost them every session they had signed into. Discarding is what
	 * `/screen forget` is for, and it is the only way the profile goes.
	 */
	async destroy(agentId: string, options: { discardProfile?: boolean } = {}): Promise<void> {
		try {
			await this.#engine.request(
				"DELETE",
				`/containers/${screenContainerName(agentId, this.#deployment)}?force=true`,
			);
		} catch (error) {
			if (!(error instanceof DockerError) || error.status !== 404) throw error;
		}
		if (options.discardProfile !== true) return;
		try {
			await this.#engine.request(
				"DELETE",
				`/volumes/${encodeURIComponent(screenVolumeName(agentId, this.#deployment))}`,
			);
		} catch (error) {
			if (!(error instanceof DockerError) || error.status !== 404) throw error;
		}
	}

	/**
	 * Runs a command in the screen container and waits for it.
	 *
	 * Used by the plane to ask the screen a question about itself, and by nothing on the agent's
	 * behalf: the agent reaches this container over the network, through the one door that refuses
	 * everything but the verbs.
	 */
	async exec(agentId: string, cmd: readonly string[]): Promise<ExecResult> {
		const created = await this.#engine.request<{ Id: string }>(
			"POST",
			`/containers/${screenContainerName(agentId, this.#deployment)}/exec`,
			{ AttachStdout: true, AttachStderr: true, Cmd: cmd },
		);
		const raw = await this.#engine.requestRaw("POST", `/exec/${created.body.Id}/start`, {
			Detach: false,
			Tty: false,
		});
		const { stdout, stderr } = demultiplex(raw);
		const inspected = await this.#engine.request<{ ExitCode: number | null }>(
			"GET",
			`/exec/${created.body.Id}/json`,
		);
		return { exitCode: inspected.body.ExitCode ?? -1, stdout, stderr };
	}

	/** A duplex channel onto a command in the screen container, which is how the view is forwarded. */
	async attach(agentId: string, cmd: readonly string[]): Promise<HijackedStream> {
		const created = await this.#engine.request<{ Id: string }>(
			"POST",
			`/containers/${screenContainerName(agentId, this.#deployment)}/exec`,
			{ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd },
		);
		return this.#engine.hijack("POST", `/exec/${created.body.Id}/start`, {
			Detach: false,
			Tty: false,
		});
	}
}
