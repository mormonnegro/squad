#!/usr/bin/env node
import { ConfigError, loadConfig } from "./config.ts";
import { ControlPlane } from "./control-plane.ts";

const USAGE = `agent-dive - run self-hosted cloud agents

Usage:
  agent-dive <config.yaml>

The configuration names its secrets; their values come from the environment.`;

async function main(argv: readonly string[]): Promise<number> {
	const path = argv[0];
	if (path === undefined || path === "--help" || path === "-h") {
		process.stdout.write(`${USAGE}\n`);
		return path === undefined ? 1 : 0;
	}

	const config = await loadConfig(path);
	const plane = new ControlPlane({
		...config,
		onError: (context, error) => {
			process.stderr.write(`[${context}] ${error.message}\n`);
		},
		onAudit: (entry) => {
			process.stdout.write(
				`${entry.at} ${entry.agentId ?? "-"} ${entry.outcome} ${entry.method} ${entry.host}${entry.path}` +
					`${entry.reason ? ` (${entry.reason})` : ""}\n`,
			);
		},
	});

	await plane.start();
	process.stdout.write(`agent-dive running with ${config.agents.length} agent(s)\n`);

	await new Promise<void>((resolve) => {
		const shutdown = (): void => {
			process.stdout.write("stopping\n");
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});

	await plane.stop();
	return 0;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	if (error instanceof ConfigError) process.stderr.write(`${error.message}\n`);
	else process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
}
