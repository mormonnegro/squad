import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clientHome,
	describePlane,
	localStateDir,
	normalizeTarget,
	planePath,
	readPlane,
	writePlane,
} from "../src/plane.ts";

describe("the plane this operator chose", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "squad-client-"));
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("has no answer before one is given", async () => {
		expect(await readPlane(home)).toBeUndefined();
	});

	it("remembers a plane on this computer", async () => {
		await writePlane(home, { kind: "here", stateDir: localStateDir(home) });
		expect(await readPlane(home)).toEqual({ kind: "here", stateDir: join(home, "state") });
	});

	it("remembers a plane on a server", async () => {
		await writePlane(home, { kind: "server", target: "root@example.test" });
		expect(await readPlane(home)).toEqual({ kind: "server", target: "root@example.test" });
	});

	// A small JSON file going bad is not a reason to refuse to start. The question it answers costs
	// one keystroke, so an unreadable answer is the same situation as no answer at all.
	it.each([
		["not JSON at all", "{{{"],
		["JSON that is not an object", '"here"'],
		["a door nobody knows", '{"kind":"cloud"}'],
		["a door with nowhere to go", '{"kind":"server"}'],
	])("asks again when the file holds %s", async (_what, written) => {
		await writeFile(planePath(home), written);
		expect(await readPlane(home)).toBeUndefined();
	});

	it("names a plane by the machine it is on", () => {
		expect(describePlane({ kind: "server", target: "me@vps" })).toBe("me@vps");
		expect(describePlane({ kind: "here", stateDir: "/tmp/x" })).toBe("/tmp/x");
	});

	// The client's own directory, which the tests need somewhere that is not the operator's.
	it("keeps its answer where it was told to", () => {
		expect(clientHome({ SQUAD_HOME: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
		expect(planePath("/tmp/elsewhere")).toBe("/tmp/elsewhere/plane.json");
	});
});

describe("an address typed at the prompt", () => {
	// The prompt already reads `root@`, so a bare host completes the line that is on screen.
	it("becomes root's when no user is named", () => {
		expect(normalizeTarget("example.test")).toBe("root@example.test");
		expect(normalizeTarget("  example.test\n")).toBe("root@example.test");
	});

	it("keeps a user that was named", () => {
		expect(normalizeTarget("me@example.test")).toBe("me@example.test");
	});

	// What a hosting panel puts on the screen, and so what gets pasted over the prompt.
	it("takes the scheme off what was pasted", () => {
		expect(normalizeTarget("ssh://me@example.test")).toBe("me@example.test");
	});
});
