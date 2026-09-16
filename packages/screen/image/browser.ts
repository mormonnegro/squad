import { spawn } from "node:child_process";
import { Cdp } from "./cdp.ts";
import {
	boxScript,
	OUTLINE_SCRIPT,
	type Outline,
	pageBriefly,
	pageForAgent,
	readOutline,
} from "./reading.ts";
import { type Asked, MOST_TABS, tooManyTabs } from "./verbs.ts";

/**
 * The size everything here agrees on.
 *
 * Fixed rather than whatever the browser felt like, because three separate things measure this
 * page: the screencast that sends it, the operator's mouse that lands on it, and the refs that say
 * where an element is. A viewport that changed under any of them would put clicks somewhere other
 * than where they were aimed, which is the kind of bug that looks like the site being broken.
 */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * What a click costs in time, which is the point of it costing anything.
 *
 * A hand cannot press and release in zero milliseconds and a pointer cannot arrive without crossing
 * the distance, and a site that measures either of those is measuring something true. Jittered
 * because a constant is a fingerprint too: the same interval, exact to the millisecond, on every
 * click for ever is a stranger signal than a fast one.
 */
const MOVE_STEPS = 6;
const MOVE_STEP_MS = 12;
const DOWN_MS = 55;
const DOWN_JITTER_MS = 70;

const DEBUG_PORT = Number(process.env.SQUAD_SCREEN_DEBUG_PORT ?? 9222);
const PROFILE = process.env.SQUAD_SCREEN_PROFILE ?? "/home/screen/profile";
const PROXY = `http://127.0.0.1:${process.env.SQUAD_SCREEN_PROXY_PORT ?? 7182}`;

/**
 * What the browser says it is, and where it says it is from.
 *
 * Not a disguise. This is a real Chromium, driven by a person's agent on their behalf, and left to
 * itself it announces `HeadlessChrome` in its user agent and in its client hints — a word half the
 * web treats as a reason to refuse before looking at anything else. What it is is Chromium; what it
 * is not is a different browser, and nothing here claims to be one.
 *
 * The language and the time zone are the other half of the same honesty: a browser buying a flight
 * from Buenos Aires that says `en-US` and answers in UTC is not lying about being a browser, but it
 * is inconsistent with everything else about the connection, and inconsistency is what these systems
 * actually measure. Both come from the deployment, because the plane cannot know where its operator
 * is and guessing would be worse than the default.
 */
/**
 * A plain list — `es-AR,es,en` — and not a weighted one.
 *
 * Chromium takes this string for both the header and `navigator.languages`, and given the weighted
 * form it splits on commas and reports `es;q=0.9` as a language a person reads. Which is a stranger
 * thing for a page to find than any of what this setting is here to fix.
 */
const LANGUAGES = (process.env.SQUAD_SCREEN_LANG ?? "en-US,en")
	.split(",")
	.map((one) => one.split(";")[0]?.trim() ?? "")
	.filter((one) => one !== "")
	.join(",");
const TIMEZONE = process.env.TZ ?? "";

/**
 * Where the browser waits, served by this program on the operator's own door.
 *
 * Loopback, which Chromium reaches directly: its proxy bypasses localhost, so this one page is the
 * only thing it ever loads that does not go out through the egress proxy — and there is nothing out
 * there to go and get.
 */
export const START_PAGE = `http://127.0.0.1:${process.env.SQUAD_SCREEN_VIEW_PORT ?? 7180}/start`;

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

/**
 * An address as it should be read, which for the browser's own start page is no address at all.
 *
 * That page is this program's, served on loopback inside this container, and its address is a
 * number nobody typed and nobody can use. Shown in the bar it is noise that looks like somewhere
 * the agent went; left empty, the bar says what is true — nothing is open.
 */
function shown(url: string): string {
	return url === START_PAGE ? "" : url;
}

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
	/**
	 * The page being driven, which is not always the page it started on.
	 *
	 * Half the web opens a new tab to check out in. Attached once at startup, this browser went on
	 * driving the page behind the new one: the agent clicked, read, clicked again, and nothing it did
	 * changed anything it could see — which reads, from a transcript, exactly like a site that has
	 * blocked you.
	 */
	#target = "";
	/**
	 * The tab being watched, which is not always the tab being driven.
	 *
	 * Two of them because looking is not touching. An operator who wants to see what is on the other
	 * tab should not have to take the keyboard to look, and looking should not move the agent off the
	 * page it is halfway through — which is the whole thing tabs were added to protect. So the
	 * picture, the address bar and the operator's own clicks follow this one, the agent's verbs follow
	 * the other, and the two are the same until somebody says otherwise.
	 */
	#seen = "";
	#seenSession = "";
	#frame: string | undefined;
	/**
	 * Everybody watching, which is more than one more often than it looks.
	 *
	 * A set rather than the one slot this used to be, because a screen is watched from two places at
	 * once as a matter of course: the frame in the console, and the window somebody opened beside it
	 * to see the page at its own size. With one slot the second viewer to arrive took the frames and
	 * the first went still — and worse, the first to leave stopped the screencast for whoever was
	 * left, with nothing to start it again. What that looks like is a live view that draws its
	 * header, polls its state, and shows a black rectangle forever.
	 */
	readonly #watching = new Set<(jpeg: string) => void>();
	/**
	 * Where the browser is, kept from the navigations rather than asked for.
	 *
	 * The live view shows it in an address bar and asks for the state every couple of seconds, and a
	 * round trip into the page for a string the browser already told us would be a question asked of
	 * every viewer, forever, for something that changes when somebody clicks a link.
	 */
	#where = START_PAGE;
	/** One attachment at a time, because the events that ask for one arrive in bursts. */
	#following: Promise<void> = Promise.resolve();
	/**
	 * The tabs, in the order they were opened, which is the order they are numbered in.
	 *
	 * Kept rather than asked for, because the numbers have to mean the same thing between one call
	 * and the next: an agent told that its search is tab 1 has to find its search at tab 1 a minute
	 * later, and the order the debugging protocol lists targets in is nobody's promise.
	 */
	#knownTabs: string[] = [];
	/**
	 * Where the pointer is, so that the next click starts from where the last one left it.
	 *
	 * A page watching the mouse sees a journey rather than a teleport, which is both what a hover
	 * handler needs and what a site deciding whether this is a person is looking at.
	 */
	#pointer: { x: number; y: number } = { x: 0, y: 0 };

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
				`--lang=${LANGUAGES.split(",")[0]}`,
				`--accept-lang=${LANGUAGES}`,
				// A page of our own rather than `about:blank`, which is a white rectangle the size of a
				// browser — and a white rectangle is what a page that failed to load looks like. It was
				// the first thing anybody saw of a screen they had just turned on.
				START_PAGE,
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
		// Told about tabs as they come and go, which is what lets a checkout that opens one be
		// followed rather than watched from behind.
		await cdp.send("Target.setDiscoverTargets", { discover: true });
		cdp.on((event) => {
			const info = event.params.targetInfo as
				| { targetId?: string; type?: string; url?: string; title?: string }
				| undefined;

			/*
			 * A tab that has just been opened, which is the only kind worth going to on its own.
			 *
			 * Created and changed used to be treated the same, and that was wrong in a way that only
			 * shows up once there is more than one tab: `targetInfoChanged` fires every time any page
			 * settles its title or its address, so a tab loading in the background would take the
			 * agent off the page it was working on. A click that opens a tab brings it to the front,
			 * the way a browser does; a background tab finishing its business does not.
			 */
			if (event.method === "Target.targetCreated") {
				if (info?.type !== "page" || info.targetId === undefined) return;
				this.#knownTabs.push(info.targetId);
				void this.#follow(info.targetId, info.url);
				return;
			}

			if (event.method === "Target.targetInfoChanged") {
				if (info?.type !== "page" || info.targetId === undefined) return;
				if (!this.#knownTabs.includes(info.targetId)) this.#knownTabs.push(info.targetId);
				if (info.targetId === this.#target && typeof info.url === "string" && info.url !== "") {
					this.#where = info.url;
				}
				return;
			}

			if (event.method === "Target.targetDestroyed") {
				const gone = event.params.targetId;
				if (typeof gone === "string") {
					this.#knownTabs = this.#knownTabs.filter((one) => one !== gone);
				}
				if (gone !== this.#target) return;
				// Whatever is left, which after a checkout tab is closed is the page it was opened from.
				void this.#lastPage();
			}
		});

		const { targetInfos } = await cdp.send<{
			targetInfos: readonly { targetId: string; type: string; url?: string }[];
		}>("Target.getTargets");
		const pages = targetInfos.filter((target) => target.type === "page");
		this.#knownTabs = pages.map((page) => page.targetId);
		const page = pages[pages.length - 1];
		if (page === undefined) throw new Error("chromium opened no page to drive");
		await this.#follow(page.targetId, page.url);

		cdp.on((event) => {
			if (event.method === "Page.frameNavigated") {
				const frame = event.params.frame as { url?: string; parentId?: string } | undefined;
				// The top frame of the tab being watched. An advert in an iframe navigating is not the
				// browser going somewhere, and neither is a tab nobody is looking at.
				if (event.sessionId !== this.#seenSession) return;
				if (frame?.parentId === undefined && typeof frame?.url === "string") {
					this.#where = frame.url;
				}
				return;
			}
			if (event.method !== "Page.screencastFrame") return;
			const data = event.params.data;
			const ack = event.params.sessionId;
			if (typeof data === "string") {
				this.#frame = data;
				for (const watcher of this.#watching) watcher(data);
			}
			// Unacknowledged frames stop the stream after a handful, and a live view that freezes after
			// four frames is worse than one that never started, because it looks like the page froze.
			if (typeof ack === "number") {
				void cdp.send("Page.screencastFrameAck", { sessionId: ack }, this.#session).catch(() => {});
			}
		});
	}

	/**
	 * Drives a different page, and takes the picture with it.
	 *
	 * Serialised through a promise because the events that call it arrive in bursts — a new tab
	 * announces itself as created and then again as its title and address settle, and two attachments
	 * racing would leave the screencast running on a session nobody is reading.
	 */
	async #follow(targetId: string, url?: string): Promise<void> {
		this.#following = this.#following.catch(() => {}).then(() => this.#followed(targetId, url));
		return this.#following;
	}

	async #followed(targetId: string, url?: string): Promise<void> {
		if (this.#target === targetId) return;
		const cdp = this.#need();
		const was = this.#session;
		const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		if (was !== "" && this.#watching.size > 0) {
			await cdp.send("Page.stopScreencast", {}, was).catch(() => {});
		}
		this.#target = targetId;
		this.#session = sessionId;
		// The agent moving takes the watcher along: what somebody watching a screen wants to see is
		// what the agent is doing, unless they have just said otherwise by going to a tab themselves.
		await this.#see(targetId, sessionId, url);
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Runtime.enable", {}, sessionId);
		await cdp.send(
			"Emulation.setDeviceMetricsOverride",
			{
				...VIEWPORT,
				deviceScaleFactor: 1,
				mobile: false,
				/*
				 * The display this window is on, said as well as the window, because leaving it out left
				 * the two contradicting each other.
				 *
				 * Overriding the metrics moves `innerWidth` and leaves `screen.width` at the headless
				 * default of 800×600 — so the page saw a 1280×800 window open on an 800×600 display, which
				 * is not a thing that can happen on any machine. A window larger than its own screen is one
				 * of the first things a site checks when it is deciding whether a visitor is a person, and
				 * it was our own override putting it there.
				 *
				 * The same numbers, which is what is actually true here: there is no desktop in this
				 * container, so the window is the display.
				 */
				screenWidth: VIEWPORT.width,
				screenHeight: VIEWPORT.height,
				positionX: 0,
				positionY: 0,
			},
			sessionId,
		);
		await this.#presentAs(sessionId);
	}

	/**
	 * Says what this browser is, per tab, because that is the only place it can be said.
	 *
	 * Per session rather than once at launch: `--user-agent` reaches `navigator.userAgent` and leaves
	 * the client hints — `Sec-CH-UA` — saying `HeadlessChrome` underneath, which is worse than saying
	 * it in one place, because a header and a script disagreeing is itself the signal. So both are set
	 * together, here, for every tab as it is attached.
	 *
	 * The version comes off the browser rather than out of a constant, so this keeps telling the truth
	 * through an image rebuild that moves Chromium.
	 */
	async #presentAs(sessionId: string): Promise<void> {
		const cdp = this.#need();
		const { result } = await cdp
			.send<{ result: { value?: string } }>(
				"Runtime.evaluate",
				{ expression: "navigator.userAgent", returnByValue: true },
				sessionId,
			)
			.catch(() => ({ result: { value: undefined } }));
		const said = result.value ?? "";
		// The one word that is not true of this browser: it is Chromium, and it is headless, and only
		// the first of those is something a website is entitled to refuse.
		const userAgent = said.replace("HeadlessChrome/", "Chrome/");
		const version = /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? "";

		await cdp
			.send(
				"Network.setUserAgentOverride",
				{
					userAgent,
					acceptLanguage: LANGUAGES,
					userAgentMetadata: {
						// Chromium, which is what it is. The brand list a headless build ships says
						// HeadlessChrome beside it, and that is the entry being dropped rather than replaced.
						brands: [
							{ brand: "Chromium", version },
							{ brand: "Not_A Brand", version: "24" },
						],
						fullVersion: version,
						platform: "Linux",
						platformVersion: "",
						architecture: "x86",
						model: "",
						mobile: false,
					},
				},
				sessionId,
			)
			.catch(() => undefined);

		if (TIMEZONE !== "") {
			await cdp
				.send("Emulation.setTimezoneOverride", { timezoneId: TIMEZONE }, sessionId)
				.catch(() => undefined);
		}
	}

	/** Watches a tab: the picture, the address bar, and wherever the operator's own clicks land. */
	async #see(targetId: string, sessionId: string, url?: string): Promise<void> {
		if (this.#seen === targetId) return;
		const cdp = this.#need();
		if (this.#seenSession !== "" && this.#watching.size > 0) {
			await cdp.send("Page.stopScreencast", {}, this.#seenSession).catch(() => {});
		}
		this.#seen = targetId;
		this.#seenSession = sessionId;
		if (typeof url === "string" && url !== "") this.#where = url;
		if (this.#watching.size > 0) await this.#cast();
	}

	/**
	 * The operator going to a tab to look at it, which moves nothing the agent is doing.
	 *
	 * Its own way in rather than the agent's, and that is the point: switching used to be the same
	 * act for both, so the console disabled it unless you held the keyboard — and what that looked
	 * like was a row of tabs that would not open.
	 */
	async watchTab(number: number): Promise<boolean> {
		const wanted = (await this.tabs())[number - 1];
		const id = this.#knownTabs[number - 1];
		if (wanted === undefined || id === undefined) return false;
		const { sessionId } = await this.#need().send<{ sessionId: string }>("Target.attachToTarget", {
			targetId: id,
			flatten: true,
		});
		await this.#see(id, sessionId, wanted.url);
		return true;
	}

	/**
	 * The tabs, as the agent and the operator both see them.
	 *
	 * The title and address come from the browser rather than from anything remembered here, because
	 * a tab that has navigated since it was opened is still that tab and is no longer that page.
	 */
	async tabs(): Promise<
		readonly { number: number; title: string; url: string; here: boolean; seen: boolean }[]
	> {
		const { targetInfos } = await this.#need().send<{
			targetInfos: readonly { targetId: string; type: string; url?: string; title?: string }[];
		}>("Target.getTargets");
		const pages = new Map(
			targetInfos.filter((one) => one.type === "page").map((one) => [one.targetId, one]),
		);
		// The kept order, minus whatever has gone, plus anything that appeared without an event.
		const order = this.#knownTabs.filter((id) => pages.has(id));
		for (const id of pages.keys()) if (!order.includes(id)) order.push(id);
		this.#knownTabs = order;
		return order.map((id, at) => ({
			number: at + 1,
			title: pages.get(id)?.title ?? "",
			url: shown(pages.get(id)?.url ?? ""),
			// What the agent is driving, which is what its own listing means by "here".
			here: id === this.#target,
			// And what is on the screen, which is the same tab until somebody goes to look at another.
			seen: id === this.#seen,
		}));
	}

	/** A page opened beside the one being worked on, rather than instead of it. */
	async openTab(url: string): Promise<void> {
		const { targetId } = await this.#need().send<{ targetId: string }>("Target.createTarget", {
			url,
		});
		if (!this.#knownTabs.includes(targetId)) this.#knownTabs.push(targetId);
		await this.#follow(targetId, url);
		await this.#settled();
	}

	/** Back to one of them, by the number it was listed as. Answers whether there was one. */
	async toTab(number: number): Promise<boolean> {
		const wanted = (await this.tabs())[number - 1];
		const id = this.#knownTabs[number - 1];
		if (wanted === undefined || id === undefined) return false;
		await this.#follow(id, wanted.url);
		return true;
	}

	/** Closes one. The browser is left with at least one page, because a browser with none is gone. */
	async closeTab(number: number): Promise<boolean> {
		const open = await this.tabs();
		if (open.length <= 1) return false;
		const id = this.#knownTabs[number - 1];
		if (id === undefined) return false;
		await this.#need().send("Target.closeTarget", { targetId: id });
		this.#knownTabs = this.#knownTabs.filter((one) => one !== id);
		// Chrome answers the close before the tab is gone, and the list is read from the browser
		// rather than remembered — so asked a moment too early it finds the tab still open and puts
		// it back, and what the agent sees is a tab it just closed still sitting there.
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && (await this.#pageIds()).includes(id)) await sleep(100);
		if (id === this.#target) await this.#lastPage();
		return true;
	}

	async #pageIds(): Promise<readonly string[]> {
		const { targetInfos } = await this.#need().send<{
			targetInfos: readonly { targetId: string; type: string }[];
		}>("Target.getTargets");
		return targetInfos.filter((one) => one.type === "page").map((one) => one.targetId);
	}

	/** Back to whichever page is left, after the one being driven was closed. */
	async #lastPage(): Promise<void> {
		const { targetInfos } = await this.#need().send<{
			targetInfos: readonly { targetId: string; type: string; url?: string }[];
		}>("Target.getTargets");
		const pages = targetInfos.filter((target) => target.type === "page");
		const page = pages[pages.length - 1];
		if (page !== undefined) await this.#follow(page.targetId, page.url);
	}

	#cast(): Promise<unknown> {
		return this.#need()
			.send(
				"Page.startScreencast",
				{
					format: "jpeg",
					quality: 60,
					maxWidth: VIEWPORT.width,
					maxHeight: VIEWPORT.height,
					everyNthFrame: 1,
				},
				this.#seenSession,
			)
			.catch(() => undefined);
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

	/**
	 * A click, with the pointer arriving at the thing before it presses it.
	 *
	 * It used to be two events at one instant and nothing before them: no movement anywhere on the
	 * page, press and release in the same millisecond, at coordinates the pointer had never been to.
	 * That is wrong twice over.
	 *
	 * It is wrong about the web, first. A widget that arms on hover is never armed — the element gets
	 * no `mousemove`, no `mouseover`, no `mouseenter` — and the click lands on something that had not
	 * finished becoming clickable. That is a whole class of "I pressed it and nothing happened".
	 *
	 * And it is wrong about who is driving. A ticketing site turned this browser away and printed its
	 * reasons, the first of which was that the visitor clicks at a superhuman speed. It was right: a
	 * hand cannot press and release a mouse button in zero milliseconds, and a pointer cannot arrive
	 * somewhere without crossing the distance. Neither of those is a disguise — the operator watching
	 * this screen is a person, and what got refused was their browser.
	 */
	async #clickAt(x: number, y: number): Promise<void> {
		const cdp = this.#need();
		const to = { x: Math.round(x), y: Math.round(y) };
		await this.#moveTo(to.x, to.y);
		const where = { ...to, button: "left", clickCount: 1 };
		await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...where }, this.#session);
		// How long a finger is down. Short, and never the same twice: a constant is a fingerprint of
		// its own, and this one would be exact to the millisecond on every click for ever.
		await sleep(DOWN_MS + Math.floor(Math.random() * DOWN_JITTER_MS));
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...where }, this.#session);
		this.#pointer = to;
	}

	/**
	 * The pointer crossing the page, in the few steps a page needs to see to believe it moved.
	 *
	 * Not a simulation of a human arm — a straight line in half a dozen hops, which is enough for the
	 * hover handlers to fire in order and enough that the journey took a plausible moment. Anything
	 * more elaborate would be spending a page load's worth of time drawing a curve nobody sees.
	 */
	async #moveTo(x: number, y: number): Promise<void> {
		const cdp = this.#need();
		const from = this.#pointer;
		for (let step = 1; step <= MOVE_STEPS; step++) {
			const part = step / MOVE_STEPS;
			await cdp.send(
				"Input.dispatchMouseEvent",
				{
					type: "mouseMoved",
					x: Math.round(from.x + (x - from.x) * part),
					y: Math.round(from.y + (y - from.y) * part),
				},
				this.#session,
			);
			await sleep(MOVE_STEP_MS);
		}
		this.#pointer = { x, y };
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

	async #press(key: string, session = this.#session): Promise<void> {
		const cdp = this.#need();
		const code = KEY_CODES[key] ?? 0;
		const common = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
		await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common }, session);
		await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, session);
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
			// The same page as data, for whatever is choosing a ref on the agent's behalf. Nothing
			// reads this: it is parsed.
			case "outline":
				return { text: JSON.stringify(await this.#outline()) };
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
				return { text: said(await this.#outline(), asked.brief === true) };
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
				return { text: said(await this.#outline(), asked.brief === true) };
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
			case "tabs": {
				const open = await this.tabs();
				return {
					text: [
						"Tabs open:",
						...open.map(
							(one) =>
								`[${one.number}]${one.here ? " (you are here)" : ""} ${one.title || "(untitled)"} — ${one.url}`,
						),
						"",
						"tab_open keeps the page you are on and opens another beside it. tab goes back to one.",
					].join("\n"),
				};
			}
			case "tab_open": {
				// Counted here rather than trusted to the description above it: what stops a browser
				// from filling a machine is a number, not advice.
				const already = await this.tabs();
				if (already.length >= MOST_TABS) return { text: tooManyTabs(already) };
				await this.openTab(asked.url ?? "about:blank");
				const outline = await this.#outline();
				const now = await this.tabs();
				const from = now.find((one) => one.here === false && one.seen === false) ?? now[0];
				return {
					text: [
						`Opened in a new tab. The page you were on is still where you left it, at tab ${from?.number ?? 1}.`,
						"",
						`Close this one with screen_tab_close as soon as you have what you came for. ${now.length} of ${MOST_TABS} tabs are open, and every one of them is a whole page held in memory.`,
						"",
						pageForAgent(outline),
					].join("\n"),
				};
			}
			case "tab": {
				if (!(await this.toTab(asked.tab ?? 0))) {
					return { text: `There is no tab ${asked.tab}. Ask for tabs to see which there are.` };
				}
				return { text: pageForAgent(await this.#outline()) };
			}
			case "tab_close": {
				if (!(await this.closeTab(asked.tab ?? 0))) {
					return {
						text: `Nothing closed. Either there is no tab ${asked.tab}, or it is the only one open — a browser with no pages is a browser that has gone.`,
					};
				}
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

	/** Where the browser is, for the address bar on the operator's view. */
	where(): string {
		return shown(this.#where);
	}

	/** The last frame the browser sent, for a viewer that has just arrived mid-stream. */
	async frame(): Promise<string> {
		if (this.#frame !== undefined) return this.#frame;
		const { data } = await this.#need().send<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "jpeg", quality: 70 },
			this.#seenSession,
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
		// Started on every arrival and stopped only when the last viewer goes.
		//
		// Asked for again rather than only when the set was empty, because "the set is not empty" is
		// not the same as "the screencast is running": a viewer whose connection died without its
		// close being noticed leaves a name in the set, and the next person to open the screen then
		// gets one still frame and nothing after it. Starting twice costs a keyframe; not starting
		// costs the feature.
		void this.#cast();
		this.#watching.add(onFrame);
		return () => {
			if (!this.#watching.delete(onFrame) || this.#watching.size > 0) return;
			void this.#need()
				.send("Page.stopScreencast", {}, this.#session)
				.catch(() => {});
		};
	}

	/**
	 * The operator's mouse, in page coordinates the viewer has already scaled.
	 *
	 * On the tab they are looking at rather than the one the agent is driving, because those can
	 * differ now and what somebody clicks is what they can see.
	 */
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
			this.#seenSession,
		);
	}

	async wheel(x: number, y: number, deltaY: number): Promise<void> {
		await this.#need().send(
			"Input.dispatchMouseEvent",
			{ type: "mouseWheel", x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY },
			this.#seenSession,
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
			await this.#need().send("Input.insertText", { text: key }, this.#seenSession);
			return;
		}
		await this.#press(key, this.#seenSession);
	}
}

/** The page as the caller asked for it: the whole reading, or it without the numbers. */
function said(outline: Outline, brief: boolean): string {
	return brief ? pageBriefly(outline) : pageForAgent(outline);
}
