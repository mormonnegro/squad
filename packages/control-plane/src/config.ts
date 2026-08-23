import { readFile } from "node:fs/promises";
import type { Hook } from "@agent-dive/channels";
import { parse as parseYaml } from "yaml";
import type { AgentConfig, ControlPlaneOptions } from "./control-plane.ts";

export class ConfigError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a secret from the environment rather than the file.
 *
 * The configuration names its secrets and the process holds them. That way the file describing what
 * an agent may reach can be committed, reviewed and diffed like anything else, which is the only
 * way capability changes get noticed.
 */
function secretFromEnv(
	name: string,
	label: string,
	env: NodeJS.ProcessEnv,
	issues: string[],
): string | undefined {
	const value = env[name];
	if (value === undefined || value.length === 0) {
		issues.push(`${label} reads ${name} from the environment, which is not set`);
		return undefined;
	}
	return value;
}

function parseHook(
	raw: unknown,
	index: number,
	env: NodeJS.ProcessEnv,
	issues: string[],
): Hook | undefined {
	const label = `hooks[${index}]`;
	if (!isRecord(raw)) {
		issues.push(`${label} must be a mapping`);
		return undefined;
	}

	const { id, agentId, secretEnv, trust, replyUrl } = raw;
	if (typeof id !== "string" || id.length === 0) issues.push(`${label}.id is required`);
	if (typeof agentId !== "string" || agentId.length === 0)
		issues.push(`${label}.agentId is required`);
	if (typeof secretEnv !== "string" || secretEnv.length === 0) {
		issues.push(`${label}.secretEnv is required`);
		return undefined;
	}
	if (trust === "operator") {
		issues.push(`${label}.trust cannot be operator: a hook proves the sender, not the intent`);
	}

	const secret = secretFromEnv(secretEnv, label, env, issues);
	if (typeof id !== "string" || typeof agentId !== "string" || secret === undefined)
		return undefined;

	return {
		id,
		agentId,
		secret,
		...(trust === "participant" || trust === "public" ? { trust } : {}),
		...(typeof replyUrl === "string" ? { replyUrl } : {}),
	};
}

/**
 * Resolves `envFrom`, which names the control plane's variables instead of quoting their values.
 *
 * An agent needs at least a model key inside its sandbox, and writing that key here would put a
 * live credential in the one file that is meant to be committed.
 */
function parseEnvFrom(
	raw: unknown,
	label: string,
	env: NodeJS.ProcessEnv,
	issues: string[],
): Record<string, string> {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		issues.push(`${label}.envFrom must be a mapping of container variable to source variable`);
		return {};
	}

	const resolved: Record<string, string> = {};
	for (const [name, source] of Object.entries(raw)) {
		if (typeof source !== "string" || source.length === 0) {
			issues.push(`${label}.envFrom.${name} must name an environment variable`);
			continue;
		}
		const value = secretFromEnv(source, `${label}.envFrom.${name}`, env, issues);
		if (value !== undefined) resolved[name] = value;
	}
	return resolved;
}

function parseAgent(
	raw: unknown,
	index: number,
	env: NodeJS.ProcessEnv,
	issues: string[],
): AgentConfig | undefined {
	const label = `agents[${index}]`;
	if (!isRecord(raw)) {
		issues.push(`${label} must be a mapping`);
		return undefined;
	}
	if (typeof raw.id !== "string" || raw.id.length === 0) {
		issues.push(`${label}.id is required`);
		return undefined;
	}

	const { envFrom, env: literal, ...rest } = raw;
	const resolved = {
		...(isRecord(literal) ? literal : {}),
		...parseEnvFrom(envFrom, label, env, issues),
	};

	// Grants and schedules are handed to the proxy and scheduler as written; both validate their
	// own shape and report better errors than a second copy of their rules would.
	return {
		...rest,
		...(Object.keys(resolved).length > 0 ? { env: resolved } : {}),
	} as unknown as AgentConfig;
}

export interface LoadedConfig extends ControlPlaneOptions {
	readonly agents: readonly AgentConfig[];
	readonly stateDir: string;
}

export function parseConfig(source: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
	const issues: string[] = [];

	let raw: unknown;
	try {
		raw = parseYaml(source);
	} catch (error) {
		throw new ConfigError([`could not parse YAML: ${(error as Error).message}`]);
	}
	if (!isRecord(raw)) throw new ConfigError(["configuration must be a YAML mapping"]);

	const { stateDir, agents, hooks } = raw;
	if (typeof stateDir !== "string" || stateDir.length === 0) issues.push("stateDir is required");
	if (!Array.isArray(agents) || agents.length === 0) issues.push("agents must be a non-empty list");

	const parsedAgents: AgentConfig[] = [];
	if (Array.isArray(agents)) {
		agents.forEach((entry, index) => {
			const agent = parseAgent(entry, index, env, issues);
			if (agent) parsedAgents.push(agent);
		});
	}

	const parsedHooks: Hook[] = [];
	if (hooks !== undefined) {
		if (!Array.isArray(hooks)) issues.push("hooks must be a list");
		else {
			hooks.forEach((entry, index) => {
				const hook = parseHook(entry, index, env, issues);
				if (hook) parsedHooks.push(hook);
			});
		}
	}

	const known = new Set(parsedAgents.map((agent) => agent.id));
	for (const hook of parsedHooks) {
		if (!known.has(hook.agentId))
			issues.push(`hook "${hook.id}" points at unknown agent "${hook.agentId}"`);
	}

	if (issues.length > 0) throw new ConfigError(issues);

	return {
		...(raw as Record<string, unknown>),
		stateDir: stateDir as string,
		agents: parsedAgents,
		hooks: parsedHooks,
	} as LoadedConfig;
}

export async function loadConfig(path: string, env?: NodeJS.ProcessEnv): Promise<LoadedConfig> {
	return parseConfig(await readFile(path, "utf8"), env);
}
