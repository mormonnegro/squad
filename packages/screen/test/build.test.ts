import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLines, tarball } from "../src/build.ts";

const run = promisify(execFile);

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "squad-tar-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("the build context", () => {
	it("is a tar the system's own tar can read", async () => {
		// Hand-rolled formats are checked against the thing that will actually read them. Docker's
		// untar is not this one, but a tar that `tar` refuses is a tar Docker will refuse too.
		await writeFile(join(dir, "Dockerfile"), "FROM scratch\n", "utf8");
		await writeFile(join(dir, "start.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
		const archive = join(dir, "context.tar");
		await writeFile(archive, await tarball(dir));

		const listed = await run("tar", ["-tf", archive]);
		expect(listed.stdout.split("\n").filter(Boolean).sort()).toEqual(["Dockerfile", "start.sh"]);
	});

	it("carries the contents back out byte for byte", async () => {
		await writeFile(join(dir, "screen.ts"), 'const x = "ñ";\n', "utf8");
		const archive = join(dir, "context.tar");
		await writeFile(archive, await tarball(dir));

		const out = await mkdtemp(join(tmpdir(), "squad-untar-"));
		await run("tar", ["-xf", archive, "-C", out]);
		const read = await run("cat", [join(out, "screen.ts")]);
		expect(read.stdout).toBe('const x = "ñ";\n');
		await rm(out, { recursive: true, force: true });
	});

	it("keeps the executable bit, which is the one mode that matters here", async () => {
		// The entrypoint. A build that dropped this would produce an image that starts and stops with
		// nothing to say about why.
		await writeFile(join(dir, "start.sh"), "#!/bin/sh\n", { mode: 0o755 });
		const archive = join(dir, "context.tar");
		await writeFile(archive, await tarball(dir));

		const listed = await run("tar", ["-tvf", archive]);
		expect(listed.stdout).toMatch(/rwxr-xr-x/);
	});

	it("ends the way a tar ends, so nothing reading it waits for more", async () => {
		await writeFile(join(dir, "Dockerfile"), "FROM scratch\n", "utf8");
		const context = await tarball(dir);
		expect(context.subarray(context.byteLength - 1024).every((byte) => byte === 0)).toBe(true);
	});
});

describe("what a build says while it runs", () => {
	it("keeps the lines and drops the noise", () => {
		expect(
			buildLines('{"stream":"Step 1/8 : FROM node\\n"}\n{"stream":"\\n"}\n{"aux":{"ID":"sha"}}'),
		).toEqual(["Step 1/8 : FROM node"]);
	});

	it("throws what the build said went wrong, rather than finishing quietly", () => {
		// A failed build that resolved would leave `/screen on` waiting for an image that is never
		// coming, and nothing anywhere saying why.
		expect(() => buildLines('{"error":"no such package: chromium"}')).toThrow("chromium");
	});

	it("ignores a line that is not JSON at all", () => {
		expect(buildLines("something unexpected\n")).toEqual([]);
	});
});
