import { randomBytes } from "node:crypto";
import type { NewAgentEvent, TrustLevel } from "@agent-dive/events";
import { type Channel, ChannelError, type Reply } from "./channel.ts";

/**
 * A bot the plane holds for one agent, and who it has learned to listen to in it.
 *
 * One bot per agent rather than one bot shared out, because the bot is the agent as far as anyone
 * writing to it is concerned: it has the agent's name, its picture and its conversation history.
 * BotFather gives them away, so the cost of that is a token and the benefit is that a message
 * needs no addressing — whoever opened this chat is already talking to exactly one agent.
 */
export interface Bot {
	readonly agentId: string;
	/** BotFather's token. It is the whole account: whoever holds it is the bot. */
	readonly token: string;
	/** Telegram user ids whose messages carry operator trust. */
	readonly operators: readonly number[];
	/** Chats the bot answers in at all. Anything from elsewhere is dropped unread. */
	readonly chats: readonly number[];
	/** The phrase that binds the first operator, until one is bound. */
	readonly pairing?: string;
	/** Where getUpdates resumes. Telegram holds the rest for 24 hours. */
	readonly offset?: number;
}

export interface TelegramPublisher {
	publish(event: NewAgentEvent): Promise<unknown>;
}

export interface TelegramChannelOptions {
	readonly bots?: readonly Bot[];
	readonly publisher: TelegramPublisher;
	/**
	 * A bot after something about it changed: a new operator, a chat it learned, an offset moved on.
	 *
	 * Handed out rather than written here because where this belongs on disk is the plane's business,
	 * and a channel that picked a file would be a second thing deciding where the plane's state lives.
	 */
	readonly onChange?: (bot: Bot) => void;
	readonly api?: string;
	readonly fetch?: typeof globalThis.fetch;
	/** How long a poll hangs waiting for a message. Telegram allows up to 50 seconds. */
	readonly pollSeconds?: number;
	readonly onError?: (agentId: string, error: Error) => void;
}

interface TelegramUser {
	readonly id: number;
	readonly is_bot?: boolean;
	readonly first_name?: string;
	readonly username?: string;
}

interface TelegramChat {
	readonly id: number;
	readonly type?: string;
	readonly title?: string;
}

interface TelegramMessage {
	readonly from?: TelegramUser;
	readonly chat?: TelegramChat;
	readonly text?: string;
	readonly caption?: string;
}

interface TelegramUpdate {
	readonly update_id: number;
	readonly message?: TelegramMessage;
}

/** What getMe says about a token, which is the only authority on whether it is a live one. */
export interface BotIdentity {
	readonly id: number;
	readonly username?: string;
	readonly firstName?: string;
}

const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_POLL_SECONDS = 50;

/** Telegram refuses anything longer, so a turn that wrote an essay arrives in several messages. */
const MOST_CHARS = 4096;

const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 60_000;

/** No vowels, so it cannot come out as a word, and none of the letters a digit is mistaken for. */
const CODE_ALPHABET = "bcdfghjkmnpqrstvwxz23456789";

/**
 * A phrase that binds whoever sends it as the operator of a bot.
 *
 * In the alphabet a `/start` deep link allows, so the console can offer this as a link to tap rather
 * than a code to copy across to a phone — which is where Telegram is, and where a keyboard is not.
 */
export function pairingPhrase(): string {
	return Array.from(randomBytes(10), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

/** The link that opens the chat with the phrase already in the Start button. */
export function startLink(username: string, phrase: string): string {
	return `https://t.me/${username}?start=${phrase}`;
}

/** Splits an answer into messages Telegram will carry, preferring to break where the text does. */
export function intoMessages(text: string, limit = MOST_CHARS): readonly string[] {
	const parts: string[] = [];
	let rest = text.trim();

	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const broke = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
		// Only if the break is late enough to be worth taking. A paragraph whose only newline is in
		// the first line would otherwise be cut there, sending one word and then the whole essay.
		const cut = broke > limit / 2 ? broke : limit;
		parts.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest.length > 0) parts.push(rest);
	return parts;
}

class TelegramApiError extends ChannelError {
	readonly code: number | undefined;

	constructor(message: string, code?: number) {
		super(message);
		this.name = "TelegramApiError";
		this.code = code;
	}
}

interface Polling {
	readonly stopping: AbortController;
	/** What went wrong last, so an hour of the same failure is reported once rather than every poll. */
	said?: string | undefined;
	backoffMs: number;
}

/**
 * Turns Telegram messages into events, and posts answers back into the chat they came from.
 *
 * Long polling rather than a webhook, because a webhook needs a public address with a certificate on
 * it, and the machine this is meant to run on is a small VPS behind whatever its provider gave it.
 * Polling reaches Telegram from the inside, so an agent-dive that can make outbound requests can be
 * spoken to, with no DNS record, no port open and nothing to point at it.
 *
 * Trust is a list of user ids per bot, unlike a webhook, which may never carry operator trust. The
 * difference is real: a hook's secret proves which system sent a request and says nothing about who
 * wrote the contents, while Telegram authenticates the account behind every message it delivers. So
 * an operator who has paired their own account can instruct their agent from their phone, and
 * everyone else in the chat is a participant whose words are data.
 */
export class TelegramChannel implements Channel {
	readonly name = "telegram";
	readonly #bots = new Map<string, Bot>();
	readonly #polling = new Map<string, Polling>();
	readonly #publisher: TelegramPublisher;
	readonly #onChange: ((bot: Bot) => void) | undefined;
	readonly #api: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #pollSeconds: number;
	readonly #onError: ((agentId: string, error: Error) => void) | undefined;
	#running = false;

	constructor(options: TelegramChannelOptions) {
		for (const bot of options.bots ?? []) this.#bots.set(bot.agentId, bot);
		this.#publisher = options.publisher;
		this.#onChange = options.onChange;
		this.#api = options.api ?? TELEGRAM_API;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#pollSeconds = options.pollSeconds ?? DEFAULT_POLL_SECONDS;
		this.#onError = options.onError;
	}

	bot(agentId: string): Bot | undefined {
		return this.#bots.get(agentId);
	}

	bots(): readonly Bot[] {
		return [...this.#bots.values()];
	}

	/** Asks Telegram who a token belongs to, which is how a token is checked before it is kept. */
	async identify(token: string): Promise<BotIdentity> {
		const me = await this.#call<TelegramUser>(token, "getMe", {});
		return {
			id: me.id,
			...(me.username !== undefined ? { username: me.username } : {}),
			...(me.first_name !== undefined ? { firstName: me.first_name } : {}),
		};
	}

	/** Takes a bot on, and starts listening for it if the channel is already listening. */
	add(bot: Bot): void {
		this.#bots.set(bot.agentId, bot);
		if (this.#running) this.#listen(bot.agentId);
	}

	/** Puts a bot down, and says whether there was one. The token stays valid; this stops using it. */
	remove(agentId: string): boolean {
		const had = this.#bots.delete(agentId);
		this.#polling.get(agentId)?.stopping.abort();
		this.#polling.delete(agentId);
		return had;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		for (const agentId of this.#bots.keys()) this.#listen(agentId);
	}

	stop(): void {
		this.#running = false;
		for (const polling of this.#polling.values()) polling.stopping.abort();
		this.#polling.clear();
	}

	async send(reply: Reply): Promise<void> {
		const bot = this.#bots.get(reply.agentId);
		if (bot === undefined) throw new ChannelError(`No Telegram bot for "${reply.agentId}"`);

		const chatId = Number(reply.channel.slice(`${this.name}:`.length));
		if (!Number.isFinite(chatId)) {
			throw new ChannelError(`"${reply.channel}" does not name a Telegram chat`);
		}
		for (const text of intoMessages(reply.body)) {
			await this.#say(bot.token, chatId, text);
		}
	}

	/**
	 * Sent as plain text, with no parse mode.
	 *
	 * Asking Telegram to read it as Markdown would be asking it to reject the message whenever the
	 * agent wrote an asterisk it did not close — which a model writing about multiplication or a glob
	 * does constantly. A refused message is worse than an unstyled one: the operator sees nothing at
	 * all and the turn has already been paid for.
	 */
	async #say(token: string, chatId: number, text: string): Promise<void> {
		await this.#call(token, "sendMessage", { chat_id: chatId, text });
	}

	#listen(agentId: string): void {
		if (this.#polling.has(agentId)) return;
		const polling: Polling = { stopping: new AbortController(), backoffMs: FIRST_RETRY_MS };
		this.#polling.set(agentId, polling);
		void this.#poll(agentId, polling);
	}

	async #poll(agentId: string, polling: Polling): Promise<void> {
		while (this.#running && this.#polling.get(agentId) === polling) {
			const bot = this.#bots.get(agentId);
			if (bot === undefined) break;

			try {
				const updates = await this.#call<TelegramUpdate[]>(
					bot.token,
					"getUpdates",
					{
						...(bot.offset !== undefined ? { offset: bot.offset } : {}),
						timeout: this.#pollSeconds,
						// Edits are left out on purpose: a message rewritten an hour later would wake the
						// agent again, and nobody editing a typo means to ask a second time.
						allowed_updates: ["message"],
					},
					polling.stopping.signal,
				);
				polling.backoffMs = FIRST_RETRY_MS;
				polling.said = undefined;

				for (const update of updates) await this.#receive(agentId, update);
				// After the events are queued rather than before, so a plane that dies mid-batch is told
				// the same messages again instead of losing them. A repeat is a wasted turn; a loss is an
				// operator whose message was never answered and who has no way to know that.
				const last = updates.at(-1);
				if (last !== undefined)
					this.#change(agentId, (held) => ({ ...held, offset: last.update_id + 1 }));
			} catch (error) {
				if (polling.stopping.signal.aborted) return;
				if (!(await this.#recover(agentId, polling, error))) return;
			}
		}
	}

	/**
	 * Waits out a failure, and says whether polling should carry on at all.
	 *
	 * A token Telegram has rejected is not going to start working, so that one stops and says so
	 * once. Everything else is treated as weather — a dropped connection, a 502, the other end of a
	 * restart — and backed off up to a minute, because the alternative to retrying is an agent that
	 * silently stopped answering its messages.
	 */
	async #recover(agentId: string, polling: Polling, error: unknown): Promise<boolean> {
		const failure = error instanceof Error ? error : new Error(String(error));
		const fatal = error instanceof TelegramApiError && error.code === 401;

		// Only when it is news. A bot broken all afternoon should say so at the start of the afternoon,
		// not once a minute until somebody scrolls past the rest of the plane's log looking for it.
		if (fatal || polling.said !== failure.message) {
			polling.said = failure.message;
			this.#onError?.(agentId, failure);
		}
		if (fatal) {
			this.#polling.delete(agentId);
			return false;
		}

		await new Promise((resolve) => setTimeout(resolve, polling.backoffMs));
		polling.backoffMs = Math.min(polling.backoffMs * 2, LONGEST_RETRY_MS);
		return true;
	}

	async #receive(agentId: string, update: TelegramUpdate): Promise<void> {
		const bot = this.#bots.get(agentId);
		const message = update.message;
		const from = message?.from;
		const chat = message?.chat;
		if (bot === undefined || message === undefined || from === undefined || chat === undefined) {
			return;
		}
		// Another bot is not a person, and two bots put in the same group would otherwise answer each
		// other for as long as the tokens last.
		if (from.is_bot === true) return;

		const text = message.text ?? message.caption;
		if (text === undefined || text.trim().length === 0) return;

		if (bot.pairing !== undefined) {
			await this.#pair(bot, from, chat, text);
			return;
		}

		const isOperator = bot.operators.includes(from.id);
		// A chat is learned from the operator speaking in it, which is what makes adding the bot to a
		// group enough to make the group work. A chat nobody trusted has spoken in is dropped unread:
		// a bot's name is guessable, and without this anyone who found it could spend the agent's day.
		if (isOperator && !bot.chats.includes(chat.id)) {
			this.#change(agentId, (held) => ({ ...held, chats: [...held.chats, chat.id] }));
		} else if (!bot.chats.includes(chat.id)) {
			return;
		}

		// Telegram's client sends this by itself when a chat is opened. Answering it costs a turn for a
		// button nobody thought of as writing to anyone.
		if (text.trim() === "/start") return;

		const trust: TrustLevel = isOperator ? "operator" : "participant";
		const displayName = nameOf(from);
		await this.#publisher.publish({
			agentId,
			source: "channel",
			trust,
			channel: `${this.name}:${chat.id}`,
			actor: { id: String(from.id), ...(displayName !== undefined ? { displayName } : {}) },
			...(chat.title !== undefined ? { subject: chat.title } : {}),
			body: text,
			replyTo: String(chat.id),
		});
	}

	/**
	 * Binds the first account to send the phrase as the operator, and answers where they sent it.
	 *
	 * A phrase rather than the first message that arrives, because a bot's name can be guessed and
	 * the window between connecting one and pairing it would otherwise be a race a stranger could
	 * win — winning, in that case, the right to instruct somebody else's agent.
	 */
	async #pair(bot: Bot, from: TelegramUser, chat: TelegramChat, text: string): Promise<void> {
		if (!text.includes(bot.pairing ?? "")) return;

		this.#change(bot.agentId, (held) => ({
			agentId: held.agentId,
			token: held.token,
			operators: [...held.operators, from.id],
			chats: held.chats.includes(chat.id) ? held.chats : [...held.chats, chat.id],
			...(held.offset !== undefined ? { offset: held.offset } : {}),
		}));
		// The phrase is not a message to the agent, so nothing is published for it. What is owed is an
		// answer to the person who just tapped a link and is looking at an empty chat.
		await this.#say(
			bot.token,
			chat.id,
			`Paired. You are the operator of ${bot.agentId}: write here and it takes a turn.`,
		).catch((error: Error) => this.#onError?.(bot.agentId, error));
	}

	#change(agentId: string, edit: (bot: Bot) => Bot): void {
		const held = this.#bots.get(agentId);
		if (held === undefined) return;
		const changed = edit(held);
		this.#bots.set(agentId, changed);
		this.#onChange?.(changed);
	}

	async #call<T>(
		token: string,
		method: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await this.#fetch(`${this.#api}/bot${token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			...(signal !== undefined ? { signal } : {}),
		});

		const parsed = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; result?: T; description?: string }
			| undefined;

		if (parsed?.ok !== true) {
			// Telegram's own sentence rather than the status, because "chat not found" and "bot was
			// blocked by the user" are both 400 and only one of them is the operator's to fix.
			const said = parsed?.description ?? `${response.status}`;
			throw new TelegramApiError(`Telegram refused ${method}: ${said}`, response.status);
		}
		return parsed.result as T;
	}
}

function nameOf(user: TelegramUser): string | undefined {
	return user.username !== undefined ? `@${user.username}` : user.first_name;
}
