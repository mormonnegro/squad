import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSecretStore } from "@squad/proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderKeys } from "../src/keys.ts";

describe("ProviderKeys", () => {
	let dir = "";
	let path = "";
	const environment = new EnvSecretStore({ DEEPSEEK_API_KEY: "from-the-machine" });
	const keysAt = (at = path) => new ProviderKeys(at, environment);

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "keys-"));
		path = join(dir, "keys.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	// The layering, from underneath: a machine that already exports its keys goes on working with an
	// empty file beside it, which is what makes this safe to add to a plane nobody wants to touch.
	it("answers with the environment while nothing has been typed", async () => {
		expect(await keysAt().resolve({ ref: "DEEPSEEK_API_KEY" })).toBe("from-the-machine");
	});

	it("has nothing to say about a variable nobody set anywhere", async () => {
		expect(await keysAt().resolve({ ref: "GROQ_API_KEY" })).toBeUndefined();
	});

	it("takes a key for a provider the environment never had", async () => {
		const keys = keysAt();

		await keys.keep("ANTHROPIC_API_KEY", "sk-typed");

		expect(await keys.resolve({ ref: "ANTHROPIC_API_KEY" })).toBe("sk-typed");
	});

	// The more recent answer to the same question wins, which is the only thing that makes this a
	// place to fix a key rather than a second place to be confused by one.
	it("wins over the environment, because it was said later", async () => {
		const keys = keysAt();

		await keys.keep("DEEPSEEK_API_KEY", "sk-typed");

		expect(await keys.resolve({ ref: "DEEPSEEK_API_KEY" })).toBe("sk-typed");
	});

	it("hands the question back to the environment when the key is taken away", async () => {
		const keys = keysAt();
		await keys.keep("DEEPSEEK_API_KEY", "sk-typed");

		await keys.keep("DEEPSEEK_API_KEY", "");

		expect(await keys.resolve({ ref: "DEEPSEEK_API_KEY" })).toBe("from-the-machine");
	});

	// A plane restarts on every update, and a key that lived in memory would make setting one a thing
	// you do again after each deploy — which is the whole problem this exists to end.
	it("survives the plane it was typed at", async () => {
		await keysAt().keep("ANTHROPIC_API_KEY", "sk-typed");

		expect(await keysAt().resolve({ ref: "ANTHROPIC_API_KEY" })).toBe("sk-typed");
	});

	it("says which keys are its own, so a screen can say where one came from", async () => {
		const keys = keysAt();
		await keys.keep("ANTHROPIC_API_KEY", "sk-typed");

		expect([...(await keys.here())]).toEqual(["ANTHROPIC_API_KEY"]);
	});

	// The environment's key is not this file's, and a row that claimed it was would send somebody to
	// this screen to change something that is actually in `.env`.
	it("does not claim the ones the machine exported", async () => {
		expect((await keysAt().here()).has("DEEPSEEK_API_KEY")).toBe(false);
	});

	it("keeps two keys pasted in the same breath", async () => {
		const keys = keysAt();

		await Promise.all([keys.keep("A_API_KEY", "one"), keys.keep("B_API_KEY", "two")]);

		expect([
			await keys.resolve({ ref: "A_API_KEY" }),
			await keys.resolve({ ref: "B_API_KEY" }),
		]).toEqual(["one", "two"]);
	});

	/**
	 * The one file in the state directory holding secrets rather than the names of secrets. Everything
	 * else there can be read by anyone with an account on the machine without giving anything away.
	 */
	it("is readable by nobody but its owner", async () => {
		await keysAt().keep("ANTHROPIC_API_KEY", "sk-typed");

		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
