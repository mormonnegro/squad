import type { Reply } from "@agent-dive/channels";
import type { WakeupHandler } from "@agent-dive/events";
import type { ExecResult } from "@agent-dive/sandbox";

/** The part of the sandbox manager a turn needs. Narrow so a test can stand in for Docker. */
export interface TurnSandbox {
	run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options?: { timeoutMs?: number },
	): Promise<ExecResult>;
}

export interface TurnResult {
	readonly text: string;
	readonly exitCode: number;
	readonly stderr: string;
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
	readonly timeoutMs?: number;
	readonly command?: readonly string[];
}

const DEFAULT_SESSION_DIR = "/home/agent/.self/.sessions";
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
	readonly #timeoutMs: number;
	readonly #command: readonly string[];

	constructor(options: PiTurnRunnerOptions) {
		this.#sandbox = options.sandbox;
		this.#provider = options.provider;
		this.#model = options.model;
		this.#sessionDir = options.sessionDir ?? DEFAULT_SESSION_DIR;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#command = options.command ?? ["pi"];
	}

	sessionId(agentId: string): string {
		return `agent-dive-${agentId}`;
	}

	commandFor(agentId: string): string[] {
		return [
			...this.#command,
			"--print",
			"--session-id",
			this.sessionId(agentId),
			"--session-dir",
			this.#sessionDir,
			...(this.#provider !== undefined ? ["--provider", this.#provider] : []),
			...(this.#model !== undefined ? ["--model", this.#model] : []),
		];
	}

	async run(agentId: string, prompt: string): Promise<TurnResult> {
		const executed = await this.#sandbox.run(agentId, this.commandFor(agentId), prompt, {
			timeoutMs: this.#timeoutMs,
		});

		const result: TurnResult = {
			text: executed.stdout.trim(),
			exitCode: executed.exitCode,
			stderr: executed.stderr.trim(),
		};
		// Throwing leaves the events queued, so a turn lost to a bad key is retried rather than
		// acknowledged as if the agent had answered.
		if (result.exitCode !== 0) {
			throw new TurnError(`Turn for "${agentId}" exited ${result.exitCode}`, result);
		}
		return result;
	}
}

export interface TurnRunner {
	run(agentId: string, prompt: string): Promise<TurnResult>;
}

export interface ReplyRouter {
	send(reply: Reply): Promise<void>;
}

export interface TurnHandlerOptions {
	readonly runner: TurnRunner;
	readonly router?: ReplyRouter;
	readonly onTurn?: (agentId: string, result: TurnResult) => void;
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
		const result = await options.runner.run(agentId, prompt);
		options.onTurn?.(agentId, result);
		if (!options.router || result.text.length === 0) return;

		for (const channel of new Set(events.map((event) => event.channel))) {
			await options.router.send({ agentId, channel, body: result.text });
		}
	};
}
