import { SANDBOX_REPO_PATH, SKILLS_DIR } from "@squad/agent-repo";
import type { TurnSandbox } from "./turn.ts";

/**
 * One thing an agent knows how to do, written down where it will be read again.
 *
 * A folder with a `SKILL.md` in it, which is the format the harness already loads: a name, a line
 * about when it applies, and then the procedure. The point of writing one is that the agent stops
 * working the same thing out from scratch every time — and the point of these three fields is that
 * a person can see, from a list, what their agent has learned.
 *
 * They live in the agent's own repository, so a skill travels with the agent and is versioned by the
 * same commits as everything else about it. Nothing here writes one: the agent writes its own,
 * because it is the one that knows what it just did.
 */
export interface Skill {
	readonly name: string;
	/** The `description:` from the front matter, which is what the harness matches against. */
	readonly does: string;
	/** How many lines the procedure runs to. A skill nobody trimmed is a skill nobody reads. */
	readonly lines: number;
}

/** Where a skill lives inside an agent, given the repository root the sandbox mounts. */
export function skillPath(name: string, root: string = SANDBOX_REPO_PATH): string {
	return `${root}/${SKILLS_DIR}/${name}`;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function nameRefused(name: string): string | undefined {
	if (name.length === 0) return "A skill needs a name.";
	if (!NAME.test(name)) {
		return `"${name}" will not do as a skill name: lowercase letters, digits and dashes, starting with a letter or a digit.`;
	}
	return undefined;
}

/**
 * Reads front matter without a YAML parser.
 *
 * What is wanted is one field out of the two or three anybody writes, and the alternative is a
 * dependency in the control plane for a file the harness has already parsed its own way. A skill
 * whose front matter is exotic enough to defeat this still works; it just lists without a sentence.
 */
export function describedIn(text: string): string {
	// Leading blank lines tolerated: what is passed in has come off a `cat` in a listing, and a file
	// that begins with one is a file, not a broken skill.
	const fence = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const head = fence?.[1] ?? "";
	const said = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? "";
	return said.replace(/^["']|["']$/g, "");
}

/** What the listing script puts between a name and its file, chosen so no SKILL.md contains it. */
const BETWEEN = "<<squad-skill>>";

/**
 * What an agent knows, read out of its own repository.
 *
 * One command rather than one per skill: every round trip here is an exec into a container, and a
 * list of six skills should not be six of them. Anything unreadable is left out rather than
 * reported — a folder without a SKILL.md is not a broken skill, it is not a skill.
 */
export async function skillsOf(
	sandbox: TurnSandbox,
	agentId: string,
	root: string = SANDBOX_REPO_PATH,
): Promise<readonly Skill[]> {
	const script = [
		`cd "$1/${SKILLS_DIR}" 2>/dev/null || exit 0`,
		"for d in */; do",
		'  [ -f "$d/SKILL.md" ] || continue',
		'  printf "%s%s\\n" "${d%/}" "$2"',
		'  cat "$d/SKILL.md"',
		'  printf "%s\\n" "$2"',
		"done",
	].join("\n");
	const result = await sandbox.run(agentId, ["sh", "-c", script, "sh", root, BETWEEN], "");
	if (result.exitCode !== 0) return [];
	return readSkills(result.stdout);
}

/** The half of the above that is arithmetic, so it can be tested without a container. */
export function readSkills(printed: string): readonly Skill[] {
	const skills: Skill[] = [];
	// Name, marker, the file, marker — so the parts alternate, and the name of the next one is
	// whatever was left after the marker that closed the last.
	const parts = printed.split(BETWEEN);
	for (let at = 0; at + 1 < parts.length; at += 2) {
		const name = (parts[at] ?? "").trim();
		const text = parts[at + 1] ?? "";
		if (name.length === 0) continue;
		skills.push({
			name,
			does: describedIn(text),
			lines: text.trim().split("\n").length,
		});
	}
	return skills;
}

/**
 * Copies one skill from one agent to another.
 *
 * Through a tarball on stdin rather than file by file: a skill is a folder, and the scripts and
 * reference files beside the `SKILL.md` are half of what makes one worth copying. Base64 because
 * what runs between the two ends is a shell, and a shell is not a place to put arbitrary bytes.
 *
 * The copy is a copy. The agent it lands in owns it from then on and may edit it into something
 * else, which is what happens when a person is taught something too.
 */
export async function copySkill(
	sandbox: TurnSandbox,
	from: string,
	to: string,
	name: string,
	root: string = SANDBOX_REPO_PATH,
): Promise<void> {
	const refused = nameRefused(name);
	if (refused !== undefined) throw new Error(refused);

	const packed = await sandbox.run(
		from,
		[
			"sh",
			"-c",
			`cd "$1/${SKILLS_DIR}" && [ -d "$2" ] && tar -cz "$2" | base64 | tr -d "\\n"`,
			"sh",
			root,
			name,
		],
		"",
	);
	if (packed.exitCode !== 0 || packed.stdout.trim().length === 0) {
		throw new Error(`${from} has no skill called "${name}".`);
	}

	const landed = await sandbox.run(
		to,
		[
			"sh",
			"-c",
			`mkdir -p "$1/${SKILLS_DIR}" && cd "$1/${SKILLS_DIR}" && base64 -d | tar -xz`,
			"sh",
			root,
		],
		packed.stdout.trim(),
	);
	if (landed.exitCode !== 0) {
		throw new Error(`${name} did not land in ${to}: ${landed.stderr.trim() || "the copy failed"}`);
	}
}
