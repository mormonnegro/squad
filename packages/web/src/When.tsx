import { useCallback, useEffect, useRef, useState } from "react";
import type { Plane, Wake } from "./plane.ts";
import { until } from "./until.ts";

/**
 * When an agent comes back, and — if you ask it — why, and a way to call it off.
 *
 * The countdown is the whole of what a row has room for, and it is the smaller half of the question:
 * an agent waking in thirty seconds to do something you did not ask for is the same four characters
 * as one waking to do exactly what you told it. So the note the agent left itself is here, and so is
 * the only thing worth doing about it once you have read it.
 *
 * Hovering shows it; clicking opens the same thing where it can be read without holding a mouse
 * still, which is what a paragraph and a button that stops something both need.
 */
export function When({
	plane,
	agentId,
	wakeAt,
}: {
	/** Absent while the connection is coming back, when there is nobody to ask. */
	plane: Plane | undefined;
	agentId: string;
	wakeAt: string;
}) {
	const [hovering, setHovering] = useState(false);
	const [open, setOpen] = useState(false);
	const [at, setAt] = useState<{ top?: number; bottom?: number; left: number } | undefined>();
	const [wakes, setWakes] = useState<readonly Wake[] | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const mark = useRef<HTMLButtonElement>(null);

	const showing = hovering || open;

	const read = useCallback((): void => {
		if (plane === undefined) return;
		setWhy(undefined);
		plane.schedules(agentId).then(
			(all) => setWakes(all),
			(error: Error) => setWhy(error.message),
		);
	}, [plane, agentId]);

	useEffect(() => {
		if (showing) read();
	}, [showing, read]);

	// Escape closes what a click opened. A hover closes itself by ending.
	useEffect(() => {
		if (!open) return;
		const key = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [open]);

	const place = (): void => {
		// Placed off the mark's own box and drawn fixed, because the column it sits in scrolls and
		// clips: a panel positioned inside that box would be cut off by the list it belongs to.
		const box = mark.current?.getBoundingClientRect();
		if (box === undefined) return;
		// Below when there is room and above when there is not — anchored to the window's own edge
		// rather than to a guess at the panel's height, which would have to be kept equal to the
		// number in the stylesheet by somebody remembering to.
		const below = window.innerHeight - box.bottom;
		setAt(
			below < 14 * 16
				? { bottom: window.innerHeight - box.top + 6, left: box.left }
				: { top: box.bottom + 6, left: box.left },
		);
	};

	const stop = async (wake: Wake): Promise<void> => {
		if (plane === undefined) return;
		try {
			await plane.unschedule(agentId, wake.id);
			// Asked again rather than filtered here: what the plane has is the answer, and an agent
			// mid-turn may have booked another one while this was being read.
			read();
		} catch (error) {
			setWhy((error as Error).message);
		}
	};

	/**
	 * The same list, read two ways.
	 *
	 * A peek is a few lines and nothing to press: reaching a button in it means leaving the mark it
	 * hangs off, and leaving the mark is what takes it away. So the peek says what it can and the
	 * whole thing is one click behind it.
	 */
	const list = (peek: boolean): React.ReactNode =>
		why !== undefined ? (
			<span className="wake-why">{why}</span>
		) : wakes === undefined ? (
			<span className="wake-why">reading its schedule…</span>
		) : wakes.length === 0 ? (
			<span className="wake-why">Nothing is booked. It waits to be spoken to.</span>
		) : (
			wakes.map((wake) => (
				<Booked key={wake.id} wake={wake} peek={peek} onStop={() => void stop(wake)} />
			))
		);

	return (
		<>
			<button
				type="button"
				ref={mark}
				className="row-note when"
				onMouseEnter={() => {
					place();
					setHovering(true);
				}}
				onMouseLeave={() => setHovering(false)}
				onFocus={() => {
					place();
					setHovering(true);
				}}
				onBlur={() => setHovering(false)}
				onClick={() => {
					setHovering(false);
					setOpen(true);
				}}
				aria-expanded={showing}
			>
				{until(wakeAt)}
			</button>

			{hovering && !open && at !== undefined && plane !== undefined && (
				<span
					className="wake-panel"
					style={{ top: at.top, bottom: at.bottom, left: at.left }}
					role="tooltip"
				>
					{list(true)}
					<span className="wake-more">click to read it all, and to call it off</span>
				</span>
			)}

			{open && plane !== undefined && (
				<Modal onClose={() => setOpen(false)} title={`${agentId} comes back in ${until(wakeAt)}`}>
					{list(false)}
				</Modal>
			)}
		</>
	);
}

/**
 * The same thing, held open.
 *
 * A hover is the wrong shape for a paragraph and the wrong shape for a button that stops something:
 * one of them needs to be read without holding a mouse still, and the other needs the mouse to get
 * to it without passing over anything that would take the panel away.
 */
function Modal({
	title,
	children,
	onClose,
}: {
	title: string;
	children: React.ReactNode;
	onClose: () => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => box.current?.focus(), []);

	return (
		<div className="scrim">
			{/* The way out for a mouse, as a layer behind the dialog rather than around it: around it,
			    every click inside would have to be stopped from reaching it, and stopping clicks is a
			    thing that goes wrong quietly. The way out for a keyboard is Escape, above. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard's way out */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a backdrop is a way out, not a control */}
			<div className="scrim-back" onClick={onClose} />
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				ref={box}
				tabIndex={-1}
			>
				<div className="modal-head">
					<strong>{title}</strong>
					<button type="button" className="key" onClick={onClose}>
						esc
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

function Booked({
	wake,
	peek,
	onStop,
}: {
	wake: Wake;
	/** A few lines of it, with nothing to press. */
	peek: boolean;
	onStop: () => void;
}) {
	const own = wake.createdBy === "agent";
	return (
		<span className="wake">
			<span className="wake-head">
				<strong>{stamp(wake.nextRunAt)}</strong>
				<span className="wake-kind">
					{wake.kind === "cron" ? `every ${wake.expression}` : "once"}
					{/* Whose idea this was. An agent that books itself is doing something it decided to
					    keep doing, and that reads very differently from a line in the operator's file. */}
					{own ? " · its own" : " · yours"}
				</span>
			</span>
			<span className="wake-body" data-peek={peek}>
				{wake.body}
			</span>
			{peek ? null : own ? (
				<button type="button" className="key stop" onClick={onStop}>
					stop this
				</button>
			) : (
				<span className="wake-why">
					This one is in your configuration. Taking it away here would last until the next start.
				</span>
			)}
		</span>
	);
}

/** The moment itself, because "30s" answers how long and not when. */
function stamp(iso: string): string {
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) return iso;
	const soon = when.getTime() - Date.now() < 12 * 60 * 60 * 1000;
	return when.toLocaleString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		...(soon ? {} : { month: "short", day: "numeric" }),
	});
}
