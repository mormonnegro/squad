import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentNameStore } from "../src/agent-names.ts";

describe("the agent names the plane wrote down, because the config could not be", () => {
	let stateDir: string;
	let path: string;
	let store: AgentNameStore;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "agent-dive-created-"));
		path = join(stateDir, "agents.json");
		store = new AgentNameStore(path, "createdAt");
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("is empty before anything is made", async () => {
		expect(await store.list()).toEqual([]);
	});

	it("remembers a name across a restart, which is the whole reason it exists", async () => {
		await store.add("maxi");

		expect(await new AgentNameStore(path, "createdAt").list()).toEqual(["maxi"]);
	});

	it("records only the name, so capabilities stay a question the operator's file answers", async () => {
		await store.add("maxi");

		expect(Object.keys(JSON.parse(await readFile(path, "utf8"))[0])).toEqual(["id", "createdAt"]);
	});

	// The same list twice over: one file of names made here, one of names deleted here. The date is
	// the only thing that differs, and it says which file is being read by whoever opens it.
	it("dates the name after whatever happened to it", async () => {
		const deleted = new AgentNameStore(join(stateDir, "deleted.json"), "deletedAt");
		await deleted.add("maxi");

		expect(
			Object.keys(JSON.parse(await readFile(join(stateDir, "deleted.json"), "utf8"))[0]),
		).toEqual(["id", "deletedAt"]);
	});

	it("adds a name once, however many times it is created", async () => {
		await store.add("maxi");
		await store.add("maxi");

		expect(await store.list()).toEqual(["maxi"]);
	});

	it("forgets one without touching the rest", async () => {
		await store.add("maxi");
		await store.add("scout");
		await store.forget("maxi");

		expect(await store.list()).toEqual(["scout"]);
	});

	// A file the plane cannot read is a plane that starts with no agents at all, which would be a
	// worse answer than starting with the ones the config declares.
	it("reads a damaged file as no agents rather than refusing to start", async () => {
		await writeFile(path, "{ not json");

		expect(await store.list()).toEqual([]);
	});
});
