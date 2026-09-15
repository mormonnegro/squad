import { spawn } from "node:child_process";
import { Cdp } from "./cdp.ts";
import { boxScript, OUTLINE_SCRIPT, type Outline, pageForAgent, readOutline } from "./reading.ts";
import type { Asked } from "./verbs.ts";

/**
 * The size everything here agrees on.
 *
 * Fixed rather than whatever the browser felt like, because three separate things measure this
 * page: the screencast that sends it, the operator's mouse that lands on it, and the refs that say
 * where an element is. A viewport that changed under any of them would put clicks somewhere other
 * than where they were aimed, which is the kind of bug that looks like the site being broken.
 */
export const VIEWPORT = { width: 1280, height: 800 } as const;

const DEBUG_PORT = Number(process.env.SQUAD_SCREEN_DEBUG_PORT ?? 9222);
const PROFILE = process.env.SQUAD_SCREEN_PROFILE ?? "/home/screen/profile";
const PROXY = `http://127.0.0.1:${process.env.SQUAD_SCREEN_PROXY_PORT ?? 7182}`;

/** What a verb did, in the two shapes a tool result can take. */
export interface Did {
	readonly text: string;
	/** Base64 PNG, only ever from `look`. */
	readonly image?: string;
}

const KEY_CODES: Readonly<Record<string, number>> = {
	Enter: 13,
	Tab: 9,
	Escape: 27,
	Backspace: 8,
	Delete: 46,
	ArrowUp: 38,
	ArrowDown: 40,
	ArrowLeft: 37,
	ArrowRight: 39,
	PageUp: 33,
	PageDown: 34,
	Home: 36,
	End: 35,
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chromium, and the one connection to it.
 *
 * Everything that touches the browser goes through here, which is what makes the verb list a
 * boundary rather than a convention: the door the agent knocks on holds no socket of its own.
 */
export class Browser {
	#cdp: Cdp | undefined;
	#session = "";
	#frame: string | undefined;
	#onFrame: ((jpeg: string) => void) | undefined;
	#casting = false;

	/** Starts the browser and waits for it to answer, which is the slowest thing this container does. */
	async start(): Promise<void> {
		const child = spawn(
			"/usr/bin/chromium",
			[
				"--headless=new",
				`--remote-debugging-port=${DEBUG_PORT}`,
				// Loopback and not a hostname: the debugging protocol is the whole browser, and this
				// container shares a network with every agent on the plane.
				"--remote-debugging-address=127.0.0.1",
				`--user-data-dir=${PROFILE}`,
				// The container is the boundary here. Chromium's own sandbox needs privileges this
				// container drops on purpose, and a browser that will not start is not a safer one.
				"--no-sandbox",
				"--disable-gpu",
				// Fatal only. In a container with no dbus, no keyring and no display, Chromium writes several
				// hundred ERROR lines about services that are not there and are not coming — and this is the
				// log an operator reads when a screen will not start, so it has to be readable.
				"--log-level=3",
				`--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
				// Its own loopback rather than the egress proxy directly, because Chromium drops the
				// credential out of a proxy URL and then asks a person for it. See the forwarder.
				`--proxy-server=${PROXY}`,
				"--no-first-run",
				"--no-default-browser-check",
				// Without these two, Chromium looks for a system keyring that is not in this container
				// and spends its startup failing to find one.
				"--password-store=basic",
				"--use-mock-keychain",
				// The flag that decides whether a sign-in page treats this as a robot. It is not a
				// disguise — the browser is one — but the operator signing in here is a person, and a
				// login refused for automation is refused to them.
				"--disable-blink-features=AutomationControlled",
				"about:blank",
			],
			{ stdio: ["ignore", "inherit", "inherit"] },
		);
		child.on("exit", (code) => {
			process.stderr.write(`screen: chromium exited with ${code}\n`);
			process.exit(1);
		});

		const url = await this.#debuggerUrl();
		this.#cdp = await Cdp.open(url);
		await this.#attach();
	}

	/**
	 * Waits for the debugging port to answer, and gives up loudly rather than quietly.
	 *
	 * Chromium takes a couple of seconds to bind on a first run with a cold profile, and longer on a
	 * Raspberry Pi. A container that failed here and kept running would be a screen whose link opens
	 * onto nothing, which is a thing to read in a log rather than to discover from a blank page.
	 */
	async #debuggerUrl(): Promise<string> {
		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
				const body = (await response.json()) as { webSocketDebuggerUrl?: string };
				if (typeof body.webSocketDebuggerUrl === "string") return body.webSocketDebuggerUrl;
			} catch {
				// Not listening yet, which is the expected answer for the first second or two.
			}
			if (Date.now() > deadline) throw new Error("chromium never opened its debugging port");
			await sleep(200);
		}
	}

	async #attach(): Promise<void> {
		const cdp = this.#need();
		const { targetInfos } = await cdp.send<{
			targetInfos: readonly { targetId: string; type: string }[];
		}>("Target.getTargets");
		const page = targetInfos.find((target) => target.type === "page");
		if (page === undefined) throw new Error("chromium opened no page to drive");
		const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
			targetId: page.targetId,
			flatten: true,
		});
		this.#session = sessionId;
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Runtime.enable", {}, sessionId);
		await cdp.send(
			"Emulation.setDeviceMetricsOverride",
			{ ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
			sessionId,
		);
		cdp.on((event) => {
			if (event.method !== "Page.screencastFrame") return;
			const data = event.params.data;
			const ack = event.params.sessionId;
			if (typeof data === "string") {
				this.#frame = data;
				this.#onFrame?.(data);
			}
			// Unacknowledged frames stop the stream after a handful, and a live view that freezes after
			// four frames is worse than one that never started, because it looks like the page froze.
			if (typeof ack === "number") {
				void cdp.send("Page.screencastFrameAck", { sessionId: ack }, this.#session).catch(() => {});
			}
		});
	}

	#need(): Cdp {
		if (this.#cdp === undefined) throw new Error("the browser is not up yet");
		return this.#cdp;
	}

	async #evaluate(expression: string): Promise<unknown> {
		const { result } = await this.#need().send<{ result: { value?: unknown } }>(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: true },
			this.#session,
		);
		return result.value;
	}

	async #outline(): Promise<Outline> {
		const raw = await this.#evaluate(OUTLINE_SCRIPT);
		const read = readOutline(raw);
		if (read === undefined) throw new Error("the page would not describe itself");
		return read;
	}

	async #clickAt(x: number, y: number): Promise<void> {
		const cdp = this.#need();
		const where = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
		await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...where }, this.#session);
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...where }, this.#session);
	}

	/**
	 * Finds a numbered element and clicks where it actually is.
	 *
	 * A real mouse event at real coordinates rather than the element's own `click()`, because half
	 * the web checks whether the event came from a person. A synthetic click is how an agent ends up
	 * reporting that it pressed the button and nothing happened.
	 */
	async #clickRef(ref: number): Promise<boolean> {
		const raw = await this.#evaluate(boxScript(ref));
		if (typeof raw !== "string" || raw === "null") return false;
		const box = JSON.parse(raw) as { x: number; y: number };
		await this.#clickAt(box.x, box.y);
		return true;
	}

	async #press(key: string): Promise<void> {
		const cdp = this.#need();
		const code = KEY_CODES[key] ?? 0;
		const common = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
		await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common }, this.#session);
		await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, this.#session);
	}

	/** Everything the agent asked for, once the door has decided it may ask for it. */
	async does(asked: Asked): Promise<Did> {
		switch (asked.verb) {
			case "open": {
				// Listening before asking, because a page served from cache can load between the call and
				// the listener, and a wait that began after that waits out its whole timeout for an event
				// that already happened.
				const load = this.#loading();
				await this.#need().send("Page.navigate", { url: asked.url }, this.#session);
				await this.#settled(load);
				const outline = await this.#outline();
				return { text: pageForAgent(outline) };
			}
			case "read":
				return { text: pageForAgent(await this.#outline()) };
			case "look": {
				const { data } = await this.#need().send<{ data: string }>(
					"Page.captureScreenshot",
					{ format: "png" },
					this.#session,
				);
				const outline = await this.#outline();
				return {
					text: `${outline.title || "(untitled)"} — ${outline.url}`,
					image: data,
				};
			}
			case "click": {
				const ref = asked.ref ?? 0;
				const load = this.#loading();
				if (!(await this.#clickRef(ref))) {
					return {
						text: `There is no [${ref}] on this page any more. The page has moved on since that read — read it again and use the numbers that come back.`,
					};
				}
				await this.#settled(load);
				return { text: pageForAgent(await this.#outline()) };
			}
			case "type": {
				if (asked.ref !== undefined && !(await this.#clickRef(asked.ref))) {
					return { text: `There is no [${asked.ref}] on this page any more. Read it again.` };
				}
				await this.#need().send("Input.insertText", { text: asked.text ?? "" }, this.#session);
				if (asked.enter === true) {
					await this.#press("Enter");
					await this.#settled();
				}
				return { text: pageForAgent(await this.#outline()) };
			}
			case "key": {
				await this.#press(asked.key ?? "Enter");
				await this.#settled();
				return { text: pageForAgent(await this.#outline()) };
			}
			case "scroll": {
				const by =
					asked.to === "top"
						? "window.scrollTo(0, 0)"
						: asked.to === "bottom"
							? "window.scrollTo(0, document.body.scrollHeight)"
							: `window.scrollBy(0, ${asked.to === "up" ? -700 : 700})`;
				await this.#evaluate(`(() => { ${by}; return "done"; })()`);
				await sleep(200);
				return { text: pageForAgent(await this.#outline()) };
			}
			case "back": {
				const history = await this.#need().send<{
					currentIndex: number;
					entries: readonly { id: number }[];
				}>("Page.getNavigationHistory", {}, this.#session);
				const previous = history.entries[history.currentIndex - 1];
				if (previous === undefined) return { text: "There is nothing behind this page." };
				await this.#need().send(
					"Page.navigateToHistoryEntry",
					{ entryId: previous.id },
					this.#session,
				);
				await this.#settled();
				return { text: pageForAgent(await this.#outline()) };
			}
			case "ask":
				// Handled by the door, which is where the note is kept. Here so the switch is total.
				return { text: "asked" };
		}
	}

	/**
	 * Long enough for a click to have become a page, short enough not to be the reason a turn is slow.
	 *
	 * Waiting on the load event alone is wrong on most of the web now: a single-page application
	 * fires it once and then changes everything afterwards without firing it again. So this waits for
	 * the load if one is coming and settles for a pause if it is not.
	 */
	#loading(): Promise<void> {
		return new Promise<void>((resolve) => {
			const stop = this.#need().on((event) => {
				if (event.method !== "Page.loadEventFired") return;
				stop();
				resolve();
			});
			// Resolved rather than rejected when it never comes, because for most of the web it never
			// does: a click that changed the page without navigating fires nothing, and refusing the
			// verb for that would refuse it on every application written in the last ten years.
			setTimeout(() => {
				stop();
				resolve();
			}, 8_000);
		});
	}

	async #settled(load?: Promise<void>): Promise<void> {
		await (load ?? this.#loading());
		await sleep(400);
	}

	/** The last frame the browser sent, for a viewer that has just arrived mid-stream. */
	async frame(): Promise<string> {
		if (this.#frame !== undefined) return this.#frame;
		const { data } = await this.#need().send<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "jpeg", quality: 70 },
			this.#session,
		);
		return data;
	}

	/**
	 * Starts sending frames, and stops when the last viewer leaves.
	 *
	 * Stopping matters more than it looks: a screencast nobody is watching is a browser encoding a
	 * JPEG of every animation frame on the page, forever, on a machine that is also running agents.
	 */
	watch(onFrame: (jpeg: string) => void): () => void {
		this.#onFrame = onFrame;
		if (!this.#casting) {
			this.#casting = true;
			void this.#need()
				.send(
					"Page.startScreencast",
					{
						format: "jpeg",
						quality: 60,
						maxWidth: VIEWPORT.width,
						maxHeight: VIEWPORT.height,
						everyNthFrame: 1,
					},
					this.#session,
				)
				.catch(() => {});
		}
		return () => {
			if (this.#onFrame !== onFrame) return;
			this.#onFrame = undefined;
			this.#casting = false;
			void this.#need()
				.send("Page.stopScreencast", {}, this.#session)
				.catch(() => {});
		};
	}

	/** The operator's mouse, in page coordinates the viewer has already scaled. */
	async pointer(type: string, x: number, y: number): Promise<void> {
		const cdp = this.#need();
		await cdp.send(
			"Input.dispatchMouseEvent",
			{
				type,
				x: Math.round(x),
				y: Math.round(y),
				...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
			},
			this.#session,
		);
	}

	async wheel(x: number, y: number, deltaY: number): Promise<void> {
		await this.#need().send(
			"Input.dispatchMouseEvent",
			{ type: "mouseWheel", x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY },
			this.#session,
		);
	}

	/**
	 * The operator's keyboard.
	 *
	 * Text goes in as text and named keys go in as keys, which is the same split the agent's verbs
	 * make, for the same reason: what a person types into a password field is a string, and what
	 * they press to submit it is not.
	 */
	async typed(key: string): Promise<void> {
		if (key.length === 1) {
			await this.#need().send("Input.insertText", { text: key }, this.#session);
			return;
		}
		await this.#press(key);
	}
}
