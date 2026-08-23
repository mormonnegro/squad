#!/usr/bin/env node
import { ConfigError, loadConfig } from "./config.ts";
import { ControlClient, ControlError } from "./control-client.ts";
import { ControlPlane, type PlaneEvent } from "./control-plane.ts";
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

	await plane.start();
	await server.listen();
	process.stdout.write(
		`agent-dive running with ${config.agents.length} agent(s)\n` +
			`control socket at ${server.socketPath}\n`,
	);

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

async function agents(argv: readonly string[]): Promise<number> {
	const client = await connect(parseArgs(argv).stateDir);
	try {
		const summaries = await client.agents();
		if (summaries.length === 0) process.stdout.write("no agents\n");
		for (const agent of summaries) {
			process.stdout.write(
				`${agent.id}\t${agent.running ? "running" : "stopped"}` +
					`\t${agent.grants} grant(s)\t${agent.schedules} schedule(s)\n`,
			);
		}
		return 0;
	} finally {
		client.close();
	}
}

async function wake(argv: readonly string[]): Promise<number> {
	const { stateDir, rest } = parseArgs(argv);
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

async function logs(argv: readonly string[]): Promise<number> {
	const client = await connect(parseArgs(argv).stateDir);
	client.logs((event) => process.stdout.write(`${describe(event)}\n`));
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => resolve());
		process.once("SIGTERM", () => resolve());
	});
	client.close();
	return 0;
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;

	switch (command) {
		case "run": {
			const path = rest[0];
			if (path === undefined) {
				process.stderr.write("usage: agent run <config.yaml>\n");
				return 1;
			}
			return run(path);
		}
		case "agents":
			return agents(rest);
		case "wake":
			return wake(rest);
		case "logs":
			return logs(rest);
		case undefined:
			process.stdout.write(`${USAGE}\n`);
			return 1;
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
