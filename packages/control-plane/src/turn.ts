import { SANDBOX_REPO_PATH, SKILLS_DIR, SOUL_FILE } from "@squad/agent-repo";
import type { Reply } from "@squad/channels";
import { type AgentEvent, isOwnNote, type WakeupHandler } from "@squad/events";
import {
	type ExecResult,
	SANDBOX_CONSOLE_FILE,
	SANDBOX_EXTENSIONS,
	SANDBOX_LESSONS_FILE,
	SANDBOX_MCP_FILE,
	SANDBOX_SEARCH_FILE,
	SANDBOX_WAKE_FILE,
	SANDBOX_WORKSPACE_PATH,
} from "@squad/sandbox";
import { CLI_CHANNEL } from "./control-server.ts";
import type { NamedServer } from "./mcp.ts";
import type { ModelChoice } from "./models.ts";
import { type AgentStep, PiOutput } from "./pi-output.ts";
import { type RepoStanding, reposPrompt } from "./repos.ts";
import type { Search } from "./search.ts";

/** The part of the sandbox manager a turn needs. Narrow so a test can stand in for Docker. */
export interface TurnSandbox {
	run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options?: {
			idleMs?: number;
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
	/** Where the agent works, and where a turn starts. Its projects, not itself. */
	readonly workspacePath?: string;
	/** How long a turn may go without a word before it is given up on. Not how long it may take. */
	readonly idleMs?: number;
	readonly command?: readonly string[];
	/** Called with each thing the agent does inside the sandbox, while it is still doing it. */
	readonly onStep?: (agentId: string, step: AgentStep) => void;
	readonly wakeFile?: string;
	readonly consoleFile?: string;
	readonly extensions?: readonly string[];
	/** The MCP servers this agent has been given, asked for again at the start of every turn. */
	readonly servers?: (agentId: string) => Promise<readonly NamedServer[]>;
	readonly mcpFile?: string;
	/** Which provider the web_search tool goes through, asked again at the start of every turn. */
	readonly search?: () => Promise<Search | undefined>;
	readonly searchFile?: string;
	/**
	 * The repositories this agent holds, asked for again at the start of every turn so one given at
	 * the console is in front of the agent on its next turn rather than its next container.
	 */
	readonly repos?: (agentId: string) => Promise<readonly RepoStanding[]>;
	/** The agent's own file of what it got wrong, read back to it at the start of every turn. */
	readonly lessonsFile?: string;
}

const DEFAULT_REPO_PATH = SANDBOX_REPO_PATH;

/**
 * How long a turn may go without saying anything before the plane gives up on it.
 *
 * There is deliberately no limit on how long a turn may take. An agent asked to read every document
 * on a website is being asked for hours of small steps, and a clock that stopped it at ten minutes
 * threw away the ten minutes as well as the answer — the work was never wrong, only long.
 *
 * What is worth giving up on is silence, and this is a generous amount of it: pi writes an event
 * for every step, a search inside the sandbox is capped at two minutes and so is a call to an MCP
 * server, so nothing an agent legitimately does is quiet for anything like this long. A turn that
 * is, is wedged or waiting on something that will never arrive.
 *
 * Nothing else needs a clock to be safe. A hand at the console stops a turn with escape, and the
 * spending ceiling is what stops an agent nobody is watching.
 */
const DEFAULT_IDLE_MS = 10 * 60_000;

/**
 * The house rule, said by the plane every turn rather than written into the agent.
 *
 * An agent asked for a to-do list built it in `.self`, which is where it was standing and the only
 * place it had ever been told about. Being given somewhere to work is half the fix; the other half
 * is that tidiness is a habit and a habit has to be said again, so this goes in as argv on every
 * turn. Not into `soul.md`: that file is the agent's own and it may rewrite it, and a rule the
 * subject can edit is not a rule. Not into the workspace either, for the same reason.
 *
 * Short on purpose. A paragraph of housekeeping in front of the actual question is a paragraph the
 * model reads past.
 */
export const HOUSE_RULES = [
	`Everything you build goes under ${SANDBOX_WORKSPACE_PATH}, one directory per project:`,
	`${SANDBOX_WORKSPACE_PATH}/todo-list/index.html, never ${SANDBOX_WORKSPACE_PATH}/index.html.`,
	"Make the directory before the first file, even when you think there will only be one.",
	"",
	`Nothing sits loose at the top of ${SANDBOX_WORKSPACE_PATH}. If you find something that does,`,
	"put it where it belongs as part of whatever you are doing rather than leaving it for later,",
	"and delete the scratch files you made to work something out once you have worked it out.",
	"",
	`${SANDBOX_REPO_PATH} is not a workspace. It is you — your soul, your skills, what you chose to`,
	"remember. Go there to change yourself, never to park a project.",
	"",
	"Anything you leave running — a server, a watcher, a queue — has to outlive the turn that started",
	"it, and one started with & does not: it keeps this turn's pipes, and the first thing it writes",
	"once the turn is over kills it. Start it with keep instead:",
	"",
	"  keep web npm run dev",
	"",
	"That gives it a session of its own and puts its output in .keep/web.log, which is where you go",
	"when something has stopped and you need to know why. Then ask for /serve on its port.",
].join("\n");

/**
 * How many lessons are read back to the agent, and how much of them.
 *
 * The tool caps this too, and this is the cap that decides. The file is the agent's own — it has a
 * shell and an editor and is expected to use both on it — so the number it was told is a number it
 * can walk past, and what would come of trusting it is not a broken turn but a slow expensive one
 * that nobody notices until the bill. The bytes are the same guarantee against one enormous line.
 */
export const MOST_LESSONS = 20;
export const LESSON_BYTES = 4_000;

/**
 * The lessons, framed as what they are, or nothing at all when there are none.
 *
 * Nothing at all is the important half. An agent that has never been wrong should not carry a
 * heading saying so, and a heading over an empty list is an invitation to fill it — which is how a
 * list meant for what was learned the hard way fills up with things the model thought sounded wise.
 */
export function lessonsPrompt(lessons: string): string | undefined {
	const written = lessons.trim();
	if (written.length === 0) return undefined;
	return [
		"What you got wrong before, written down by you at the time it happened. They are here so",
		"that you do not have to learn them a second time:",
		"",
		written,
	].join("\n");
}

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
	readonly #workspacePath: string;
	readonly #idleMs: number;
	readonly #command: readonly string[];
	readonly #onStep: ((agentId: string, step: AgentStep) => void) | undefined;
	readonly #wakeFile: string;
	readonly #consoleFile: string;
	readonly #extensions: readonly string[];
	readonly #servers: ((agentId: string) => Promise<readonly NamedServer[]>) | undefined;
	readonly #mcpFile: string;
	readonly #search: (() => Promise<Search | undefined>) | undefined;
	readonly #searchFile: string;
	readonly #repos: ((agentId: string) => Promise<readonly RepoStanding[]>) | undefined;
	readonly #lessonsFile: string;
	/** The turn each agent is taking, while it is taking it, so that it can be stopped. */
	readonly #running = new Map<string, AbortController>();

	constructor(options: PiTurnRunnerOptions) {
		this.#sandbox = options.sandbox;
		this.#model = options.model;
		this.#repoPath = options.repoPath ?? DEFAULT_REPO_PATH;
		this.#workspacePath = options.workspacePath ?? SANDBOX_WORKSPACE_PATH;
		this.#sessionDir = options.sessionDir ?? `${this.#repoPath}/.sessions`;
		this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
		this.#command = options.command ?? ["pi"];
		this.#onStep = options.onStep;
		this.#wakeFile = options.wakeFile ?? SANDBOX_WAKE_FILE;
		this.#consoleFile = options.consoleFile ?? SANDBOX_CONSOLE_FILE;
		this.#extensions = options.extensions ?? SANDBOX_EXTENSIONS;
		this.#servers = options.servers;
		this.#mcpFile = options.mcpFile ?? SANDBOX_MCP_FILE;
		this.#search = options.search;
		this.#repos = options.repos;
		this.#searchFile = options.searchFile ?? SANDBOX_SEARCH_FILE;
		this.#lessonsFile = options.lessonsFile ?? SANDBOX_LESSONS_FILE;
	}

	sessionId(agentId: string): string {
		return `squad-${agentId}`;
	}

	/**
	 * The soul and skills are passed as paths rather than discovered, because discovery is gated on
	 * pi trusting the project and the answer to "is this project trusted" is the agent itself.
	 */
	commandFor(
		agentId: string,
		thinksWith?: ModelChoice,
		lessons?: string,
		repos?: readonly RepoStanding[],
	): string[] {
		const learned = lessons === undefined ? undefined : lessonsPrompt(lessons);
		const holding = repos === undefined ? undefined : reposPrompt(repos, this.#workspacePath);
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
			// After the soul rather than before it, because the soul is who the agent is and this is the
			// house it lives in: an agent may rewrite the first and may not rewrite the second. pi takes
			// this flag more than once, and takes text where the line above takes a path.
			"--append-system-prompt",
			HOUSE_RULES,
			// After the house rules because it is more of them — where the agent's repositories are and
			// what it may do to them are rules about where it lives, said by the plane for the reason the
			// rest are: a grant nobody mentions is a grant found by trial.
			...(holding !== undefined ? ["--append-system-prompt", holding] : []),
			// Last of them, nearest the task, because it is the one that is about the work rather than
			// about the agent: the soul is who it is, the house rules are where it lives, and this is
			// what it found out by being wrong here.
			...(learned !== undefined ? ["--append-system-prompt", learned] : []),
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

	/**
	 * Throws away what the agent remembers of the conversation, so the next turn starts on nothing.
	 *
	 * Only the session goes. The repository beside it is the agent — its soul, its skills, what it
	 * chose to write down — and that is the part worth keeping across a conversation that had gone
	 * somewhere useless.
	 *
	 * pi names its file `{when}_{session}.jsonl`, so the id is matched inside the name rather than
	 * being the whole of it. The underscore is part of the pattern and not decoration: an agent may be
	 * called `my-squad-scout`, and matching on the id alone would have clearing `scout` take that
	 * agent's conversation too, since one name ends in the other. No agent name may hold an underscore,
	 * so the one pi writes is the only one there is and it anchors the match.
	 *
	 * The pattern goes to `find` as a single argument rather than through a shell. Nothing an operator
	 * may name an agent could survive a shell as anything but a filename, but a glob that something
	 * else expands is not where that guarantee should be load-bearing.
	 */
	async forget(agentId: string): Promise<boolean> {
		const found = await this.#sandbox.run(
			agentId,
			[
				"find",
				this.#sessionDir,
				"-maxdepth",
				"1",
				"-name",
				`*_${this.sessionId(agentId)}.jsonl`,
				"-print",
				"-delete",
			],
			"",
		);
		return found.stdout.trim().length > 0;
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
			await this.#putSearch(agentId);
			const thinksWith = await this.#model?.(agentId);
			const lessons = await this.#lessons(agentId);
			// A failed read leaves the turn to happen without the list, which is the turn there was before.
			const repos = await this.#repos?.(agentId).catch(() => undefined);
			// In the workspace, because a turn works where it is standing and the repository is not a
			// workspace: standing there is what had agents building projects inside their own soul. The
			// soul, the skills and the session are named by absolute path above, so none of them needs
			// this to be the repository — and the agent can still walk into it when it means to.
			executed = await this.#sandbox.run(
				agentId,
				this.commandFor(agentId, thinksWith, lessons, repos),
				prompt,
				{
					idleMs: this.#idleMs,
					workingDir: this.#workspacePath,
					onStdout: (chunk) => output.push(chunk),
					signal: stopping.signal,
				},
			);
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
	 * Puts the search provider this plane has chosen where the extension will look.
	 *
	 * On the same terms as the servers: written every turn so that a provider chosen at the console
	 * holds on the next one, and a failed write leaves the turn to happen anyway — the extension keeps
	 * a default, and a worse search is better than no turn.
	 */
	async #putSearch(agentId: string): Promise<void> {
		if (this.#search === undefined) return;
		const chosen = await this.#search().catch(() => undefined);
		if (chosen === undefined) return;
		await this.#sandbox
			.run(
				agentId,
				["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", this.#searchFile],
				JSON.stringify(chosen),
			)
			.catch(() => undefined);
	}

	/**
	 * Reads back what the agent wrote down about its own mistakes, and no more of it than was agreed.
	 *
	 * Cut in the sandbox rather than after it arrives, so that a file somebody has filled with a
	 * hundred thousand lines is a hundred thousand lines that never cross the socket. The cut is the
	 * point of the whole feature: this is read on every turn forever, and the difference between a
	 * memory and a leak is whether anything bounds it.
	 *
	 * Left rather than taken, unlike the wakeup and the console queue. Those are messages, consumed
	 * once. This is the agent's, and reading it changes nothing.
	 */
	async #lessons(agentId: string): Promise<string | undefined> {
		const read = await this.#sandbox
			.run(
				agentId,
				[
					"sh",
					"-c",
					'head -n "$2" "$1" 2>/dev/null | head -c "$3"',
					"sh",
					this.#lessonsFile,
					String(MOST_LESSONS),
					String(LESSON_BYTES),
				],
				"",
			)
			.catch(() => undefined);

		// A turn with no lessons is the ordinary case — a new agent has none — so nothing here is worth
		// failing a turn over, and an unreadable file is the same as an empty one from where pi stands.
		if (read === undefined || read.exitCode !== 0) return undefined;
		return read.stdout.trim().length > 0 ? read.stdout : undefined;
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
	/**
	 * Throws away what the agent remembers of the conversation, and says whether there was any.
	 *
	 * Optional because remembering between turns is a thing a runner does rather than a thing one is:
	 * a runner that starts every turn fresh has nothing here to throw away.
	 */
	forget?(agentId: string): Promise<boolean>;
}

export interface ReplyRouter {
	send(reply: Reply): Promise<void>;
}

export interface TurnHandlerOptions {
	readonly runner: TurnRunner;
	readonly router?: ReplyRouter;
	/**
	 * The turn as it finished, and the channels its answer is about to go out on.
	 *
	 * The destinations come with the turn rather than after the sending, because this is where the
	 * answer is written into the conversation and an answer that left by mail should say so there. A
	 * turn that was stopped is going nowhere and says so, being the one case where the pane shows an
	 * answer that nobody outside it will ever read.
	 */
	readonly onTurn?: (agentId: string, result: TurnResult, to: readonly string[]) => void;
	/**
	 * The turn beginning, for whoever is watching the agent rather than the conversation.
	 *
	 * A separate thing from the messages that caused it, which were already said elsewhere when they
	 * arrived: several of them make one turn, and a turn nothing was said to start.
	 */
	readonly onStart?: (agentId: string) => void;
	/** The answer as it is written, for whoever is waiting rather than whoever is reading a log. */
	readonly onSay?: (agentId: string, text: string) => void;
	/**
	 * The next turn the agent asked for, or dropped, and the channel it was asked for on. Awaited, so
	 * it is settled before this one is over.
	 */
	readonly onWake?: (agentId: string, wake: WakeChange, answering?: string) => Promise<void>;
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
		// Every channel the turn drew from, which is where the answer is owed — and nowhere at all when
		// it was stopped or when there is nothing to carry it, because then nothing leaves.
		const owed =
			result.stopped || options.router === undefined
				? []
				: [...new Set(events.map((event) => event.channel))];
		options.onTurn?.(agentId, result, owed);
		// A stopped turn's answer is half of one, and half an answer is worse than none somewhere it
		// will be read as the whole. Whoever stopped it was watching it being written anyway.
		if (result.stopped) return;
		// Before the reply and after the turn: the appointment is state and the reply is a courtesy, and
		// a process that stops between the two should have kept the one the agent cannot ask for twice.
		// With the channel it was booked on, because an agent asking to be woken is carrying on the
		// conversation it is in the middle of: somebody who asked by mail for a joke every minute is
		// owed the second joke where they asked for the first.
		if (result.wake) await options.onWake?.(agentId, result.wake, answering(events));
		// After the wake and before the reply, for both of their reasons: it is state rather than a
		// courtesy, and what it changes is what the agent has — which whoever reads the reply is about
		// to be told about.
		if (result.asked) await options.onAsked?.(agentId, result.asked);
		if (!options.router || result.text.length === 0) return;

		// Every destination is tried, and none of them can undo the turn. The model has been paid and
		// the agent has answered; throwing here would queue the events for a retry that costs another
		// turn and, on a channel that simply cannot carry replies, never stops — one hook without a
		// reply URL would be enough to make the agent unable to finish a turn ever again.
		for (const channel of owed) {
			await options.router
				.send({ agentId, channel, body: result.text })
				.catch((error: Error) => options.onUndelivered?.(agentId, channel, error));
		}
	};
}

/**
 * Which conversation a turn was having, for the next turn it books: whoever spoke to it, last first.
 *
 * A wakeup that comes due while somebody is writing is folded into the same turn, and the agent's own
 * note is the one thing in a burst that is nobody talking. Taking the last event outright let the note
 * win that tie, and losing it once loses it for good — every turn after that has only its own note to
 * go by, and books another one exactly like it. A note is what is left when nothing else spoke, and by
 * then it is already carrying the channel of the conversation it came from.
 *
 * The console is nowhere at all, and that is not the same as having nothing to inherit: a console
 * channel names one request, which is answered and gone, so a wakeup booked on it days ago would come
 * due holding the address of something that stopped existing when the line was answered. The console
 * needs no address anyway — it is shown every turn as it happens, whoever booked it.
 */
function answering(events: readonly AgentEvent[]): string | undefined {
	const channel = (events.findLast((event) => !isOwnNote(event)) ?? events.at(-1))?.channel;
	return channel === undefined || isRequest(channel) ? undefined : channel;
}

function isRequest(channel: string): boolean {
	return channel === CLI_CHANNEL || channel.startsWith(`${CLI_CHANNEL}:`);
}
