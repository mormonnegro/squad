import type { AgentSummary } from "@squad/control-plane";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useServedAt } from "./served.tsx";
import { Spin } from "./spin.tsx";

/**
 * Where an agent's browser is watched from, copied here because the browser cannot import the
 * plane's own packages: the one that names this number reaches for node:http on its first line.
 * A test in a node environment holds both and refuses to let the two drift.
 */
export const SCREEN_VIEW_PORT = 7180;

/**
 * Whether this agent has a browser right now.
 *
 * Read off the ports it is serving rather than asked for separately, because that is what the
 * plane already publishes and what the screen actually is from out here: one port, opened by the
 * plane rather than by the agent, that answers with a live view of a browser.
 */
export function hasScreen(agent: AgentSummary): boolean {
	return agent.served.some((one) => one.port === SCREEN_VIEW_PORT);
}

/**
 * The width somebody dragged, kept so that it is still there tomorrow.
 *
 * The first thing in this console to remember anything in the browser, and it is the right kind of
 * thing to: how much room the screen gets against the conversation is a decision about this
 * machine and this monitor, not about the plane — two people reading the same plane from two
 * laptops want two different answers, and neither wants to drag it again every morning.
 */
const WIDTH_KEY = "squad.screen.width";

/** Narrow enough to be a strip of a browser, wide enough that the address bar is still readable. */
const NARROWEST = 320;

/**
 * The most the screen may take, which is a fact about the conversation beside it.
 *
 * Measured off the room the two of them share rather than off the window, and it leaves the
 * conversation enough to be one: dragged to the far edge, what is left otherwise is a column three
 * words wide, where every line of an answer wraps four times and the box to reply in says "Say".
 */
function widest(room: number): number {
	return Math.max(NARROWEST, Math.round(room - 360));
}

function remembered(): number | undefined {
	try {
		const said = Number(window.localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(said) && said >= NARROWEST ? said : undefined;
	} catch {
		// A browser with storage turned off, or a page in a context that refuses it. The width is a
		// convenience and the screen works without it, so this is not worth saying anything about.
		return undefined;
	}
}

function remember(width: number): void {
	try {
		window.localStorage.setItem(WIDTH_KEY, String(width));
	} catch {
		// As above.
	}
}

interface Tab {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	/** The one the agent is driving. */
	readonly here: boolean;
	/** The one on the screen, which is the same until somebody goes to look at another. */
	readonly seen?: boolean;
}

interface Standing {
	readonly holder: "agent" | "operator";
	readonly url?: string;
	readonly note?: string;
	readonly tabs?: readonly Tab[];
}

/**
 * The agent's browser, drawn by this console rather than framed from the container it runs in.
 *
 * A frame was the obvious way and it is the wrong one, for a reason that is not about taste: every
 * other port an agent opens is answered at a name of its own, and on Docker Desktop that name has
 * an IPv6 address nothing listens on — a browser retries that on a tab and does not on a picture
 * inside a page. So the link worked when you pasted it and not where it was used.
 *
 * Drawing it here fixes that and is the better arrangement anyway. What crosses from the container
 * is a JPEG and four small JSON answers; no document written over there is ever read at this
 * address, which is a stronger separation than the frame was. And the chrome around it — whose
 * screen, who has the keyboard, where it is pointed — is this console's own, in its own type.
 */
export function Screen({ agentId }: { agentId: string }) {
	const servedAt = useServedAt();
	const [open, setOpen] = useState(true);
	// Undefined until somebody drags it, and then a number of pixels. Undefined is not a width of
	// zero: it is the share the layout gives it, which is the right answer until somebody disagrees.
	const [width, setWidth] = useState<number | undefined>(remembered);
	const [dragging, setDragging] = useState(false);
	const column = useRef<HTMLElement>(null);
	/**
	 * Which attempt at the picture this is, and whether one has arrived.
	 *
	 * A stream of JPEGs in an `<img>` is a connection held open, and an `<img>` whose connection ends
	 * does not try again: it stops, with the last frame still on the screen or with nothing at all if
	 * none had come. Every deploy of the plane ends it, and so does the browser's container being
	 * replaced — after which the picture is dead until somebody reloads the whole console, which is
	 * not a thing anybody should have to know.
	 *
	 * The number is part of the address, so raising it asks again rather than reading a cache.
	 */
	const [attempt, setAttempt] = useState(0);
	const [arrived, setArrived] = useState(false);
	const wasReachable = useRef(true);
	const [standing, setStanding] = useState<Standing>({ holder: "agent" });
	const [typed, setTyped] = useState("");
	const picture = useRef<HTMLImageElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const holding = standing.holder === "operator";

	const at = (path: string) => `/screen/${encodeURIComponent(agentId)}/${path}`;

	const ask = async (path: string, body: unknown): Promise<Standing | undefined> => {
		const answer = await fetch(at(path), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}).catch(() => undefined);
		if (answer === undefined || !answer.ok) return undefined;
		return (await answer.json().catch(() => undefined)) as Standing | undefined;
	};

	// Asked rather than pushed, because what it answers is three short strings and the picture is
	// already a connection held open: a second one for "who has the keyboard" would be two sockets
	// per viewer for a question whose answer changes when somebody presses a button.
	useEffect(() => {
		let reading = true;
		const look = async () => {
			const answer = await fetch(at("state")).catch(() => undefined);
			const reachable = answer !== undefined && answer.ok;
			// The screen coming back is the moment to ask for the picture again: whatever ended that
			// stream — a plane redeployed, a browser container replaced — ended this too, and out here
			// it is the only signal that says so.
			if (reading && reachable && !wasReachable.current) {
				setArrived(false);
				setAttempt((one) => one + 1);
			}
			wasReachable.current = reachable;
			if (!reading || answer === undefined || !reachable) return;
			const said = (await answer.json().catch(() => undefined)) as Standing | undefined;
			if (reading && said !== undefined) setStanding(said);
		};
		void look();
		const ticking = setInterval(() => void look(), 1_500);
		return () => {
			reading = false;
			clearInterval(ticking);
		};
	}, [agentId]);

	// The address bar follows the browser except while it is being typed into, which is the whole of
	// why it is held here: a field that rewrote itself every second and a half is one nobody can
	// finish typing a URL into.
	useEffect(() => {
		setTyped(standing.url ?? "");
	}, [standing.url]);

	/** Where the pointer is on the page, not on the picture of it, which is drawn at any width. */
	const pointAt = (event: { clientX: number; clientY: number }) => {
		const img = picture.current;
		if (img === null) return undefined;
		const box = img.getBoundingClientRect();
		const scale = img.naturalWidth === 0 ? 1 : img.naturalWidth / box.width;
		return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
	};

	// Attached by hand because a wheel handler that cannot say no is one that scrolls the
	// conversation under the screen while somebody is scrolling the page on it.
	useEffect(() => {
		const img = picture.current;
		if (img === null) return;
		const rolled = (event: WheelEvent) => {
			if (!holding) return;
			event.preventDefault();
			const point = pointAt(event);
			if (point !== undefined) void ask("input", { kind: "wheel", ...point, deltaY: event.deltaY });
		};
		img.addEventListener("wheel", rolled, { passive: false });
		return () => img.removeEventListener("wheel", rolled);
	});

	// Away, and a way back. A column that collapses to nothing would take its own handle with it, so
	// what is left is the narrowest thing that can still be clicked.
	if (!open) {
		return (
			<aside className="flex w-9 flex-none flex-col items-center border-line border-l py-2">
				<button
					type="button"
					className="text-muted hover:text-say"
					onClick={() => setOpen(true)}
					title="show the screen"
				>
					<ChevronLeft className="size-4" />
				</button>
			</aside>
		);
	}

	/*
	 * While the keyboard is held, say every so often that somebody is still here.
	 *
	 * The screen gives it back on its own after a while, and what that timer has to measure is a
	 * person rather than a picture. It used to be renewed by the frames, which was fine while the
	 * screen was only ever watched in a window somebody had opened on purpose — and wrong the moment
	 * it lived here, where the frames flow all day whether or not anybody is looking. Taken once, the
	 * keyboard was then held until the console was closed, with every verb the agent tried refused.
	 *
	 * Any interaction anywhere in the console counts. Somebody typing a long message to the agent
	 * about what they are looking at is present, and their mouse has not moved in a minute.
	 */
	useEffect(() => {
		if (!holding) return;
		let last = 0;
		const here = () => {
			const now = Date.now();
			if (now - last < 30_000) return;
			last = now;
			void fetch(at("here"), { method: "POST" }).catch(() => undefined);
		};
		here();
		for (const kind of ["pointermove", "pointerdown", "keydown"]) {
			document.addEventListener(kind, here, { passive: true });
		}
		return () => {
			for (const kind of ["pointermove", "pointerdown", "keydown"]) {
				document.removeEventListener(kind, here);
			}
		};
	}, [holding, agentId]);

	// Nothing gets selected while an edge is being dragged. Without this, pulling the handle left
	// sweeps a selection across the conversation behind it, and the drag ends with half the page
	// highlighted.
	useEffect(() => {
		if (!dragging) return;
		const was = document.body.style.userSelect;
		document.body.style.userSelect = "none";
		return () => {
			document.body.style.userSelect = was;
		};
	}, [dragging]);

	/**
	 * Where the edge somebody is dragging has got to, held to something usable at both ends.
	 *
	 * Answers with the width as well as setting it, which is what lets the end of a drag write down
	 * exactly where it was let go. Reading the state instead wrote down the step before: a render is
	 * one tick behind the pointer, and the column jumped back thirty pixels on the next reload.
	 */
	const dragTo = (clientX: number): number => {
		const here = column.current?.getBoundingClientRect();
		const room = column.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
		const right = here?.right ?? window.innerWidth;
		const wanted = Math.min(widest(room), Math.max(NARROWEST, Math.round(right - clientX)));
		setWidth(wanted);
		return wanted;
	};

	return (
		<>
			{/*
			 * The edge between the conversation and the screen, which is a thing to move.
			 *
			 * How much room each of them wants is not something this program can know: it depends on
			 * the page being watched, the size of the monitor, and whether the work at hand is reading
			 * what the agent said or watching what it is doing. So it is a handle, and where it is left
			 * is remembered.
			 */}
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="how much room the screen takes"
				tabIndex={0}
				className={`-mr-1 z-10 w-2 flex-none cursor-col-resize border-line border-l transition-colors hover:border-say/40 ${
					dragging ? "border-say/60" : ""
				}`}
				onPointerDown={(event) => {
					event.currentTarget.setPointerCapture(event.pointerId);
					setDragging(true);
				}}
				onPointerMove={(event) => {
					if (dragging) dragTo(event.clientX);
				}}
				onPointerUp={(event) => {
					event.currentTarget.releasePointerCapture(event.pointerId);
					setDragging(false);
					remember(dragTo(event.clientX));
				}}
				// The same edge from the keyboard, because a handle that can only be dragged is one
				// nobody using a keyboard can move at all.
				onKeyDown={(event) => {
					const step = event.key === "ArrowLeft" ? 48 : event.key === "ArrowRight" ? -48 : 0;
					if (step === 0) return;
					event.preventDefault();
					const now = width ?? column.current?.getBoundingClientRect().width ?? NARROWEST;
					const room =
						column.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
					const next = Math.min(widest(room), Math.max(NARROWEST, Math.round(now + step)));
					setWidth(next);
					remember(next);
				}}
			/>
			<section
				ref={column}
				className="flex w-[clamp(22rem,42%,46rem)] flex-none flex-col border-line border-l"
				style={width === undefined ? undefined : { width }}
				aria-label="screen"
			>
				<div className="flex items-center gap-3 px-3 py-1.5 text-[0.78rem] text-muted">
					<button
						type="button"
						className="flex items-center gap-1.5 hover:text-say"
						onClick={() => setOpen(false)}
						title="put the screen away"
					>
						<ChevronRight className="size-3.5" />
						<span>screen</span>
					</button>

					<span className="flex-1" />

					{standing.note !== undefined && (
						<span className="max-w-[18ch] truncate text-working" title={standing.note}>
							asks: {standing.note}
						</span>
					)}

					<button
						type="button"
						className={`rounded-md border px-2.5 py-1 ${
							holding ? "border-up/50 bg-up/10 text-up" : "border-line hover:text-say"
						}`}
						onClick={() =>
							void ask("keyboard", { hold: !holding }).then((said) => said && setStanding(said))
						}
					>
						{holding ? "Give it back" : "Take the keyboard"}
					</button>

					{/* The way out to a window of its own, for signing into something at the size it was
				    designed at. That one is read at the port's own name, the way every served port is. */}
					<a
						className="flex items-center gap-1.5 hover:text-say"
						href={servedAt(agentId, SCREEN_VIEW_PORT)}
						target="_blank"
						rel="noreferrer noopener"
						title={`${agentId}'s browser, in a window of its own`}
					>
						<ExternalLink className="size-3.5" />
						<span>open</span>
					</a>
				</div>

				{/* On a line of its own, because a column is narrow: an address bar sharing a row with two
			    buttons in here would be a field too short to read a URL in. */}
				<div className="px-3 pb-2">
					<form
						className="flex min-w-0 items-center"
						onSubmit={(event) => {
							event.preventDefault();
							const wanted = typed.trim();
							if (wanted === "" || !holding) return;
							// What a person types into an address bar is a hostname about as often as it is a
							// URL, and the screen opens http and https — so the scheme is added, not refused.
							const url = wanted.includes("://") ? wanted : `https://${wanted}`;
							void ask("open", { url }).then((said) => said && setStanding(said));
						}}
					>
						<input
							className="w-full rounded-md border border-line bg-sunk px-2.5 py-1 font-mono text-[0.74rem] text-say disabled:text-muted"
							value={typed}
							disabled={!holding}
							spellCheck={false}
							placeholder={holding ? "Where to?" : "Take the keyboard to go somewhere"}
							onChange={(event) => setTyped(event.target.value)}
						/>
					</form>
				</div>

				{/*
				 * The tabs, when there is more than one.
				 *
				 * Drawn for the reason a browser draws them: a page that opened somewhere else has not
				 * vanished, and without a strip saying so the agent looking something up in a second tab
				 * looks, from out here, exactly like the agent having wandered off. One tab needs no strip
				 * — a row that is always there and usually says nothing is a row nobody reads.
				 */}
				{(standing.tabs?.length ?? 0) > 1 && (
					<div className="flex gap-1 overflow-x-auto px-3 pb-2">
						{standing.tabs?.map((tab) => (
							<button
								key={tab.number}
								type="button"
								title={`${tab.title || "(untitled)"}\n${tab.url}${tab.here ? "\n\nthe agent is working on this one" : ""}`}
								className={`max-w-[14rem] flex-none truncate rounded-md border px-2 py-0.5 text-[0.7rem] ${
									(tab.seen ?? tab.here)
										? "border-line bg-raised text-say"
										: "border-transparent text-muted hover:text-say"
								}`}
								onClick={() =>
									void fetch(at("tab"), {
										method: "POST",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ tab: tab.number }),
									}).catch(() => undefined)
								}
							>
								{/* A dot on the one the agent is driving, so going to look at another does not
								    lose track of where it is working. */}
								{tab.here && <span className="mr-1 text-up">•</span>}
								{tab.title || tab.url.replace(/^https?:\/\//, "")}
							</button>
						))}
					</div>
				)}

				{/* Focusable, so that typing goes to the page only once somebody has clicked on it. The
			    alternative — listening on the window — is a console where every keystroke meant for the
			    message box lands in whatever the agent has open. */}
				<div
					ref={stage}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: it is interactive — it is a browser
					tabIndex={0}
					// Against the top rather than the middle of the column: the picture belongs under the
					// address bar that says where it is, and a browser floating in the vertical centre of a tall
					// column with a gap over it reads as something that failed to load.
					className="relative flex min-h-0 flex-1 justify-center overflow-auto border-line border-t bg-ground p-2 outline-none focus-visible:bg-sunk"
					onKeyDown={(event) => {
						if (!holding) return;
						if (event.metaKey || event.ctrlKey || event.altKey) return;
						if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(event.key)) return;
						event.preventDefault();
						void ask("input", { kind: "key", key: event.key });
					}}
				>
					{/* `max-h-full` here as well as on the picture, and not only there: a percentage height
				    resolves against a definite one, and a figure that sizes itself to its contents has
				    none to give the picture inside it. Without this the page runs off the bottom of a
				    wide column. */}
					<figure className="relative m-0 max-h-full min-h-0 self-start leading-none">
						<img
							ref={picture}
							// Keyed by the agent and the attempt and by nothing else: changing this address
							// restarts the stream, and a stream restarted on every render is a browser
							// encoding a fresh keyframe forever.
							key={`${agentId}:${attempt}`}
							src={`${at("frames")}?n=${attempt}`}
							onLoad={() => setArrived(true)}
							// A stream that ended is not an error anybody can do anything about, so it is not
							// said out loud: it is asked for again, once, after a moment.
							onError={() => {
								setArrived(false);
								window.setTimeout(() => setAttempt((one) => one + 1), 1_500);
							}}
							alt={`what ${agentId}'s browser is showing`}
							className="max-h-full max-w-full rounded-md border border-line object-contain"
							onMouseDown={(event) => {
								stage.current?.focus();
								if (!holding) return;
								const point = pointAt(event);
								if (point !== undefined) void ask("input", { kind: "down", ...point });
							}}
							onMouseUp={(event) => {
								if (!holding) return;
								const point = pointAt(event);
								if (point !== undefined) void ask("input", { kind: "up", ...point });
							}}
							onDragStart={(event) => event.preventDefault()}
						/>
						{/* Along the bottom of the picture rather than across the middle of it: it is a note
				    about the page, and the part somebody is trying to read is the one place it cannot
				    go. Inside the figure, so it stays with the picture rather than with the column. */}
						{arrived && !holding && (
							<figcaption className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
								<span className="rounded-full bg-ground/85 px-3 py-1 text-[0.72rem] text-muted">
									the agent is driving — take the keyboard to touch this page
								</span>
							</figcaption>
						)}
					</figure>

					{/*
					 * Over the whole stage rather than inside the figure, which is the shape of the picture
					 * and so has no shape at all until one arrives: the line used to wrap into a column
					 * three words wide and clip against the top, which is a broken screen saying so.
					 */}
					{!arrived && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-[0.78rem] text-muted">
							<Spin />
							<span>waiting for the first frame…</span>
						</div>
					)}
				</div>
			</section>
		</>
	);
}
