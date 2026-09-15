/**
 * Everything the agent may ask this browser to do, which is a list and not a protocol.
 *
 * The browser is driven over the debugging protocol, and the debugging protocol is not a thing to
 * hand an agent: `Network.getAllCookies` is in it. Giving an agent CDP is giving it the session it
 * was supposed to be borrowing rather than holding — the one the operator signed in for, on their
 * account, exportable to anywhere the agent's grants reach.
 *
 * So the agent gets verbs. Nine of them, each a sentence about a page rather than a call into a
 * browser, and anything not on this list is not refused by a rule somewhere: there is no code here
 * that could do it.
 */

export const VERBS = [
	"open",
	"read",
	"look",
	"click",
	"type",
	"key",
	"scroll",
	"back",
	"ask",
] as const;

export type Verb = (typeof VERBS)[number];

export interface Asked {
	readonly verb: Verb;
	/** An element from the last read, by the number that read gave it. */
	readonly ref?: number;
	readonly text?: string;
	readonly url?: string;
	readonly key?: string;
	readonly to?: "up" | "down" | "top" | "bottom";
	readonly note?: string;
	/** Whether to press Enter after typing, which is one turn instead of two for every search box. */
	readonly enter?: boolean;
}

export interface Refused {
	readonly refused: string;
}

const SCROLLS = new Set(["up", "down", "top", "bottom"]);

/**
 * Keys a page can be sent, named rather than coded.
 *
 * A list rather than anything typeable, because this is for the keys that do something — submitting,
 * moving between fields, closing a dialog. Text goes in as text: an agent spelling a word out in
 * keystrokes is an agent spending nine calls on a word and getting the ninth wrong.
 */
const KEYS = new Set([
	"Enter",
	"Tab",
	"Escape",
	"Backspace",
	"Delete",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"PageUp",
	"PageDown",
	"Home",
	"End",
]);

/**
 * Whether an address is one this browser will go to.
 *
 * The important half is not the typo-catching: it is that `file://` is a way to read the profile
 * this whole arrangement exists to keep out of the agent's hands, and `chrome://` and
 * `devtools://` are ways to reach the browser's own insides. An agent that could open a URL of any
 * scheme could open the cookie jar as a document and read it back through `read`.
 */
export function readUrl(raw: string): { url: string } | Refused {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return {
			refused: `"${raw}" is not an address. Open a whole one, with the https:// on the front.`,
		};
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return {
			refused: `This screen opens http and https and nothing else, so ${parsed.protocol} is refused. The other schemes are not missing features: file:// reads this container's own disk, and chrome:// and devtools:// are the browser's insides. Neither is yours.`,
		};
	}
	return { url: parsed.href };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads what arrived on the agent's door, and answers with a sentence when it cannot.
 *
 * Every refusal here names what to send instead. The reader is a model that will try again inside
 * the same turn, and "invalid request" costs it a call and tells it nothing about which call to
 * make next.
 */
export function readAsked(body: unknown): Asked | Refused {
	if (!isRecord(body)) return { refused: "Send a JSON object with a verb in it." };

	const verb = body.verb;
	if (typeof verb !== "string" || !(VERBS as readonly string[]).includes(verb)) {
		return { refused: `"${String(verb)}" is not one of: ${VERBS.join(", ")}.` };
	}

	switch (verb as Verb) {
		case "open": {
			if (typeof body.url !== "string") return { refused: "open takes a url." };
			const read = readUrl(body.url);
			if ("refused" in read) return read;
			return { verb: "open", url: read.url };
		}
		case "click": {
			const ref = body.ref;
			if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
				return {
					refused:
						"click takes a ref, which is one of the numbers from the last read. Read the page first: the numbers are only good for the page they came off.",
				};
			}
			return { verb: "click", ref };
		}
		case "type": {
			if (typeof body.text !== "string" || body.text === "") {
				return { refused: "type takes the text to put in, and something to put it in." };
			}
			const ref = body.ref;
			if (ref !== undefined && (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1)) {
				return {
					refused: "type takes a ref from the last read, or none to type where the cursor is.",
				};
			}
			return {
				verb: "type",
				text: body.text,
				...(typeof ref === "number" ? { ref } : {}),
				...(body.enter === true ? { enter: true } : {}),
			};
		}
		case "key": {
			if (typeof body.key !== "string" || !KEYS.has(body.key)) {
				return { refused: `key takes one of: ${[...KEYS].join(", ")}.` };
			}
			return { verb: "key", key: body.key };
		}
		case "scroll": {
			const to = body.to;
			if (typeof to !== "string" || !SCROLLS.has(to)) {
				return { refused: "scroll takes to: up, down, top or bottom." };
			}
			return { verb: "scroll", to: to as "up" | "down" | "top" | "bottom" };
		}
		case "ask": {
			if (typeof body.note !== "string" || body.note.trim() === "") {
				return {
					refused:
						"ask takes a note: the sentence the operator reads on the screen, saying what you need them to do there.",
				};
			}
			return { verb: "ask", note: body.note };
		}
		default:
			return { verb: verb as Verb };
	}
}

/**
 * Whether a verb changes the page, which is what decides if the keyboard matters.
 *
 * Reading does not need the keyboard and is never refused for it. An agent told to stop touching
 * the page can still watch it, which is exactly what it should be doing while somebody signs in:
 * the turn after the operator lets go begins by looking at where they left it.
 */
export function needsTheKeyboard(verb: Verb): boolean {
	return verb !== "read" && verb !== "look" && verb !== "ask";
}
