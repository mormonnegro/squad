import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGS_SCRIPT, type Printed } from "../src/logs.ts";

/**
 * The script run the way it runs in the box — `node -e`, arguments — against a `/proc` made up here.
 *
 * Made up rather than the real one because the real one is a kernel: a test that needed a dev server
 * listening on a port to be able to run is a test that runs on nobody's machine. What is under test
 * is the reading, and `/proc` is a directory of files either way.
 */
function run(args: readonly string[]): Printed {
	return JSON.parse(
		execFileSync("node", ["-e", LOGS_SCRIPT, ...args], {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		}),
	) as Printed;
}

let root: string;
let proc: string;

/** A listening socket on a port, as `/proc/net/tcp` writes one: hex address, `0A`, and its inode. */
function listening(port: number, inode: string, table = "tcp"): void {
	const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid";
	const hex = port.toString(16).toUpperCase().padStart(4, "0");
	const line = `   0: 0100007F:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 ffff 100 0 0 10 0`;
	writeFileSync(join(proc, "net", table), `${head}\n${line}\n`);
}

/** A process holding that socket, and wherever it is sending its output. */
function holder(pid: string, inode: string, out: string, cmd = "node vite"): void {
	mkdirSync(join(proc, pid, "fd"), { recursive: true });
	symlinkSync(`socket:[${inode}]`, join(proc, pid, "fd", "3"));
	symlinkSync(out, join(proc, pid, "fd", "1"));
	symlinkSync(out, join(proc, pid, "fd", "2"));
	writeFileSync(join(proc, pid, "cmdline"), `${cmd.split(" ").join("\0")}\0`);
}

function log(text: string): string {
	const at = join(root, "dev.log");
	writeFileSync(at, text);
	return at;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "squad-logs-"));
	proc = join(root, "proc");
	mkdirSync(join(proc, "net"), { recursive: true });
	writeFileSync(join(proc, "net", "tcp"), "  sl  local_address\n");
	writeFileSync(join(proc, "net", "tcp6"), "  sl  local_address\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("what is printing on a port", () => {
	it("finds who holds it and reads what it is writing", () => {
		listening(3005, "99887");
		holder("412", "99887", log("ready in 300 ms\nGET / 200\n"));

		const printed = run([proc, "3005", "-1", "131072", ""]);

		expect(printed.listening).toBe(true);
		expect(printed.pid).toBe(412);
		expect(printed.cmd).toBe("node vite");
		expect(printed.at).toBe(join(root, "dev.log"));
		expect(Buffer.from(printed.data, "base64").toString()).toBe("ready in 300 ms\nGET / 200\n");
	});

	it("finds one bound to the second table, which is where `::` lands", () => {
		listening(3005, "77665", "tcp6");
		holder("9", "77665", log("listening on [::]:3005\n"));

		expect(run([proc, "3005", "-1", "131072", ""]).pid).toBe(9);
	});

	it("says nothing is listening when nothing is, and has nothing to read", () => {
		const printed = run([proc, "3005", "-1", "131072", ""]);

		expect(printed.listening).toBe(false);
		expect(printed.pid).toBeUndefined();
		expect(printed.at).toBeUndefined();
		expect(printed.data).toBe("");
	});

	it("leaves a port alone that is not the one asked about", () => {
		listening(5173, "99887");
		holder("412", "99887", log("vite\n"));

		expect(run([proc, "3005", "-1", "131072", ""]).listening).toBe(false);
	});

	/*
	 * The state a crash leaves: the port is empty, the process is gone, and what it said on the way
	 * out is still on disk. It is also the only moment anybody comes looking, so the file the plane
	 * saw it writing last time is worth more than the fact that nobody holds the port now.
	 */
	it("reads the file it was last seen writing when nothing is listening any more", () => {
		const at = log("Error: connect ECONNREFUSED\n");

		const printed = run([proc, "3005", "-1", "131072", at]);

		expect(printed.listening).toBe(false);
		expect(printed.at).toBe(at);
		expect(Buffer.from(printed.data, "base64").toString()).toBe("Error: connect ECONNREFUSED\n");
	});

	it("keeps to what is running while something is, whatever it was reading before", () => {
		listening(3005, "99887");
		holder("412", "99887", "pipe:[4242]");

		const printed = run([proc, "3005", "-1", "131072", log("the last one's\n")]);

		expect(printed.at).toBeUndefined();
		expect(printed.to).toBe("pipe:[4242]");
	});

	it("says where the output goes when it is somewhere nobody can read it", () => {
		listening(3005, "99887");
		holder("412", "99887", "/dev/null");

		const printed = run([proc, "3005", "-1", "131072", ""]);

		expect(printed.listening).toBe(true);
		expect(printed.pid).toBe(412);
		expect(printed.to).toBe("/dev/null");
		expect(printed.at).toBeUndefined();
	});

	/*
	 * A server started through a package manager leaves two processes on the socket, and only one of
	 * them has anywhere to write. Which of the two `readdir` hands over first is the filesystem's
	 * business, so the answer cannot depend on it.
	 */
	it("answers with the holder whose output can be read, not the first one found", () => {
		listening(3005, "99887");
		holder("100", "99887", "pipe:[4242]", "pnpm dev");
		holder("200", "99887", log("vite ready\n"), "node vite");

		const printed = run([proc, "3005", "-1", "131072", ""]);

		expect(printed.pid).toBe(200);
		expect(printed.at).toBe(join(root, "dev.log"));
	});
});

describe("following one", () => {
	it("reads only what is new, from where the last answer left off", () => {
		listening(3005, "99887");
		const at = log("one\ntwo\n");
		holder("412", "99887", at);

		const first = run([proc, "3005", "-1", "131072", ""]);
		expect(first.from + Buffer.from(first.data, "base64").length).toBe(first.size);

		writeFileSync(at, "one\ntwo\nthree\n");
		const next = run([proc, "3005", String(first.size), "131072", ""]);

		expect(Buffer.from(next.data, "base64").toString()).toBe("three\n");
		expect(next.restarted).toBe(false);
	});

	it("starts over when the file is shorter than where the reader was, which is a restart", () => {
		listening(3005, "99887");
		const at = log("a long first run, ending badly\n");
		holder("412", "99887", at);

		writeFileSync(at, "ready\n");
		const printed = run([proc, "3005", "400", "131072", ""]);

		expect(printed.restarted).toBe(true);
		expect(printed.from).toBe(0);
		expect(Buffer.from(printed.data, "base64").toString()).toBe("ready\n");
	});

	it("carries the end of a long log rather than the beginning of it", () => {
		listening(3005, "99887");
		holder("412", "99887", log(`${"x".repeat(500)}\nthe last line\n`));

		const printed = run([proc, "3005", "-1", "64", ""]);

		expect(printed.from).toBe(printed.size - 64);
		expect(Buffer.from(printed.data, "base64").toString().endsWith("the last line\n")).toBe(true);
	});

	it("answers with nothing new when nothing has been written since", () => {
		listening(3005, "99887");
		holder("412", "99887", log("ready\n"));

		const printed = run([proc, "3005", "6", "131072", ""]);

		expect(printed.data).toBe("");
		expect(printed.size).toBe(6);
		expect(printed.restarted).toBe(false);
	});
});
