import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the agents live, as answered once and remembered.
 *
 * Two doors, and the difference between them is only how the first byte gets there: a plane in a
 * container on this computer, or a plane on a machine this computer has SSH to. There is a third
 * door coming — a hosted one — and it will be a third arm here rather than a change to these two.
 */
export type Plane =
	| { readonly kind: "here"; readonly stateDir: string }
	| { readonly kind: "server"; readonly target: string };

/**
 * The client's own directory, which is not the plane's.
 *
 * Everything in here belongs to the person rather than to the deployment: which plane they chose,
 * and the SSH control sockets that keep the second connection cheap. A local plane's state goes
 * under it too, but as a directory of its own that the server half owns.
 *
 * Overridable because the tests need somewhere that is not the home directory of whoever is
 * running them.
 */
export function clientHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.SQUAD_HOME ?? join(homedir(), ".squad");
}

export function planePath(home: string): string {
	return join(home, "plane.json");
}

/** The state directory a plane installed on this computer serves. */
export function localStateDir(home: string): string {
	return join(home, "state");
}

/**
 * The plane last chosen, or nothing at all.
 *
 * A file that is missing, unreadable or no longer shaped like an answer all mean the same thing to
 * the caller: ask again. The question costs one keystroke, and refusing to start because a small
 * JSON file went bad would be the worse trade.
 */
export async function readPlane(home: string): Promise<Plane | undefined> {
	const text = await readFile(planePath(home), "utf8").catch(() => undefined);
	if (text === undefined) return undefined;

	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.kind === "here" && typeof record.stateDir === "string") {
			return { kind: "here", stateDir: record.stateDir };
		}
		if (record.kind === "server" && typeof record.target === "string") {
			return { kind: "server", target: record.target };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export async function writePlane(home: string, plane: Plane): Promise<void> {
	await mkdir(home, { recursive: true });
	await writeFile(planePath(home), `${JSON.stringify(plane, null, "\t")}\n`);
}

/** How the plane is named on screen: an address for a server, a directory for a plane here. */
export function describePlane(plane: Plane): string {
	return plane.kind === "server" ? plane.target : plane.stateDir;
}

/**
 * A bare address is the common case, and root is who a fresh VPS gives you.
 *
 * `ssh://` is stripped because it is what a hosting panel shows and pasting it is the obvious move.
 */
export function normalizeTarget(target: string): string {
	const trimmed = target.trim().replace(/^ssh:\/\//, "");
	return trimmed.includes("@") ? trimmed : `root@${trimmed}`;
}
