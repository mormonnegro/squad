import { readFile } from "node:fs/promises";
import { AGENT_NAME_PATTERN } from "@squad/agent-repo";
import type { Hook } from "@squad/channels";
import { ANY_HOST } from "@squad/proxy";
import { parse as parseYaml } from "yaml";
import type { AgentConfig, AgentDefaults, ControlPlaneOptions } from "./control-plane.ts";
import { type Model, modelEnv, modelGrants, PROVIDERS, resolveModel } from "./models.ts";
import { readPush, readRepo } from "./repos.ts";

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

/**
 * Checked rather than passed through, because this is the one setting whose failure mode is a bill.
 * A ceiling written as `"5"` or as `5 dollars` that silently did nothing would be discovered by
 * exceeding it.
 */
function checkLimit(raw: unknown, label: string, issues: string[]): void {
	if (raw === undefined) return;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		issues.push(`${label}.limitUsd must be a positive number of US dollars a day, e.g. 5`);
	}
}

/**
 * The one thing a grant on `*` may not do, checked because the alternative finds out by happening.
 *
 * A grant is a host and a credential to reach it with, and those two halves have very different
 * blast radii when the host is "anywhere": the reach is the internet, and the credential is the
 * operator's key handed to every server the agent is talked into touching. The road may be open. The
 * keys are given to somewhere by name.
 */
function checkGrants(raw: unknown, label: string, issues: string[]): void {
	if (!Array.isArray(raw)) return;
	raw.forEach((grant, index) => {
		if (!isRecord(grant)) return;
		if (grant.host !== ANY_HOST) return;
		const injection = grant.injection;
		if (isRecord(injection) && injection.kind !== "none") {
			issues.push(
				`${label}.grants[${index}] is host "*" with a ${String(injection.kind)} credential, which would put that secret on every server the agent reaches. Name the host, or use injection: { kind: none }`,
			);
		}
	});
}

/**
 * Reads one model off the list of the ones this plane may think with.
 *
 * Most of it is not written down: naming a provider the table knows says where it lives, what its
 * key is called and how the key is attached, because those are facts about the provider rather than
 * decisions the operator gets to make. What is left is the part that is theirs — which models they
 * want, and what to call each one at the console.
 */
/**
 * A repository is four words and the grants are derived from them, so what is checked here is the
 * four words: a repository GitHub could have, and branch patterns git could match. Checked rather than
 * passed through because the alternative is an agent told it holds a repository that no request will
 * ever match, which it finds out on the turn it was asked to use it.
 */
function checkRepos(raw: unknown, label: string, issues: string[]): void {
	if (raw === undefined) return;
	if (!Array.isArray(raw)) {
		issues.push(`${label}.repos must be a list, each with a repo like acme/website`);
		return;
	}
	raw.forEach((entry, index) => {
		const where = `${label}.repos[${index}]`;
		if (!isRecord(entry) || typeof entry.repo !== "string") {
			issues.push(`${where} must be a mapping with a repo, like { repo: acme/website }`);
			return;
		}
		const read = readRepo(entry.repo);
		if ("refused" in read) {
			issues.push(`${where}.repo: ${read.refused}`);
			return;
		}
		if (entry.push === undefined) return;
		if (!Array.isArray(entry.push) || !entry.push.every((one) => typeof one === "string")) {
			issues.push(`${where}.push must be a list of branch patterns, like [scout/*]`);
			return;
		}
		const push = readPush(entry.push);
		if ("refused" in push) issues.push(`${where}.push: ${push.refused}`);
	});
}

function parseModel(raw: unknown, index: number, issues: string[]): Model | undefined {
	const label = `models[${index}]`;
	if (!isRecord(raw)) {
		issues.push(`${label} must be a mapping`);
		return undefined;
	}

	const { id, provider, model, host, keyEnv, header } = raw;
	if (typeof id !== "string" || id.length === 0) {
		issues.push(`${label}.id is required: the name to pick it by, e.g. "sonnet"`);
		return undefined;
	}
	if (typeof provider !== "string" || provider.length === 0) {
		issues.push(
			`${label} ("${id}").provider is required, e.g. ${Object.keys(PROVIDERS).join(", ")}`,
		);
		return undefined;
	}

	// The key is not looked for here, and its absence is not an error. Refusing to start over a
	// variable nobody has exported yet would make the first run of this thing a configuration
	// exercise, and there is somewhere better to say it: the config screen marks the ones with no key
	// behind them, in the place where the answer is to paste one in.
	const resolved = resolveModel({
		id,
		provider,
		...(typeof model === "string" ? { model } : {}),
		...(typeof host === "string" ? { host } : {}),
		...(typeof keyEnv === "string" ? { keyEnv } : {}),
		...(typeof header === "string" ? { header } : {}),
	});
	if (typeof resolved === "string") {
		issues.push(`${label} ("${id}"): ${resolved}`);
		return undefined;
	}
	return resolved;
}

function parseModels(raw: unknown, issues: string[]): readonly Model[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		issues.push("models must be a list");
		return [];
	}

	const models: Model[] = [];
	raw.forEach((entry, index) => {
		const model = parseModel(entry, index, issues);
		if (model === undefined) return;
		if (models.some((other) => other.id === model.id)) {
			issues.push(`models[${index}]: there is already a model called "${model.id}"`);
			return;
		}
		models.push(model);
	});
	return models;
}

/**
 * Turns the models into what an agent needs to reach them: a grant each, and the placeholder keys.
 *
 * Folded into the defaults rather than handed to the plane separately, because that is what they
 * are — something true of every agent, which an agent's own block may narrow. It also means the
 * reach is decided here, in the file, and `/model` never has to widen anything to switch.
 */
function reaching(defaults: AgentDefaults | undefined, models: readonly Model[]): AgentDefaults {
	return {
		...defaults,
		// The operator's own first, so a hand-written grant on the same host is the one that matches.
		grants: [...(defaults?.grants ?? []), ...modelGrants(models)],
		// And theirs wins outright here: an operator who really does want a key inside the container
		// has said so by naming it, and this should not quietly put a placeholder over it.
		env: { ...modelEnv(models), ...defaults?.env },
	};
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
	// The id becomes the agent's name in its own manifest, so it has to be a name that manifest
	// accepts, not merely a non-empty string.
	if (typeof raw.id !== "string" || !AGENT_NAME_PATTERN.test(raw.id)) {
		issues.push(`${label}.id must be lowercase alphanumeric with dashes, e.g. "support-emma"`);
		return undefined;
	}

	const { envFrom, env: literal, ...rest } = raw;
	const resolved = {
		...(isRecord(literal) ? literal : {}),
		...parseEnvFrom(envFrom, label, env, issues),
	};
	checkLimit(raw.limitUsd, label, issues);
	checkGrants(raw.grants, label, issues);
	checkRepos(raw.repos, label, issues);

	// Grants and schedules are handed to the proxy and scheduler as written; both validate their
	// own shape and report better errors than a second copy of their rules would.
	return {
		...rest,
		...(Object.keys(resolved).length > 0 ? { env: resolved } : {}),
	} as unknown as AgentConfig;
}

/**
 * What every agent starts from, including one made from the CLI a month after this file was
 * written.
 *
 * An agent with no grants cannot reach the model, so without this an agent created at runtime
 * would be born unable to think, and the only cure would be editing the config and restarting the
 * plane. Putting the answer here keeps the rule intact: capabilities come from the operator's
 * file, never from the agent or from whoever typed its name.
 */
function parseDefaults(
	raw: unknown,
	env: NodeJS.ProcessEnv,
	issues: string[],
): AgentDefaults | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) {
		issues.push("defaults must be a mapping");
		return undefined;
	}
	if ("id" in raw) issues.push("defaults.id: defaults describe every agent, so they name none");

	const { envFrom, env: literal, ...rest } = raw;
	const resolved = {
		...(isRecord(literal) ? literal : {}),
		...parseEnvFrom(envFrom, "defaults", env, issues),
	};
	checkLimit(raw.limitUsd, "defaults", issues);
	checkGrants(raw.grants, "defaults", issues);
	checkRepos(raw.repos, "defaults", issues);

	return {
		...rest,
		...(Object.keys(resolved).length > 0 ? { env: resolved } : {}),
	} as unknown as AgentDefaults;
}

export interface LoadedConfig extends ControlPlaneOptions {
	readonly agents: readonly AgentConfig[];
	readonly stateDir: string;
	/** Empty when the file declares none, which is a plane whose agents think with what pi is set up for. */
	readonly models: readonly Model[];
}

/**
 * Refuses a model nobody configured, wherever it was named.
 *
 * With a `models` block the name of a model is a name off that list, and a string that is not on it
 * is not an exotic model — it is a typo, or a model whose key nobody exported. Passing it through
 * would hand it to pi, which fails the turn with a message about a provider rather than about the
 * line that was mistyped.
 */
function checkModel(id: unknown, label: string, models: readonly Model[], issues: string[]): void {
	if (typeof id !== "string" || models.some((model) => model.id === id)) return;
	issues.push(
		`${label}.model is "${id}", which is not one of the models configured: ${models.map((model) => model.id).join(", ")}`,
	);
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

	const models = parseModels(raw.models, issues);
	const declared = parseDefaults(raw.defaults, env, issues);
	const defaults = models.length > 0 ? reaching(declared, models) : declared;

	const parsedAgents: AgentConfig[] = [];
	if (Array.isArray(agents)) {
		agents.forEach((entry, index) => {
			const agent = parseAgent(entry, index, env, issues);
			if (agent) parsedAgents.push(agent);
		});
	}

	if (models.length > 0) {
		checkModel(defaults?.model, "defaults", models, issues);
		for (const agent of parsedAgents)
			checkModel(agent.model, `agent "${agent.id}"`, models, issues);
		// The provider is the model's, and a line here that decides nothing is a line somebody will
		// edit expecting it to.
		if (defaults?.provider !== undefined)
			issues.push("defaults.provider: with models configured, the provider comes from the model");
		for (const agent of parsedAgents) {
			if (agent.provider !== undefined)
				issues.push(
					`agent "${agent.id}".provider: with models configured, the provider comes from the model`,
				);
		}
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
		models,
		// After the spread, so the resolved block replaces the one still holding envFrom names.
		defaults,
	} as LoadedConfig;
}

export async function loadConfig(path: string, env?: NodeJS.ProcessEnv): Promise<LoadedConfig> {
	return parseConfig(await readFile(path, "utf8"), env);
}
