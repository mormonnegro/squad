/** Where the agent lives, which is the directory its repository sits in. */
const HOME = "/home/agent";

/**
 * A directory as a prompt says it: short enough to leave room for the line being typed.
 *
 * The home becomes `~` and the front of a long path is what goes, because the end of it is where
 * you are and the front is the part you already know.
 *
 * Copied from the terminal console's prompt, which is built out of the plane and cannot come into
 * a browser bundle. The two prompts say the same directory the same way — a person who has typed
 * `!` in one of them has already read this — and the test holds both and fails the day they
 * disagree.
 */
export function here(cwd: string, room = 24): string {
	const short = cwd === HOME || cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd;
	return short.length <= room ? short : `…${short.slice(short.length - room + 1)}`;
}
