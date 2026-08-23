import {
	MANIFEST_FILE,
	SANDBOX_REPO_PATH,
	type ScaffoldFile,
	scaffoldAgentRepo,
} from "@agent-dive/agent-repo";
import type { TurnSandbox } from "./turn.ts";

export interface EnsureSelfRepoOptions {
	readonly sandbox: TurnSandbox;
	readonly agentId: string;
	readonly description?: string;
	readonly model?: string;
	readonly root?: string;
}

/**
 * Puts a repository in the agent's volume the first time it boots, and never again.
 *
 * The repository is the agent rather than a copy of it: soul, skills and memory are files it may
 * edit and commit, so anything written here later would be the control plane overwriting the
 * agent's own work. Presence of the manifest is what marks the volume as already claimed.
 *
 * The files are written from inside the sandbox because that is the only place the volume exists;
 * the control plane cannot see it as a directory.
 */
export async function ensureSelfRepo(options: EnsureSelfRepoOptions): Promise<boolean> {
	const root = options.root ?? SANDBOX_REPO_PATH;
	const { sandbox, agentId } = options;

	const existing = await sandbox.run(agentId, ["test", "-f", `${root}/${MANIFEST_FILE}`], "");
	if (existing.exitCode === 0) return false;

	for (const file of scaffoldAgentRepo({
		name: agentId,
		...(options.description !== undefined ? { description: options.description } : {}),
		...(options.model !== undefined ? { model: options.model } : {}),
	})) {
		await write(sandbox, agentId, `${root}/${file.path}`, file.content);
	}

	// A repository, so the agent can see what it changed about itself and undo it. Identity is set
	// locally because there is no global git config in the sandbox and a commit without one fails.
	await sandbox.run(
		agentId,
		[
			"sh",
			"-c",
			'cd "$1" && git init -q && git config user.name "$2" && git config user.email "$2@agent-dive.local" && git add -A && git commit -qm "scaffold"',
			"sh",
			root,
			agentId,
		],
		"",
	);
	return true;
}

/** Writes one file, with its content on stdin so nothing in it is ever parsed as a command. */
async function write(
	sandbox: TurnSandbox,
	agentId: string,
	path: string,
	content: ScaffoldFile["content"],
): Promise<void> {
	const result = await sandbox.run(
		agentId,
		["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
		content,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Could not write ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
		);
	}
}
