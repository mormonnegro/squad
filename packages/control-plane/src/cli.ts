import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ConfigError, loadConfig } from "./config.ts";
import { ControlClient, ControlError } from "./control-client.ts";
import { type AgentSummary, ControlPlane, type PlaneEvent } from "./control-plane.ts";
import { runningPlanes } from "./control-relay.ts";
import { ControlServer, controlSocketPath } from "./control-server.ts";

const DEFAULT_STATE_DIR = "/var/lib/agent-dive";

const USAGE = `agent - run self-hosted cloud agents

  agent                        where the state is, and what is running in it
  agent chat [name]            talk to an agent, turn after turn
  agent ls                     what each agent is and whether it is up
  agent wake <name> <text>     take one turn, as the operator
  agent logs                   follow turns and egress decisions
  agent rm <name> [--purge]    take the sandbox away, and with --purge its
                               repository: soul, memory, skills, tools
  agent run <config.yaml>      start the control plane
  agent help                   this

The configuration names its secrets; their values come from the environment.
Commands other than "run" talk to a running plane over a socket in its state
directory: --state <dir>, or AGENT_DIVE_STATE, defaulting to ${DEFAULT_STATE_DIR}.
Told nothing, they look for the plane that is actually running.`;

interface Args {
	readonly stateDir: string;
	/** Whether the operator named the directory, rather than it being the default. */
	readonly named: boolean;
	readonly purge: boolean;
	readonly rest: readonly string[];
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

	const named = stateDir ?? env.AGENT_DIVE_STATE;
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

function describe(event: PlaneEvent): string {
	if (event.kind === "turn") return `[${event.agentId}] ${event.result.text}`;
	if (event.kind === "error") return `[${event.context}] ${event.message}`;
	const { at, agentId, outcome, method, host, path, reason } = event.entry;
	return `${at} ${agentId ?? "-"} ${outcome} ${method} ${host}${path}${reason ? ` (${reason})` : ""}`;
}

async function run(path: string): Promise<number> {
	const config = await loadConfig(path);
	const plane = new ControlPlane(config);
	const server = new ControlServer({ plane });

	plane.observe((event) => process.stdout.write(`${describe(event)}\n`));

	// The socket opens before the agents do. Starting them means pulling an image, creating a volume
	// and scaffolding a repository, and an operator who asks what is happening during that minute
	// should get an answer rather than find nothing listening.
	await server.listen();
	process.stdout.write(
		`agent-dive running with ${config.agents.length} agent(s)\n` +
			`control socket at ${server.socketPath}\n`,
	);
	await plane.start();

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

async function open(stateDir: string): Promise<ControlClient> {
	const client = new ControlClient(stateDir);
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
async function candidates(stateDir: string): Promise<string> {
	const elsewhere = (await runningPlanes().catch(() => [])).filter((dir) => dir !== stateDir);
	if (elsewhere.length === 0) return "";
	const lines = elsewhere.map((dir) => `  agent --state ${dir}`).join("\n");
	return `${elsewhere.length === 1 ? "A plane is" : "Planes are"} running elsewhere:\n${lines}\n`;
}

async function connect(stateDir: string): Promise<ControlClient> {
	try {
		return await open(stateDir);
	} catch (error) {
		if (!(error instanceof ControlError)) throw error;
		const found = await candidates(stateDir);
		throw new ControlError(found.length > 0 ? `${error.message}\n\n${found}` : error.message);
	}
}

async function ls(args: Args): Promise<number> {
	const client = await connect(args.stateDir);
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
	const client = await connect(args.stateDir);
	try {
		const agent = await pickAgent(client, args.rest[0]);
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
		// The config file is the operator's, and no plane may write it. Saying so beats letting them
		// discover it when the agent is back after a restart.
		process.stdout.write(`still in the config, so it returns when the plane restarts\n`);
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
 * What `agent` alone says: where the state is, whether a plane is up, and what is in it.
 *
 * The first thing an operator types is the command with nothing after it, and the useful answer to
 * that is the current state rather than a list of the other things they could have typed.
 */
async function status(args: Args): Promise<number> {
	const { stateDir } = args;
	process.stdout.write(`state   ${stateDir}\n`);

	let client: ControlClient;
	try {
		client = await open(stateDir);
	} catch (error) {
		if (!(error instanceof ControlError)) throw error;
		process.stdout.write(`plane   not running\n\n${error.message}\n\n`);
		// Pointing at a plane that is up beats suggesting they start another one.
		const found = await candidates(stateDir);
		process.stdout.write(
			found.length > 0
				? found
				: "  agent run <config.yaml>   start one\n" +
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
			"\n  agent chat                talk to it\n" +
				"  agent logs                follow turns and egress decisions\n",
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
async function pickAgent(client: ControlClient, named: string | undefined): Promise<AgentSummary> {
	const summaries = await client.agents();
	if (named !== undefined) {
		const found = summaries.find((agent) => agent.id === named);
		if (found === undefined) {
			const known = summaries.map((agent) => agent.id).join(", ");
			throw new ControlError(`No agent "${named}" here. This plane runs: ${known || "none"}`);
		}
		return found;
	}

	const [only, ...rest] = summaries;
	if (only === undefined) throw new ControlError("This plane has no agents");
	if (rest.length > 0) {
		const lines = summaries.map((agent) => `  agent chat ${agent.id}`).join("\n");
		throw new ControlError(`More than one agent here. Which:\n${lines}`);
	}
	return only;
}

/**
 * Something to watch while the agent thinks.
 *
 * A turn takes as long as it takes, and a terminal that has printed nothing for a minute reads as
 * one that has hung. Only on a TTY: piped into a file this would be noise in the transcript.
 */
function thinking(): () => void {
	if (!process.stdout.isTTY) return () => {};
	const frames = ["·  ", "·· ", "···"];
	let frame = 0;
	const timer = setInterval(() => {
		process.stdout.write(`\r${frames[frame++ % frames.length]}`);
	}, 300);
	return () => {
		clearInterval(timer);
		process.stdout.write("\r   \r");
	};
}

/**
 * A conversation with an agent: a turn per line, on the connection that already carries operator
 * trust. pi keeps a session per agent, so the agent remembers the previous line.
 */
async function chat(args: Args): Promise<number> {
	const client = await connect(args.stateDir);
	try {
		const agent = await pickAgent(client, args.rest[0]);
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

			const stop = thinking();
			try {
				const text = await client.wake(agent.id, line);
				stop();
				process.stdout.write(`\n${text.length > 0 ? text : "(nothing)"}\n\n`);
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
	const { stateDir, rest } = args;
	const [agentId, ...words] = rest;
	const body = words.join(" ");
	if (agentId === undefined || body.length === 0) {
		process.stderr.write("usage: agent wake <name> <text>\n");
		return 1;
	}

	const client = await connect(stateDir);
	try {
		const text = await client.wake(agentId, body);
		process.stdout.write(text.length > 0 ? `${text}\n` : "the agent said nothing\n");
		return 0;
	} finally {
		client.close();
	}
}

async function logs(args: Args): Promise<number> {
	const client = await connect(args.stateDir);
	client.logs((event) => process.stdout.write(`${describe(event)}\n`));
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => resolve());
		process.once("SIGTERM", () => resolve());
	});
	client.close();
	return 0;
}

async function main(argv: readonly string[]): Promise<number> {
	// Flags are taken out before the command is chosen, so `agent --state <dir>` on its own is the
	// status of that directory rather than an unknown command.
	const parsed = parseArgs(argv);
	const [command, ...words] = parsed.rest;

	// `run` is told where its state goes; the commands that talk to a plane have to find it.
	const connects = command === undefined || ["ls", "chat", "wake", "logs", "rm"].includes(command);
	const args: Args = connects
		? { ...(await resolveStateDir(parsed)), rest: words }
		: { ...parsed, rest: words };

	switch (command) {
		case "run": {
			const path = words[0];
			if (path === undefined) {
				process.stderr.write("usage: agent run <config.yaml>\n");
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
		case undefined:
			return status(args);
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

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	if (error instanceof ConfigError || error instanceof ControlError) {
		process.stderr.write(`${error.message}\n`);
	} else process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
}
