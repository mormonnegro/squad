import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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
import {
	askedAbout,
	askedAboutAll,
	keyAt,
	labelOf,
	nearestIn,
	type Outline,
	type Pointing,
	pickedAllIn,
	pickedIn,
	readOutline,
	readPointing,
	refOf,
	refusedBy as refusedPointing,
	spentOn as spentPointing,
	SURE_ENOUGH,
} from "./pointing.ts";
import { alreadyAsked, askFor, holding, keep } from "./question.ts";
import { askedToStep, type Move, movedIn, TARGET_KEY, walked } from "./steering.ts";
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

/**
 * The model that points, when the operator has chosen one — and nothing at all when they have not.
 *
 * Read per call, like the model that looks, because the file is written by the plane before every
 * turn. Read once more at registration as well, because whether it is there decides whether these
 * tools say they can be told what to press rather than which number to press: a parameter offered
 * on a plane that cannot answer it is a turn spent finding that out.
 */
function pointing(): Pointing | undefined {
	const path = process.env.SQUAD_POINTING_FILE ?? "";
	if (path.length === 0) return undefined;
	try {
		return readPointing(readFileSync(path, "utf8"));
	} catch {
		// No file is the answer for most planes: pointing is off until somebody turns it on.
		return undefined;
	}
}

/** The text of whatever the screen answered with, which for `outline` is the page as data. */
function textIn(blocks: readonly Block[]): string | undefined {
	for (const block of blocks) if (block.type === "text") return block.text;
	return undefined;
}

/**
 * The page, and which numbered thing on it is the one that was named.
 *
 * Everything here happens between two containers and a classifier: the browser hands over the page
 * as data, the classifier picks a row, and the number goes back to the browser. None of it passes
 * through the model driving the turn, which is the whole point — what that model asked for was "the
 * Continue button", and what it gets back is the page after the Continue button was pressed.
 */
async function pointAt(
	model: Pointing,
	what: string,
): Promise<
	| { readonly ref: number; readonly usage: Usage }
	| { readonly why: string; readonly near?: readonly string[]; readonly usage?: Usage }
> {
	const outline: Outline | undefined = readOutline(textIn(await does({ verb: "outline" })));
	if (outline === undefined) return { why: "The browser could not say what is on the page." };
	if (outline.rows.length === 0)
		return { why: "Nothing on this page can be clicked or typed into." };

	const asked = await askTheModel(model, askedAbout(model, what, outline));
	if ("why" in asked) return asked;
	const picked = pickedIn(asked.answer);
	if (picked === undefined) {
		// Which page, because the commonest reason a description matches nothing is that the browser
		// is not on the page the agent thinks it is: a tab it opened, a step it did not land on.
		return {
			why: `Nothing on ${where(outline)} is clearly "${what}".`,
			near: nearestIn(asked.answer, outline.rows),
			usage: asked.usage,
		};
	}
	return { ref: picked.ref, usage: asked.usage };
}

/**
 * Walking a site towards something, without going back to the model that thinks between steps.
 *
 * The one thing here that is a loop rather than a call. Each turn of it is: ask the browser for the
 * page as data, ask the classifier in one request what should happen and to what, do it. About half
 * a second a step, against the twenty to fifty seconds a step costs when every click is a tool call
 * answered by the model driving the turn.
 *
 * It stops at the first of four things: it says it has arrived, it says the page offers no way on,
 * it will not commit to a move, or it runs out of steps. Every one of those hands the page back and
 * says which it was — a loop that stopped for a different reason than it looks like is a loop an
 * agent will run again expecting a different answer.
 */
async function walkTowards(
	model: Pointing,
	goal: string,
	most: number,
): Promise<{ readonly said: string; readonly usage: Usage | undefined }> {
	const trail: string[] = [];
	let spent: Usage | undefined;
	const add = (usage: Usage | undefined): void => {
		if (usage === undefined) return;
		spent = spent === undefined ? usage : sums(spent, usage);
	};
	const page = async (): Promise<string> => textIn(await does({ verb: "read", brief: true })) ?? "";

	for (let step = 0; step < most; step += 1) {
		const outline: Outline | undefined = readOutline(textIn(await does({ verb: "outline" })));
		if (outline === undefined) {
			return { said: "The browser could not say what is on the page.", usage: spent };
		}
		const asked = await askTheModel(model, askedToStep(model, goal, outline, trail));
		if ("why" in asked) return { said: asked.why, usage: spent };
		add(asked.usage);
		const move: Move | undefined = movedIn(asked.answer);
		if (move === undefined) {
			return { said: [walked(trail, "unsure", goal), "", await page()].join("\n"), usage: spent };
		}
		if (move === "done" || move === "stuck") {
			return { said: [walked(trail, move, goal), "", await page()].join("\n"), usage: spent };
		}
		if (move === "scroll") {
			await does({ verb: "scroll", to: "down", brief: true });
			continue;
		}
		const picked = pickedIn(asked.answer, SURE_ENOUGH, TARGET_KEY);
		if (picked === undefined) {
			// It wanted to press something and would not say what. Scrolling is the cheap thing to try
			// before giving the page back: half the time what it meant is below the fold.
			await does({ verb: "scroll", to: "down", brief: true });
			continue;
		}
		const row = outline.rows.find((one) => refOf(one) === picked.ref);
		trail.push(row === undefined ? `[${picked.ref}]` : labelOf(row));
		await does({ verb: "click", ref: picked.ref, brief: true });
	}
	return { said: [walked(trail, "most", goal), "", await page()].join("\n"), usage: spent };
}

/** Two costs added up, because a walk is many requests and the agent is shown one number. */
function sums(one: Usage, two: Usage): Usage {
	return {
		input: one.input + two.input,
		output: one.output + two.output,
		cacheRead: one.cacheRead + two.cacheRead,
		cacheWrite: one.cacheWrite + two.cacheWrite,
		totalTokens: one.totalTokens + two.totalTokens,
		cost: {
			input: one.cost.input + two.cost.input,
			output: one.cost.output + two.cost.output,
			cacheRead: one.cost.cacheRead + two.cost.cacheRead,
			cacheWrite: one.cost.cacheWrite + two.cost.cacheWrite,
			total: one.cost.total + two.cost.total,
		},
	};
}

/** The page an answer is about, which is the fact an agent on the wrong tab is missing. */
function where(outline: Outline): string {
	const name = outline.title === "" ? outline.url : outline.title;
	return name === "" ? "this page" : `"${name}"`;
}

/** One request to the thing that chooses, with every way it can fail said in words. */
async function askTheModel(
	model: Pointing,
	asked: string,
): Promise<{ readonly answer: unknown; readonly usage: Usage } | { readonly why: string }> {
	const { status, body } = await post(model.endpoint, asked);
	let answer: unknown;
	try {
		answer = JSON.parse(body);
	} catch {
		// A proxy that refused the host answers in its own words rather than in the API's, and this
		// is where that arrives: it is the reason the pointing did not happen.
		return { why: `Pointing failed (HTTP ${status}): ${body.slice(0, 200)}` };
	}
	if (status !== 200) {
		return { why: `Pointing failed (HTTP ${status}): ${refusedPointing(answer, body)}` };
	}
	return { answer, usage: spentPointing(model, answer) };
}

/**
 * What to hand back when the pointing did not land: the rows it was choosing between.
 *
 * This used to be the whole numbered page, which was the worst thing it could be. One unsure answer
 * put two hundred rows into the conversation, and from that moment the agent had numbers in front
 * of it and went back to counting for the rest of the turn — one miss and the feature turned itself
 * off. The three it was weighing up cost nothing: they come back with every answer whether or not
 * anybody reads them.
 */
function instead(why: string, near: readonly string[], usage: Usage | undefined) {
	// Named rather than numbered, because every caller of this is an agent that names things: on a
	// plane that points, a ref is not something it can send, so a list of numbers here would be a way
	// out that does not open. The labels are what the rows say with the numbers taken off the front.
	const lines =
		near.length === 0
			? [why, "Look at the page with screen_look if you cannot tell what to call it."]
			: [
					why,
					"",
					"The closest things on the page were:",
					...near.map((row) => `  ${labelOf(row)}`),
					"",
					"Say one of those, the way it reads on screen.",
				];
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {},
		...(usage === undefined ? {} : { usage }),
	};
}

const REFS = [
	"Everything you act on is a ref: a number from the last read, like [7]. Refs belong to the read",
	"they came from — after anything that changes the page, read it again and use the new numbers.",
].join(" ");

export default function (pi: ExtensionAPI): void {
	// Whether this plane points, asked once here: it decides what these tools say they take, and a
	// tool description is written when it is registered rather than when it is called.
	const points = pointing();
	/*
	 * What every verb that answers with a page is asked for, once this plane points.
	 *
	 * The saving is not in the click, it is in what comes back from it. A page listed out is two
	 * hundred rows of button and link, it is the biggest thing in the conversation, and every later
	 * call in the turn carries it again — for an agent that names things and can no longer send a
	 * number, all of it answers a question that will never be asked. So scrolling, going back and
	 * changing tabs come back brief too, and not only the click that started it.
	 */
	const briefly = points === undefined ? {} : { brief: true };

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
			...(points === undefined
				? []
				: [
						"",
						"What comes back is where you landed and what the page says. The numbered list of",
						"things on it is not included and you do not need it: click and type by naming what you",
						"want. screen_read is there for the times you do.",
					]),
		].join("\n"),
		promptSnippet: "Open a page in your own browser, and read what is on it",
		parameters: Type.Object({
			url: Type.String({ description: "The whole address, with https:// on the front." }),
		}),
		async execute(_id, params) {
			const { url } = params as { url: string };
			// Where things can be named, the numbered list is not sent unasked. It is the biggest thing
			// that would arrive in this conversation, it arrives again with every later call, and an
			// agent that names what it wants is never going to use a line of it.
			const asked =
				points === undefined ? { verb: "open", url } : { verb: "open", url, brief: true };
			return { content: [...(await does(asked))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_read",
		label: "Read the page",
		description: [
			...(points === undefined
				? [
						"Read the page your browser is on: where it is, what you can click or type into, and",
						"what it says.",
						"",
						`${REFS}`,
						"",
					]
				: [
						"Read the page your browser is on: where it is and what it says.",
						"",
						"Not a list of things to press — there is none to give you, and you do not act by",
						"number on this browser. What comes back is the words on the page, which is what the",
						"next sentence of your work is written from. To act, name the thing.",
						"",
					]),
			...(points === undefined
				? [
						"This is the cheap one and the one to use by default. Reading a page costs a fraction of",
						"looking at it and is exact, because you act on numbered elements rather than on",
						"coordinates you guessed from a picture.",
					]
				: [
						"Read when you need what the page says: a price, an error, a confirmation, the name of",
						"the thing you are about to press. Clicking and typing do not need this at all — they",
						"come back with the page themselves.",
					]),
			...(points === undefined
				? [
						"",
						"A row that says `div` is not a mistake. The list is what a person could press, which is",
						"more than what the markup declares: a card built out of bare divs with the handler bound",
						"in script is on it, found by the hand the browser draws over it. Click those the same way.",
					]
				: []),
		].join("\n"),
		promptSnippet: "Read the page your browser is on, as text and numbered elements",
		promptGuidelines:
			points === undefined
				? [
						"Read the page rather than looking at it, unless the thing you need is genuinely visual.",
						"Read again after every click, and use the refs from the newest read.",
						"If what you want is not in the list, read the page again after scrolling to it: an element with no size and nothing drawn is left out, and a list that has just been opened or filtered is a different list.",
					]
				: [
						"Do not read the page in order to click something. Name the thing in screen_click or screen_type: reading gives you no numbers, and clicking needs none.",
						"Read when you need what the page says rather than what it offers — a price, an error, a confirmation.",
						"If what you named is not found, scroll to it and act again: an element with no size and nothing drawn is not on the page yet, and a list that has just been filtered is a different list.",
					],
		parameters: Type.Object({}),
		async execute() {
			// Brief where this plane points, which is the same page without the list of refs: the list is
			// most of what a reading costs, and every number in it answers a question this agent has no
			// way to ask.
			const asked = points === undefined ? { verb: "read" } : { verb: "read", brief: true };
			return { content: [...(await does(asked))], details: {} };
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
		description: [
			"Click something on the page.",
			"",
			...(points === undefined
				? ["Say which one by its number.", "", REFS]
				: [
						'Describe it — `what: "the Continue button"` — the way it reads on screen. Something small',
						"and fast is handed the page and finds the element for you.",
						"",
						"This is the only way to click on this browser. There are no numbers to use: nothing you",
						"can call gives you one, because a page listed out is the biggest thing you would put in",
						"this conversation and every later call would carry it again.",
						"",
						"If the description is not clearly one thing on the page, nothing is clicked and you are",
						"told what the closest things are called. Say one of those. If you cannot tell what to",
						"call it, screen_look is a pair of eyes on the page.",
					]),
		].join("\n"),
		promptSnippet:
			points === undefined
				? "Click something on the page, by its number"
				: "Click something on the page by naming it",
		...(points === undefined
			? {}
			: {
					promptGuidelines: [
						'Click by naming the thing — what: "the Continue button" — rather than by reading the page and using a ref. It is one call instead of two and keeps the page\'s element list out of this conversation.',
					],
				}),
		/*
		 * One way in, decided by whether this plane points.
		 *
		 * With a classifier behind it there is a name and no number, and that is the whole of the
		 * saving rather than a preference: a ref exists only because a page was listed out, and a
		 * schema that still offered one is a schema that tells a model the list is worth asking for.
		 * Without a classifier there is a number and nothing else, because nothing here could find an
		 * element from a description.
		 */
		parameters: Type.Object(
			points === undefined
				? {
						ref: Type.Integer({
							description: "The number from the last read, without the brackets.",
						}),
					}
				: {
						what: Type.String({
							description:
								'What to click, described as it reads on screen: "the Continue button", "the second result", "the cheapest flight".',
						}),
					},
		),
		async execute(_id, params) {
			const { ref, what } = params as { ref?: number; what?: string };
			const model = pointing();
			if (model !== undefined) {
				const named = (what ?? "").trim();
				if (named === "") {
					return {
						content: [
							{
								type: "text" as const,
								text: "Say what to click, the way it reads on screen — this browser has no numbers to click by.",
							},
						],
						details: {},
					};
				}
				const found = await pointAt(model, named);
				if ("why" in found) return instead(found.why, found.near ?? [], found.usage);
				return {
					content: [...(await does({ verb: "click", ref: found.ref, brief: true }))],
					details: {},
					usage: found.usage,
				};
			}
			if (ref === undefined) {
				return {
					content: [{ type: "text" as const, text: "Say which one: a ref from the last read." }],
					details: {},
				};
			}
			return { content: [...(await does({ verb: "click", ref }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_type",
		label: "Type",
		description: [
			"Type into a field on the page.",
			"",
			...(points === undefined
				? ["Name the field by its ref, or leave it out to type wherever the cursor already is."]
				: [
						'Describe the field — what: "the search box" — the way it reads on screen, or leave it',
						"out to type wherever the cursor already is. There are no numbers here to name it by.",
					]),
			"Set enter to submit straight after, which is one call instead of two for a search box.",
			"",
			"A named field is emptied first, so what it holds afterwards is what you sent and nothing",
			"else. Typing with no field named inserts where the cursor is and clears nothing.",
			...(points === undefined
				? []
				: [
						"",
						"Nothing is typed if the description is not clearly one field on the page: you are told",
						"what the closest ones are called, and you say one of those.",
					]),
			"",
			"Never type a password, a card number or a one-time code. You do not have them, and a page",
			"asking for one is a page to hand over: screen_login signs you in from your operator's",
			"password manager without any of it passing through you, and screen_ask brings them to the",
			"keyboard when that is not open to you.",
		].join("\n"),
		promptSnippet: "Type into a field on the page",
		promptGuidelines: [
			"Never type credentials into a page. At a login use screen_login; if that says the site is not open for you, ask the operator to take the keyboard with screen_ask.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "What to put in." }),
			// A name where this plane points and a number where it does not, for the reason the click
			// above has one of each: the two are not alternatives, they are what the browser answers to.
			...(points === undefined
				? {
						ref: Type.Optional(
							Type.Integer({ description: "The field, by its number from the last read." }),
						),
					}
				: {
						what: Type.Optional(
							Type.String({
								description:
									'The field, described as it reads on screen: "the search box", "the email field". Left out, it types where the cursor already is.',
							}),
						),
					}),
			enter: Type.Optional(Type.Boolean({ description: "Press Enter afterwards." })),
		}),
		async execute(_id, params) {
			const { text, ref, what, enter } = params as {
				text: string;
				ref?: number;
				what?: string;
				enter?: boolean;
			};
			const model = pointing();
			if (what !== undefined && what.trim() !== "" && model !== undefined) {
				const found = await pointAt(model, what.trim());
				if ("why" in found) return instead(found.why, found.near ?? [], found.usage);
				return {
					content: [
						...(await does({
							verb: "type",
							text,
							ref: found.ref,
							brief: true,
							...(enter === true ? { enter: true } : {}),
						})),
					],
					details: {},
					usage: found.usage,
				};
			}
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

	/*
	 * A whole form in one call, which is the only thing here that changes how long a turn takes.
	 *
	 * Everything else this feature does saves tokens. This saves calls to the model that thinks —
	 * and that model is where the minute goes: ten seconds a step, two steps a box, six boxes on a
	 * checkout. The questions about which row is which box are asked in one request and answered in
	 * parallel by something that takes a tenth of a second, the boxes are filled inside the browser
	 * one after another, and the button under them is pressed on the way out.
	 */
	/*
	 * The one tool that walks rather than acts, and the only one that does several things per call.
	 *
	 * Everything else here is one move decided by the model that thinks. This is a destination: the
	 * loop inside it asks the classifier what to do and does it, over and over, without a word to
	 * that model in between. Which is the whole saving — on this plane a step costs about half a
	 * second here against twenty to fifty seconds there.
	 *
	 * Only where there is a classifier, because without one there is nothing to ask.
	 */
	if (points !== undefined) {
		pi.registerTool({
			name: "screen_goal",
			label: "Get to a page",
			description: [
				"Walk this browser to somewhere, in one call.",
				"",
				"Say where you want to end up and it presses its own way there: it looks at the page,",
				"decides what gets closest, presses it, and looks again. Nothing comes back to you in",
				"between, which is why it is fast — a walk of five pages takes seconds rather than a call",
				"of yours per page.",
				"",
				"Use it for getting somewhere: a section of a site, a product page, the page behind three",
				"menus. Not for doing something once you are there — filling a form is screen_fill, one",
				"press is screen_click, and anything with a password in it is screen_login.",
				"",
				'Say the destination, not the route: "the page about coffee in Brazil" rather than "click',
				'Brasil then Café". It chooses each step from what the page actually offers.',
				"",
				"It stops by itself and tells you which: it arrived, the page offered no way on, it was",
				"unsure what to do next, or it ran out of steps. What comes back is where it ended and",
				"what it pressed to get there. It types nothing — a page that needs words needs you.",
			].join("\n"),
			promptSnippet: "Walk the browser to a page, pressing its own way there",
			promptGuidelines: [
				"To get somewhere that takes several clicks, use screen_goal once rather than screen_click several times: the steps happen without a turn of yours, which is most of the time a walk costs.",
				"Say where to end up, not which links to press. If it comes back unsure or out of steps, carry on with screen_click from where it left you.",
			],
			parameters: Type.Object({
				goal: Type.String({
					description:
						'Where to end up, as you would say it: "the page about coffee in Brazil", "the checkout", "the settings for billing".',
				}),
				most: Type.Optional(
					Type.Integer({
						description: "How many presses it may make before stopping. Eight by default.",
					}),
				),
			}),
			async execute(_id, params) {
				const { goal, most } = params as { goal: string; most?: number };
				const model = pointing();
				if (model === undefined) {
					return {
						content: [{ type: "text" as const, text: "Nothing points on this plane." }],
						details: {},
					};
				}
				// Bounded here as well as offered as a default: a walk is the one call that can make
				// twenty presses without anybody watching, and the ceiling is what keeps a goal it will
				// never reach from pressing its way across a site until the turn runs out.
				const steps = Math.max(1, Math.min(most ?? 8, 15));
				const walk = await walkTowards(model, goal.trim(), steps);
				return {
					content: [{ type: "text" as const, text: walk.said }],
					details: {},
					...(walk.usage === undefined ? {} : { usage: walk.usage }),
				};
			},
		});

		pi.registerTool({
			name: "screen_fill",
			label: "Fill a form",
			description: [
				"Fill in a whole form at once, and press the button under it.",
				"",
				"Name each box the way it reads on screen and say what goes in it. They are all worked",
				"out together and filled in order, so a six-box checkout is one call instead of twelve.",
				"",
				"Use this for anything with more than one box in it. screen_type is for a single box —",
				"a search field, a code — and this is for everything else.",
				"",
				"A box that is not clearly one thing on the page is left empty and named in the answer,",
				"so you can do that one yourself. The rest are still filled: a form is not all or nothing.",
			].join("\n"),
			promptSnippet: "Fill in a form and press the button under it, in one call",
			promptGuidelines: [
				"Fill forms with screen_fill rather than one box at a time. Two calls per box is where a turn's minutes go.",
			],
			parameters: Type.Object({
				fields: Type.Array(
					Type.Object({
						what: Type.String({
							description:
								'The box, as it reads on screen: "the first name field", "Fecha de nacimiento".',
						}),
						text: Type.String({ description: "What to put in it." }),
					}),
					{ description: "Every box you want filled, in the order they are on the page." },
				),
				then: Type.Optional(
					Type.String({
						description:
							'Something to press once they are filled, described: "the Continue button".',
					}),
				),
			}),
			async execute(_id, params) {
				const { fields, then } = params as {
					fields: readonly { what: string; text: string }[];
					then?: string;
				};
				const model = pointing();
				if (model === undefined || fields.length === 0) {
					return {
						content: [
							{ type: "text" as const, text: "Say which boxes to fill and what goes in them." },
						],
						details: {},
					};
				}
				const outline = readOutline(textIn(await does({ verb: "outline" })));
				if (outline === undefined || outline.rows.length === 0) {
					return {
						content: [{ type: "text" as const, text: "There is nothing on this page to fill in." }],
						details: {},
					};
				}

				// One request for every box and the button: the provider answers them independently and
				// in parallel, so asking about seven things costs what asking about one costs.
				const wants = [...fields.map((one) => one.what), ...(then === undefined ? [] : [then])];
				const asked = await askTheModel(model, askedAboutAll(model, wants, outline));
				if ("why" in asked) return instead(asked.why, [], undefined);
				const found = pickedAllIn(asked.answer, wants.length);

				const puts: { ref: number; text: string }[] = [];
				const missed: string[] = [];
				fields.forEach((one, at) => {
					const picked = found[at];
					if (picked === undefined) missed.push(one.what);
					else puts.push({ ref: picked.ref, text: one.text });
				});
				const press = then === undefined ? undefined : found[fields.length]?.ref;
				if (puts.length === 0 && press === undefined) {
					return instead(
						`None of those is clearly a box on ${where(outline)}: ${missed.join(", ")}. If that is not the page you meant, you are on another tab — screen_tabs says which.`,
						nearestIn(asked.answer, outline.rows, 3, keyAt(0)),
						asked.usage,
					);
				}

				const did = await does({
					verb: "put",
					puts,
					...(press === undefined ? {} : { press }),
					brief: true,
				});
				const said = [
					`Filled ${puts.length} of ${fields.length} on ${where(outline)}.`,
					...(missed.length === 0
						? []
						: [
								`Not clearly on this page, so left empty: ${missed.join(", ")}. Do those one at a time, or read the page.`,
							]),
					...(then === undefined
						? []
						: press === undefined
							? [`Nothing on this page is clearly "${then}", so nothing was pressed.`]
							: [`Then pressed "${then}".`]),
				].join(" ");
				return {
					content: [{ type: "text" as const, text: said }, ...did],
					details: {},
					usage: asked.usage,
				};
			},
		});
	}

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
			return { content: [...(await does({ verb: "key", key, ...briefly }))], details: {} };
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
			return { content: [...(await does({ verb: "scroll", to, ...briefly }))], details: {} };
		},
	});

	pi.registerTool({
		name: "screen_back",
		label: "Go back",
		description: "Go back to the page before this one, the way the browser's own back button does.",
		promptSnippet: "Go back to the previous page",
		parameters: Type.Object({}),
		async execute() {
			return { content: [...(await does({ verb: "back", ...briefly }))], details: {} };
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
			return { content: [...(await does({ verb: "tab_open", url, ...briefly }))], details: {} };
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
			return { content: [...(await does({ verb: "tab", tab, ...briefly }))], details: {} };
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
			return { content: [...(await does({ verb: "tab_close", tab, ...briefly }))], details: {} };
		},
	});

	/*
	 * Signing in, which is the one tool here whose answer the agent may not see.
	 *
	 * The other way out of a login, beside asking the operator to come and type one. What it takes is
	 * a site and never an entry: the vault is opened in the browser's container by a CLI holding a
	 * token this sandbox has no path to, and what crosses into the page is keystrokes. There is no
	 * shape of request here that answers with a password, because nothing on the other side answers
	 * with one — a filled password box reads as bullets in every later reading of the page.
	 *
	 * It works for the sites the operator opened for this agent and no others. The refusal says what
	 * to do about it, because an agent stopped at a login with no way to say so is an agent that
	 * starts guessing.
	 */
	pi.registerTool({
		name: "screen_login",
		label: "Sign in from the vault",
		description: [
			"Sign into the site you are on, using an account your operator keeps in their password",
			"manager.",
			"",
			"You never see any of it. The password is read inside the browser's own container and typed",
			"into the page; what you get back is a sentence about which boxes were filled, and the page",
			"afterwards shows a password box as bullets like anybody else's.",
			"",
			"This works only for sites your operator has opened for you, which is a list this browser",
			"holds and not a setting in their password manager. If it says one is not open, do not send",
			"them to the password manager — it is fine. Ask for the site instead: run /screen login <host>",
			"at your console, which opens nothing and puts the question on their screen with one key to",
			"answer. They press it once and after that you sign yourself in whenever the session runs out.",
			"",
			"Open the sign-in page first, and call this on it. If the form is the two-step kind — the",
			"name first and the password on the next page — call it again on the second page.",
		].join("\n"),
		promptSnippet: "Sign into the site you are on, from your operator's password manager",
		promptGuidelines: [
			"At a login, try screen_login before anything else: it is the only way you may sign in, and it costs one call.",
			"Never type a password, a card or a code yourself, and never invent one. If screen_login says the site is not open for you, ask for it with /screen login <host> at your console — that raises a question your operator answers with one key, and it is not a setting in their password manager.",
		],
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"The site to sign into, when it is not the page you are on. A host like github.com.",
				}),
			),
		}),
		async execute(_id, params) {
			const { url } = params as { url?: string };
			return {
				content: [...(await does(url === undefined ? { verb: "login" } : { verb: "login", url }))],
				details: {},
			};
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
