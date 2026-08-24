import { SANDBOX_REPO_PATH, SKILLS_DIR, SOUL_FILE } from "@agent-dive/agent-repo";
import type { Reply } from "@agent-dive/channels";
import type { WakeupHandler } from "@agent-dive/events";
import {
	type ExecResult,
	SANDBOX_CONSOLE_FILE,
	SANDBOX_EXTENSIONS,
	SANDBOX_MCP_FILE,
	SANDBOX_WAKE_FILE,
} from "@agent-dive/sandbox";
import type { NamedServer } from "./mcp.ts";
import type { ModelChoice } from "./models.ts";
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
			signal?: AbortSignal;
		},
	): Promise<ExecResult>;
}

/** An agent asking for its next turn: how long from now, and what it wants to be told then. */
export interface WakeRequest {
	readonly afterSeconds: number;
	readonly note: string;
}

/**
 * An agent dropping the turn it had asked for, rather than moving it.
 *
 * A separate thing to ask for because there is no time that means "not at all": the plane clamps
 * what it is given into a range it can honour, so an agent trying to cancel by asking for a very
 * distant wakeup only postpones one — which is what an agent that wanted to cancel actually did.
 */
export interface WakeCancel {
	readonly cancel: true;
}

/** Either half of the one appointment an agent has: when to keep it, or that there is none. */
export type WakeChange = WakeRequest | WakeCancel;

export interface TurnResult {
	readonly text: string;
	readonly exitCode: number;
	readonly stderr: string;
	/** How long the turn took, what it burned and what it cost: the three questions asked after. */
	readonly ms: number;
	readonly tokens: number;
	readonly costUsd: number;
	/** Present when the agent asked about its next turn. What it may ask for is decided upstream. */
	readonly wake?: WakeChange;
	/** The console commands the turn asked for, in the order it asked. Which of them may run is decided upstream. */
	readonly asked?: readonly string[];
	/** Set when the turn was stopped rather than finished. The text is as far as it had got. */
	readonly stopped?: true;
}

/**
 * Reads a wakeup request, and refuses to guess at one that does not read as written.
 *
 * The sanctioned way to make one is a tool that cannot produce anything but this, so anything else
 * arriving here is an agent that wrote the file by hand — which it can, having a shell — and the
 * safe answer to a request nobody can read is not to act on it.
 */
export function parseWake(text: string): WakeChange | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;

	const { afterSeconds, note, cancel } = parsed as Record<string, unknown>;
	// Read before the rest, and carrying nothing else: dropping an appointment has no time to keep
	// and nothing to be told at it.
	if (cancel === true) return { cancel: true };
	if (typeof afterSeconds !== "number" || !Number.isFinite(afterSeconds)) return undefined;
	if (typeof note !== "string" || note.trim().length === 0) return undefined;

	return { afterSeconds, note };
}

/**
 * How many commands one turn may ask for.
 *
 * Applied here as well as in the tool, because the tool is a convenience inside a sandbox where the
 * agent has a shell and could write the file itself. What it bounds is not cost but the console: a
 * turn that asked for four hundred is one whose operator cannot find anything else that was said.
 */
export const MOST_ASKED = 10;

/**
 * Reads the commands a turn asked for, dropping anything that does not read as one.
 *
 * Line by line rather than all or nothing: the list is steps, and an agent that got its second line
 * wrong should still have its first one run. What is dropped silently is only what could not have
 * been meant — a number where a command goes — and a command the agent may not ask for is a
 * different thing entirely, refused out loud further up where the reason can be said.
 */
export function parseAsked(text: string): readonly string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;

	const lines = parsed
		.filter((one): one is string => typeof one === "string")
		.map((one) => one.trim())
		// A newline would put a second command into the conversation underneath the first one's
		// answer, where whoever is reading has no reason to look for it.
		.filter((one) => one.startsWith("/") && !/[\n\r]/.test(one))
		.slice(0, MOST_ASKED);
	return lines.length > 0 ? lines : undefined;
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
	/**
	 * What to think with, asked again at the start of every turn.
	 *
	 * Asked rather than held, for the same reason the servers are: an agent moved onto another model
	 * from the console should answer with it on its next turn, without waiting for a new container.
	 */
	readonly model?: (agentId: string) => Promise<ModelChoice | undefined>;
	/** Where pi keeps session files. On the agent's volume, so turns survive a new container. */
	readonly sessionDir?: string;
	/** The agent's own repository inside the sandbox: its soul, its skills, its memory. */
	readonly repoPath?: string;
	readonly timeoutMs?: number;
	readonly command?: readonly string[];
	/** Called with each thing the agent does inside the sandbox, while it is still doing it. */
	readonly onStep?: (agentId: string, step: AgentStep) => void;
	readonly wakeFile?: string;
	readonly consoleFile?: string;
	readonly extensions?: readonly string[];
	/** The MCP servers this agent has been given, asked for again at the start of every turn. */
	readonly servers?: (agentId: string) => Promise<readonly NamedServer[]>;
	readonly mcpFile?: string;
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
	readonly #model: ((agentId: string) => Promise<ModelChoice | undefined>) | undefined;
	readonly #sessionDir: string;
	readonly #repoPath: string;
	readonly #timeoutMs: number;
	readonly #command: readonly string[];
	readonly #onStep: ((agentId: string, step: AgentStep) => void) | undefined;
	readonly #wakeFile: string;
	readonly #consoleFile: string;
	readonly #extensions: readonly string[];
	readonly #servers: ((agentId: string) => Promise<readonly NamedServer[]>) | undefined;
	readonly #mcpFile: string;
	/** The turn each agent is taking, while it is taking it, so that it can be stopped. */
	readonly #running = new Map<string, AbortController>();

	constructor(options: PiTurnRunnerOptions) {
		this.#sandbox = options.sandbox;
		this.#model = options.model;
		this.#repoPath = options.repoPath ?? DEFAULT_REPO_PATH;
		this.#sessionDir = options.sessionDir ?? `${this.#repoPath}/.sessions`;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#command = options.command ?? ["pi"];
		this.#onStep = options.onStep;
		this.#wakeFile = options.wakeFile ?? SANDBOX_WAKE_FILE;
		this.#consoleFile = options.consoleFile ?? SANDBOX_CONSOLE_FILE;
		this.#extensions = options.extensions ?? SANDBOX_EXTENSIONS;
		this.#servers = options.servers;
		this.#mcpFile = options.mcpFile ?? SANDBOX_MCP_FILE;
	}

	sessionId(agentId: string): string {
		return `agent-dive-${agentId}`;
	}

	/**
	 * The soul and skills are passed as paths rather than discovered, because discovery is gated on
	 * pi trusting the project and the answer to "is this project trusted" is the agent itself.
	 */
	commandFor(agentId: string, thinksWith?: ModelChoice): string[] {
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
			// the project being trusted, and these are the plane's rather than the project's anyway.
			...this.#extensions.flatMap((extension) => ["--extension", extension]),
			...(thinksWith?.provider !== undefined ? ["--provider", thinksWith.provider] : []),
			...(thinksWith?.model !== undefined ? ["--model", thinksWith.model] : []),
		];
	}

	/**
	 * Stops the turn an agent is taking, and says whether there was one.
	 *
	 * Nothing is undone: the tokens are spent, and whatever the agent did to its own files it did.
	 * What stops is the thinking, which is the part still costing something.
	 */
	stop(agentId: string): boolean {
		const running = this.#running.get(agentId);
		running?.abort();
		return running !== undefined;
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
		const stopping = new AbortController();
		// Before the first await, so that a stop arriving in the same breath as the turn has something
		// to stop rather than falling through and letting the turn run on unstoppable.
		this.#running.set(agentId, stopping);
		let executed: ExecResult;
		try {
			await this.#putServers(agentId);
			const thinksWith = await this.#model?.(agentId);
			// In its own repository, so what it remembers and what it can do are where it works.
			executed = await this.#sandbox.run(agentId, this.commandFor(agentId, thinksWith), prompt, {
				timeoutMs: this.#timeoutMs,
				workingDir: this.#repoPath,
				onStdout: (chunk) => output.push(chunk),
				signal: stopping.signal,
			});
		} finally {
			// Cleared before anything else can go wrong, so a stop arriving late finds nothing to stop
			// rather than reaching into the turn after it.
			this.#running.delete(agentId);
		}
		const stopped = stopping.signal.aborted;

		// Before the exit code is looked at, so that a turn which died having asked to come back still
		// comes back. A failed turn is the one most worth retrying, and it is also the one that cannot
		// ask again.
		const wake = await this.#takeWake(agentId);
		// Taken for the same reason and on the same terms: a turn that died having asked for the server
		// it needed died for want of that server, and losing the request with the turn is how an agent
		// stays broken across every retry.
		const asked = await this.#takeAsked(agentId);

		const result: TurnResult = {
			text: output.text,
			exitCode: executed.exitCode,
			stderr: executed.stderr.trim(),
			ms: Date.now() - started,
			tokens: output.tokens,
			costUsd: output.costUsd,
			// Taken off the disk either way, so the next turn does not find it and act on it. But a turn
			// that was stopped does not get to book the one after it: being woken in a second by the very
			// turn somebody just stopped is not stopping.
			...(wake !== undefined && !stopped ? { wake } : {}),
			// Off the disk either way and dropped when the turn was stopped, on the wake's terms: whoever
			// stopped a turn stopped what it was doing, and a login opening in their browser afterwards is
			// the turn carrying on without it.
			...(asked !== undefined && !stopped ? { asked } : {}),
			...(stopped ? { stopped: true } : {}),
		};
		// A turn that was stopped did not fail. Its exit code says killed and its answer ends mid
		// sentence, and calling either of those a failure would leave the events queued for another
		// attempt — which takes the turn again, the one thing whoever stopped it asked for.
		if (stopped) return result;
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
	 * Puts the servers this agent has been given where the extension will look, before pi starts.
	 *
	 * Written every turn rather than kept, because the shelf is the plane's and this is a copy: an
	 * agent given a server between one turn and the next would otherwise have to wait for a new
	 * container to hear about it, and one that had a server taken away would go on being offered a
	 * tool that nothing answers.
	 *
	 * Over stdin, so that a URL or a command line the operator typed is never an argument. A write
	 * that fails leaves the turn to happen anyway: fewer tools is a worse turn, and no turn is worse
	 * than that.
	 */
	async #putServers(agentId: string): Promise<void> {
		if (this.#servers === undefined) return;
		const held = await this.#servers(agentId).catch(() => []);
		await this.#sandbox
			.run(
				agentId,
				["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", this.#mcpFile],
				JSON.stringify(held),
			)
			.catch(() => undefined);
	}

	/**
	 * Takes the request the turn left behind, and takes it away in the same breath.
	 *
	 * Read and removed together because a request left in place is one the next turn finds and acts
	 * on again: an agent that asked once would be asking every turn from then on, and the wakeups it
	 * never asked for are the ones nobody thinks to look for.
	 */
	async #takeWake(agentId: string): Promise<WakeChange | undefined> {
		const read = await this.#sandbox
			.run(agentId, ["sh", "-c", 'cat "$1" && rm -f "$1"', "sh", this.#wakeFile], "")
			.catch(() => undefined);

		if (read === undefined || read.exitCode !== 0) return undefined;
		return parseWake(read.stdout);
	}

	/** The same read-and-remove, for the same reason: a list left in place is one run again next turn. */
	async #takeAsked(agentId: string): Promise<readonly string[] | undefined> {
		const read = await this.#sandbox
			.run(agentId, ["sh", "-c", 'cat "$1" && rm -f "$1"', "sh", this.#consoleFile], "")
			.catch(() => undefined);

		if (read === undefined || read.exitCode !== 0) return undefined;
		return parseAsked(read.stdout);
	}
}

export interface TurnRunner {
	run(agentId: string, prompt: string, onText?: (delta: string) => void): Promise<TurnResult>;
	/** Stops the turn in flight, and says whether there was one. A runner may have none to stop. */
	stop?(agentId: string): boolean;
}

export interface ReplyRouter {
	send(reply: Reply): Promise<void>;
}

export interface TurnHandlerOptions {
	readonly runner: TurnRunner;
	readonly router?: ReplyRouter;
	readonly onTurn?: (agentId: string, result: TurnResult) => void;
	/**
	 * The turn beginning, for whoever is watching the agent rather than the conversation.
	 *
	 * A separate thing from the messages that caused it, which were already said elsewhere when they
	 * arrived: several of them make one turn, and a turn nothing was said to start.
	 */
	readonly onStart?: (agentId: string) => void;
	/** The answer as it is written, for whoever is waiting rather than whoever is reading a log. */
	readonly onSay?: (agentId: string, text: string) => void;
	/** The next turn the agent asked for, or dropped. Awaited, so it is settled before this one is over. */
	readonly onWake?: (agentId: string, wake: WakeChange) => Promise<void>;
	/**
	 * The console commands the turn asked for. Awaited, so a server the agent connected itself to is
	 * there before the reply goes out saying that it is.
	 */
	readonly onAsked?: (agentId: string, asked: readonly string[]) => Promise<void>;
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
		options.onStart?.(agentId);
		const result = await options.runner.run(agentId, prompt, (text) =>
			options.onSay?.(agentId, text),
		);
		options.onTurn?.(agentId, result);
		// A stopped turn's answer is half of one, and half an answer is worse than none somewhere it
		// will be read as the whole. Whoever stopped it was watching it being written anyway.
		if (result.stopped) return;
		// Before the reply and after the turn: the appointment is state and the reply is a courtesy, and
		// a process that stops between the two should have kept the one the agent cannot ask for twice.
		if (result.wake) await options.onWake?.(agentId, result.wake);
		// After the wake and before the reply, for both of their reasons: it is state rather than a
		// courtesy, and what it changes is what the agent has — which whoever reads the reply is about
		// to be told about.
		if (result.asked) await options.onAsked?.(agentId, result.asked);
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
