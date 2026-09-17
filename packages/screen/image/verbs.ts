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
	/*
	 * The same read as data rather than as prose, for whoever is choosing on the agent's behalf.
	 *
	 * Not a tool the agent has: it is what the extension asks for when the agent has named the thing
	 * it wants instead of numbering it, so that something small and fast can be handed the rows as
	 * options and hand a number back. Prose is for a model that is reading; this is for one that is
	 * choosing.
	 */
	"outline",
	"look",
	"click",
	"type",
	"key",
	"scroll",
	"back",
	"ask",
	// Tabs, because the work an agent does on the web is not one page at a time. Halfway through a
	// booking it needs to go and read what a fare includes, and doing that on the page it was
	// working on costs the page: a search with a flight selected on it does not come back by going
	// back. These four are what let it look something up and return to exactly where it was.
	"tabs",
	"tab",
	"tab_open",
	"tab_close",
	/*
	 * Being signed in somewhere, which is the one verb whose answer the agent may not see.
	 *
	 * It names a host and nothing else: not a vault, not an entry, not a field. What it gets back is
	 * a sentence about the boxes on the page. The credential is read inside this container by a CLI
	 * holding a token the sandbox has no path to, and it goes into the page as keystrokes — so there
	 * is no request an agent can make here that answers with a password, because nothing answers with
	 * one.
	 */
	"login",
	/*
	 * Several boxes filled in and one thing pressed, in one go.
	 *
	 * Not a convenience: it is the difference between a form costing one call to the agent's model
	 * and costing two per box. The refs come from one batch of questions asked of something small
	 * and fast, so the whole of a checkout page — six boxes and the Continue under them — is one
	 * decision by the thing that thinks and one visit here.
	 */
	"put",
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
	/**
	 * Whether to answer with the page and not its numbered rows.
	 *
	 * Asked for by the half of this that acts on a named thing rather than on a ref: an agent that
	 * never uses a number is an agent carrying two hundred rows of them through the rest of its turn
	 * for nothing. The numbers stay one `read` away.
	 */
	readonly brief?: boolean;
	/** Which tab, by the number the last listing gave it. */
	readonly tab?: number;
	/** The boxes to fill and what goes in each, for the one verb that does more than one thing. */
	readonly puts?: readonly { readonly ref: number; readonly text: string }[];
	/** Something to press once they are filled, by ref. */
	readonly press?: number;
}

export interface Refused {
	readonly refused: string;
}

const SCROLLS = new Set(["up", "down", "top", "bottom"]);

/**
 * The most tabs this browser will open on the agent's say-so.
 *
 * A number rather than a rule in a description, because a description is advice and this is
 * memory: every open tab is a renderer process holding a whole page, and a measured one runs to
 * about half a gigabyte. Three agents with a screen apiece on a small machine is already the whole
 * of it, and an agent that opens a tab per thing it wonders about would take the machine down
 * rather than work slowly.
 *
 * Three, which is the shape of the work: the page being worked on, something a site opened by
 * itself — a checkout, a sign-in — and one to go and look something up in. A fourth is not a
 * different kind of work, it is the last one not having been closed.
 */
export const MOST_TABS = 3;

/** What the agent is told when it asks for one too many, which names what to do about it. */
export function tooManyTabs(open: readonly { number: number; url: string }[]): string {
	return [
		`This browser already has ${open.length} tabs open, which is as many as it holds.`,
		"",
		...open.map((one) => `  [${one.number}] ${one.url}`),
		"",
		"Close one you are finished with — screen_tab_close takes the number — and open this then.",
		"Every tab open is a whole page held in memory, which is why there is a limit at all: a tab",
		"you looked something up in an hour ago is costing as much as the one you are working on.",
	].join("\n");
}

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
			return { verb: "open", url: read.url, ...(body.brief === true ? { brief: true } : {}) };
		}
		case "outline":
			return { verb: "outline" };
		case "put": {
			const puts = Array.isArray(body.puts) ? body.puts : [];
			const wanted: { ref: number; text: string }[] = [];
			for (const one of puts) {
				if (!isRecord(one)) continue;
				const ref = one.ref;
				const text = one.text;
				if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
					return { refused: "put takes boxes as {ref, text}, with a ref from the last read." };
				}
				if (typeof text !== "string") return { refused: "put takes text for every box." };
				wanted.push({ ref, text });
			}
			const press = body.press;
			if (
				press !== undefined &&
				(typeof press !== "number" || !Number.isInteger(press) || press < 1)
			) {
				return { refused: "put takes press as a ref, or nothing to fill the boxes and stop." };
			}
			if (wanted.length === 0 && press === undefined) {
				return { refused: "put takes something to do: boxes to fill, or something to press." };
			}
			return {
				verb: "put",
				puts: wanted,
				...(typeof press === "number" ? { press } : {}),
				...(body.brief === true ? { brief: true } : {}),
				...(body.enter === true ? { enter: true } : {}),
			};
		}
		// A host, or none for the page it is already on — which is the usual case, because what makes
		// an agent ask is a sign-in form in front of it.
		case "login": {
			const url = body.url;
			if (url !== undefined && typeof url !== "string") {
				return {
					refused: "login takes the site to sign into, or nothing for the page you are on.",
				};
			}
			return { verb: "login", ...(typeof url === "string" && url !== "" ? { url } : {}) };
		}
		case "click": {
			const ref = body.ref;
			if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
				return {
					refused:
						"click takes a ref, which is one of the numbers from the last read. Read the page first: the numbers are only good for the page they came off.",
				};
			}
			return { verb: "click", ref, ...(body.brief === true ? { brief: true } : {}) };
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
				...(body.brief === true ? { brief: true } : {}),
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
		case "tab_open": {
			if (typeof body.url !== "string") return { refused: "tab_open takes a url." };
			const read = readUrl(body.url);
			if ("refused" in read) return read;
			return { verb: "tab_open", url: read.url };
		}
		case "tab":
		case "tab_close": {
			const tab = body.tab;
			if (typeof tab !== "number" || !Number.isInteger(tab) || tab < 1) {
				return {
					refused: `${verb} takes a tab number, which is one of the numbers from tabs. Ask for tabs first.`,
				};
			}
			return { verb: verb as Verb, tab };
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
	// Listing the tabs is reading, like reading a page: it changes nothing and says where things
	// are. Going to one, opening one and closing one are all the browser moving under somebody's
	// hands, so they wait their turn like every other thing that touches it.
	return (
		verb !== "read" && verb !== "outline" && verb !== "look" && verb !== "ask" && verb !== "tabs"
	);
}
