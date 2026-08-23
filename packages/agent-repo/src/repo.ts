import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentManifest, ManifestError, parseManifest } from "./manifest.ts";

export const MANIFEST_FILE = "agent.yaml";
export const SOUL_FILE = "soul.md";
export const SKILLS_DIR = "skills";
export const MEMORY_DIR = "memory";
export const TOOLS_DIR = "tools";
export const MCP_FILE = "mcp.json";

/** Memory is partitioned so the agent can scope what it recalls to the subject at hand. */
export const MEMORY_PARTITIONS = ["users", "projects", "reference"] as const;

/** Mount point of the agent repository inside its sandbox. */
export const SANDBOX_REPO_PATH = "/home/agent/.self";

export interface AgentDefinition {
	readonly root: string;
	readonly manifest: AgentManifest;
	/** Persona and operating instructions, prepended to the system prompt. Empty when absent. */
	readonly soul: string;
	/** Handed to pi's loadSkills; pi owns SKILL.md parsing. */
	readonly skillsDir: string;
	readonly memoryDir: string;
	readonly toolsDir: string;
	readonly mcpConfigPath: string;
}

export class AgentRepoError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AgentRepoError";
	}
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Reads an agent repository from disk. Pass the host path when inspecting it from the control
 * plane, or {@link SANDBOX_REPO_PATH} when running inside the sandbox.
 */
export async function loadAgentRepo(root: string): Promise<AgentDefinition> {
	const manifestPath = join(root, MANIFEST_FILE);
	const manifestSource = await readOptionalFile(manifestPath);
	if (manifestSource === undefined) {
		throw new AgentRepoError(`No ${MANIFEST_FILE} found at ${root}`);
	}

	let manifest: AgentManifest;
	try {
		manifest = parseManifest(manifestSource);
	} catch (error) {
		if (error instanceof ManifestError) {
			throw new AgentRepoError(`${manifestPath}: ${error.message}`, { cause: error });
		}
		throw error;
	}

	return {
		root,
		manifest,
		soul: (await readOptionalFile(join(root, SOUL_FILE))) ?? "",
		skillsDir: join(root, SKILLS_DIR),
		memoryDir: join(root, MEMORY_DIR),
		toolsDir: join(root, TOOLS_DIR),
		mcpConfigPath: join(root, MCP_FILE),
	};
}

export interface InitAgentRepoOptions {
	readonly name: string;
	readonly description?: string;
	readonly model?: string;
}

/** Scaffolds an empty agent repository. */
export async function initAgentRepo(
	root: string,
	options: InitAgentRepoOptions,
): Promise<AgentDefinition> {
	await mkdir(join(root, SKILLS_DIR), { recursive: true });
	await mkdir(join(root, TOOLS_DIR), { recursive: true });
	for (const partition of MEMORY_PARTITIONS) {
		await mkdir(join(root, MEMORY_DIR, partition), { recursive: true });
	}

	const manifestLines = [`name: ${options.name}`];
	if (options.description !== undefined) manifestLines.push(`description: ${options.description}`);
	if (options.model !== undefined) manifestLines.push(`model: ${options.model}`);
	manifestLines.push(
		"",
		"# Capabilities this agent asks for. These are requests, not grants:",
		"# an operator approves them in the control plane before any traffic is allowed.",
		"requests: []",
		"",
	);

	await writeFile(join(root, MANIFEST_FILE), manifestLines.join("\n"), "utf8");
	await writeFile(
		join(root, SOUL_FILE),
		`# ${options.name}\n\n${options.description ?? "Describe who this agent is and how it works."}\n`,
		"utf8",
	);
	await writeFile(join(root, MCP_FILE), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8");

	return loadAgentRepo(root);
}
