import { createContext, type ReactNode, useContext } from "react";

/**
 * A file the agent named, as a place to go rather than as characters on a screen.
 *
 * An agent talks about its work in paths, because paths are what it has: it says it wrote
 * `/home/agent/workspace/noticias/README.md`, and until now the only way to see that file was to
 * read the sentence, remember it, open the files screen and walk down to it by hand — which is the
 * same three folders the message had already named. So a path an agent writes is a link, wherever
 * it writes it: in a sentence, inside backticks, in the tree it drew of what it built.
 *
 * Nothing here decides whether the file is there. A message is a thing that was true when it was
 * written, and the box has been written to since; a link to something the agent has deleted opens
 * the files screen on the sentence that says so, which is the honest answer and the one an operator
 * can act on. What this refuses to do is guess — a name with no folder in front of it is linked only
 * where something has said which folder it is in.
 */

/**
 * The one directory an agent has, written out on this side.
 *
 * Known before anything is asked rather than read off an answer, because this is what makes a run of
 * characters in a message a path at all — there is no request whose reply could arrive in time. It
 * is `SANDBOX_HOME` in the sandbox, and the two are one edit apart on the day that moves.
 */
const HOME = "/home/agent";

/** The names at the top of the box that a path may start at without saying the home first. */
const ROOTS = "workspace|\\.self|\\.run";

/**
 * Whose box a path leads into, and what a name with no folder is read against.
 *
 * Held as context rather than passed down, because what draws a path is four levels under whoever
 * knows which agent is speaking — a message, its markdown, a line of that, a word in the line — and
 * every one of those levels would otherwise carry an argument it has no use for.
 */
export interface Box {
	/** Opens one of this agent's paths, written from its home, in the files screen. */
	readonly open: (path: string) => void;
	/**
	 * The folder a rootless name is read against, or nothing when nothing has said one.
	 *
	 * A conversation starts with nothing, and that is the point: `data/latest.md` in a sentence is a
	 * path on the agent's machine only if something nearby said where from, and a console that
	 * guessed would hand out links that go nowhere in the ordinary case of an agent discussing a
	 * repository it read. A file being read on the files screen has one — the folder it is in — which
	 * is what makes the links inside a README the files beside it.
	 */
	readonly base?: string;
}

const Whose = createContext<Box | undefined>(undefined);

export const BoxIs = Whose.Provider;

export function useBox(): Box | undefined {
	return useContext(Whose);
}

/** The path as a person writes it, for the line that says where a link goes. */
export function tilde(path: string): string {
	return path === "" ? "~" : `~/${path}`;
}

/**
 * A path written anywhere, read as somewhere inside the box — or nothing, for somewhere else.
 *
 * `~` and the home spell the same place and both arrive: the agent is told its workspace in full and
 * writes it back that way, and a person typing about it writes the short one. Everything else is
 * read against `base`, which is how a name in a drawn tree becomes the file that tree is of.
 *
 * A path that climbs out of the home comes back as nothing rather than as an error, because this is
 * asked of every run of characters in every message: `../../etc/passwd` is not an attack on a screen
 * that can only open what the plane will hand it, it is simply not a place this screen goes.
 */
export function homely(written: string, base = ""): string | undefined {
	const raw = written.trim();
	if (raw === HOME) return "";
	if (raw.startsWith(`${HOME}/`)) return settled(raw.slice(HOME.length));
	// Somewhere else on the machine. The box is the whole of what this screen shows.
	if (raw.startsWith("/")) return undefined;
	if (raw === "~") return "";
	if (raw.startsWith("~/")) return settled(raw.slice(2));
	if (raw === "") return undefined;
	return settled(`${base}/${raw}`);
}

/** The same path with `.`, `..` and doubled slashes spent, or nothing when it climbs out. */
function settled(path: string): string | undefined {
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length === 0) return undefined;
			out.pop();
			continue;
		}
		out.push(part);
	}
	return out.join("/");
}

/**
 * What a path looks like when it is written down, as something to find in a line of prose.
 *
 * Two shapes, and the difference between them is how much is being assumed. The first says where it
 * is from — the home, a `~`, or one of the names at the top of the box — and is a path no matter
 * what is around it. The second is a name with a slash in it, which is only a path once something
 * has said which folder to read it in: `./dist/index.js` says where it is from relative to
 * something, and on its own it is as likely to be a line of somebody's build output as a file in
 * here. So it is only ever looked for when there is a folder to read it against.
 *
 * The guard in front of both is what keeps `myworkspace/thing` from being found inside itself.
 */
const GUARD = String.raw`(?<![\p{L}\p{N}_/~.@+-])`;
const SAID = String.raw`\/home\/agent(?:\/\S+)?(?![\p{L}\p{N}_-])|~\/\S*|(?:${ROOTS})\/\S+`;
const GUESSED = String.raw`[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*\/?`;
const WRITTEN = new RegExp(`${GUARD}(?:${SAID})`, "gu");
const UNDER = new RegExp(`${GUARD}(?:${SAID}|${GUESSED})`, "gu");
/** Whether a run says where it is from itself, which is what a folderless one has to be told. */
const ROOTED = new RegExp(`^(?:\\/home\\/agent|~\\/|(?:${ROOTS})\\/)`, "u");

/**
 * Whether a path says for itself where it is from.
 *
 * The line between the two shapes above, asked as a question, because it is also the line between a
 * name worth drawing as a link and a name worth leaving alone when nothing has said a folder.
 */
export function rooted(written: string): boolean {
	return ROOTED.test(written);
}

/**
 * What a sentence puts after a path rather than inside one.
 *
 * The backtick and the star are in here for a reason the others are not: a path is read out of the
 * raw text of a paragraph as well as out of its prose, and in the raw text the mark an agent wrote
 * around it — `` `~/workspace` `` — is still sitting against it.
 */
const AFTER = /[.,;:!?"'`*…]/;
/** Brackets, which sit inside a name about as often as a sentence puts one around it. */
const SHUT: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * The path inside a run of characters with no spaces in it.
 *
 * The same trimming a link gets, and for the same reason: a path at the end of a sentence is
 * followed by the full stop that ended it, and one inside brackets by the bracket that shut them.
 * Neither is part of the name, and both are inside the run.
 */
function trimmed(run: string): string {
	let path = run;
	while (path.length > 0) {
		const last = path.slice(-1);
		const opener = SHUT[last];
		const outside = opener === undefined ? AFTER.test(last) : !opened(path, opener, last);
		if (!outside) break;
		path = path.slice(0, -1);
	}
	return path;
}

function opened(run: string, open: string, shut: string): boolean {
	const count = (mark: string): number => run.split(mark).length - 1;
	return count(open) >= count(shut);
}

/** Whether a rootless name is file-shaped: it ends in a folder's slash, or in an extension. */
function shaped(path: string): boolean {
	return path.endsWith("/") || /\.[\p{L}\p{N}]{1,8}$/u.test(path);
}

/**
 * Where a run of characters leads, or nothing when it is not a path this screen can open.
 *
 * A run that says where it is from is taken at its word. One that does not has to look like a file
 * and has to have a folder to be read against, and is otherwise left as the word it was — which is
 * what nearly every slash in a sentence is.
 */
function leads(run: string, base: string | undefined): string | undefined {
	if (!ROOTED.test(run)) {
		if (base === undefined || !run.includes("/") || !shaped(run)) return undefined;
	}
	return homely(run, base ?? "");
}

/** One path found in a run of text: where it starts, what was written, and where it leads. */
interface Found {
	readonly at: number;
	readonly run: string;
	readonly path: string;
}

/**
 * Every path in a run of text, in the order they were written.
 *
 * Whole strings rather than a walk character by character: this is asked of every line of every
 * message and of files up to a few megabytes, and a scan that stops at every letter to try four
 * patterns is one that is felt on the screen.
 */
function every(text: string, base: string | undefined): readonly Found[] {
	const scan = base === undefined ? WRITTEN : UNDER;
	scan.lastIndex = 0;
	const out: Found[] = [];
	for (let found = scan.exec(text); found !== null; found = scan.exec(text)) {
		const run = trimmed(found[0]);
		const path = run === "" ? undefined : leads(run, base);
		// Past this one, not past what was trimmed off it: the full stop that ended a sentence is
		// where the next one starts.
		scan.lastIndex = found.index + Math.max(1, run.length || found[0].length);
		if (path === undefined) continue;
		out.push({ at: found.index, run, path });
	}
	return out;
}

/**
 * A run of text with every path in it turned into somewhere to go.
 *
 * Comes back as the pieces rather than as one node wrapping them, so that a run with no path in it
 * comes back as the string it was and a caller can pour these straight in among its own. `seed` is
 * what keeps the keys apart when it does: the caller hands over a number nothing else it drew is
 * using, because two runs of prose in one sentence would otherwise both call their first link 0.
 */
export function paths(text: string, base: string | undefined, seed = 0): ReactNode[] {
	const out: ReactNode[] = [];
	let cut = 0;
	let key = 0;
	for (const found of every(text, base)) {
		if (found.at > cut) out.push(text.slice(cut, found.at));
		out.push(
			<FileLink key={`${seed}:${key++}`} path={found.path}>
				{found.run}
			</FileLink>,
		);
		cut = found.at + found.run.length;
	}
	if (cut < text.length) out.push(text.slice(cut));
	return out;
}

/**
 * The folder a run of prose was talking about, for whatever comes after it without one.
 *
 * "Esto es lo que hay en /home/agent/workspace:" and then a drawing of what is in there: the
 * drawing names a dozen files and not one of them says where it is, because the sentence above it
 * already did. This is that sentence, read for the one thing the drawing is missing. The last path
 * rather than the first, because a paragraph that names two is walking from one to the other.
 */
export function folderSaid(text: string, base: string | undefined): string | undefined {
	const found = every(text, base).at(-1);
	if (found === undefined) return undefined;
	// A file names its folder. "I wrote ~/workspace/news/README.md" is a sentence about `news`, and
	// what follows it is about the things beside that file rather than inside it.
	if (found.run.endsWith("/") || !/\.[\p{L}\p{N}]{1,8}$/u.test(found.run)) return found.path;
	const cut = found.path.lastIndexOf("/");
	return cut === -1 ? "" : found.path.slice(0, cut);
}

/**
 * Where a whole run of characters leads, for the places that already know they are holding one.
 *
 * Backticks are the commonest of them. An agent writes a path inside them more often than not, and
 * what is inside a pair of them is the path and nothing else — no sentence around it to trim off, no
 * guessing where it starts. The check is still the same one, so `inbox` in backticks stays a word.
 */
export function pathOf(written: string, base: string | undefined): string | undefined {
	const [found, ...rest] = every(written, base);
	if (found === undefined || rest.length > 0) return undefined;
	return found.at === 0 && found.run === written ? found.path : undefined;
}

/**
 * Where a markdown link points, when it points into the box.
 *
 * `[the log](.keep/noticias.log)` is a link this page will not hand a browser and used to be drawn
 * as the characters it was written with. It is a path, said more plainly than anywhere else in a
 * message — somebody wrote out both what it is and where it is — so it is worth reading as one,
 * down to a bare name, which is the one place a name with no folder in it is not a guess.
 */
export function linkedPath(href: string, base: string | undefined): string | undefined {
	if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
	if (!ROOTED.test(href) && (base === undefined || !shaped(href))) return undefined;
	return homely(href, base ?? "");
}

/**
 * A path, drawn as the thing it names.
 *
 * A button rather than an anchor, because that is what every other way into a folder on this console
 * already is — the rows of the files screen, the crumbs above them, the folder in a conversation's
 * header. Where there is no box behind it, which is every screen that draws a message without an
 * agent to attach it to, the text is left exactly as it was written.
 */
export function FileLink({
	path,
	chip = false,
	children,
}: {
	path: string;
	/** Whether it was written inside backticks, in which case it keeps the box they draw. */
	chip?: boolean;
	children: ReactNode;
}) {
	const box = useBox();
	const body = chip ? <code className="md-code">{children}</code> : children;
	if (box === undefined) return <>{body}</>;
	return (
		<button
			type="button"
			className={chip ? "md-path md-path-chip" : "md-path"}
			title={`open ${tilde(path)}`}
			onClick={() => box.open(path)}
		>
			{body}
		</button>
	);
}
