import type { AgentSummary } from "@squad/control-plane";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useServedAt } from "./served.tsx";

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

interface Standing {
	readonly holder: "agent" | "operator";
	readonly url?: string;
	readonly note?: string;
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
			if (!reading || answer === undefined || !answer.ok) return;
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

	return (
		<section className="flex flex-none flex-col border-line border-b" aria-label="screen">
			<div className="flex items-center gap-3 px-5 py-1.5 text-[0.78rem] text-muted">
				<button
					type="button"
					className="flex items-center gap-1.5 hover:text-say"
					onClick={() => setOpen(!open)}
					title={open ? "put the screen away" : "show the screen"}
				>
					{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
					<span>screen</span>
				</button>

				<form
					className="flex min-w-0 flex-1 items-center"
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

				{standing.note !== undefined && (
					<span className="max-w-[26ch] truncate text-working" title={standing.note}>
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

			{open && (
				// Focusable, so that typing goes to the page only once somebody has clicked on it. The
				// alternative — listening on the window — is a console where every keystroke meant for
				// the message box lands in whatever the agent has open.
				<div
					ref={stage}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: it is interactive — it is a browser
					tabIndex={0}
					className="relative flex h-[min(46vh,30rem)] items-center justify-center border-line border-t bg-ground p-2 outline-none focus-visible:bg-sunk"
					onKeyDown={(event) => {
						if (!holding) return;
						if (event.metaKey || event.ctrlKey || event.altKey) return;
						if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(event.key)) return;
						event.preventDefault();
						void ask("input", { kind: "key", key: event.key });
					}}
				>
					<img
						ref={picture}
						// Keyed by the agent alone: changing this address restarts the stream, and a stream
						// restarted on every render is a browser encoding a fresh keyframe forever.
						key={agentId}
						src={at("frames")}
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
					{/* Along the bottom rather than across the middle: it is a note about the page, and a
					    sentence over the part somebody is trying to read is the one place it cannot go. */}
					{!holding && (
						<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
							<span className="rounded-full bg-ground/85 px-3 py-1 text-[0.72rem] text-muted">
								the agent is driving — take the keyboard to touch this page
							</span>
						</div>
					)}
				</div>
			)}
		</section>
	);
}
