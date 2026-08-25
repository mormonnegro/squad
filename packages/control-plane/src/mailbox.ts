import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Account } from "@agent-dive/channels";

interface Book {
	readonly mailbox?: Account;
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
