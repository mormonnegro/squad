import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { answerOf, type Block, unreachable } from "./screen-answer.ts";

/**
 * A browser the agent can use and cannot read.
 *
 * The browser is not in here. It runs in a container of its own, beside this one, holding a profile
 * this sandbox has no path to — which is the entire point: an operator who signs into their mail on
 * that screen has lent the agent the use of a session rather than handed it the cookie. What
 * crosses between the two containers is this list of verbs, over one port, and nothing that comes
 * back is a credential.
 *
 * The extension is only loaded when the agent has been given a screen. An agent without one has no
 * screen tools at all rather than nine that fail, because a tool that is present and always refuses
 * is a tool a model spends a turn discovering.
 */

const AGENT_ID = process.env.SQUAD_AGENT_ID ?? "agent";

/**
 * Where the screen answers, worked out rather than passed in.
 *
 * The plane gives the screen container a name on the sandbox network built out of the agent's own
 * name, so this needs nothing the sandbox did not already know about itself. One less variable to
 * be missing from a container that was created before the variable existed.
 */
const SCREEN_URL = process.env.SQUAD_SCREEN_URL ?? `http://${AGENT_ID}-screen:7181`;

/** Long, because a verb here is a page loading, and short of the turn's own patience. */
const VERB_TIMEOUT_MS = 90_000;

/**
 * What this sandbox says at its screen's door to prove the screen is its own.
 *
 * The screen's door has to be on the network the sandboxes share, and every agent on the plane is
 * on it. The egress token is the thing this container holds that no other one does — it is in the
 * proxy URL because every request out of here carries it — so it is what the screen is told to
 * expect. Nothing new is distributed to make this work, which is why it works in a sandbox that was
 * created before screens existed.
 */
function token(): string | undefined {
	const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
	if (proxy === undefined || proxy === "") return undefined;
	try {
		const password = decodeURIComponent(new URL(proxy).password);
		return password === "" ? undefined : password;
	} catch {
		return undefined;
	}
}

/** Read once: the proxy URL does not change under a running container, and neither does this. */
const held = token();

async function does(asked: Record<string, unknown>): Promise<readonly Block[]> {
	let response: Response;
	try {
		response = await fetch(SCREEN_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(held === undefined ? {} : { authorization: `Bearer ${held}` }),
			},
			body: JSON.stringify(asked),
			signal: AbortSignal.timeout(VERB_TIMEOUT_MS),
		});
	} catch (error) {
		return [{ type: "text", text: unreachable(AGENT_ID, (error as Error).message) }];
	}
	try {
		return answerOf(await response.json());
	} catch {
		return [{ type: "text", text: unreachable(AGENT_ID, `it answered ${response.status}`) }];
	}
}

const REFS = [
	"Everything you act on is a ref: a number from the last read, like [7]. Refs belong to the read",
	"they came from — after anything that changes the page, read it again and use the new numbers.",
].join(" ");

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "screen_open",
		label: "Open a page",
		description: [
			"Point your browser at an address, and get back what is on the page.",
			"",
			"This browser is yours and it is signed in to whatever your operator has signed it into. It",
			"keeps its cookies between turns, so a site you were logged into last week is a site you are",
			"logged into now — check by opening it, rather than by asking.",
			"",
			"http and https only. It is not a way to read files.",
		].join("\n"),
		promptSnippet: "Open a page in your own browser, and read what is on it",
		parameters: Type.Object({
			url: Type.String({ description: "The whole address, with https:// on the front." }),
		}),
		async execute(_id, params) {
			const { url } = params as { url: string };
			return { content: [...(await does({ verb: "open", url }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_read",
		label: "Read the page",
		description: [
			"Read the page your browser is on: where it is, what you can click or type into, and what it",
			"says.",
			"",
			`${REFS}`,
			"",
			"This is the cheap one and the one to use by default. Reading a page costs a fraction of",
			"looking at it and is exact, because you act on numbered elements rather than on coordinates",
			"you guessed from a picture.",
		].join("\n"),
		promptSnippet: "Read the page your browser is on, as text and numbered elements",
		promptGuidelines: [
			"Read the page rather than looking at it, unless the thing you need is genuinely visual.",
			"Read again after every click, and use the refs from the newest read.",
		],
		parameters: Type.Object({}),
		async execute() {
			return { content: [...(await does({ verb: "read" }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_look",
		label: "Look at the page",
		description: [
			"Take a picture of the page and look at it.",
			"",
			"For what reading cannot tell you: a chart, a map, a photograph, a layout somebody asked you",
			"about, a page that reads as nonsense and might be showing something else. It is not for",
			"finding a button — reading tells you where the buttons are, exactly, and this only tells you",
			"roughly.",
			"",
			"A picture costs about as much as a page of text to look at, every time you look. Do not",
			"take one after every click.",
		].join("\n"),
		promptSnippet: "Take a picture of the page, for what text cannot show",
		promptGuidelines: [
			"Look at the page only when the question is visual. Reading is cheaper and more precise for anything else.",
		],
		parameters: Type.Object({}),
		async execute() {
			return { content: [...(await does({ verb: "look" }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_click",
		label: "Click",
		description: ["Click one of the numbered things on the page.", "", REFS].join("\n"),
		promptSnippet: "Click a numbered element on the page",
		parameters: Type.Object({
			ref: Type.Integer({ description: "The number from the last read, without the brackets." }),
		}),
		async execute(_id, params) {
			const { ref } = params as { ref: number };
			return { content: [...(await does({ verb: "click", ref }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_type",
		label: "Type",
		description: [
			"Type into a field on the page.",
			"",
			"Name the field by its ref, or leave it out to type wherever the cursor already is. Set enter",
			"to submit straight after, which is one call instead of two for a search box.",
			"",
			"Never type a password, a card number or a one-time code. You do not have them, and a page",
			"asking for one is a page to hand over: use screen_ask, and your operator will come and type",
			"it themselves.",
		].join("\n"),
		promptSnippet: "Type into a field on the page",
		promptGuidelines: [
			"Never type credentials into a page. Ask the operator to take the keyboard instead, with screen_ask.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "What to put in." }),
			ref: Type.Optional(
				Type.Integer({ description: "The field, by its number from the last read." }),
			),
			enter: Type.Optional(Type.Boolean({ description: "Press Enter afterwards." })),
		}),
		async execute(_id, params) {
			const { text, ref, enter } = params as { text: string; ref?: number; enter?: boolean };
			return {
				content: [
					...(await does({
						verb: "type",
						text,
						...(ref === undefined ? {} : { ref }),
						...(enter === true ? { enter: true } : {}),
					})),
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "screen_key",
		label: "Press a key",
		description: [
			"Press one of the keys that does something: Enter, Tab, Escape, Backspace, Delete, the four",
			"arrows, PageUp, PageDown, Home, End.",
			"",
			"Text goes in with screen_type. Spelling a word out in keystrokes is nine calls and a typo.",
		].join("\n"),
		promptSnippet: "Press Enter, Tab, Escape or another named key",
		parameters: Type.Object({
			key: Type.String({ description: "The key's name, exactly: Enter, Tab, Escape, ArrowDown…" }),
		}),
		async execute(_id, params) {
			const { key } = params as { key: string };
			return { content: [...(await does({ verb: "key", key }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_scroll",
		label: "Scroll",
		description: [
			"Move down or up the page, or jump to the top or the bottom of it.",
			"",
			"A read only numbers what is rendered, so scrolling is how the rest of a long page arrives.",
		].join("\n"),
		promptSnippet: "Scroll the page to bring more of it into view",
		parameters: Type.Object({
			to: Type.String({ description: "up, down, top or bottom." }),
		}),
		async execute(_id, params) {
			const { to } = params as { to: string };
			return { content: [...(await does({ verb: "scroll", to }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_back",
		label: "Go back",
		description: "Go back to the page before this one, the way the browser's own back button does.",
		promptSnippet: "Go back to the previous page",
		parameters: Type.Object({}),
		async execute() {
			return { content: [...(await does({ verb: "back" }))], details: {} };
		},
	});

	/**
	 * The tool that makes the rest of them safe to have.
	 *
	 * An agent facing a login has three options, and two of them are bad: invent a credential, or
	 * give up silently. This is the third — the operator is already able to take this screen and
	 * drive it, and all that was missing was the agent being able to say so on the screen they would
	 * be looking at.
	 */
	pi.registerTool({
		name: "screen_ask",
		label: "Ask the operator to take the screen",
		description: [
			"Put a sentence on the screen asking your operator to come and do something on it themselves:",
			"sign in, approve something, answer a code, get past whatever will not let you past.",
			"",
			"Your note appears on their live view of this browser, where there is a button that takes the",
			"keyboard off you. While they hold it, everything that touches the page is refused and",
			"reading still works, so you can watch but not interfere.",
			"",
			"Nothing waits for them. They may be asleep. Say what you need in your answer too, and if the",
			"work cannot go on without it, end the turn and book one later with wake_me — then read the",
			"page when you wake and carry on from wherever they left it.",
		].join("\n"),
		promptSnippet: "Ask the operator to take this screen and do something on it",
		promptGuidelines: [
			"When a page wants a password, a card or a one-time code, use screen_ask. Never type one yourself and never invent one.",
		],
		parameters: Type.Object({
			note: Type.String({ description: "What you need them to do, in one sentence." }),
		}),
		async execute(_id, params) {
			const { note } = params as { note: string };
			return { content: [...(await does({ verb: "ask", note }))], details: {} };
		},
	});
}
