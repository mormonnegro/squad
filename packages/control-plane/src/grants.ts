import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ANY_HOST, type Grant, type Injection } from "@squad/proxy";

/** Where a grant came from, which is what decides whether this console may take it back. */
export type GrantOrigin = "file" | "here" | "model" | "search";

/** A grant as the config screen has it: what it opens, and which list it is on. */
export interface GrantStanding {
	readonly id: string;
	readonly host: string;
	/** The path under it, when the grant is narrower than the whole host. */
	readonly pathPrefix?: string;
	readonly methods?: readonly string[];
	readonly origin: GrantOrigin;
	/** The variables the proxy writes onto the request, when anything of the operator's rides along. */
	readonly carries?: string;
}

/**
 * Which of the operator's secrets goes out on a request this grant allows, named rather than counted.
 *
 * The names, because that is what the rest of this console shows: a key is `ANTHROPIC_API_KEY` on the
 * models screen and on the search screen, and a row that said only "carries a credential" would be a
 * row you have to go and look something up about.
 */
export function carriedBy(injection: Injection): string | undefined {
	if (injection.kind === "none") return undefined;
	if (injection.kind === "bearer") return injection.token.ref;
	if (injection.kind === "basic") {
		// A username written into the grant is not the operator's, so it is not what the row is about.
		const username = "literal" in injection.username ? undefined : injection.username.ref;
		return username === undefined
			? injection.password.ref
			: `${username} ${injection.password.ref}`;
	}
	return injection.value.ref;
}

/** Namespaced the way the derived ones are, so nothing added here can land on a generated id. */
export function reachId(host: string): string {
	return `reach:${host}`;
}

/**
 * Which of the lists a grant already in the file came off.
 *
 * The models the file declares have their grant written for them before the plane ever sees it, so by
 * the time this is asked the two are one list. The id is what tells them apart, and it is worth
 * telling them apart: one of these rows is changed by editing the file and the other by opening the
 * section above.
 */
export function originOf(id: string): GrantOrigin {
	if (id.startsWith("model:")) return "model";
	if (id.startsWith("search:")) return "search";
	return "file";
}

/**
 * The one grant a console may write: somewhere to go, and nothing to go with.
 *
 * The whole of why this screen is allowed to exist. A grant is a host and a credential to reach it
 * with, and only the second half was ever the dangerous one — so the console gets the first half and
 * the file keeps the second. There is no field here to put a key in, which is a stronger guarantee
 * than a check would be: this shape cannot express one.
 */
export function reachGrant(host: string): Grant {
	return { id: reachId(host), host, injection: { kind: "none" } };
}

/**
 * Takes a host out of whatever was pasted, because what a person has to hand is a URL.
 *
 * The failure this is here for is the whole reason the screen exists: somebody watched an agent get
 * refused at `https://api.chess.com/pub/player/x`, came here, and typed back the thing they were
 * looking at. Reading that as a host is a line of code; refusing it is a second thing to get right
 * before the first one works.
 */
export function readHost(said: string): { readonly host: string } | { readonly refused: string } {
	const trimmed = said.trim().toLowerCase();
	if (trimmed.length === 0)
		return { refused: "a host to allow, like api.chess.com — or * for the web" };
	if (/\s/.test(trimmed))
		return { refused: `"${said.trim()}" is more than one word — a host is one` };
	const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	// Everything from the first separator on is the part of a URL that is not the host. A path typed
	// here is not an error to report, it is a fact about what was pasted.
	const [authority = ""] = withoutScheme.split(/[/?#]/, 1);
	const [, credentialless = authority] = authority.split("@");
	const host = credentialless.replace(/:\d+$/, "").replace(/\.$/, "");
	if (host === ANY_HOST) return { host };
	// A star stands for one label and only the front one, which is all the proxy matches. Anywhere
	// else it is a grant that looks like it covers something and covers nothing.
	if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
		return { refused: `"${said.trim()}" is not a host — try api.chess.com, *.chess.com, or *` };
	}
	return { host };
}

/**
 * The hosts this plane was opened to at the keyboard, on top of the ones its file grants.
 *
 * Beside the operator's file rather than in it, for the reason everything decided at a console is:
 * the file is theirs, and a change that vanished on the next deploy would be worse than one that was
 * never offered. Hosts rather than grants, because a host is all there is to keep — the grant built
 * from one carries nothing, and a store that could hold a credential is a store somebody would.
 */
export class AddedGrants {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async hosts(): Promise<readonly string[]> {
		return await this.#serialize(() => this.#read());
	}

	async all(): Promise<readonly Grant[]> {
		return (await this.hosts()).map(reachGrant);
	}

	async add(host: string): Promise<void> {
		await this.#serialize(async () => {
			const all = (await this.#read()).filter((other) => other !== host);
			all.push(host);
			await this.#write(all);
		});
	}

	/** True when there was one to drop, so the console can tell a typo from a host that is gone. */
	async drop(host: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const all = await this.#read();
			const left = all.filter((other) => other !== host);
			if (left.length === all.length) return false;
			await this.#write(left);
			return true;
		});
	}

	async #read(): Promise<string[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((entry): entry is string => typeof entry === "string");
		} catch {
			return [];
		}
	}

	async #write(all: readonly string[]): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(all, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
