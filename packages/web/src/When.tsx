import { useEffect, useRef, useState } from "react";
import type { Plane, Wake } from "./plane.ts";
import { until } from "./until.ts";

/**
 * When an agent comes back, and — if you ask it — why.
 *
 * The countdown is the whole of what a row has room for, and it is the smaller half of the question:
 * an agent waking in thirty seconds to do something you did not ask for is the same four characters
 * as one waking to do exactly what you told it. So the note the agent left itself is here, one hover
 * away, rather than nowhere.
 *
 * Fetched on the hover rather than carried on every summary, because it is a paragraph, it is wanted
 * rarely, and the alternative is sending it for every agent every two seconds to be read once.
 */
export function When({
	plane,
	agentId,
	wakeAt,
	glyph,
}: {
	/** Absent while the connection is coming back, when there is nobody to ask. */
	plane: Plane | undefined;
	agentId: string;
	wakeAt: string;
	/** Drawn before the countdown, where there is room for it. */
	glyph?: string;
}) {
	const [open, setOpen] = useState(false);
	// One of `top` or `bottom`, never both: the panel hangs off whichever edge of the mark has room.
	const [at, setAt] = useState<{ top?: number; bottom?: number; left: number } | undefined>();
	const [wakes, setWakes] = useState<readonly Wake[] | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const mark = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open || plane === undefined) return;
		let alive = true;
		plane.schedules(agentId).then(
			(all) => alive && setWakes(all),
			(error: Error) => alive && setWhy(error.message),
		);
		return () => {
			alive = false;
		};
	}, [open, plane, agentId]);

	const show = (): void => {
		// Placed off the mark's own box and drawn fixed, because the column it sits in scrolls and
		// clips: a panel positioned inside that box would be cut off by the list it belongs to.
		const box = mark.current?.getBoundingClientRect();
		if (box !== undefined) {
			// Below when there is room and above when there is not — anchored to the window's own edge
			// rather than to a guess at the panel's height, which would have to be kept equal to the
			// number in the stylesheet by somebody remembering to.
			const below = window.innerHeight - box.bottom;
			setAt(
				below < 14 * 16
					? { bottom: window.innerHeight - box.top + 6, left: box.left }
					: { top: box.bottom + 6, left: box.left },
			);
		}
		setOpen(true);
	};

	return (
		// A button rather than a span with handlers on it: it is reached by hover and by tab, and the
		// note behind it is the only place what the agent told itself can be read at all. Pressing it
		// does what hovering does, so a keyboard and a mouse arrive at the same panel.
		<button
			type="button"
			ref={mark}
			className="row-note when"
			onMouseEnter={show}
			onMouseLeave={() => setOpen(false)}
			onFocus={show}
			onBlur={() => setOpen(false)}
			onClick={() => (open ? setOpen(false) : show())}
			aria-expanded={open}
		>
			{glyph !== undefined && `${glyph} `}
			{until(wakeAt)}
			{open && at !== undefined && plane !== undefined && (
				<span
					className="wake-panel"
					style={{ top: at.top, bottom: at.bottom, left: at.left }}
					role="tooltip"
				>
					{why !== undefined ? (
						<span className="wake-why">{why}</span>
					) : wakes === undefined ? (
						<span className="wake-why">reading its schedule…</span>
					) : wakes.length === 0 ? (
						<span className="wake-why">Nothing is booked. It waits to be spoken to.</span>
					) : (
						wakes.map((wake) => <Booked key={wake.id} wake={wake} />)
					)}
				</span>
			)}
		</button>
	);
}

function Booked({ wake }: { wake: Wake }) {
	return (
		<span className="wake">
			<span className="wake-head">
				<strong>{stamp(wake.nextRunAt)}</strong>
				<span className="wake-kind">
					{wake.kind === "cron" ? `every ${wake.expression}` : "once"}
					{/* Whose idea this was. An agent that books itself is doing something it decided to
					    keep doing, and that reads very differently from a line in the operator's file. */}
					{wake.createdBy === "agent" ? " · its own" : ` · ${wake.createdBy}`}
				</span>
			</span>
			<span className="wake-body">{wake.body}</span>
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
