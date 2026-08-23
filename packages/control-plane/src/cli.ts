import { ConfigError, loadConfig } from "./config.ts";
import { ControlClient, ControlError } from "./control-client.ts";
import { type AgentSummary, ControlPlane, type PlaneEvent } from "./control-plane.ts";
import { ControlServer } from "./control-server.ts";

const DEFAULT_STATE_DIR = "/var/lib/agent-dive";

const USAGE = `agent - run self-hosted cloud agents

  agent run <config.yaml>      start the control plane
  agent agents                 what each agent is and whether it is up
  agent wake <name> <text>     take a turn, as the operator
  agent logs                   follow turns and egress decisions

The configuration names its secrets; their values come from the environment.
Commands other than "run" talk to a running plane over a socket in its state
directory: --state <dir>, or AGENT_DIVE_STATE, defaulting to ${DEFAULT_STATE_DIR}.`;

interface Args {
	readonly stateDir: string;
	readonly rest: readonly string[];
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Args {
	const rest: string[] = [];
	let stateDir: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const argument = argv[i];
		if (argument === "--state") {
			stateDir = argv[++i];
			if (stateDir === undefined) throw new ControlError("--state needs a directory");
		} else if (argument !== undefined) rest.push(argument);
	}

	return { stateDir: stateDir ?? env.AGENT_DIVE_STATE ?? DEFAULT_STATE_DIR, rest };
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

async function connect(stateDir: string): Promise<ControlClient> {
	const client = new ControlClient(stateDir);
	await client.connect();
	return client;
}

async function agents(args: Args): Promise<number> {
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
		client = await connect(stateDir);
	} catch (error) {
		if (!(error instanceof ControlError)) throw error;
		process.stdout.write(`plane   not running\n\n${error.message}\n\n`);
		process.stdout.write(
			"  agent run <config.yaml>   start one\n" +
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
			'\n  agent wake <name> "..."   take a turn, as the operator\n' +
				"  agent logs                follow turns and egress decisions\n",
		);
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
	const { stateDir, rest } = parseArgs(argv);
	const [command, ...words] = rest;
	const args: Args = { stateDir, rest: words };

	switch (command) {
		case "run": {
			const path = words[0];
			if (path === undefined) {
				process.stderr.write("usage: agent run <config.yaml>\n");
				return 1;
			}
			return run(path);
		}
		case "agents":
			return agents(args);
		case "wake":
			return wake(args);
		case "logs":
			return logs(args);
		case undefined:
			return status(args);
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
