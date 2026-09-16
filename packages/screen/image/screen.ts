import http from "node:http";
import { Browser } from "./browser.ts";
import { readEgress, startForwarder } from "./forward.ts";
import { refusedToAgent, refusedToOperator, TheKeyboard } from "./keyboard.ts";
import { viewPage } from "./page.ts";
import { presented, tokenIn } from "./token.ts";
import { needsTheKeyboard, readAsked, readUrl } from "./verbs.ts";

/**
 * The program that is this container.
 *
 * Two doors onto one browser, opened to two different people. The agent's door is on the sandbox
 * network, because that is where the agent is, and it answers verbs and nothing else. The
 * operator's door is on loopback, because the only thing that can reach loopback in here is the
 * plane's own tunnel — which means the live view, and the button on it that takes the keyboard away
 * from the agent, is not something the agent can open for itself. An agent that could would be an
 * agent that could lock its operator out of the screen, or hand itself the keyboard back in the
 * middle of somebody typing a password.
 */

const AGENT_ID = process.env.SQUAD_AGENT_ID ?? "agent";
const VERB_PORT = Number(process.env.SQUAD_SCREEN_VERB_PORT ?? 7181);
const VIEW_PORT = Number(process.env.SQUAD_SCREEN_VIEW_PORT ?? 7180);
const PROXY_PORT = Number(process.env.SQUAD_SCREEN_PROXY_PORT ?? 7182);

const keyboard = new TheKeyboard();
const browser = new Browser();

/**
 * The one agent whose screen this is, as a secret rather than as a name.
 *
 * Its door is on the network every sandbox shares, so being asked by something is not evidence of
 * being asked by the right one. Nothing else on that network holds this agent's egress token.
 */
const TOKEN = tokenIn(process.env.SQUAD_EGRESS_PROXY);

function json(response: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response
		.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
		.end(payload);
}

async function body(request: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

/**
 * The agent's door.
 *
 * One route, because there is one thing to do here: say what you want done, in the words on the
 * list. Nothing about a browser is reachable from this port except through `does`, and `does` can
 * only be reached with something `readAsked` agreed to.
 */
const verbs = http.createServer((request, response) => {
	void (async () => {
		if (request.method !== "POST") {
			json(response, 405, { refused: "Post a verb." });
			return;
		}
		// Before the body is even read. Whoever is asking is on a network shared with every other
		// sandbox on this plane, and only one of them is the agent this browser belongs to.
		if (!presented(request.headers.authorization, TOKEN)) {
			json(response, 403, { refused: "This screen is not yours." });
			return;
		}
		const asked = readAsked(await body(request));
		if ("refused" in asked) {
			json(response, 400, asked);
			return;
		}
		if (asked.verb === "ask") {
			json(response, 200, { text: sawTheNote(keyboard.ask(asked.note ?? "").note) });
			return;
		}
		if (needsTheKeyboard(asked.verb) && keyboard.holder === "operator") {
			json(response, 409, { refused: refusedToAgent(keyboard.state().note) });
			return;
		}
		try {
			const did = await browser.does(asked);
			json(response, 200, did);
		} catch (error) {
			json(response, 500, { refused: `The browser would not: ${(error as Error).message}` });
		}
	})().catch(() => json(response, 500, { refused: "the screen failed" }));
});

function sawTheNote(note: string | undefined): string {
	if (note === undefined) return "Nothing to ask.";
	return [
		`Your note is on the operator's screen: "${note}"`,
		"",
		"Nothing is waiting on it. They may be looking at the screen or they may be asleep, and you",
		"have not been put on hold either way — you still have the keyboard until they take it. If",
		"what you need is for them to have done the thing, end the turn and book one later with",
		"wake_me, then read the page again when you wake.",
	].join("\n");
}

/** The operator's door, on loopback, reached only through the plane's tunnel. */
const view = http.createServer((request, response) => {
	void (async () => {
		const path = (request.url ?? "/").split("?")[0];

		if (request.method === "GET" && (path === "/" || path === "")) {
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
				.end(viewPage(AGENT_ID));
			return;
		}

		if (request.method === "GET" && path === "/state") {
			// The tabs come with it rather than on a door of their own: whoever is drawing this is
			// drawing a browser, and a browser with no tab strip is one where a page that opened
			// somewhere else has simply vanished.
			json(response, 200, {
				...keyboard.state(),
				url: browser.where(),
				tabs: await browser.tabs().catch(() => []),
			});
			return;
		}

		/*
		 * The operator going to look at another tab, which needs no keyboard.
		 *
		 * It used to take the agent along, so it was gated behind the keyboard the way every other
		 * thing that moves the browser is — and what that looked like from the console was a row of
		 * tabs that would not open. Looking is not touching: this moves the picture and where the
		 * operator's own clicks land, and the agent goes on driving the tab it was driving.
		 */
		if (request.method === "POST" && path === "/tab") {
			const asked = (await body(request)) as { tab?: unknown };
			const wanted = typeof asked?.tab === "number" ? asked.tab : 0;
			if (!(await browser.watchTab(wanted))) {
				json(response, 404, { refused: `There is no tab ${wanted}.` });
				return;
			}
			keyboard.stillThere();
			json(response, 200, { url: browser.where() });
			return;
		}

		/*
		 * The address bar.
		 *
		 * Missing from the first version of this, which made the whole feature unusable for the one
		 * thing it exists for: an operator takes the keyboard on a blank page, and a blank page has
		 * nothing to click. There was no way to get to the sign-in form except to ask the agent to
		 * open it first, which is backwards — the agent asks for help precisely when it cannot.
		 */
		if (request.method === "POST" && path === "/open") {
			if (keyboard.holder !== "operator") {
				json(response, 409, { refused: refusedToOperator() });
				return;
			}
			const asked = (await body(request)) as { url?: unknown };
			const read = readUrl(typeof asked?.url === "string" ? asked.url : "");
			if ("refused" in read) {
				json(response, 400, read);
				return;
			}
			await browser.does({ verb: "open", url: read.url });
			keyboard.take();
			json(response, 200, { url: browser.where() });
			return;
		}

		/*
		 * Somebody is still there, said by a page that has seen them move.
		 *
		 * The lease used to be renewed by the frames themselves, which was fine while this was only
		 * ever watched in a window opened on purpose and wrong as soon as it lived in the console: the
		 * frames flow all day whether or not anybody is looking, so a keyboard taken once was held
		 * until the browser was closed — the agent's every verb refused, its turns spent saying so,
		 * and nothing on the screen suggesting the button was still down. What renews it now is a
		 * console that has seen a pointer move or a key pressed, and nothing else.
		 */
		if (request.method === "POST" && path === "/here") {
			json(response, 200, keyboard.stillThere());
			return;
		}

		if (request.method === "POST" && path === "/keyboard") {
			const asked = (await body(request)) as { hold?: unknown };
			json(response, 200, asked?.hold === true ? keyboard.take() : keyboard.release());
			return;
		}

		if (request.method === "POST" && path === "/input") {
			if (keyboard.holder !== "operator") {
				json(response, 409, { refused: refusedToOperator() });
				return;
			}
			const event = (await body(request)) as Record<string, unknown>;
			await operated(event);
			// Every event is proof somebody is there, which is what the lease is actually measuring.
			keyboard.stillThere();
			json(response, 200, keyboard.state());
			return;
		}

		if (request.method === "GET" && path === "/frames") {
			await frames(response);
			return;
		}

		json(response, 404, { refused: "nothing there" });
	})().catch(() => json(response, 500, { refused: "the screen failed" }));
});

async function operated(event: Record<string, unknown>): Promise<void> {
	const x = Number(event.x ?? 0);
	const y = Number(event.y ?? 0);
	if (event.kind === "down") await browser.pointer("mousePressed", x, y);
	else if (event.kind === "up") await browser.pointer("mouseReleased", x, y);
	else if (event.kind === "wheel") await browser.wheel(x, y, Number(event.deltaY ?? 0));
	else if (event.kind === "key" && typeof event.key === "string") await browser.typed(event.key);
}

/**
 * The picture, as a stream of JPEGs the browser decodes itself.
 *
 * `multipart/x-mixed-replace` is older than most of the web and is exactly this: each part replaces
 * the last one in the `<img>`. What it buys over a websocket is that nothing in the chain has to
 * understand it — not the plane's tunnel, not the door on the operator's machine, not the browser.
 *
 * Frames do not renew the keyboard's lease. They used to, which cost an afternoon: in a window
 * somebody opened on purpose a frame arriving is somebody watching, and in a panel that is part of
 * the console it is only the console being open. What says a person is there is `/here`.
 */
async function frames(response: http.ServerResponse): Promise<void> {
	const boundary = "squadframe";
	response.writeHead(200, {
		"content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
		"cache-control": "no-store",
		connection: "close",
	});

	/*
	 * Each frame ends with the boundary that opens the next one, rather than waiting for the next one
	 * to write it.
	 *
	 * This is the whole of why a still page showed nothing. A browser's multipart parser does not
	 * commit a part when its Content-Length is satisfied — it commits it when the next boundary
	 * arrives. Written the ordinary way, the last frame sent is always the one being held back, and
	 * on a page that is not moving the last frame is the only frame. What that looks like is a live
	 * view that is perfect while something on the page animates and empty the moment it settles,
	 * which is a bug that hides behind whatever site you happened to test it on.
	 */
	let opened = false;
	const send = (jpeg: string): void => {
		const bytes = Buffer.from(jpeg, "base64");
		if (!opened) {
			response.write(`--${boundary}\r\n`);
			opened = true;
		}
		response.write(`Content-Type: image/jpeg\r\n`);
		response.write(`Content-Length: ${bytes.byteLength}\r\n\r\n`);
		response.write(bytes);
		response.write(`\r\n--${boundary}\r\n`);
	};

	// One straight away, so the page is not blank until the browser next decides something changed.
	// A still page sends no frames at all, and a live view that starts empty reads as a broken one.
	send(await browser.frame());
	const stop = browser.watch(send);
	response.on("close", stop);
}

async function main(): Promise<void> {
	const egress = readEgress(process.env.SQUAD_EGRESS_PROXY);
	if (egress !== undefined) startForwarder(PROXY_PORT, egress);
	else process.stderr.write("screen: no egress proxy configured, the browser reaches nothing\n");

	// Fails closed and says so. A screen with no token cannot tell its own agent from anybody else's,
	// and the safe version of that is a door that refuses everyone rather than one that refuses
	// nobody — the operator's live view still works, so the screen is inspectable either way.
	if (TOKEN === undefined) {
		process.stderr.write("screen: no egress credential, so the agent's door refuses everything\n");
	}

	await browser.start();

	// The agent's door on the network it shares with the plane's other sandboxes, the operator's on
	// loopback. The asymmetry is the security property, and it is one line each.
	verbs.listen(VERB_PORT, "0.0.0.0");
	view.listen(VIEW_PORT, "127.0.0.1");
	process.stdout.write(`screen: ${AGENT_ID} up — verbs on ${VERB_PORT}, view on ${VIEW_PORT}\n`);
}

void main().catch((error: unknown) => {
	process.stderr.write(`screen: ${(error as Error).message}\n`);
	process.exit(1);
});
