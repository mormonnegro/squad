import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The browsers this plane has let in, one line each.
 *
 * Before this there was a secret, and a secret is a poor answer to every question anybody actually
 * has about access. Who is in here — it cannot say. Take this one person out — it cannot, short of
 * changing the secret, which takes everybody out. When did that laptop last use this — it does not
 * know. A list answers all three, and the cost of keeping one is this file.
 *
 * What is stored is a hash, never the secret. The secret exists in exactly one place, which is the
 * cookie in the browser that earned it, and this file is a list of things that have been let in
 * rather than a list of ways in. Somebody who reads it holds nothing.
 */
export interface Device {
	readonly id: string;
	/** What to call it on a screen. Guessed from the browser, and the operator's to change. */
	readonly name: string;
	readonly createdAt: string;
	readonly lastSeenAt: string;
	/**
	 * The invitation this came in on, for the ones that came in on one.
	 *
	 * A list of browsers cannot say who let one in, and that is the question somebody has when they
	 * find a row they do not recognise. Absent on every device admitted by the plane's own token,
	 * which is to say: by whoever was at the machine.
	 */
	readonly from?: string;
}

interface Kept extends Device {
	/** sha256 of the secret this device carries. The secret itself is never written down. */
	readonly hash: string;
}

/** A minute, because last-seen is for a human reading a list and not for an audit log. */
const SEEN_EVERY_MS = 60_000;

export class Devices {
	readonly #path: string;
	#held: Promise<Kept[]> | undefined;
	#tail: Promise<unknown> = Promise.resolve();
	/** When each was last written down, so a busy console does not rewrite this file per request. */
	readonly #touched = new Map<string, number>();

	constructor(path: string) {
		this.#path = path;
	}

	/** The list, as a screen shows it: no hashes, newest first. */
	async all(): Promise<readonly Device[]> {
		const held = await this.#load();
		return held
			.map(({ hash: _hash, ...rest }) => rest)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/**
	 * A new way in, handed out once.
	 *
	 * The secret comes back from here and is never available again — this is the only moment it
	 * exists outside the browser that is about to hold it.
	 */
	async issue(name: string, from?: string): Promise<{ device: Device; secret: string }> {
		const secret = randomBytes(32).toString("base64url");
		const device: Kept = {
			id: randomBytes(8).toString("hex"),
			name,
			createdAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
			...(from === undefined ? {} : { from }),
			hash: hashOf(secret),
		};
		await this.#serialize(async () => {
			const held = await this.#load();
			held.push(device);
			await this.#write(held);
		});
		const { hash: _hash, ...rest } = device;
		return { device: rest, secret };
	}

	/**
	 * Whose this is, if anybody's.
	 *
	 * Every candidate is compared even after one matches, because returning early is a measurement
	 * of how far down the list a secret got. The list is short and the comparison is cheap; the
	 * timing is the thing being protected.
	 */
	async whose(secret: string | undefined): Promise<Device | undefined> {
		if (secret === undefined || secret.length === 0) return undefined;
		const offered = Buffer.from(hashOf(secret), "utf8");
		let found: Kept | undefined;
		for (const device of await this.#load()) {
			const mine = Buffer.from(device.hash, "utf8");
			if (mine.length === offered.length && timingSafeEqual(mine, offered)) found = device;
		}
		if (found === undefined) return undefined;
		// Awaited rather than fired off, and never allowed to refuse anybody. Left to run on its own it
		// was a promise nobody held: a state directory that is briefly unwritable turned a note about
		// when a laptop was last seen into an unhandled rejection in the plane. It writes at most once
		// a minute per device, so what awaiting it costs is one small write on the request that
		// crosses the minute.
		await this.#seen(found.id).catch(() => {});
		const { hash: _hash, ...rest } = found;
		return rest;
	}

	/** Out. The device's own browser stops being an operator on its next request and nobody else is
	 * touched, which is the whole difference between a list and a secret. */
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

	async rename(id: string, name: string): Promise<boolean> {
		let renamed = false;
		await this.#serialize(async () => {
			const held = await this.#load();
			const at = held.findIndex((one) => one.id === id);
			if (at === -1) return;
			held[at] = { ...(held[at] as Kept), name };
			renamed = true;
			await this.#write(held);
		});
		return renamed;
	}

	/** Written at most once a minute per device: this is for a list a person reads, not a ledger. */
	async #seen(id: string): Promise<void> {
		const last = this.#touched.get(id) ?? 0;
		if (Date.now() - last < SEEN_EVERY_MS) return;
		this.#touched.set(id, Date.now());
		await this.#serialize(async () => {
			const held = await this.#load();
			const at = held.findIndex((one) => one.id === id);
			if (at === -1) return;
			held[at] = { ...(held[at] as Kept), lastSeenAt: new Date().toISOString() };
			await this.#write(held);
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
		// new one — which would read as a plane that had forgotten who was allowed in.
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

/** How a secret is written down here: the hash, never the secret. Shared with the invitations. */
export function hashOf(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

function isKept(value: unknown): value is Kept {
	if (typeof value !== "object" || value === null) return false;
	const { id, name, hash, createdAt, lastSeenAt } = value as Record<string, unknown>;
	return (
		typeof id === "string" &&
		typeof name === "string" &&
		typeof hash === "string" &&
		typeof createdAt === "string" &&
		typeof lastSeenAt === "string"
	);
}

/**
 * What to call a browser nobody has named yet.
 *
 * A user agent is a paragraph of archaeology and two useful words are in it. Guessed rather than
 * asked for, because a dialog between somebody and the thing they just installed should not be a
 * form — and it is a label on a row they can change, not an identity.
 */
export function nameFromAgent(agent: string | undefined): string {
	if (agent === undefined || agent.length === 0) return "a browser";
	const browser = /Firefox\/|Edg\/|OPR\/|Chrome\/|Safari\//.exec(agent)?.[0] ?? "";
	const named =
		{ "Firefox/": "Firefox", "Edg/": "Edge", "OPR/": "Opera", "Chrome/": "Chrome" }[browser] ??
		(browser === "Safari/" ? "Safari" : "a browser");
	const os = /Macintosh|Windows|Android|iPhone|iPad|Linux|CrOS/.exec(agent)?.[0];
	const where = { Macintosh: "a Mac", CrOS: "ChromeOS", iPhone: "an iPhone", iPad: "an iPad" }[
		os ?? ""
	];
	return where !== undefined
		? `${named} on ${where}`
		: os !== undefined
			? `${named} on ${os}`
			: named;
}
