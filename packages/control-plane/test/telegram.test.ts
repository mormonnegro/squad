import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "@squad/channels";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelegramBots } from "../src/telegram.ts";

let dir = "";
let path = "";
let bots: TelegramBots;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "telegram-"));
	path = join(dir, "telegram.json");
	bots = new TelegramBots(path);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const bot = (over: Partial<Bot> = {}): Bot => ({
	agentId: "scout",
	token: "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
	username: "scout_bot",
	operators: [],
	chats: [],
	...over,
});

describe("TelegramBots", () => {
	it("has nothing to say before anything has been written", async () => {
		expect(await bots.all()).toEqual([]);
		expect(await bots.get("scout")).toBeUndefined();
	});

	it("gives a bot back as it was written down", async () => {
		await bots.save(bot({ operators: [7], chats: [-100], offset: 42 }));

		expect(await bots.get("scout")).toMatchObject({ operators: [7], chats: [-100], offset: 42 });
		expect(await bots.all()).toHaveLength(1);
	});

	// The channel writes here on every message it learns from, so a save is a replacement rather
	// than a merge: what the channel holds in memory is the whole truth about that bot.
	it("replaces the bot an agent had rather than adding a second", async () => {
		await bots.save(bot({ operators: [7] }));
		await bots.save(bot({ operators: [7, 9], chats: [-100] }));

		expect(await bots.all()).toHaveLength(1);
		expect(await bots.get("scout")).toMatchObject({ operators: [7, 9], chats: [-100] });
	});

	it("keeps one agent's bot out of another's", async () => {
		await bots.save(bot());
		await bots.save(bot({ agentId: "clerk", username: "clerk_bot" }));

		expect(await bots.forget("scout")).toBe(true);
		expect(await bots.get("clerk")).toBeDefined();
		expect(await bots.forget("scout")).toBe(false);
	});

	it("reads back what another plane left on disk", async () => {
		await bots.save(bot({ chats: [-100] }));

		expect(await new TelegramBots(path).get("scout")).toMatchObject({ chats: [-100] });
	});

	// Every message can move the offset, and a read-modify-write that interleaves loses whichever
	// change lost the race — which for this file is an operator whose chat was never learned.
	it("does not lose a change to a write happening at the same time", async () => {
		await bots.save(bot());
		await Promise.all([
			bots.save(bot({ agentId: "a1", username: "a1_bot" })),
			bots.save(bot({ agentId: "a2", username: "a2_bot" })),
			bots.forget("scout"),
		]);

		expect((await bots.all()).map((one) => one.agentId).sort()).toEqual(["a1", "a2"]);
	});

	// A plane killed mid-write, or a file edited by hand into something that is not this.
	it("starts over rather than throwing on a file it cannot read", async () => {
		await writeFile(path, "{ this is not", "utf8");

		expect(await bots.all()).toEqual([]);
		await bots.save(bot());
		expect(await bots.get("scout")).toBeDefined();
	});

	it("leaves nothing behind but the file it meant to write", async () => {
		await bots.save(bot());

		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			bots: { scout: { username: "scout_bot" } },
		});
	});
});
