import { SANDBOX_REPO_PATH, SKILLS_DIR, SOUL_FILE } from "@agent-dive/agent-repo";
import type { Reply } from "@agent-dive/channels";
import type { WakeupHandler } from "@agent-dive/events";
import type { ExecResult } from "@agent-dive/sandbox";

/** The part of the sandbox manager a turn needs. Narrow so a test can stand in for Docker. */
export interface TurnSandbox {
	run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options?: { timeoutMs?: number; workingDir?: string },
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
	/** The agent's own repository inside the sandbox: its soul, its skills, its memory. */
	readonly repoPath?: string;
	readonly timeoutMs?: number;
	readonly command?: readonly string[];
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

	constructor(options: PiTurnRunnerOptions) {
		this.#sandbox = options.sandbox;
		this.#provider = options.provider;
		this.#model = options.model;
		this.#repoPath = options.repoPath ?? DEFAULT_REPO_PATH;
		this.#sessionDir = options.sessionDir ?? `${this.#repoPath}/.sessions`;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#command = options.command ?? ["pi"];
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
			"--session-id",
			this.sessionId(agentId),
			"--session-dir",
			this.#sessionDir,
			"--append-system-prompt",
			`${this.#repoPath}/${SOUL_FILE}`,
			"--skill",
			`${this.#repoPath}/${SKILLS_DIR}`,
			...(this.#provider !== undefined ? ["--provider", this.#provider] : []),
			...(this.#model !== undefined ? ["--model", this.#model] : []),
		];
	}

	async run(agentId: string, prompt: string): Promise<TurnResult> {
		// In its own repository, so what it remembers and what it can do are where it works.
		const executed = await this.#sandbox.run(agentId, this.commandFor(agentId), prompt, {
			timeoutMs: this.#timeoutMs,
			workingDir: this.#repoPath,
		});

		const result: TurnResult = {
			text: executed.stdout.trim(),
			exitCode: executed.exitCode,
			stderr: executed.stderr.trim(),
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
		const result = await options.runner.run(agentId, prompt);
		options.onTurn?.(agentId, result);
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
