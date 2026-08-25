import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServedPorts, servedAt, unservable } from "../src/ports.ts";

let dir = "";
let path = "";
let ports: ServedPorts;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ports-"));
	path = join(dir, "served.json");
	ports = new ServedPorts(path);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("ServedPorts", () => {
	it("opens a port on the same number when nothing else has it", async () => {
		expect(await ports.open("scout", 3000)).toEqual({ port: 3000, at: 3000 });
		expect(await ports.of("scout")).toEqual([{ port: 3000, at: 3000 }]);
	});

	// The agent that restarts its server has no way of knowing whether the last turn already asked,
	// and a second link for the same thing is the console binding twice and failing the second time.
	it("does not move a port that was already asked for", async () => {
		const first = await ports.open("scout", 3000);
		expect(await ports.open("scout", 3000)).toEqual(first);
		expect(await ports.of("scout")).toHaveLength(1);
	});

	// Two agents both running a dev server land on 3000 without either of them having chosen it, and
	// the machine at the other end has one 3000. The number gives way; neither agent is refused.
	it("gives the second agent the next free number, and keeps its own port intact", async () => {
		await ports.open("scout", 3000);
		expect(await ports.open("scribe", 3000)).toEqual({ port: 3000, at: 3001 });
	});

	it("does not hand out a number another agent is already reached on", async () => {
		await ports.open("scout", 3000);
		await ports.open("scribe", 3001);
		expect(await ports.open("sleeper", 3000)).toEqual({ port: 3000, at: 3002 });
	});

	// Every agent on the plane shares one of these, and read-modify-write is not atomic. Whether the
	// second 3000 gets 3001 is decided entirely by the first one having finished being written.
	it("settles two agents asking at the same instant", async () => {
		const [one, other] = await Promise.all([ports.open("scout", 8080), ports.open("scribe", 8080)]);
		expect(new Set([one.at, other.at])).toEqual(new Set([8080, 8081]));
	});

	it("says whether there was a port to close", async () => {
		await ports.open("scout", 3000);
		expect(await ports.close("scout", 3000)).toBe(true);
		expect(await ports.close("scout", 3000)).toBe(false);
		expect(await ports.of("scout")).toEqual([]);
	});

	it("frees the number for whoever asks next", async () => {
		await ports.open("scout", 3000);
		await ports.open("scribe", 3000);
		await ports.close("scout", 3000);
		expect(await ports.open("sleeper", 3000)).toEqual({ port: 3000, at: 3000 });
	});

	it("forgets every port of a purged agent", async () => {
		await ports.open("scout", 3000);
		await ports.open("scout", 8080);
		await ports.forget("scout");
		expect(await ports.all()).toEqual({});
	});

	// A console opened tomorrow should find the same links without anyone having to remember which
	// port the agent picked, which is the whole reason this is a file rather than a field.
	it("outlives the plane the port was asked for on", async () => {
		await ports.open("scout", 3000);
		expect(await new ServedPorts(path).of("scout")).toEqual([{ port: 3000, at: 3000 }]);
	});

	it("reads a file that is not there as nothing being served", async () => {
		expect(await new ServedPorts(join(dir, "nowhere.json")).all()).toEqual({});
	});
});

describe("servedAt", () => {
	// The name is what makes the link legible, and `*.localhost` is loopback in every modern browser
	// with nothing configured anywhere.
	it("names the agent in the host, and the local port in the port", () => {
		expect(servedAt("scout", { port: 3000, at: 3001 })).toBe("http://scout.localhost:3001");
	});
});

describe("unservable", () => {
	it("takes an ordinary port", () => {
		expect(unservable(3000)).toBeUndefined();
	});

	// Refused where the answer is being written rather than found out at a console on somebody else's
	// machine, where the failure would be a bind error nobody was looking at.
	it("refuses one the console would need root to bind", () => {
		expect(unservable(80)).toMatch(/under 1024/);
	});

	it("refuses what is not a port at all", () => {
		expect(unservable(Number.NaN)).toMatch(/not a port/);
		expect(unservable(70_000)).toMatch(/not a port/);
		expect(unservable(3000.5)).toMatch(/not a port/);
	});
});
