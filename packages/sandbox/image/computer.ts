import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	askedOf,
	type Looking,
	readLooking,
	refusedBy,
	saidBy,
	spentOn,
	type Usage,
} from "./looking.ts";
import { alreadyAsked, askFor, holding, keep } from "./question.ts";
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

/**
 * The request to the screen, sent with `node:http` rather than `fetch`, which is the whole point.
 *
 * `fetch` in here goes through the egress proxy — the runtime this extension is loaded into points
 * it there, so that what the agent reaches is what the operator granted. That is right for the
 * internet and exactly wrong for this: the screen is a container on the sandbox network, it is not
 * a host anybody granted, and the proxy turns the request down. What came back was a tidy JSON
 * refusal that an earlier version of this read as an empty success, so the agent was told its
 * browser had opened a page and found nothing on it.
 *
 * `node:http` reads no proxy variable and has no global dispatcher to be pointed anywhere. It goes
 * to the address it is given, which is a name on a network this container is already on.
 */
function does(asked: Record<string, unknown>): Promise<readonly Block[]> {
	const payload = Buffer.from(JSON.stringify(asked), "utf8");
	return new Promise((resolve) => {
		const request = http.request(
			SCREEN_URL,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(payload.byteLength),
					...(held === undefined ? {} : { authorization: `Bearer ${held}` }),
				},
				timeout: VERB_TIMEOUT_MS,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve(answerOf(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"))),
				);
			},
		);
		request.on("timeout", () => request.destroy(new Error("it took too long to answer")));
		request.on("error", (error) => {
			resolve([{ type: "text", text: unreachable(AGENT_ID, error.message) }]);
		});
		request.end(payload);
	});
}

/**
 * The same card `ask_operator` puts up, filed from here.
 *
 * Two doors onto one thing, and both of them earn their keep: a question about a decision is asked
 * from anywhere, and a question about this browser is asked where the browser is. What they must not
 * be is two different notions of a pending question — an operator with a note on the screen and
 * nothing in the conversation has to be watching the right pane at the right minute, which is the
 * failure this whole card exists to end.
 */
const ASK_FILE = process.env.SQUAD_ASK_FILE ?? "/home/agent/.run/ask.json";

function alsoAsk(question: string, options: readonly string[], hands: boolean): string {
	const asked = askFor(question, options, hands, alreadyAsked(holding(ASK_FILE)));
	keep(ASK_FILE, asked.asked);
	return asked.text;
}

/**
 * The model that looks, when the operator has chosen one — and nothing at all when they have not.
 *
 * Read per call rather than once when pi started, because a turn is a process and this file is
 * written before every turn by the plane that owns the choice.
 */
async function looking(): Promise<Looking | undefined> {
	const path = process.env.SQUAD_VISION_FILE ?? "";
	if (path.length === 0) return undefined;
	try {
		return readLooking(await readFile(path, "utf8"));
	} catch {
		// No file is the answer for most planes: looking is off until somebody turns it on.
		return undefined;
	}
}

/**
 * curl rather than fetch, and the opposite reason from the screen's own door.
 *
 * This request is meant to leave the sandbox, so it has to go the way everything that leaves goes:
 * through the egress proxy, which resolves the name, writes the key on, and refuses a host nobody
 * granted. Node's fetch reads neither HTTPS_PROXY nor NODE_EXTRA_CA_CERTS and dies resolving the
 * name; curl reads both and is in the image already. The body goes over stdin, because a screenshot
 * is a megabyte of base64 and an argument is not.
 */
function post(
	endpoint: string,
	body: string,
): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const curl = execFile(
			"curl",
			[
				"-sS",
				endpoint,
				"-H",
				"Content-Type: application/json",
				"--data-binary",
				"@-",
				"-w",
				"\n%{http_code}",
			],
			{ timeout: VERB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
			(failure, stdout, stderr) => {
				if (failure !== null) {
					reject(new Error(stderr.trim().length > 0 ? stderr.trim() : failure.message));
					return;
				}
				const cut = stdout.lastIndexOf("\n");
				resolve({ status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) });
			},
		);
		curl.stdin?.end(body);
	});
}

/** The picture out of what the screen answered, which is the one block that is not words. */
function pictureIn(blocks: readonly Block[]): string | undefined {
	for (const block of blocks) if (block.type === "image") return block.data;
	return undefined;
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
			"This replaces the page you are on. If you are partway through something — a form filled in,",
			"a result selected, a checkout started — use screen_tab_open instead and keep it. Going back",
			"does not restore any of that: it was made by clicking, and the clicks are gone.",
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

	/*
	 * Looking, which is the one tool here that may not be done by the agent's own model.
	 *
	 * Most agents think with something that cannot see at all, and handing such an agent an image is
	 * a silent no-op: it goes out, nothing reads it, and the agent believes it has looked. So when
	 * the operator has chosen a model that can see, the picture goes there with the question and
	 * words come back — the same arrangement web_search has, and for the same reasons. It is paid
	 * for once, too: an image in a tool result is sent again with every later call in the turn.
	 */
	pi.registerTool({
		name: "screen_look",
		label: "Look at the page",
		description: [
			"Have somebody look at the page and tell you what is on it.",
			"",
			"For what reading cannot tell you: a chart, a map, a photograph, a layout somebody asked you",
			"about, a page that reads as nonsense and might be showing something else. It is not for",
			"finding a button — reading tells you where the buttons are, exactly, and this only roughly.",
			"",
			"Ask for what you actually want to know. The picture is looked at by a model that can see,",
			"and it does better with a question than with nothing: 'is there a captcha or a cookie wall",
			"in the way?' gets you an answer, where a bare look gets you a description.",
			"",
			"It is billed to you, and it costs more than reading. Do not look after every click.",
		].join("\n"),
		promptSnippet: "Have the page looked at, for what its text cannot show",
		promptGuidelines: [
			"Look at the page only when the question is visual. Reading is cheaper and more precise for anything else.",
			"When you look, say what you want to know. A question is answered; a bare look is described.",
		],
		parameters: Type.Object({
			about: Type.Optional(
				Type.String({ description: "What you want to know about what is on the screen." }),
			),
		}),
		async execute(_id, params) {
			const { about } = params as { about?: string };
			const blocks = await does({ verb: "look" });
			const png = pictureIn(blocks);
			const model = await looking();

			// Nobody to ask, so the picture goes to whatever is reading this — which works when that
			// model can see and is worth saying plainly when it cannot, because from in here there is
			// no way to tell the two apart.
			if (png === undefined || model === undefined) {
				return {
					content: [
						...blocks,
						{
							type: "text" as const,
							text: "This plane has no model set up to look at pictures, so the screenshot is above for your own model to read. If you cannot read images, say so in your answer: your operator turns one on at the console, under /config vision.",
						},
					],
					details: {},
				};
			}

			const { status, body } = await post(model.endpoint, askedOf(model, about ?? "", png));
			let answer: unknown;
			try {
				answer = JSON.parse(body);
			} catch {
				// A proxy that refused the host answers in its own words rather than in the API's, and
				// this is where that arrives: it is the reason the looking did not happen.
				throw new Error(`Looking failed (HTTP ${status}): ${body.slice(0, 400)}`);
			}
			if (status !== 200) {
				throw new Error(`Looking failed (HTTP ${status}): ${refusedBy(answer, body)}`);
			}
			const said = saidBy(model, answer);
			if (said.length === 0) {
				throw new Error("The model that looks came back with nothing to say about the screen.");
			}

			// The address above the description, because a paragraph about a page is worth much less
			// without the page it is about.
			const where = blocks.find((block) => block.type === "text");
			const usage: Usage = spentOn(model, answer);
			return {
				content: [
					{
						type: "text" as const,
						text: `${where !== undefined && where.type === "text" ? `${where.text}\n\n` : ""}${said}`,
					},
				],
				details: {},
				usage,
			};
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
	/*
	 * Tabs, which exist because the work is not one page at a time.
	 *
	 * Halfway through a booking an agent needs to go and read what a fare includes — and doing that
	 * on the page it was working on costs the page. A search with a flight selected on it does not
	 * come back by going back: the state was built by clicking, and the click is gone. What that
	 * looks like from the outside is an agent that was nearly finished and started over.
	 */
	pi.registerTool({
		name: "screen_tab_open",
		label: "Open in a new tab",
		description: [
			"Open a page in a new tab, keeping the one you are on exactly where it is.",
			"",
			"This is how you look something up in the middle of something else: a fare's baggage rules,",
			"a price somewhere else, what a form field means. The page you were working on is still",
			"there, with whatever you had filled in and selected on it, and screen_tab takes you back.",
			"",
			"Use it rather than screen_open whenever you are partway through anything. Going back does",
			"not undo a form or restore a selection — that state was made by clicking, and the clicks",
			"are gone.",
			"",
			"Work in one tab. Open a second only when you are partway through something and have to go",
			"and find something out — and close it with screen_tab_close the moment you have the answer.",
			"A tab left open is a whole page held in memory for as long as it is open, on a machine that",
			"is also running the other agents, and this browser will refuse to open more than three.",
		].join("\n"),
		promptSnippet: "Look something up in a new tab, without losing the page you are on",
		promptGuidelines: [
			"Work in one tab. Open a second only when you are partway through something and have to look something else up — never as a way of keeping pages around.",
			"Close a look-up tab with screen_tab_close as soon as you have the answer. Every tab open costs memory on a machine that is also running the other agents.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The whole address, with https:// on the front." }),
		}),
		async execute(_id, params) {
			const { url } = params as { url: string };
			return { content: [...(await does({ verb: "tab_open", url }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_tabs",
		label: "List the tabs",
		description:
			"Every tab this browser has open, numbered, with the one you are on marked. Cheap, and never refused — it changes nothing.",
		promptSnippet: "See which tabs are open and which one you are on",
		parameters: Type.Object({}),
		async execute() {
			return { content: [...(await does({ verb: "tabs" }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_tab",
		label: "Go to a tab",
		description: [
			"Go back to one of the open tabs, by its number from screen_tabs.",
			"",
			"The page is as you left it. This is the other half of screen_tab_open: look something up,",
			"then come back to the thing you were partway through.",
		].join("\n"),
		promptSnippet: "Go back to a tab you left open",
		parameters: Type.Object({
			tab: Type.Integer({ description: "The number from screen_tabs." }),
		}),
		async execute(_id, params) {
			const { tab } = params as { tab: number };
			return { content: [...(await does({ verb: "tab", tab }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_tab_close",
		label: "Close a tab",
		description: [
			"Close one of the tabs, by its number from screen_tabs.",
			"",
			"The other half of screen_tab_open, and not an optional one: you close the tab you looked",
			"something up in as soon as you have the answer, the way you would close it yourself. Leaving",
			"it open holds a whole page in memory for nothing, and this browser will not open a fourth.",
			"",
			"The last tab cannot be closed — a browser with no pages is a browser that has gone.",
		].join("\n"),
		promptSnippet: "Close a tab you are finished with",
		promptGuidelines: [
			"After looking something up in a second tab, go back to the one you were working in and close the one you opened. Do not accumulate tabs.",
		],
		parameters: Type.Object({
			tab: Type.Integer({ description: "The number from screen_tabs." }),
		}),
		async execute(_id, params) {
			const { tab } = params as { tab: number };
			return { content: [...(await does({ verb: "tab_close", tab }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_ask",
		label: "Ask the operator to take the screen",
		description: [
			"Ask your operator to come and do something on this browser themselves: sign in, approve",
			"something, answer a code, press whatever will not let you press it.",
			"",
			"It puts the note in two places, because there are two places they might be looking. On their",
			"live view of this browser, beside the button that takes the keyboard off you — and in the",
			"conversation, as a card carrying that same button and whatever you wrote in `then`. While",
			"they hold the keyboard everything that touches the page is refused and reading still works,",
			"so you can watch without interfering.",
			"",
			"The options are what they press when they are done, and each one is the message it sends you:",
			"one that says they did it, one that says they could not. Without them the card is a sentence",
			"with nothing to answer it, and they are left typing a reply you then have to interpret.",
			"",
			"Nothing waits for them. They may be asleep. Say what you need in your answer too, and then",
			"end the turn: the answer comes back as a message, in a turn of its own.",
		].join("\n"),
		promptSnippet: "Ask the operator to take this screen and do something on it",
		promptGuidelines: [
			"When a page wants a password, a card or a one-time code, use screen_ask. Never type one yourself and never invent one.",
			"When an element will not respond to screen_click — a widget your reading of the page does not expose — use screen_ask rather than trying it four more ways. Say which button, in the words printed on it.",
			"Always write the options, in the operator's own language: the card is answered by pressing one of them, and a card with nothing to press is a paragraph again.",
		],
		parameters: Type.Object({
			note: Type.String({ description: "What you need them to do, in one sentence." }),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"What they press when they are done, each written as the message it sends you. Two is usually right: done, and could not.",
				}),
			),
		}),
		async execute(_id, params) {
			const { note, options } = params as { note: string; options?: readonly string[] };
			// The note on the screen and the card in the conversation are one act, so a failure to file
			// the card is not a reason for the note not to be on the screen: the operator who is already
			// watching the browser is the likeliest reader of either.
			const filed = ((): string => {
				try {
					return alsoAsk(note, options ?? [], true);
				} catch (error) {
					return `The card was not put up: ${(error as Error).message}`;
				}
			})();
			const said = await does({ verb: "ask", note });
			return { content: [...said, { type: "text", text: filed }], details: {} };
		},
	});
}
