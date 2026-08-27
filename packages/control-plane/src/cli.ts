import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ConfigError, loadConfig } from "./config.ts";
import {
	ControlClient,
	ControlError,
	type Dial,
	dialLocal,
	RELAY_HELLO,
} from "./control-client.ts";
import { type AgentSummary, ControlPlane, type PlaneEvent } from "./control-plane.ts";
import { runningPlanes } from "./control-relay.ts";
import { ControlServer, controlSocketPath } from "./control-server.ts";
import { LogFeed } from "./feed.ts";
import { MarkdownStream } from "./markdown.ts";

const DEFAULT_STATE_DIR = "/var/lib/squad";

const USAGE = `squad - run self-hosted cloud agents

  squad                        the console: every agent, its turns and its logs on
                               one screen. With no terminal to take over, says where
                               the state is and what is running in it
  squad chat [name]            talk to one agent in the scrollback, turn after turn.
                               A name no agent answers to offers to make one
  squad ls                     what each agent is and whether it is up
  squad wake [name] <text>     take one turn, as the operator
  squad logs                   follow what every agent runs, answers and spends
  squad rm <name> [--purge]    take the sandbox away, and with --purge its
                               repository: soul, memory, skills, tools
  squad run <config.yaml>      start the control plane
  squad relay                  this plane's control socket, on stdin and stdout: the
                               door a console on another computer comes through
  squad help                   this

The configuration names its secrets; their values come from the environment.
Commands other than "run" talk to a running plane over a socket in its state
directory: --state <dir>, or SQUAD_STATE, defaulting to ${DEFAULT_STATE_DIR}.
Told nothing, they look for the plane that is actually running.`;

/**
 * A plane that is not on this machine, and how to reach it.
 *
 * Every command here is written against a `ControlClient`, and a client is the same object whether
 * its bytes go down a socket in a directory or down an SSH connection. So the console package hands
 * one of these in and the commands do not change: `squad ls` against a VPS is this process, running
 * the same code, dialling further.
 *
 * `at` is what the operator called the machine, and it is only ever printed. Nothing here should
 * decide anything from it.
 */
export interface Remote {
	readonly at: string;
	readonly dial: Dial;
}

interface Args {
	readonly stateDir: string;
	/** Whether the operator named the directory, rather than it being the default. */
	readonly named: boolean;
	readonly purge: boolean;
	readonly rest: readonly string[];
	readonly remote?: Remote;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Args {
	const rest: string[] = [];
	let stateDir: string | undefined;
	let purge = false;

	for (let i = 0; i < argv.length; i++) {
		const argument = argv[i];
		if (argument === "--state") {
			stateDir = argv[++i];
			if (stateDir === undefined) throw new ControlError("--state needs a directory");
		} else if (argument === "--purge") {
			purge = true;
		} else if (argument !== undefined) rest.push(argument);
	}

	const named = stateDir ?? env.SQUAD_STATE;
	return { stateDir: named ?? DEFAULT_STATE_DIR, named: named !== undefined, purge, rest };
}

/**
 * Where to look when the operator did not say: the plane that is actually running.
 *
 * The default is right for the deployment and wrong for everything else, and being told "not
 * running" while a plane is up is the least useful thing this command can do. Planes label their
 * container with the directory they serve, so the answer is on the machine already. One running
 * plane is unambiguous; several are not, and there the default stands and status lists them.
 */
async function resolveStateDir(args: Args): Promise<Args> {
	if (args.named || existsSync(controlSocketPath(args.stateDir))) return args;
	const [only, ...others] = await runningPlanes().catch(() => []);
	if (only === undefined || others.length > 0) return args;
	return { ...args, stateDir: only };
}

function feed(): (event: PlaneEvent) => void {
	// Colour on a terminal and none into a pipe. A feed being read by a person is scanned down the
	// action column; one being read by `grep` is text, and escape codes in it are damage.
	const log = new LogFeed((line) => process.stdout.write(line), {
		color: process.stdout.isTTY === true,
	});
	return (event) => log.push(event);
}

async function run(path: string): Promise<number> {
	const config = await loadConfig(path);
	const plane = new ControlPlane(config);
	const server = new ControlServer({ plane });

	plane.observe(feed());

	// The socket opens before the agents do. Starting them means pulling an image, creating a volume
	// and scaffolding a repository, and an operator who asks what is happening during that minute
	// should get an answer rather than find nothing listening.
	await server.listen();
	process.stdout.write(`control socket at ${server.socketPath}\n`);
	await plane.start();
	// Counted after starting, not from the config: the agents made from the CLI in an earlier life
	// are not in that file, and a plane that reports fewer agents than it runs is worse than silence.
	process.stdout.write(`squad running with ${(await plane.agents()).length} agent(s)\n`);

	await new Promise<void>((resolve) => {
		const shutdown = (): void => {
			process.stdout.write("stopping\n");
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});

	await server.close();
	await plane.stop();
	return 0;
}

async function open(args: Args): Promise<ControlClient> {
	const client = new ControlClient(args.remote?.dial ?? args.stateDir);
	await client.connect();
	return client;
}

/**
 * The planes that do exist, for the complaint that this one does not.
 *
 * Nothing found is nearly always something found somewhere else — a demo alongside a deployment,
 * or a checkout the default knows nothing about — and "no plane where you did not look" is the
 * least useful way to say so.
 */
async function candidates(args: Args): Promise<string> {
	// A plane running on this machine is not an alternative to one the operator asked for on another
	// machine; it is a different deployment that happens to be nearby.
	if (args.remote !== undefined) return "";
	const elsewhere = (await runningPlanes().catch(() => [])).filter((dir) => dir !== args.stateDir);
	if (elsewhere.length === 0) return "";
	const lines = elsewhere.map((dir) => `  squad --state ${dir}`).join("\n");
	return `${elsewhere.length === 1 ? "A plane is" : "Planes are"} running elsewhere:\n${lines}\n`;
}

async function connect(args: Args): Promise<ControlClient> {
	try {
		return await open(args);
	} catch (error) {
		if (!(error instanceof ControlError)) throw error;
		const found = await candidates(args);
		throw new ControlError(found.length > 0 ? `${error.message}\n\n${found}` : error.message);
	}
}

async function ls(args: Args): Promise<number> {
	const client = await connect(args);
	try {
		const summaries = await client.agents();
		if (summaries.length === 0) process.stdout.write("no agents\n");
		for (const agent of summaries) process.stdout.write(`${describeAgent(agent)}\n`);
		return 0;
	} finally {
		client.close();
	}
}

/**
 * Takes an agent's sandbox away, and with --purge the repository inside it.
 *
 * Only the purge asks, because only the purge cannot be undone: a container comes back on the next
 * start with everything the agent knew, and a deleted volume takes the soul, the memory and the
 * tools it wrote with it. Typing the name is the confirmation, so a reflexive "y" cannot do it.
 */
async function rm(args: Args): Promise<number> {
	const client = await connect(args);
	try {
		const agent = await pickAgent(client, args.rest[0], "rm");
		if (args.purge) {
			if (!process.stdin.isTTY) {
				process.stderr.write("--purge deletes what the agent wrote. Run it in a terminal.\n");
				return 1;
			}
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				process.stdout.write(
					`This deletes ${agent.id}'s repository: its soul, memory, skills and tools.\n` +
						"There is no copy anywhere else.\n\n",
				);
				const typed = await rl.question(`type ${agent.id} to confirm: `);
				if (typed.trim() !== agent.id) {
					process.stdout.write("nothing removed\n");
					return 1;
				}
			} finally {
				rl.close();
			}
		}

		await client.remove(agent.id, args.purge);
		process.stdout.write(
			args.purge
				? `removed ${agent.id} and its repository\n`
				: `removed ${agent.id}'s sandbox, kept its repository\n`,
		);
		// What happens at the next restart, said now rather than left to be discovered then: without
		// the purge the agent comes back with everything it knew, and with it the name is gone for
		// good — even a declared one, whose deletion the plane writes down because the config is the
		// operator's file and no plane may write that.
		process.stdout.write(
			!args.purge
				? "kept, so it returns when the plane restarts\n"
				: agent.created
					? "made here rather than declared, so that was the last of it\n"
					: "still in the config, so the deletion is written down instead: it stays gone\n",
		);
		return 0;
	} finally {
		client.close();
	}
}

function describeAgent(agent: AgentSummary): string {
	return (
		`${agent.id}\t${agent.running ? "running" : "stopped"}` +
		`\t${agent.grants} grant(s)\t${agent.schedules} schedule(s)`
	);
}

/**
 * What `squad` alone does: open the console on the plane it finds.
 *
 * The first thing an operator types is the command with nothing after it, and what they want then
 * is to be in front of the thing rather than to be told about it. Everything the console does is
 * still a command of its own, because a pane cannot be piped into anything.
 *
 * It needs a terminal it can take over and a plane to take it over for. Missing either, `status`
 * answers instead — printed, scriptable, and the one that knows how to say there is no plane.
 */
async function console_(args: Args): Promise<number> {
	if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return status(args);

	let client: ControlClient;
	try {
		client = await open(args);
	} catch (error) {
		if (!(error instanceof ControlError)) throw error;
		return status(args);
	}

	try {
		// Imported here rather than at the top so React and Ink are loaded by the one command that
		// draws a screen. `squad run` is the plane itself, and it has no business paying for a
		// renderer — in startup time or in what ends up resident in the process holding the Docker
		// socket.
		const { openConsole } = await import("./console.ts");
		return await openConsole(client);
	} finally {
		client.close();
	}
}

/**
 * The plane's control socket, on this process's stdin and stdout.
 *
 * The door a console on another computer comes through. `ssh vps squad relay` is a connection to
 * this socket, and what travels it is the protocol a console on this machine already speaks, so the
 * two roads differ in nothing past the first byte.
 *
 * One line is printed, and only after the socket is open: the mark that says the protocol starts
 * here, so a login shell that greets its sessions is bytes the console throws away rather than the
 * first response failing to parse. Nothing else is ever written to stdout — it is the plane's for
 * the length of the connection. What goes wrong is said on stderr, which ssh keeps on a channel of
 * its own, and it is said instead of the mark rather than after it.
 */
async function relay(args: Args): Promise<number> {
	const socket = await dialLocal(args.stateDir)();
	process.stdout.write(`${RELAY_HELLO}\n`);
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	return new Promise<number>((resolve) => {
		socket.once("error", (error: Error) => {
			process.stderr.write(`${error.message}\n`);
			resolve(1);
		});
		socket.once("close", () => resolve(0));
	});
}

/**
 * Where the state is, whether a plane is up, and what is in it — in text, on the way past.
 *
 * This is what `squad` alone used to do, and it is still what it does wherever the console cannot
 * run: piped into another program, redirected into a file, or pointed at a directory no plane is
 * listening in.
 */
async function status(args: Args): Promise<number> {
	// Which machine, always, and before anything else. Once the plane can be somewhere other than
	// here, every line under this one is about a computer the reader has to be told the name of.
	process.stdout.write(
		args.remote !== undefined ? `at      ${args.remote.at}\n` : `state   ${args.stateDir}\n`,
	);

	let client: ControlClient;
	try {
		client = await open(args);
	} catch (error) {
		if (!(error instanceof ControlError)) throw error;
		process.stdout.write(`plane   not running\n\n${error.message}\n\n`);
		// Pointing at a plane that is up beats suggesting they start another one.
		const found = await candidates(args);
		process.stdout.write(
			found.length > 0
				? found
				: args.remote !== undefined
					? "  squad connect             put a plane on a machine, or choose another one\n"
					: "  squad run <config.yaml>   start one\n" +
						"  ./deploy/demo.sh up       or watch the whole thing run on throwaway names\n",
		);
		return 1;
	}

	try {
		const summaries = await client.agents();
		process.stdout.write("plane   running\n\n");
		if (summaries.length === 0) process.stdout.write("no agents\n");
		for (const agent of summaries) process.stdout.write(`${describeAgent(agent)}\n`);
		process.stdout.write(
			"\n  squad chat                talk to it\n" +
				"  squad logs                watch what it runs, answers and spends\n",
		);
		return 0;
	} finally {
		client.close();
	}
}

/**
 * Which agent to talk to: the one named, or the only one there is.
 *
 * Most planes run one agent, and making that operator type its name to reach it is asking for a
 * fact the plane already holds.
 */
async function pickAgent(
	client: ControlClient,
	named: string | undefined,
	command: string,
): Promise<AgentSummary> {
	const summaries = await client.agents();
	if (named !== undefined) {
		const found = summaries.find((agent) => agent.id === named);
		if (found === undefined) {
			const known = summaries.map((agent) => agent.id).join(", ");
			throw new ControlError(`No agent "${named}" here. This plane runs: ${known || "none"}`);
		}
		return found;
	}
	return theOnlyOne(summaries, (agent) => `  squad ${command} ${agent.id}`);
}

function theOnlyOne(
	summaries: readonly AgentSummary[],
	suggest: (agent: AgentSummary) => string,
): AgentSummary {
	const [only, ...rest] = summaries;
	if (only === undefined) throw new ControlError("This plane has no agents");
	if (rest.length > 0) {
		throw new ControlError(
			`More than one agent here. Which:\n${summaries.map(suggest).join("\n")}`,
		);
	}
	return only;
}

/**
 * Who the words are for, and which of them are the words.
 *
 * Typing the message straight after `wake` is what people do, and a plane running one agent has no
 * choice to make, so a first word that names an agent addresses it and anything else is already the
 * message. The name wins the collision: an agent called "hola" cannot be greeted with that word
 * alone, which is the cheaper of the two mistakes and the only one that says so out loud.
 */
export async function addressee(
	client: Pick<ControlClient, "agents">,
	rest: readonly string[],
): Promise<{ readonly agent: AgentSummary; readonly body: string }> {
	const summaries = await client.agents();
	const [first, ...words] = rest;
	const named = summaries.find((agent) => agent.id === first);
	if (named === undefined) {
		const body = rest.join(" ");
		return { agent: theOnlyOne(summaries, (a) => `  squad wake ${a.id} "${body}"`), body };
	}

	const body = words.join(" ");
	if (body.length === 0) throw new ControlError(`usage: squad wake ${named.id} <text>`);
	return { agent: named, body };
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Something to watch while the agent thinks, or while one is being built.
 *
 * A turn takes as long as it takes, and a terminal that has printed nothing for a minute reads as
 * one that has hung. The elapsed count is the part that earns its place: it says the wait is being
 * measured rather than merely animated, so a turn that is slow looks different from one that is
 * stuck. Only on a TTY, since piped into a file this is a line of noise per frame.
 *
 * Stopping is idempotent, because callers stop it before printing and again on the way out.
 */
function waiting(label: string): () => void {
	if (!process.stdout.isTTY) return () => {};
	const started = Date.now();
	let frame = 0;
	const draw = () => {
		const seconds = Math.round((Date.now() - started) / 1000);
		// Erase the whole line first: the frame that follows is shorter once the count rolls over.
		process.stdout.write(`\r\u001b[2K${SPINNER[frame++ % SPINNER.length]} ${label}  ${seconds}s`);
	};
	draw();
	const timer = setInterval(draw, 120);

	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		process.stdout.write("\r\u001b[2K");
	};
}

/**
 * The agent to talk to, made first if there is no such agent yet.
 *
 * Naming one that does not exist is how a new agent is asked for, because it is what an operator
 * types when they want one. It asks first: the same keystrokes are also how a typo looks, and the
 * difference between "make me an agent" and "I misspelled scout" is one the terminal can settle in
 * a second and nothing else can settle at all.
 *
 * Undefined means the operator said no, which is an answer rather than a failure.
 */
async function reach(
	client: ControlClient,
	named: string | undefined,
): Promise<AgentSummary | undefined> {
	if (named === undefined) return pickAgent(client, undefined, "chat");

	const summaries = await client.agents();
	const found = summaries.find((agent) => agent.id === named);
	if (found !== undefined) return found;

	const known = summaries.map((agent) => agent.id).join(", ");
	process.stdout.write(`No agent "${named}" here. This plane runs: ${known || "none"}\n\n`);
	if (!(await confirm(`create ${named}?`))) {
		process.stdout.write("nothing made\n");
		return undefined;
	}

	const stop = waiting(`creating ${named}`);
	try {
		const agent = await client.create(named);
		stop();
		process.stdout.write(`${named} is up, with its own repository and nothing in its memory.\n`);
		if (agent.grants === 0) process.stdout.write(UNGRANTED);
		return agent;
	} finally {
		stop();
	}
}

/**
 * What a new agent is missing when the config never said what an agent may reach.
 *
 * The model is a grant like any other here, so an agent without one cannot think — and it would
 * find that out mid-turn, as a refusal at the proxy that reads like a broken API key. Better said
 * at the moment the agent is made, with the block that fixes it.
 */
const UNGRANTED = `
It cannot reach anything yet, the model included: this plane's config has no defaults
for a new agent. Add them to it, and restart the plane:

  defaults:
    provider: deepseek
    model: deepseek-v4-flash
    env:
      DEEPSEEK_API_KEY: injected-by-the-proxy
    grants:
      - id: model
        host: api.deepseek.com
        injection:
          kind: bearer
          token: { ref: DEEPSEEK_API_KEY }
`;

/**
 * Asks, with enter meaning yes.
 *
 * No terminal to ask with is a yes, because whoever piped this in already said what they wanted and
 * there is nobody to answer. Ctrl-D is the opposite: someone is there and declined to say, which is
 * near enough to no, and certainly not a stack trace about an aborted question.
 */
async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return true;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(`${question} [Y/n] `);
		return !/^n/i.test(answer.trim());
	} catch {
		process.stdout.write("\n");
		return false;
	} finally {
		rl.close();
	}
}

/**
 * Takes a turn and prints the answer as the agent writes it.
 *
 * The spinner stops at the first word rather than at the end of the turn, because from that word on
 * there is something better to look at, and a wait that has visibly started producing an answer is
 * no longer a wait anyone needs reassuring about.
 *
 * Markdown is rendered only into a terminal. Piped, it goes through as the agent wrote it: whoever
 * redirected this into a file asked for the text, and bold is not text.
 */
async function say(
	client: ControlClient,
	agentId: string,
	body: string,
	options: { readonly stop: () => void; readonly lead?: string },
): Promise<string> {
	const out = new MarkdownStream({
		write: (chunk) => process.stdout.write(chunk),
		color: process.stdout.isTTY === true,
		width: process.stdout.columns ?? 80,
	});

	let opened = false;
	const open = (): void => {
		if (opened) return;
		opened = true;
		options.stop();
		if (options.lead !== undefined) process.stdout.write(options.lead);
	};

	try {
		const text = await client.wake(agentId, body, (delta) => {
			open();
			out.push(delta);
		});
		options.stop();
		// A plane that answered without streaming still has an answer to show, and so does one whose
		// turn produced its text only at the end.
		if (!opened && text.length > 0) {
			open();
			out.push(text);
		}
		return text;
	} finally {
		out.end();
	}
}

/**
 * A conversation with an agent: a turn per line, on the connection that already carries operator
 * trust. pi keeps a session per agent, so the agent remembers the previous line.
 */
async function chat(args: Args): Promise<number> {
	const client = await connect(args);
	try {
		const agent = await reach(client, args.rest[0]);
		if (agent === undefined) return 1;
		if (!agent.running) {
			process.stdout.write(
				`${agent.id}'s sandbox is not up. What you type stays queued until it is.\n`,
			);
		}
		process.stdout.write(`talking to ${agent.id}, as the operator. ctrl-c to leave.\n\n`);

		const rl = createInterface({ input: process.stdin, output: process.stdout });
		// question() never settles if the interface closes under it, so closing is an abort.
		const leaving = new AbortController();
		rl.once("close", () => leaving.abort());
		rl.on("SIGINT", () => rl.close());

		for (;;) {
			let line: string;
			try {
				line = await rl.question("> ");
			} catch {
				break;
			}
			if (line.trim().length === 0) continue;

			const stop = waiting("thinking");
			try {
				const text = await say(client, agent.id, line, { stop, lead: "\n" });
				if (text.length === 0) process.stdout.write("\n(nothing)\n");
				process.stdout.write("\n");
			} catch (error) {
				stop();
				// A turn that failed is not a conversation that ended: the events stay queued, and the
				// next line is a new turn. Leaving over it would throw away the session.
				process.stdout.write(`\n${(error as Error).message}\n\n`);
			}
		}

		rl.close();
		process.stdout.write("\n");
		return 0;
	} finally {
		client.close();
	}
}

async function wake(args: Args): Promise<number> {
	const { rest } = args;
	if (rest.length === 0) {
		process.stderr.write("usage: squad wake [name] <text>\n");
		return 1;
	}

	const client = await connect(args);
	let stop = (): void => {};
	try {
		// Resolved here rather than left to the plane, which queues an event for an agent it does not
		// run and answers nobody. That wait is fifteen minutes and looks exactly like thinking.
		const { agent, body } = await addressee(client, rest);
		stop = waiting("thinking");
		const text = await say(client, agent.id, body, { stop });
		if (text.length === 0) process.stdout.write("the agent said nothing\n");
		return 0;
	} finally {
		stop();
		client.close();
	}
}

async function logs(args: Args): Promise<number> {
	const client = await connect(args);
	client.logs(feed());
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => resolve());
		process.once("SIGTERM", () => resolve());
	});
	client.close();
	return 0;
}

async function main(argv: readonly string[], remote?: Remote): Promise<number> {
	// Flags are taken out before the command is chosen, so `squad --state <dir>` on its own is the
	// status of that directory rather than an unknown command.
	const parsed = { ...parseArgs(argv), ...(remote !== undefined ? { remote } : {}) };
	const [command, ...words] = parsed.rest;

	// `run` is told where its state goes; the commands that talk to a plane have to find it. Given a
	// remote there is nothing to find: the plane is the one the console was pointed at, and looking
	// at this machine's containers would answer about a different deployment.
	const connects =
		remote === undefined &&
		(command === undefined || ["ls", "chat", "wake", "logs", "rm", "relay"].includes(command));
	const args: Args = connects
		? { ...(await resolveStateDir(parsed)), rest: words }
		: { ...parsed, rest: words };

	switch (command) {
		case "run": {
			const path = words[0];
			if (path === undefined) {
				process.stderr.write("usage: squad run <config.yaml>\n");
				return 1;
			}
			return run(path);
		}
		case "ls":
			return ls(args);
		case "chat":
			return chat(args);
		case "wake":
			return wake(args);
		case "logs":
			return logs(args);
		case "rm":
			return rm(args);
		case "relay":
			// The door onto this machine's plane, so it cannot be held open on somebody else's behalf.
			if (args.remote !== undefined) {
				process.stderr.write(
					`relay is a door onto a plane here, and yours is on ${args.remote.at}\n`,
				);
				return 1;
			}
			return relay(args);
		case undefined:
			return console_(args);
		case "help":
		case "--help":
		case "-h":
			process.stdout.write(`${USAGE}\n`);
			return 0;
		default:
			process.stderr.write(`Unknown command "${command}"\n\n${USAGE}\n`);
			return 1;
	}
}

/**
 * The entry point, called by the bin rather than run on import.
 *
 * Importing this module used to take a turn: `main` ran at the top level against whatever argv the
 * importing process had, so a test that reached in for one function drove the CLI against a live
 * plane instead.
 *
 * A failure prints its message and nothing else. ConfigError and ControlError are the two that are
 * about the operator's situation rather than a defect, and a stack trace above them would bury the
 * one line that says what to do.
 */
export async function cli(argv: readonly string[], remote?: Remote): Promise<void> {
	try {
		process.exitCode = await main(argv, remote);
	} catch (error) {
		if (error instanceof ConfigError || error instanceof ControlError) {
			process.stderr.write(`${error.message}\n`);
		} else process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	}
}
