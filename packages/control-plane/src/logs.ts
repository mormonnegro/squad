/**
 * What the thing behind a served port is printing.
 *
 * A port an agent serves is the one part of its work an operator watches rather than reads about:
 * you click `:3005`, the page is white, and the question is what the server said about it. Until
 * now the only way to that answer was to spend a turn asking the agent to `tail` its own log —
 * which is a conversation about a file, in a thread that is supposed to be about the work.
 *
 * Nothing here starts the server or holds its output. The plane did not spawn it and has no pipe on
 * it: what this does is what a person would do at a prompt in that container — find the process
 * listening on the port, look at where its stdout goes, and read that file. When the output goes
 * somewhere a reader cannot follow it — a pipe, a terminal, `/dev/null` — that is an answer too,
 * and the screen says it in those words rather than showing an empty box.
 *
 * `/proc` and not `lsof` or `ss`, neither of which is in the image, and node rather than a shell
 * because these are the same three reads either way and one of them is a directory of every process
 * in the box.
 */

/**
 * How much of a log one answer carries.
 *
 * The same bound a file slice has, for the same reason: a frame through a relay in front of a plane
 * that is not on this machine is refused over a quarter of a megabyte. As a first look it is the
 * last 128 kB of the file, which is a thousand-odd lines of a dev server — far more than the reason
 * anybody opened it, and the reason is always near the bottom.
 */
export const LOG_CHUNK = 128 * 1024;

/**
 * What is printing on a port, and how much of it this answer carries.
 *
 * The four states are all worth telling apart, and the screen says a different sentence for each:
 * nothing is listening; something is listening and its output goes where nobody can read it;
 * something is listening and writing to a file; nothing is listening any more but the file it was
 * writing to is still there — which is the state a server is in about a second after it crashed,
 * and the one the log was wanted for.
 */
export interface Printed {
	readonly port: number;
	/** Whether anything holds that port inside the box at all. */
	readonly listening: boolean;
	readonly pid?: number;
	/** What it was started as, so the screen can say whose output this is. */
	readonly cmd?: string;
	/** Where its output goes: a path when that is a file, and what it is instead when it is not. */
	readonly to?: string;
	/** The file being read, which is absent when there is none to read. */
	readonly at?: string;
	readonly from: number;
	readonly size: number;
	/** The bytes, base64 — a log is text until the day something writes a byte that is not. */
	readonly data: string;
	/** The file is shorter than where the last answer left off, so it was started again. */
	readonly restarted: boolean;
}

/**
 * The program that does it, run with `node -e` inside the container.
 *
 * `/proc` is an argument rather than a constant so this can be run against a made-up one: what is
 * worth testing here is the reading — hex ports, listening sockets, an inode found again as a file
 * descriptor of some process — and a test that could only run against a live kernel would be a test
 * that never runs.
 *
 * Every path it opens it found in `/proc` itself or was handed back from its own last answer, so
 * none of them is a name the agent chose. They still go in as arguments rather than into a shell
 * line, because the file the server writes to is under a directory the agent named.
 */
export const LOGS_SCRIPT = [
	'const { closeSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync } = require("node:fs");',
	'const { join } = require("node:path");',
	'const [, proc = "/proc", said = "0", from = "-1", most = "131072", was = ""] = process.argv;',
	"const port = Number(said);",
	"",
	// The listening sockets on that port, as the inode numbers they are known by everywhere else in
	// /proc. Both tables every time: a server bound to `::` is in the second one only, and a screen
	// that read the first would say nothing is listening to a port being served right now.
	"const inodes = new Set();",
	'for (const table of ["net/tcp", "net/tcp6"]) {',
	"\tlet text;",
	'\ttry { text = readFileSync(join(proc, table), "utf8"); } catch { continue; }',
	'\tfor (const line of text.split("\\n").slice(1)) {',
	"\t\tconst bits = line.trim().split(/\\s+/);",
	// sl, local, remote, state, queues, timer, retransmits, uid, timeout, inode. `0A` is LISTEN, and
	// the local address is `<address>:<port>` in hex.
	'\t\tif (bits.length < 10 || bits[3] !== "0A") continue;',
	'\t\tconst [, hex = ""] = bits[1].split(":");',
	"\t\tif (parseInt(hex, 16) !== port) continue;",
	"\t\tinodes.add(bits[9]);",
	"\t}",
	"}",
	"",
	"function linkOf(pid, fd) {",
	'\ttry { return readlinkSync(join(proc, pid, "fd", String(fd))); } catch { return ""; }',
	"}",
	"",
	// A file that has been deleted while it is still open reads back as its old name with a word
	// after it, which is not a path. Said as it is, and the stat below is what decides.
	"function fileOf(link) {",
	'\tconst at = link.replace(/ \\(deleted\\)$/, "");',
	'\tif (!at.startsWith("/")) return undefined;',
	"\ttry { return statSync(at).isFile() ? at : undefined; } catch { return undefined; }",
	"}",
	"",
	"function cmdOf(pid) {",
	'\tlet raw = "";',
	'\ttry { raw = readFileSync(join(proc, pid, "cmdline"), "utf8"); } catch {}',
	'\tconst line = raw.split("\\0").filter((word) => word.length > 0).join(" ").trim();',
	// A process started through a package manager carries its whole tree in the command line, and a
	// row on a screen has room for the beginning of it.
	"\tif (line.length > 0) return line.slice(0, 300);",
	'\ttry { return readFileSync(join(proc, pid, "comm"), "utf8").trim(); } catch { return ""; }',
	"}",
	"",
	"function holds(pid) {",
	"\tlet fds;",
	'\ttry { fds = readdirSync(join(proc, pid, "fd")); } catch { return false; }',
	"\tfor (const fd of fds) {",
	"\t\tconst to = linkOf(pid, fd);",
	'\t\tif (to.startsWith("socket:[") && inodes.has(to.slice(8, -1))) return true;',
	"\t}",
	"\treturn false;",
	"}",
	"",
	// Several processes can hold one listening socket — a server that forked, a package manager still
	// sitting in front of its child — and they do not all have the same idea of where output goes.
	// The one worth answering with is the one whose output can be read; the first of them is what is
	// left to say when none of them can.
	"let found;",
	"if (inodes.size > 0) {",
	"\tfor (const pid of readdirSync(proc).filter((name) => /^[0-9]+$/.test(name))) {",
	"\t\tif (!holds(pid)) continue;",
	"\t\tconst out = linkOf(pid, 1);",
	"\t\tconst err = linkOf(pid, 2);",
	"\t\tconst at = fileOf(out) ?? fileOf(err);",
	"\t\tconst one = { pid: Number(pid), cmd: cmdOf(pid), to: at ?? out ?? err, at };",
	"\t\tif (at !== undefined) { found = one; break; }",
	"\t\tfound = found ?? one;",
	"\t}",
	"}",
	"",
	// The file from the last answer is used only when nothing is listening any more. That is the
	// crash: the port is empty, the process is gone, and what it printed on the way out is still on
	// disk. While something is listening, what it is writing to now is the only honest answer.
	"const at = found?.at ?? (inodes.size === 0 ? fileOf(was) : undefined);",
	"",
	'let slice = { from: 0, size: 0, data: "", restarted: false };',
	"if (at !== undefined) {",
	"\ttry {",
	'\t\tconst fd = openSync(at, "r");',
	"\t\tconst size = fstatSync(fd).size;",
	"\t\tconst asked = Number(from);",
	// Shorter than where the reader left off is a file that was emptied and started again, which is
	// what a restarted server does to its log. Going back to the tail is the only place to go: the
	// bytes the reader is holding are from a program that is no longer running.
	"\t\tconst restarted = asked > size;",
	"\t\tconst start = asked < 0 || restarted",
	"\t\t\t? Math.max(0, size - Number(most))",
	"\t\t\t: Math.min(Math.max(0, asked), size);",
	"\t\tconst room = Math.max(0, Math.min(Number(most), size - start));",
	"\t\tconst buffer = Buffer.alloc(room);",
	"\t\tconst read = room === 0 ? 0 : readSync(fd, buffer, 0, room, start);",
	"\t\tcloseSync(fd);",
	'\t\tslice = { from: start, size, data: buffer.subarray(0, read).toString("base64"), restarted };',
	// A file that was there a moment ago and cannot be opened now is one that has just been rotated
	// or taken away. The rest of the answer still says what is listening and where it was writing,
	// which is what the screen needs to say what happened.
	"\t} catch {}",
	"}",
	"",
	"process.stdout.write(JSON.stringify({",
	"\tport,",
	"\tlistening: inodes.size > 0,",
	"\t...(found === undefined ? {} : { pid: found.pid, cmd: found.cmd, to: found.to }),",
	"\t...(at === undefined ? {} : { at }),",
	"\t...slice,",
	"}));",
].join("\n");
