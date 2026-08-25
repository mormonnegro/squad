import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Bot } from "@agent-dive/channels";

interface Book {
	readonly bots: Record<string, Bot>;
}

/**
 * The Telegram bots the plane holds, one per agent.
 *
 * On disk rather than in the operator's config file for the reason every other console-set thing is:
 * a bot is connected by pasting a token into the console and paired by tapping a link on a phone,
 * and neither of those is an edit somebody makes to a file and redeploys. It also holds what pairing
 * discovered — which account is the operator, which chats to answer in — and that is not configuration
 * at all; it is what happened, and a file the operator writes has nowhere to put it.
 *
 * The token is here too. It is a live credential, so this file is as sensitive as the state directory
 * around it, which is the same thing already true of the keys beside it.
 */
export class TelegramBots {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async all(): Promise<readonly Bot[]> {
		const book = await this.#serialize(() => this.#read());
		return Object.values(book.bots);
	}

	async get(agentId: string): Promise<Bot | undefined> {
		const book = await this.#serialize(() => this.#read());
		return book.bots[agentId];
	}

	/** Writes a bot down as it now is, replacing whatever was held for that agent. */
	async save(bot: Bot): Promise<void> {
		await this.#change((book) => {
			book.bots[bot.agentId] = bot;
		});
	}

	/** Forgets an agent's bot, and says whether there was one. */
	async forget(agentId: string): Promise<boolean> {
		let had = false;
		await this.#change((book) => {
			had = book.bots[agentId] !== undefined;
			delete book.bots[agentId];
		});
		return had;
	}

	async #change(edit: (book: { bots: Record<string, Bot> }) => void): Promise<void> {
		await this.#serialize(async () => {
			const book = await this.#read();
			edit(book);
			await this.#write(book);
		});
	}

	async #read(): Promise<{ bots: Record<string, Bot> }> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				return { bots: {} };
			return { bots: (parsed as Partial<Book>).bots ?? {} };
		} catch {
			return { bots: {} };
		}
	}

	async #write(book: Book): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the bots it had rather than
		// half of them — which for this file means a token gone and an agent that stops answering.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(book, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic, and the channel writes here on every message it learns from.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
