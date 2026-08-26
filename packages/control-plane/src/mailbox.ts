import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Account } from "@agent-dive/channels";

interface Book {
	readonly mailbox?: Account;
}

/**
 * The whole of this plane's email as one screen needs it: what it reads, and what it writes through.
 *
 * The two halves are separate on purpose. Reading is a mailbox and a password, and it is the channel;
 * writing is whichever company hands the message over, and it is an improvement on the channel that
 * can be missing, chosen, or chosen and unpaid for. A screen that ran them together would have one
 * dot for two things that fail for unrelated reasons.
 */
export interface MailStanding {
	/** The account mail arrives at, or nothing when none is connected. */
	readonly mailbox: string | undefined;
	readonly host: string | undefined;
	/** Which carrier takes the mail out. Empty is the mailbox's own submission server. */
	readonly carrier: string;
	/** The domain that carrier was set up to send from, for the ones that will not guess. */
	readonly domain: string;
	/** What the way out is paid with, or nothing when it is the mailbox's own password. */
	readonly keyEnv: string | undefined;
	readonly held: boolean;
	/** Whether the key is this plane's own file rather than the environment it was started with. */
	readonly here: boolean;
	/** Whether mail can actually leave: somewhere to hand it in, and the means to pay for that. */
	readonly writes: boolean;
	/** What went wrong the last time this was tried, if something did. */
	readonly trouble: string | undefined;
}

/**
 * The mailbox on disk, beside the bots and for the same reasons.
 *
 * An address and an app password are pasted into a console, and what pairing then discovers — which
 * address is the operator, how far the mail has been read — is not configuration at all. It is what
 * happened, and a file the operator writes has nowhere to put it.
 */
export class MailboxStore {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async get(): Promise<Account | undefined> {
		return (await this.#serialize(() => this.#read())).mailbox;
	}

	async save(mailbox: Account): Promise<void> {
		await this.#serialize(() => this.#write({ mailbox }));
	}

	/** Forgets it, and says whether there was one. */
	async forget(): Promise<boolean> {
		return this.#serialize(async () => {
			const had = (await this.#read()).mailbox !== undefined;
			await this.#write({});
			return had;
		});
	}

	async #read(): Promise<Book> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			return parsed as Book;
		} catch {
			return {};
		}
	}

	async #write(book: Book): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the mailbox it had rather
		// than half of one — which here means a password gone and mail piling up unread.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(book, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic, and the channel writes here every time it reads a message.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
