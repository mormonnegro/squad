import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashOf } from "./devices.ts";

/**
 * The ways in that have been handed out, one line each.
 *
 * Before this there was one way to let somebody in: give them `web.token`, which is the key to the
 * plane itself. It never expires, it is the same string for everybody, and the device list — which
 * is otherwise the honest answer to who is in here — could take a browser out and then watch the
 * same person walk back in with the token they still had. Taking that access away meant rotating
 * the token, which takes everybody out at once, including you.
 *
 * So an invitation is a thing of its own: it is for somebody, it runs out, and it can be called off
 * before it is spent. What it admits is a device, and the device remembers which invitation let it
 * in — so "who let this browser in" has an answer, which is the question a list of browsers cannot
 * answer by itself.
 *
 * What is stored is a hash. The secret exists once, in the link somebody is handed, and nowhere
 * else: whoever reads this file holds a list of things that have been given out rather than a way
 * in. Lose the link and there is nothing to recover — call it off and make another, which is a
 * weaker promise than a password manager and the right one for a thing that expires anyway.
 */
export interface Invite {
	readonly id: string;
	/** Who it is for, as the operator wrote it: "for Nico", "the laptop at home". */
	readonly label: string;
	readonly createdAt: string;
	/** When it stops admitting anybody. Every invitation has one. */
	readonly expiresAt: string;
	/** How many more browsers it may let in. Zero is spent. */
	readonly left: number;
	/** The devices that came in on it, oldest first. */
	readonly admitted: readonly string[];
}

interface Kept extends Invite {
	/** sha256 of the secret this invitation carries. The secret itself is never written down. */
	readonly hash: string;
}

/** What an invitation may be made to last. Never "forever": that is what the token already is. */
export const LASTS = {
	hour: 60 * 60_000,
	day: 24 * 60 * 60_000,
	week: 7 * 24 * 60 * 60_000,
} as const;

export type Lasts = keyof typeof LASTS;

/** What to make when nobody said: one browser, today. The narrow end of both choices. */
export const DEFAULT_LASTS: Lasts = "day";

export class Invites {
	readonly #path: string;
	#held: Promise<Kept[]> | undefined;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** The list as a screen shows it: no hashes, newest first. */
	async all(): Promise<readonly Invite[]> {
		const held = await this.#load();
		return held
			.map(({ hash: _hash, ...rest }) => rest)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/**
	 * A way in for one person, handed out once.
	 *
	 * The secret comes back from here and never again. It is the whole of the invitation — an
	 * address with this on the end of it is what gets pasted into a chat window — and the plane
	 * keeps only enough to recognise it coming back.
	 */
	async issue(options: {
		label: string;
		lasts?: Lasts;
		uses?: number;
	}): Promise<{ invite: Invite; secret: string }> {
		const secret = randomBytes(32).toString("base64url");
		const now = Date.now();
		const invite: Kept = {
			id: randomBytes(8).toString("hex"),
			label: options.label.trim().slice(0, 60),
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + LASTS[options.lasts ?? DEFAULT_LASTS]).toISOString(),
			left: Math.max(1, Math.min(options.uses ?? 1, 99)),
			admitted: [],
			hash: hashOf(secret),
		};
		await this.#serialize(async () => {
			const held = await this.#load();
			held.push(invite);
			await this.#write(held);
		});
		const { hash: _hash, ...rest } = invite;
		return { invite: rest, secret };
	}

	/**
	 * Spends an invitation, if what was offered is one that is still good for somebody.
	 *
	 * Every candidate is compared even after one matches, for the reason the device list does it:
	 * returning early is a measurement of how far down the list a secret got, and the list is short
	 * enough that the timing is the only thing worth protecting here.
	 *
	 * Refuses an expired one and a spent one without saying which. Whoever is holding a link that no
	 * longer works has to ask for another either way, and the difference is only useful to somebody
	 * who is guessing.
	 */
	async spend(secret: string | undefined): Promise<Invite | undefined> {
		if (secret === undefined || secret.length === 0) return undefined;
		const offered = Buffer.from(hashOf(secret), "utf8");
		let found: Kept | undefined;
		for (const invite of await this.#load()) {
			const mine = Buffer.from(invite.hash, "utf8");
			if (mine.length === offered.length && timingSafeEqual(mine, offered)) found = invite;
		}
		if (found === undefined) return undefined;
		if (found.left <= 0 || Date.parse(found.expiresAt) <= Date.now()) return undefined;
		const { hash: _hash, ...rest } = found;
		return rest;
	}

	/** Writes down that this one let a browser in, which is what spends it. */
	async spent(id: string, deviceId: string): Promise<void> {
		await this.#serialize(async () => {
			const held = await this.#load();
			const at = held.findIndex((one) => one.id === id);
			const was = held[at];
			if (was === undefined) return;
			held[at] = { ...was, left: Math.max(0, was.left - 1), admitted: [...was.admitted, deviceId] };
			await this.#write(held);
		});
	}

	/**
	 * Calls one off, so nobody else comes in on it.
	 *
	 * What it already let in stays let in. Those are browsers, they are in the device list under
	 * their own names, and taking one out is what that list is for — an invitation that dragged its
	 * devices out with it would be one act doing two things, and the second one silently.
	 */
	async revoke(id: string): Promise<boolean> {
		let gone = false;
		await this.#serialize(async () => {
			const held = await this.#load();
			const left = held.filter((one) => one.id !== id);
			gone = left.length !== held.length;
			if (gone) await this.#write(left);
		});
		return gone;
	}

	/** Everything that can admit nobody any more, dropped. Called when the list is read. */
	async tidy(): Promise<void> {
		const now = Date.now();
		await this.#serialize(async () => {
			const held = await this.#load();
			// Kept while it can still admit somebody, and for a day after it stopped: a row that says
			// "spent by Nico an hour ago" is the answer to a question somebody is about to ask, and a
			// row that vanished the moment it was used is a screen that forgets what just happened.
			const left = held.filter(
				(one) =>
					(one.left > 0 && Date.parse(one.expiresAt) > now) ||
					Date.parse(one.createdAt) > now - LASTS.week,
			);
			if (left.length !== held.length) await this.#write(left);
		});
	}

	#load(): Promise<Kept[]> {
		this.#held ??= this.#read();
		return this.#held;
	}

	async #read(): Promise<Kept[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(isKept);
		} catch {
			return [];
		}
	}

	async #write(held: Kept[]): Promise<void> {
		this.#held = Promise.resolve(held);
		await mkdir(dirname(this.#path), { recursive: true });
		// Elsewhere and renamed, so a plane killed mid-write leaves the old list rather than half of a
		// new one, which would read as a plane that had forgotten what it handed out.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(held, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic and two browsers can arrive in the same breath.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}

function isKept(value: unknown): value is Kept {
	if (typeof value !== "object" || value === null) return false;
	const { id, hash, label, expiresAt } = value as Record<string, unknown>;
	return (
		typeof id === "string" &&
		typeof hash === "string" &&
		typeof label === "string" &&
		typeof expiresAt === "string"
	);
}
