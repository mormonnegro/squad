import type { NewAgentEvent } from "@agent-dive/events";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelRouter } from "../src/channel.ts";
import {
	type Bot,
	intoMessages,
	pairingPhrase,
	startLink,
	TelegramChannel,
} from "../src/telegram.ts";

const TOKEN = "1234:abcdef";

class RecordingPublisher {
	readonly published: NewAgentEvent[] = [];

	async publish(event: NewAgentEvent): Promise<void> {
		this.published.push(event);
	}
}

interface Update {
	readonly update_id: number;
	readonly message?: {
		readonly from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
		readonly chat?: { id: number; type?: string; title?: string };
		readonly text?: string;
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Stands in for api.telegram.org, holding a poll open until something arrives the way it does. */
class FakeTelegram {
	readonly sent: Array<{ token: string; chatId: number; text: string }> = [];
	readonly polls: Array<Record<string, unknown>> = [];
	refusing: { status: number; description: string } | undefined;
	#pending: Update[] = [];

	deliver(...updates: readonly Update[]): void {
		this.#pending.push(...updates);
	}

	readonly fetch: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		const token = url.split("/bot")[1]?.split("/")[0] ?? "";
		const method = url.split("/").at(-1) ?? "";
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

		if (method === "getMe") {
			return json({ ok: true, result: { id: 42, username: "agent_bot", first_name: "Agent" } });
		}
		if (method === "sendMessage") {
			this.sent.push({ token, chatId: Number(body.chat_id), text: String(body.text) });
			return json({ ok: true, result: {} });
		}
		if (method !== "getUpdates") return json({ ok: false, description: "unknown method" }, 404);

		this.polls.push(body);
		if (this.refusing !== undefined) {
			return json({ ok: false, description: this.refusing.description }, this.refusing.status);
		}
		// Telegram treats an offset as an acknowledgement of everything below it.
		if (typeof body.offset === "number") {
			this.#pending = this.#pending.filter((update) => update.update_id >= Number(body.offset));
		}
		await this.#hang(init?.signal);
		return json({ ok: true, result: this.#pending.splice(0) });
	};

	async #hang(signal?: AbortSignal | null): Promise<void> {
		for (let waited = 0; waited < 400; waited += 1) {
			if (signal?.aborted === true) throw new Error("aborted");
			if (this.#pending.length > 0) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

function message(
	updateId: number,
	from: number,
	chat: number,
	text: string,
	extra: { title?: string; isBot?: boolean; username?: string } = {},
): Update {
	return {
		update_id: updateId,
		message: {
			from: {
				id: from,
				...(extra.isBot !== undefined ? { is_bot: extra.isBot } : {}),
				...(extra.username !== undefined ? { username: extra.username } : {}),
			},
			chat: { id: chat, ...(extra.title !== undefined ? { title: extra.title } : {}) },
			text,
		},
	};
}

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let waited = 0; waited < 400; waited += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

const stoppers: Array<() => void> = [];

afterEach(() => {
	for (const stop of stoppers.splice(0)) stop();
});

interface Running {
	readonly channel: TelegramChannel;
	readonly telegram: FakeTelegram;
	readonly publisher: RecordingPublisher;
	readonly changes: Bot[];
}

function running(bot: Partial<Bot> = {}): Running {
	const telegram = new FakeTelegram();
	const publisher = new RecordingPublisher();
	const changes: Bot[] = [];
	const channel = new TelegramChannel({
		bots: [{ agentId: "a1", token: TOKEN, operators: [], chats: [], ...bot }],
		publisher,
		fetch: telegram.fetch,
		pollSeconds: 0,
		onChange: (changed) => changes.push(changed),
	});
	stoppers.push(() => channel.stop());
	channel.start();
	return { channel, telegram, publisher, changes };
}

describe("intoMessages", () => {
	it("leaves anything Telegram will carry in one piece", () => {
		expect(intoMessages("a short answer")).toEqual(["a short answer"]);
	});

	it("breaks a long answer where the text breaks", () => {
		const paragraph = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
		expect(intoMessages(paragraph)).toEqual(["a".repeat(3000), "b".repeat(3000)]);
	});

	it("cuts an unbroken run rather than refusing to send it", () => {
		const parts = intoMessages("x".repeat(9000));
		expect(parts).toHaveLength(3);
		expect(parts.every((part) => part.length <= 4096)).toBe(true);
		expect(parts.join("")).toHaveLength(9000);
	});
});

describe("pairing", () => {
	it("offers a phrase a Start link can carry", () => {
		const phrase = pairingPhrase();
		expect(phrase).toMatch(/^[a-z0-9]{10}$/);
		expect(startLink("agent_bot", phrase)).toBe(`https://t.me/agent_bot?start=${phrase}`);
	});

	it("binds whoever sends the phrase, and answers them where they sent it", async () => {
		const { channel, telegram, publisher } = running({ pairing: "openthedoor" });

		telegram.deliver(message(1, 7, 7, "/start openthedoor"));
		await until(() => telegram.sent.length > 0, "the paired reply");

		expect(channel.bot("a1")).toMatchObject({ operators: [7], chats: [7] });
		// Gone rather than emptied: a phrase left behind is a second key to the same door.
		expect(channel.bot("a1")).not.toHaveProperty("pairing");
		expect(telegram.sent[0]?.text).toContain("You are the operator of a1");
		// The phrase is plumbing, not something anyone said to the agent.
		expect(publisher.published).toHaveLength(0);
	});

	/**
	 * The link is not always enough. Telegram Web opens the chat without handing the bot what is
	 * behind `?start=`, so the way through there is typing the phrase — and a phone puts a capital on
	 * the front of a message on the way. Pairing that a keyboard can defeat is pairing that fails for
	 * the person who needed the fallback in the first place.
	 */
	it("takes the phrase typed out, however the keyboard cased it", async () => {
		const { channel, telegram } = running({ pairing: "openthedoor" });

		telegram.deliver(message(1, 7, 7, "Openthedoor"));
		await until(() => telegram.sent.length > 0, "the paired reply");

		expect(channel.bot("a1")).toMatchObject({ operators: [7], chats: [7] });
	});

	it("ignores anyone who does not have the phrase", async () => {
		const { channel, telegram, publisher } = running({ pairing: "openthedoor" });

		telegram.deliver(message(1, 9, 9, "hello?"), message(2, 7, 7, "/start openthedoor"));
		await until(() => telegram.sent.length > 0, "the paired reply");

		expect(channel.bot("a1")?.operators).toEqual([7]);
		expect(publisher.published).toHaveLength(0);
	});
});

describe("TelegramChannel", () => {
	const paired = { operators: [7], chats: [7] };

	it("publishes an operator's message as one the agent may act on", async () => {
		const { telegram, publisher } = running(paired);

		telegram.deliver(message(5, 7, 7, "deploy the site", { username: "nico" }));
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published[0]).toMatchObject({
			agentId: "a1",
			source: "channel",
			trust: "operator",
			channel: "telegram:7",
			actor: { id: "7", displayName: "@nico" },
			body: "deploy the site",
			replyTo: "7",
		});
	});

	it("publishes anyone else in the same chat as a participant", async () => {
		const { telegram, publisher } = running({ operators: [7], chats: [-100] });

		telegram.deliver(message(5, 9, -100, "and me?", { title: "the team" }));
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published[0]).toMatchObject({
			trust: "participant",
			channel: "telegram:-100",
			subject: "the team",
		});
	});

	it("learns a chat from the operator speaking in it", async () => {
		const { channel, telegram, publisher } = running(paired);

		telegram.deliver(message(5, 7, -500, "over here now", { title: "the team" }));
		await until(() => publisher.published.length > 0, "the event");

		expect(channel.bot("a1")?.chats).toEqual([7, -500]);
		expect(publisher.published[0]).toMatchObject({ trust: "operator", channel: "telegram:-500" });
	});

	it("drops a stranger writing from a chat nobody trusted", async () => {
		const { telegram, publisher } = running(paired);

		telegram.deliver(message(5, 9, 9, "hello"), message(6, 7, 7, "hello"));
		await until(() => publisher.published.length > 0, "the operator's event");

		expect(publisher.published).toHaveLength(1);
		expect(publisher.published[0]).toMatchObject({ actor: { id: "7" } });
	});

	it("says nothing back to another bot", async () => {
		const { telegram, publisher } = running(paired);

		telegram.deliver(message(5, 7, 7, "beep", { isBot: true }), message(6, 7, 7, "real"));
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published).toHaveLength(1);
		expect(publisher.published[0]).toMatchObject({ body: "real" });
	});

	it("does not spend a turn on the Start button", async () => {
		const { telegram, publisher } = running(paired);

		telegram.deliver(message(5, 7, 7, "/start"), message(6, 7, 7, "now this"));
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published).toHaveLength(1);
		expect(publisher.published[0]).toMatchObject({ body: "now this" });
	});

	it("moves the offset past what it has queued, and says so", async () => {
		const { telegram, changes, publisher } = running(paired);

		telegram.deliver(message(10, 7, 7, "one"), message(11, 7, 7, "two"));
		await until(() => publisher.published.length === 2, "both events");
		await until(() => telegram.polls.some((poll) => poll.offset === 12), "the acknowledgement");

		expect(changes.at(-1)).toMatchObject({ offset: 12 });
	});

	it("answers into the chat the message came from", async () => {
		const { channel, telegram } = running(paired);

		await channel.send({ agentId: "a1", channel: "telegram:7", body: "done" });

		expect(telegram.sent).toEqual([{ token: TOKEN, chatId: 7, text: "done" }]);
	});

	it("refuses a reply for an agent it holds no bot for", async () => {
		const { channel } = running(paired);

		await expect(
			channel.send({ agentId: "other", channel: "telegram:7", body: "hi" }),
		).rejects.toThrow(/No Telegram bot/);
	});

	it("routes a reply by the channel it arrived on", async () => {
		const { channel, telegram } = running(paired);
		const router = new ChannelRouter();
		router.register(channel);

		await router.send({ agentId: "a1", channel: "telegram:7", body: "routed" });

		expect(telegram.sent[0]?.text).toBe("routed");
	});

	it("stops polling a token Telegram has rejected, and says so once", async () => {
		const failures: Error[] = [];
		const telegram = new FakeTelegram();
		telegram.refusing = { status: 401, description: "Unauthorized" };
		const channel = new TelegramChannel({
			bots: [{ agentId: "a1", token: TOKEN, ...paired }],
			publisher: new RecordingPublisher(),
			fetch: telegram.fetch,
			pollSeconds: 0,
			onError: (_agentId, error) => failures.push(error),
		});
		stoppers.push(() => channel.stop());
		channel.start();

		await until(() => failures.length > 0, "the refusal");
		const polled = telegram.polls.length;
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(failures).toHaveLength(1);
		expect(failures[0]?.message).toContain("Unauthorized");
		expect(telegram.polls.length).toBe(polled);
	});

	it("identifies a token before it is kept", async () => {
		const { channel } = running(paired);

		expect(await channel.identify(TOKEN)).toEqual({
			id: 42,
			username: "agent_bot",
			firstName: "Agent",
		});
	});
});
