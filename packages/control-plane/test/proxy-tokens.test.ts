import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProxyTokenStore } from "../src/proxy-tokens.ts";

/**
 * The token is baked into a sandbox's environment when its container is created, and the container
 * outlives the process that made it. A plane that minted a fresh one on every start therefore came
 * back unable to recognise its own agents: every request denied at the proxy, the model included,
 * and the only cure was destroying the sandbox — which is where the agent's memory lives.
 */
describe("the proxy token an agent keeps", () => {
	let stateDir: string;
	let path: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "agent-dive-tokens-"));
		path = join(stateDir, "proxy-tokens.json");
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("survives the plane that issued it", async () => {
		const first = await new ProxyTokenStore(path).ensure("scout");

		// A different instance is what a restarted process has.
		expect(await new ProxyTokenStore(path).ensure("scout")).toBe(first);
	});

	it("gives each agent its own", async () => {
		const store = new ProxyTokenStore(path);

		expect(await store.ensure("scout")).not.toBe(await store.ensure("scribe"));
	});

	it("is not readable by anyone else on the machine", async () => {
		await new ProxyTokenStore(path).ensure("scout");

		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("rotates once the container holding it is gone", async () => {
		const store = new ProxyTokenStore(path);
		const first = await store.ensure("scout");

		await store.forget("scout");

		expect(await store.ensure("scout")).not.toBe(first);
	});

	it("leaves the other agents alone when one is forgotten", async () => {
		const store = new ProxyTokenStore(path);
		const scribe = await store.ensure("scribe");
		await store.ensure("scout");

		await store.forget("scout");

		expect(await new ProxyTokenStore(path).ensure("scribe")).toBe(scribe);
	});

	it("mints rather than throws when the file is unreadable", async () => {
		// Losing the file costs the running sandboxes their egress, which is bad. Refusing to start
		// costs them that and everything else, so a corrupt file is treated as an empty one.
		await writeFile(path, "{ not json", "utf8");

		expect(await new ProxyTokenStore(path).ensure("scout")).toMatch(/^[\w-]{32}$/);
	});

	it("writes the file whole or not at all", async () => {
		const store = new ProxyTokenStore(path);
		await store.ensure("scout");
		await store.ensure("scribe");

		expect(Object.keys(JSON.parse(await readFile(path, "utf8")))).toEqual(["scout", "scribe"]);
	});
});
