/**
 * The planes this browser knows how to reach, and the secret that opens each.
 *
 * Kept here and nowhere else. This page may be served by a plane or by somebody's static host, and
 * in the second case the list is the answer to "whose agents are these" — which is the operator's
 * answer, not a hosted service's. A page that held it would be a page that knows every machine every
 * customer runs and holds the key to each, which is a thing to be breached rather than a feature.
 *
 * Each connection is separate all the way down: its own address, its own token, its own agents. What
 * one knows tells you nothing about another, and forgetting one leaves the rest untouched.
 */

export interface Connection {
	/** This browser's name for it. Only ever printed. */
	readonly name: string;
	/**
	 * Where it answers. Empty for the plane serving this page, which needs no address and no token:
	 * it gave this browser a cookie when the token was spent on the way in.
	 */
	readonly origin: string;
	/** What opens it, when it is not the plane that served this page. */
	readonly token?: string;
}

const KEY = "squad.planes";

/**
 * The plane serving this page, if one is.
 *
 * Always offered and never stored: a browser whose storage was cleared should still find the plane
 * it is being served by, and a plane that is not there simply fails to answer and says so.
 */
export const HERE: Connection = { name: "This computer", origin: "" };

export function keyOf(one: Connection): string {
	return one.origin === "" ? "here" : one.origin;
}

export function readConnections(): readonly Connection[] {
	try {
		const held: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		const kept = Array.isArray(held) ? held.filter(isConnection) : [];
		return [HERE, ...kept.filter((one) => one.origin !== "")];
	} catch {
		return [HERE];
	}
}

function write(all: readonly Connection[]): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(all.filter((one) => one.origin !== "")));
	} catch {
		// A browser refusing storage will ask again next time, which is worse than remembering and
		// better than not opening.
	}
}

export function remember(made: Connection): readonly Connection[] {
	const kept = readConnections().filter((one) => keyOf(one) !== keyOf(made));
	const all = [...kept, made];
	write(all);
	return all;
}

export function forget(gone: Connection): readonly Connection[] {
	const all = readConnections().filter((one) => keyOf(one) !== keyOf(gone));
	write(all);
	return all;
}

/** What a code starts with, so a person can tell one from a password at a glance. */
const MARK = "squad_";

/**
 * One environment, as a single thing to hand somebody.
 *
 * The address and the key in one string rather than two fields, because they are useless apart and
 * a person copying two things copies one of them. It is not encryption and does not pretend to be —
 * it is the same two facts, in a shape that survives a chat window without being turned into a link.
 */
export function makeCode(one: Connection): string {
	const body = btoa(JSON.stringify({ o: one.origin, t: one.token ?? "" }))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
	return MARK + body;
}

/**
 * A code or an address, read back apart.
 *
 * Both, because both exist in the world: the installer prints an address and a person hands over a
 * code, and refusing whichever one somebody has in their clipboard is refusing them for being
 * right in the other way.
 */
export function readAddress(typed: string): { origin: string; token: string } | string {
	const text = typed.trim();
	if (text.length === 0) return "Paste the code, or the address the installer printed.";

	if (text.startsWith(MARK)) {
		try {
			const body = text.slice(MARK.length).replaceAll("-", "+").replaceAll("_", "/");
			const read: unknown = JSON.parse(atob(body));
			const { o, t } = read as Record<string, unknown>;
			if (typeof o !== "string" || typeof t !== "string" || o.length === 0 || t.length === 0) {
				return "That code is missing something. Ask for it again.";
			}
			return { origin: new URL(o).origin, token: t };
		} catch {
			return "That code did not read. It may have been cut short on the way here.";
		}
	}

	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return "That is neither a code nor an address. A code starts with `squad_`.";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "It has to be http or https.";
	const token = url.searchParams.get("t");
	if (token === null || token.length === 0) {
		return "That address carries no key. The installer prints one with `?t=` on the end.";
	}
	return { origin: url.origin, token };
}

/** What to call a plane before anybody names it: the machine, which is what a person calls it. */
export function nameFor(origin: string): string {
	try {
		const { hostname, port } = new URL(origin);
		const here = hostname === "127.0.0.1" || hostname === "localhost";
		return here ? `Port ${port}` : hostname;
	} catch {
		return origin;
	}
}

function isConnection(value: unknown): value is Connection {
	if (typeof value !== "object" || value === null) return false;
	const { name, origin } = value as Record<string, unknown>;
	return typeof name === "string" && typeof origin === "string";
}
