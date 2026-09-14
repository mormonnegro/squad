import { basename, dirname, resolve } from "node:path/posix";
import { SANDBOX_HOME } from "@squad/sandbox";

/**
 * Looking into the box, as a listing rather than as a command.
 *
 * Everything here was already possible with `!ls` and `!cat`, and that is exactly the problem: the
 * question "what has it actually got in there" is asked by walking around, and walking around by
 * typing means holding the last three answers in your head. A listing is read at a glance, a folder
 * is opened by pointing at it, and a file the agent wrote is read as the document it is.
 *
 * The other direction is the half that had no answer at all. An operator with a PDF to hand over
 * had to talk the agent into fetching it from somewhere the agent could reach, which is a web server
 * for a file you are holding. Now it is dropped on the screen, and it lands in the sandbox.
 *
 * Nothing here is a new authority. Whoever can reach the control socket already holds a shell inside
 * the container — see `shell` on the plane — so this grants no reach that was not already granted.
 * What it buys is that the question gets asked at all.
 */

/**
 * How much of a file travels in one answer, and how much of one is written in one request.
 *
 * Small enough that a line of this protocol stays a line: a frame goes through a relay that refuses
 * anything over 256 kB, and base64 is four bytes for every three. Big enough that a megabyte is
 * eight round trips rather than eighty.
 */
export const FILE_CHUNK = 128 * 1024;

/**
 * How many names one listing carries.
 *
 * A directory with more than this in it is a `node_modules`, and nobody has ever found anything by
 * scrolling one. The count of what is actually in there comes back either way, so a listing that
 * stops short says so rather than quietly being wrong about how much is there.
 */
export const MOST_ENTRIES = 1_000;

/** One name in a directory, as a row of a listing. */
export interface FileEntry {
	readonly name: string;
	readonly kind: "dir" | "file";
	/** A symlink, which is drawn as what it points at and is worth saying is one. */
	readonly link?: boolean;
	readonly size: number;
	readonly changedAt: string;
}

/**
 * What is at a path: the names in it, or the fact that it is a file.
 *
 * One answer for both because the caller asking has an address and not a promise about what is at
 * the end of it — a link to a folder that has since become a file is a link somebody will click,
 * and a screen that could only ask "what is in this directory" would have to guess first and be
 * told it guessed wrong.
 */
export type Listing =
	| {
			readonly at: string;
			readonly kind: "dir";
			readonly entries: readonly FileEntry[];
			/** How many names there are, which is more than were sent when the listing was cut short. */
			readonly total: number;
	  }
	| {
			readonly at: string;
			readonly kind: "file";
			readonly size: number;
			readonly changedAt: string;
	  };

/** As much of a file as one answer carries, from a byte offset, as base64. */
export interface Slice {
	readonly at: string;
	readonly from: number;
	readonly size: number;
	readonly changedAt: string;
	readonly data: string;
	readonly more: boolean;
}

/** What a written chunk landed as: where it is, and how much of it is there so far. */
export interface Wrote {
	readonly at: string;
	readonly size: number;
	/** Whether this was the last chunk, which is when the file arrives under its own name. */
	readonly done: boolean;
}

/**
 * A path inside the agent's home, or a refusal.
 *
 * The home and not the whole filesystem, not because the rest is dangerous — the operator has a
 * shell in there and `/etc` is a `!cat` away — but because a file browser is a place, and a place
 * has edges. Everything an agent is and everything it has built is under this one directory; the
 * rest of the container is the image it came from, and a screen that wandered into `/usr/lib` would
 * be a screen that had lost the thread of what it is showing.
 *
 * A relative path is read against the home, so `workspace/notes` is the obvious thing and `~` is
 * spelled out rather than left to mean a directory with that literal name.
 */
export function insideBox(path: string): string {
	const asked = path.startsWith("~/") ? path.slice(2) : path === "~" ? "" : path;
	const full = resolve(SANDBOX_HOME, asked);
	if (full !== SANDBOX_HOME && !full.startsWith(`${SANDBOX_HOME}/`)) {
		throw new Error(`${path} is outside ${SANDBOX_HOME}, which is the whole of what an agent has.`);
	}
	return full;
}

/** The home written the way a person writes it, for a sentence that has to hold a path. */
export function tilde(path: string): string {
	if (path === SANDBOX_HOME) return "~";
	return path.startsWith(`${SANDBOX_HOME}/`) ? `~${path.slice(SANDBOX_HOME.length)}` : path;
}

/** What a file is called, and the folder it is in, for the line that says a drop landed. */
export function nameOfPath(path: string): string {
	return basename(path);
}

export function folderOf(path: string): string {
	return dirname(path);
}

/**
 * What went wrong, in the script's own words where it had any.
 *
 * A program that exits non-zero having said nothing is a program that crashed in a way nobody wrote
 * a sentence for, and "exit 1" is not something to put in front of a person: the fallback says what
 * was being attempted, which is the part they can act on.
 */
export function refused(stderr: string, otherwise: string): string {
	const said = stderr.trim();
	return said.length > 0 ? said : otherwise;
}

/**
 * What a script inside the box printed, read back as the answer it was.
 *
 * A failure to parse is not a failure of the file: it is this console and that container disagreeing
 * about the protocol between them, which is worth saying in those words rather than as a JSON error
 * nobody can act on.
 */
export function readAnswer<T>(printed: string): T {
	try {
		return JSON.parse(printed) as T;
	} catch {
		throw new Error("The sandbox answered something this console could not read.");
	}
}

/**
 * The three programs that do the actual work, run with `node -e` inside the container.
 *
 * Node rather than a shell, and every path handed over as an argument rather than written into a
 * line, because these paths are names the agent chose: a directory called `; rm -rf ~` has to stay a
 * directory. Same reasoning as the tab completion beside them, and the same shape.
 */
export const LIST_SCRIPT = [
	'const { lstatSync, readdirSync, statSync } = require("node:fs");',
	'const { join } = require("node:path");',
	'const [, at = "/", most = "1000"] = process.argv;',
	"let here;",
	"try {",
	"\there = statSync(at);",
	"} catch (error) {",
	// A path that is not there is the commonest thing this is asked, and "ENOENT: no such file or
	// directory, stat '/home/agent/x'" is a sentence written for whoever wrote the program.
	'\tprocess.stderr.write(error.code === "ENOENT" ? "There is nothing at " + at + "." : String(error.message));',
	"\tprocess.exit(1);",
	"}",
	// A file answers as a file rather than as an error. Whoever asked had an address, and finding out
	// what is at the end of it is the question.
	"if (!here.isDirectory()) {",
	'\tprocess.stdout.write(JSON.stringify({ at, kind: "file", size: here.size, changedAt: here.mtime.toISOString() }));',
	"\tprocess.exit(0);",
	"}",
	"let read = [];",
	"try {",
	"\tread = readdirSync(at, { withFileTypes: true });",
	"} catch (error) {",
	'\tprocess.stderr.write(error.code === "EACCES" ? at + " is not readable." : String(error.message));',
	"\tprocess.exit(1);",
	"}",
	// Sorted before it is cut, so that what a shortened listing shows is the top of the alphabet
	// rather than whatever order the filesystem happened to hand over.
	"const names = read",
	"\t.map((entry) => ({ name: entry.name, dir: entry.isDirectory(), link: entry.isSymbolicLink() }))",
	"\t.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));",
	"const entries = [];",
	"for (const one of names.slice(0, Number(most))) {",
	"\tconst full = join(at, one.name);",
	"\tlet stat;",
	// A name that has gone between the listing and the stat is a name that is no longer there, which
	// is a row to leave out rather than an error to fail the whole listing with.
	"\ttry { stat = lstatSync(full); } catch { continue; }",
	"\tlet dir = one.dir;",
	"\tif (one.link) { try { dir = statSync(full).isDirectory(); } catch { dir = false; } }",
	"\tentries.push({",
	"\t\tname: one.name,",
	'\t\tkind: dir ? "dir" : "file",',
	"\t\t...(one.link ? { link: true } : {}),",
	"\t\tsize: stat.size,",
	"\t\tchangedAt: stat.mtime.toISOString(),",
	"\t});",
	"}",
	'process.stdout.write(JSON.stringify({ at, kind: "dir", total: read.length, entries }));',
].join("\n");

export const READ_SCRIPT = [
	'const { closeSync, fstatSync, openSync, readSync } = require("node:fs");',
	'const [, at = "", from = "0", most = "131072"] = process.argv;',
	"let fd;",
	"try {",
	'\tfd = openSync(at, "r");',
	"} catch (error) {",
	'\tprocess.stderr.write(error.code === "ENOENT" ? "There is nothing at " + at + "." : error.code === "EACCES" ? at + " is not readable." : String(error.message));',
	"\tprocess.exit(1);",
	"}",
	"const stat = fstatSync(fd);",
	"if (stat.isDirectory()) {",
	"\tcloseSync(fd);",
	'\tprocess.stderr.write(at + " is a directory.");',
	"\tprocess.exit(1);",
	"}",
	// Clamped rather than refused: a file that shrank between two chunks is a file being written,
	// and the honest answer to "the rest of it" is that there is none.
	"const start = Math.min(Math.max(0, Number(from)), stat.size);",
	"const room = Math.max(0, Math.min(Number(most), stat.size - start));",
	"const buffer = Buffer.alloc(room);",
	"const read = room === 0 ? 0 : readSync(fd, buffer, 0, room, start);",
	"closeSync(fd);",
	"process.stdout.write(",
	"\tJSON.stringify({",
	"\t\tat,",
	"\t\tfrom: start,",
	"\t\tsize: stat.size,",
	"\t\tchangedAt: stat.mtime.toISOString(),",
	'\t\tdata: buffer.subarray(0, read).toString("base64"),',
	"\t\tmore: start + read < stat.size,",
	"\t}),",
	");",
].join("\n");

/**
 * The one that writes. The bytes arrive on stdin as base64, a chunk per request.
 *
 * On stdin rather than in the command line for the reason everything else here is: arguments are
 * visible to every process in the container, and the other process in there is the agent.
 *
 * It is written beside the file under a name of its own and moved into place on the last chunk, so
 * that an upload that stops halfway leaves nothing the agent can mistake for a document. The offset
 * is checked against what is already there rather than trusted, because two browsers uploading the
 * same name would otherwise interleave into one file that is neither.
 */
export const WRITE_SCRIPT = [
	'const { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } = require("node:fs");',
	'const { basename, dirname, join } = require("node:path");',
	'const [, at = "", from = "0", ending = ""] = process.argv;',
	'const last = ending === "last";',
	"const into = dirname(at);",
	'const part = join(into, "." + basename(at) + ".part");',
	'const data = Buffer.from(readFileSync(0, "utf8"), "base64");',
	"try {",
	"\tif (Number(from) === 0) {",
	"\t\tmkdirSync(into, { recursive: true });",
	"\t\twriteFileSync(part, data);",
	"\t} else {",
	"\t\tconst held = statSync(part).size;",
	"\t\tif (held !== Number(from)) {",
	'\t\t\tprocess.stderr.write("Another upload of " + basename(at) + " is already in flight.");',
	"\t\t\tprocess.exit(1);",
	"\t\t}",
	"\t\tappendFileSync(part, data);",
	"\t}",
	"\tif (last) renameSync(part, at);",
	"} catch (error) {",
	'\tprocess.stderr.write(error.code === "EACCES" ? "There is no writing into " + into + "." : String(error.message));',
	"\tprocess.exit(1);",
	"}",
	"process.stdout.write(JSON.stringify({ at, size: statSync(last ? at : part).size, done: last }));",
].join("\n");
