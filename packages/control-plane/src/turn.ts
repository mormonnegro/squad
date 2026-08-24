import { SANDBOX_REPO_PATH, SKILLS_DIR, SOUL_FILE } from "@agent-dive/agent-repo";
import type { Reply } from "@agent-dive/channels";
import type { AgentEvent, WakeupHandler } from "@agent-dive/events";
import { type ExecResult, SANDBOX_WAKE_EXTENSION, SANDBOX_WAKE_FILE } from "@agent-dive/sandbox";
import { type AgentStep, PiOutput } from "./pi-output.ts";

/** The part of the sandbox manager a turn needs. Narrow so a test can stand in for Docker. */
export interface TurnSandbox {
	run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options?: {
			timeoutMs?: number;
			workingDir?: string;
			onStdout?: (chunk: string) => void;
		},
	): Promise<ExecResult>;
}

/** An agent asking for its next turn: how long from now, and what it wants to be told then. */
export interface WakeRequest {
	readonly afterSeconds: number;
	readonly note: string;
}

export interface TurnResult {
	readonly text: string;
	readonly exitCode: number;
	readonly stderr: string;
	/** How long the turn took, what it burned and what it cost: the three questions asked after. */
	readonly ms: number;
	readonly tokens: number;
	readonly costUsd: number;
	/** Present when the agent asked to be woken again. What it may ask for is decided upstream. */
	readonly wake?: WakeRequest;
}

/**
 * Reads a wakeup request, and refuses to guess at one that does not read as written.
 *
 * The sanctioned way to make one is a tool that cannot produce anything but this, so anything else
 * arriving here is an agent that wrote the file by hand — which it can, having a shell — and the
 * safe answer to a request nobody can read is not to act on it.
 */
export function parseWake(text: string): WakeRequest | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;

	const { afterSeconds, note } = parsed as Record<string, unknown>;
	if (typeof afterSeconds !== "number" || !Number.isFinite(afterSeconds)) return undefined;
	if (typeof note !== "string" || note.trim().length === 0) return undefined;

	return { afterSeconds, note };
}

export class TurnError extends Error {
	readonly result: TurnResult;

	constructor(message: string, result: TurnResult) {
		super(message);
		this.name = "TurnError";
		this.result = result;
	}
}

export interface PiTurnRunnerOptions {
	readonly sandbox: TurnSandbox;
	readonly provider?: string;
	readonly model?: string;
	/** Where pi keeps session files. On the agent's volume, so turns survive a new container. */
	readonly sessionDir?: string;
	/** The agent's own repository inside the sandbox: its soul, its skills, its memory. */
	readonly repoPath?: string;
	readonly timeoutMs?: number;
	readonly command?: readonly string[];
	/** Called with each thing the agent does inside the sandbox, while it is still doing it. */
	readonly onStep?: (agentId: string, step: AgentStep) => void;
	readonly wakeFile?: string;
	readonly wakeExtension?: string;
}

const DEFAULT_REPO_PATH = SANDBOX_REPO_PATH;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Takes one turn by running pi non-interactively inside the agent's sandbox.
 *
 * pi 0.84.2 has no server to hold a session open, so each wakeup is a separate process. Passing a
 * session id derived from the agent keeps them one conversation: the agent remembers the previous
 * webhook when the next one arrives, instead of meeting its own project fresh every time.
 */
export class PiTurnRunner {
	readonly #sandbox: TurnSandbox;
	readonly #provider: string | undefined;
	readonly #model: string | undefined;
	readonly #sessionDir: string;
	readonly #repoPath: string;
	readonly #timeoutMs: number;
	readonly #command: readonly string[];
	readonly #onStep: ((agentId: string, step: AgentStep) => void) | undefined;
	readonly #wakeFile: string;
	readonly #wakeExtension: string;

	constructor(options: PiTurnRunnerOptions) {
		this.#sandbox = options.sandbox;
		this.#provider = options.provider;
		this.#model = options.model;
		this.#repoPath = options.repoPath ?? DEFAULT_REPO_PATH;
		this.#sessionDir = options.sessionDir ?? `${this.#repoPath}/.sessions`;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#command = options.command ?? ["pi"];
		this.#onStep = options.onStep;
		this.#wakeFile = options.wakeFile ?? SANDBOX_WAKE_FILE;
		this.#wakeExtension = options.wakeExtension ?? SANDBOX_WAKE_EXTENSION;
	}

	sessionId(agentId: string): string {
		return `agent-dive-${agentId}`;
	}

	/**
	 * The soul and skills are passed as paths rather than discovered, because discovery is gated on
	 * pi trusting the project and the answer to "is this project trusted" is the agent itself.
	 */
	commandFor(agentId: string): string[] {
		return [
			...this.#command,
			"--print",
			// The event stream rather than the finished text, because the finished text arrives all at
			// once when the turn is over and there is no way back from that to an answer in progress.
			"--mode",
			"json",
			"--session-id",
			this.sessionId(agentId),
			"--session-dir",
			this.#sessionDir,
			"--append-system-prompt",
			`${this.#repoPath}/${SOUL_FILE}`,
			"--skill",
			`${this.#repoPath}/${SKILLS_DIR}`,
			// Named rather than discovered, for the same reason the skills are: discovery is gated on
			// the project being trusted, and this one is the plane's rather than the project's anyway.
			"--extension",
			this.#wakeExtension,
			...(this.#provider !== undefined ? ["--provider", this.#provider] : []),
			...(this.#model !== undefined ? ["--model", this.#model] : []),
		];
	}

	async run(
		agentId: string,
		prompt: string,
		onText?: (delta: string) => void,
	): Promise<TurnResult> {
		const started = Date.now();
		const output = new PiOutput({
			onText: (delta) => onText?.(delta),
			onStep: (step) => this.#onStep?.(agentId, step),
		});
		// In its own repository, so what it remembers and what it can do are where it works.
		const executed = await this.#sandbox.run(agentId, this.commandFor(agentId), prompt, {
			timeoutMs: this.#timeoutMs,
			workingDir: this.#repoPath,
			onStdout: (chunk) => output.push(chunk),
		});

		// Before the exit code is looked at, so that a turn which died having asked to come back still
		// comes back. A failed turn is the one most worth retrying, and it is also the one that cannot
		// ask again.
		const wake = await this.#takeWake(agentId);

		const result: TurnResult = {
			text: output.text,
			exitCode: executed.exitCode,
			stderr: executed.stderr.trim(),
			ms: Date.now() - started,
			tokens: output.tokens,
			costUsd: output.costUsd,
			...(wake !== undefined ? { wake } : {}),
		};
		// Throwing leaves the events queued, so a turn lost to a bad key is retried rather than
		// acknowledged as if the agent had answered.
		if (result.exitCode !== 0) {
			// What pi said last is what went wrong, and an exit code on its own sends the operator to
			// the logs to learn something the failure already knew.
			const said = result.stderr.split("\n").at(-1)?.trim();
			throw new TurnError(
				`Turn for "${agentId}" exited ${result.exitCode}${said ? `: ${said}` : ""}`,
				result,
			);
		}
		// A refused model leaves pi exiting zero with the reason inside the stream, so without this the
		// turn is an empty answer and the agent looks like it had nothing to say.
		if (output.failure !== undefined) {
			throw new TurnError(`Turn for "${agentId}" got no answer: ${output.failure}`, result);
		}
		return result;
	}

	/**
	 * Takes the request the turn left behind, and takes it away in the same breath.
	 *
	 * Read and removed together because a request left in place is one the next turn finds and acts
	 * on again: an agent that asked once would be asking every turn from then on, and the wakeups it
	 * never asked for are the ones nobody thinks to look for.
	 */
	async #takeWake(agentId: string): Promise<WakeRequest | undefined> {
		const read = await this.#sandbox
			.run(agentId, ["sh", "-c", 'cat "$1" && rm -f "$1"', "sh", this.#wakeFile], "")
			.catch(() => undefined);

		if (read === undefined || read.exitCode !== 0) return undefined;
		return parseWake(read.stdout);
	}
}

export interface TurnRunner {
	run(agentId: string, prompt: string, onText?: (delta: string) => void): Promise<TurnResult>;
}

export interface ReplyRouter {
	send(reply: Reply): Promise<void>;
}

export interface TurnHandlerOptions {
	readonly runner: TurnRunner;
	readonly router?: ReplyRouter;
	readonly onTurn?: (agentId: string, result: TurnResult) => void;
	/**
	 * What the turn is about to answer, before it answers it. Awaited, so that a turn which fails or
	 * never returns still leaves behind what it was asked — which is the half worth having then.
	 */
	readonly onHeard?: (agentId: string, events: readonly AgentEvent[]) => Promise<void>;
	/** The answer as it is written, for whoever is waiting rather than whoever is reading a log. */
	readonly onSay?: (agentId: string, text: string) => void;
	/** The next turn the agent asked for. Awaited, so it is booked before this one is over. */
	readonly onWake?: (agentId: string, wake: WakeRequest) => Promise<void>;
	/** A reply that had nowhere to go. The turn still counts as taken. */
	readonly onUndelivered?: (agentId: string, channel: string, error: Error) => void;
}

/**
 * Adapts a turn runner into a wakeup handler, answering on every channel the wakeup drew from.
 *
 * A burst is coalesced into one turn, so one answer may be owed to several places at once. Sending
 * it to each is noisier than picking one, but the alternative is that whoever spoke second is
 * ignored without ever learning why.
 */
export function createTurnHandler(options: TurnHandlerOptions): WakeupHandler {
	return async ({ agentId, events, prompt }) => {
		await options.onHeard?.(agentId, events);
		const result = await options.runner.run(agentId, prompt, (text) =>
			options.onSay?.(agentId, text),
		);
		options.onTurn?.(agentId, result);
		// Before the reply and after the turn: the appointment is state and the reply is a courtesy, and
		// a process that stops between the two should have kept the one the agent cannot ask for twice.
		if (result.wake) await options.onWake?.(agentId, result.wake);
		if (!options.router || result.text.length === 0) return;

		// Every destination is tried, and none of them can undo the turn. The model has been paid and
		// the agent has answered; throwing here would queue the events for a retry that costs another
		// turn and, on a channel that simply cannot carry replies, never stops — one hook without a
		// reply URL would be enough to make the agent unable to finish a turn ever again.
		for (const channel of new Set(events.map((event) => event.channel))) {
			await options.router
				.send({ agentId, channel, body: result.text })
				.catch((error: Error) => options.onUndelivered?.(agentId, channel, error));
		}
	};
}
