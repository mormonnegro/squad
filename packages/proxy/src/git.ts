import type { Readable } from "node:stream";

/**
 * The part of a push the proxy has to read to know which branch it is for.
 *
 * A grant knows a host, a path and a method, and for git that does not separate reading from writing:
 * a clone and a push are both a GET and a POST under the repository's path. What tells them apart is
 * the second POST's target, `git-receive-pack`, and what says which branch is inside its body — the
 * first few pkt-lines, one per ref, `<old> <new> <refname>`, closed by a flush. The packfile follows
 * and is not looked at. So the proxy reads to the flush, decides, and only then opens the upstream.
 *
 * This is readable because a push is still protocol v0: v2 never grew a receive-pack, and the client
 * does not gzip this body the way it gzips a fetch's. Anything that is not the shape below is refused
 * rather than guessed at, because a control that lets through what it could not read is not one.
 */

const FLUSH = "0000";

/** pkt-line lengths this side of a flush that mean something else: v2's delimiter and response-end. */
const RESERVED_LENGTHS = new Set([1, 2, 3]);

/** The longest pkt-line git will write, header included. */
const MAX_PKT_LINE = 65520;

/** Both hash sizes git speaks, because a repository chooses once and the proxy meets both. */
const OBJECT_ID = "(?:[0-9a-f]{40}|[0-9a-f]{64})";

const COMMAND = new RegExp(`^(${OBJECT_ID}) (${OBJECT_ID}) (\\S+)$`);

/** One ref the push would move: from where, to where, and its full name. */
export interface RefUpdate {
	readonly oldId: string;
	readonly newId: string;
	readonly ref: string;
}

export type PushCommands =
	/** Every command read, and where the flush ended so the caller knows the rest is packfile. */
	| {
			readonly kind: "commands";
			readonly updates: readonly RefUpdate[];
			/** What the client said it can take back, off the first command line. */
			readonly capabilities: ReadonlySet<string>;
			readonly end: number;
	  }
	/** The flush has not arrived yet; read more and ask again. */
	| { readonly kind: "incomplete" }
	/** Not a push this proxy can read, and so not one it will pass. */
	| { readonly kind: "unreadable"; readonly why: string };

/**
 * Reads the command section off the head of a receive-pack request body.
 *
 * Tolerant of nothing it does not have to be: a `shallow` line is skipped because a push from a
 * shallow clone starts with one; a signed push is refused because its commands travel inside the
 * certificate, which is a second parser for a thing nobody pushes from a sandbox.
 */
export function readPushCommands(head: Buffer): PushCommands {
	const updates: RefUpdate[] = [];
	let capabilities: ReadonlySet<string> = new Set();
	let offset = 0;
	while (true) {
		if (head.length < offset + 4) return { kind: "incomplete" };
		const lengthField = head.subarray(offset, offset + 4).toString("latin1");
		if (!/^[0-9a-f]{4}$/i.test(lengthField)) {
			return { kind: "unreadable", why: `pkt-line length "${lengthField}" is not hex` };
		}
		const length = Number.parseInt(lengthField, 16);
		if (lengthField === FLUSH) {
			return { kind: "commands", updates, capabilities, end: offset + 4 };
		}
		if (RESERVED_LENGTHS.has(length) || length > MAX_PKT_LINE) {
			return { kind: "unreadable", why: `pkt-line length ${length} is not a command line` };
		}
		if (head.length < offset + length) return { kind: "incomplete" };
		const payload = head.subarray(offset + 4, offset + length).toString("utf8");
		offset += length;

		const [line = "", trailer] = payload.replace(/\n$/, "").split("\0", 2);
		if (line.startsWith("shallow ")) continue;
		if (line.startsWith("push-cert")) {
			return { kind: "unreadable", why: "signed pushes are not read here" };
		}
		const match = COMMAND.exec(line);
		if (match === null) {
			return { kind: "unreadable", why: `"${line.slice(0, 80)}" is not a ref update` };
		}
		if (trailer !== undefined && updates.length === 0) {
			capabilities = new Set(trailer.split(" ").filter((word) => word.length > 0));
		}
		updates.push({ oldId: match[1] ?? "", newId: match[2] ?? "", ref: match[3] ?? "" });
	}
}

/** The name a person types for a ref, which is the branch when it is one. */
export function shortRef(ref: string): string {
	return ref.replace(/^refs\/heads\//, "");
}

/**
 * Expands a pattern the way it was written: a bare name is a branch, and `*` stands for anything,
 * slashes included — which is how git's own refspecs read it, so `scout/*` covers `scout/a/b` too.
 */
function refPattern(pattern: string): RegExp {
	const full = pattern.startsWith("refs/") ? pattern : `refs/heads/${pattern}`;
	const escaped = full.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function refMatches(patterns: readonly string[], ref: string): boolean {
	return patterns.some((pattern) => refPattern(pattern).test(ref));
}

/**
 * A receive-pack result that turns the whole push down, ref by ref, in the words git prints.
 *
 * A 403 reaches the agent as `RPC failed; HTTP 403`, which is what a wrong token looks like too, and
 * an agent reading that will go and check its token. What git does show, word for word, is the
 * server's report: `! [remote rejected] main -> main (not granted: push scout/* here)` names the
 * branch it was refused on and the ones it has. So the refusal is written the way a pre-receive hook
 * declines, which is the one shape every git client already knows how to read out loud.
 *
 * Wrapped in a sideband when the client asked for one, because then it expects nothing else — and a
 * sideband has a channel for a line addressed to the person, which git prefixes with `remote:`.
 */
export function pushRefusal(
	updates: readonly RefUpdate[],
	capabilities: ReadonlySet<string>,
	refused: readonly string[],
	allowed: readonly string[],
): Buffer {
	const lane =
		allowed.length === 0 ? "nothing here may be pushed" : `push ${allowed.join(" ")} here`;
	const refusedSet = new Set(refused);
	const report = [
		"unpack ok\n",
		...updates.map((update) =>
			refusedSet.has(update.ref)
				? `ng ${update.ref} not granted: ${lane}\n`
				: `ng ${update.ref} held back with ${shortRef(refused[0] ?? "")}\n`,
		),
	];
	if (!capabilities.has("side-band-64k") && !capabilities.has("side-band")) {
		return Buffer.concat([...report.map((line) => pktLine(line)), Buffer.from(FLUSH)]);
	}
	const notice = `squad: ${refused.map(shortRef).join(", ")} is not granted to this agent; ${lane}\n`;
	return Buffer.concat([
		pktLine(notice, 2),
		pktLine(Buffer.concat([...report.map((line) => pktLine(line)), Buffer.from(FLUSH)]), 1),
		Buffer.from(FLUSH),
	]);
}

function pktLine(payload: string | Buffer, band?: number): Buffer {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	const banded = band === undefined ? body : Buffer.concat([Buffer.from([band]), body]);
	const length = (banded.length + 4).toString(16).padStart(4, "0");
	return Buffer.concat([Buffer.from(length, "latin1"), banded]);
}

/** More than any command section is and less than a packfile: past this, the push is not being read. */
const MAX_HEAD_BYTES = 1024 * 1024;

export interface PushHead {
	/** Everything read so far — more than the commands when the first chunk carried packfile too. */
	readonly bytes: Buffer;
	/** Whether the body ended inside what was read, so there is nothing left to pipe after it. */
	readonly ended: boolean;
	/** Read whole or refused; the reading does not stop on "incomplete", so it never hands one back. */
	readonly commands: Exclude<PushCommands, { kind: "incomplete" }>;
}

/**
 * Reads a request body up to the end of its command section and no further.
 *
 * The body is left paused where the reading stopped, so whoever forwards it writes these bytes first
 * and pipes the rest — unless the body ended in here, which a push that only deletes will do, because
 * there is no packfile to follow.
 */
export function readPushHead(body: Readable): Promise<PushHead> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let commands: PushCommands = { kind: "incomplete" };
		const settle = (ended: boolean) => {
			body.off("data", onData);
			body.off("end", onEnd);
			body.off("error", onEnd);
			const settled =
				commands.kind === "incomplete"
					? {
							kind: "unreadable" as const,
							why: ended
								? "the body ended before its commands did"
								: `the commands run past ${MAX_HEAD_BYTES} bytes`,
						}
					: commands;
			resolve({ bytes: Buffer.concat(chunks), ended, commands: settled });
		};
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			size += chunk.length;
			commands = readPushCommands(Buffer.concat(chunks));
			if (commands.kind !== "incomplete" || size > MAX_HEAD_BYTES) {
				body.pause();
				settle(false);
			}
		};
		const onEnd = () => settle(true);
		body.on("data", onData);
		body.once("end", onEnd);
		body.once("error", onEnd);
	});
}
