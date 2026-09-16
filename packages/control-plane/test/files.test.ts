import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	insideBox,
	LIST_SCRIPT,
	type Listing,
	MOVE_SCRIPT,
	READ_SCRIPT,
	REMOVE_SCRIPT,
	type Slice,
	tilde,
	WRITE_SCRIPT,
	type Wrote,
} from "../src/files.ts";

/**
 * The scripts run here exactly as they run in the box: `node -e`, arguments, stdin.
 *
 * They are strings of a program that lives inside a container, which is the one kind of code a type
 * checker has nothing to say about. A test that ran the logic some other way would be a test of a
 * second copy of it.
 */
function run(script: string, args: readonly string[], input = ""): string {
	// stderr piped rather than inherited: a refusal is a thing under test here, and a test run should
	// not print the words of every one of them.
	return execFileSync("node", ["-e", script, ...args], {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "squad-files-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("insideBox", () => {
	it("reads a relative path against the agent's home", () => {
		expect(insideBox("workspace/notes")).toBe("/home/agent/workspace/notes");
	});

	it("spells out the tilde, which belongs to a shell and not to a filesystem", () => {
		expect(insideBox("~/workspace")).toBe("/home/agent/workspace");
		expect(insideBox("~")).toBe("/home/agent");
	});

	it("keeps an absolute path inside the home as it is", () => {
		expect(insideBox("/home/agent/.self/soul.md")).toBe("/home/agent/.self/soul.md");
	});

	it("refuses a path that climbs out of the home", () => {
		expect(() => insideBox("workspace/../../etc/passwd")).toThrow(/outside/);
		expect(() => insideBox("/etc/passwd")).toThrow(/outside/);
	});

	it("writes the home the way a person writes it", () => {
		expect(tilde("/home/agent/workspace/todo")).toBe("~/workspace/todo");
		expect(tilde("/home/agent")).toBe("~");
		expect(tilde("/usr/lib")).toBe("/usr/lib");
	});
});

describe("the listing script", () => {
	it("puts the directories first and says what each row is", () => {
		mkdirSync(join(root, "todo-list"));
		writeFileSync(join(root, "notes.md"), "# hello\n");
		writeFileSync(join(root, "a-file.txt"), "x");

		const listing = JSON.parse(run(LIST_SCRIPT, [root, "1000"])) as Listing;

		expect(listing.kind).toBe("dir");
		if (listing.kind !== "dir") return;
		expect(listing.entries.map((one) => one.name)).toEqual(["todo-list", "a-file.txt", "notes.md"]);
		expect(listing.entries[0]?.kind).toBe("dir");
		expect(listing.entries[2]).toMatchObject({ kind: "file", size: 8 });
		expect(listing.total).toBe(3);
	});

	/** A link to a directory is a directory to whoever is walking around, and is worth saying is one. */
	it("draws a symlink as what it points at", () => {
		mkdirSync(join(root, "project"));
		execFileSync("ln", ["-s", join(root, "project"), join(root, "shortcut")]);

		const listing = JSON.parse(run(LIST_SCRIPT, [root, "1000"])) as Listing;

		if (listing.kind !== "dir") throw new Error("expected a directory");
		expect(listing.entries.find((one) => one.name === "shortcut")).toMatchObject({
			kind: "dir",
			link: true,
		});
	});

	it("cuts a long listing and still says how many there are", () => {
		for (let at = 0; at < 12; at++) writeFileSync(join(root, `file-${at}`), "x");

		const listing = JSON.parse(run(LIST_SCRIPT, [root, "5"])) as Listing;

		if (listing.kind !== "dir") throw new Error("expected a directory");
		expect(listing.entries).toHaveLength(5);
		expect(listing.total).toBe(12);
	});

	/** An address that turns out to name a file is answered rather than refused. */
	it("answers a file as a file", () => {
		writeFileSync(join(root, "soul.md"), "I am a helpful agent.\n");

		const listing = JSON.parse(run(LIST_SCRIPT, [join(root, "soul.md"), "1000"])) as Listing;

		expect(listing.kind).toBe("file");
		if (listing.kind !== "file") return;
		expect(listing.size).toBe(22);
	});

	it("says there is nothing there in words somebody can act on", () => {
		expect(() => run(LIST_SCRIPT, [join(root, "nowhere"), "1000"])).toThrow(/There is nothing at/);
	});
});

describe("the reading script", () => {
	it("hands back a slice and says whether there is more", () => {
		writeFileSync(join(root, "log.txt"), "0123456789");

		const first = JSON.parse(run(READ_SCRIPT, [join(root, "log.txt"), "0", "4"])) as Slice;
		expect(Buffer.from(first.data, "base64").toString()).toBe("0123");
		expect(first).toMatchObject({ from: 0, size: 10, more: true });

		const rest = JSON.parse(run(READ_SCRIPT, [join(root, "log.txt"), "4", "100"])) as Slice;
		expect(Buffer.from(rest.data, "base64").toString()).toBe("456789");
		expect(rest.more).toBe(false);
	});

	it("carries bytes that are not text", () => {
		const bytes = Buffer.from([0, 1, 2, 255, 254]);
		writeFileSync(join(root, "thing.bin"), bytes);

		const slice = JSON.parse(run(READ_SCRIPT, [join(root, "thing.bin"), "0", "100"])) as Slice;

		expect(Buffer.from(slice.data, "base64").equals(bytes)).toBe(true);
	});

	it("refuses a directory in the words of what it is", () => {
		expect(() => run(READ_SCRIPT, [root, "0", "100"])).toThrow(/is a directory/);
	});
});

describe("the writing script", () => {
	it("leaves nothing under the name until the last chunk has landed", () => {
		const at = join(root, "drop", "report.pdf");

		const first = JSON.parse(
			run(WRITE_SCRIPT, [at, "0", "more"], Buffer.from("hello ").toString("base64")),
		) as Wrote;
		expect(first.done).toBe(false);
		expect(existsSync(at)).toBe(false);

		const last = JSON.parse(
			run(WRITE_SCRIPT, [at, "6", "last"], Buffer.from("world").toString("base64")),
		) as Wrote;

		expect(last).toMatchObject({ done: true, size: 11 });
		expect(existsSync(at)).toBe(true);
		expect(execFileSync("cat", [at], { encoding: "utf8" })).toBe("hello world");
	});

	it("makes the folder it was pointed at", () => {
		const at = join(root, "a", "b", "c.txt");

		run(WRITE_SCRIPT, [at, "0", "last"], Buffer.from("x").toString("base64"));

		expect(existsSync(at)).toBe(true);
	});

	it("writes an empty file when that is what was handed over", () => {
		const at = join(root, "empty.txt");

		const wrote = JSON.parse(run(WRITE_SCRIPT, [at, "0", "last"], "")) as Wrote;

		expect(wrote.size).toBe(0);
		expect(existsSync(at)).toBe(true);
	});

	/** Two uploads of one name would otherwise interleave into a file that is neither of them. */
	it("refuses a chunk that does not carry on where the last one stopped", () => {
		const at = join(root, "notes.txt");
		run(WRITE_SCRIPT, [at, "0", "more"], Buffer.from("hello").toString("base64"));

		expect(() =>
			run(WRITE_SCRIPT, [at, "99", "last"], Buffer.from("!").toString("base64")),
		).toThrow(/already in flight/);
	});
});

describe("the renaming script", () => {
	it("gives a file its new name", () => {
		writeFileSync(join(root, "notes.md"), "x");

		run(MOVE_SCRIPT, [join(root, "notes.md"), join(root, "todo.md")]);

		expect(existsSync(join(root, "notes.md"))).toBe(false);
		expect(existsSync(join(root, "todo.md"))).toBe(true);
	});

	/** A rename is also a move, because to a filesystem and to a person those are one thing. */
	it("carries a folder into another one, with everything under it", () => {
		mkdirSync(join(root, "project", "src"), { recursive: true });
		writeFileSync(join(root, "project", "src", "main.ts"), "x");
		mkdirSync(join(root, "done"));

		run(MOVE_SCRIPT, [join(root, "project"), join(root, "done", "project")]);

		expect(existsSync(join(root, "done", "project", "src", "main.ts"))).toBe(true);
	});

	/** The whole reason somebody renames a file is that they are looking at the folder it is in. */
	it("refuses a name that is already taken rather than writing over it", () => {
		writeFileSync(join(root, "notes.md"), "the one being kept");
		writeFileSync(join(root, "todo.md"), "the one being renamed");

		expect(() => run(MOVE_SCRIPT, [join(root, "todo.md"), join(root, "notes.md")])).toThrow(
			/already something called notes.md/,
		);
		expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("the one being kept");
	});

	it("says there is nothing there in words somebody can act on", () => {
		expect(() => run(MOVE_SCRIPT, [join(root, "gone.md"), join(root, "here.md")])).toThrow(
			/There is nothing at/,
		);
	});
});

describe("the deleting script", () => {
	it("deletes a file and says what it was", () => {
		writeFileSync(join(root, "cat.png"), "x");

		const gone = JSON.parse(run(REMOVE_SCRIPT, [join(root, "cat.png")])) as { kind: string };

		expect(gone.kind).toBe("file");
		expect(existsSync(join(root, "cat.png"))).toBe(false);
	});

	/** Every directory worth deleting has something in it, so a folder goes whole or not at all. */
	it("deletes a folder and everything under it", () => {
		mkdirSync(join(root, "old", "deep"), { recursive: true });
		writeFileSync(join(root, "old", "deep", "notes.md"), "x");

		const gone = JSON.parse(run(REMOVE_SCRIPT, [join(root, "old")])) as { kind: string };

		expect(gone.kind).toBe("dir");
		expect(existsSync(join(root, "old"))).toBe(false);
	});

	it("says there is nothing there rather than pretending it deleted something", () => {
		expect(() => run(REMOVE_SCRIPT, [join(root, "never-was")])).toThrow(/There is nothing at/);
	});
});
