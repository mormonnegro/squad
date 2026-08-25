import type { CSSProperties } from "react";
import { useReveal } from "../lib/reveal";

// The widths the feed pads to, so a line here breaks into the same columns it does on the machine.
const AGENT_WIDTH = 8;
const ACTION_WIDTH = 8;

export type FeedRow = {
	at: string;
	who: string;
	action: string;
	failed?: boolean;
	detail: string;
};

/**
 * The action column is what carries the colour, here as there — it is the fastest thing to scan
 * down. The hues are the ones `LogFeed` prints, so the picture on the page is the picture on the
 * machine rather than a prettier one invented for a screenshot.
 */
function hue(action: string): string {
	if (action === "error" || action === "egress") return "red";
	if (action === "answer") return "green";
	if (action === "spent") return "amber";
	return "blue";
}

export function Feed({ rows }: { rows: readonly FeedRow[] }) {
	const [ref, shown] = useReveal<HTMLDivElement>();

	return (
		<div className="terminal" ref={ref} data-reveal={shown}>
			<pre>
				{rows.map((row, i) => (
					<span
						className="feed-line"
						key={`${row.who}-${row.action}-${row.detail}`}
						style={{ "--i": i } as CSSProperties}
					>
						<span className="feed-at">{row.at}</span>
						{"  "}
						<span className="feed-who">{row.who.padEnd(AGENT_WIDTH)}</span>
						{"  "}
						<span className="feed-action" data-hue={hue(row.action)}>
							{row.action.padEnd(ACTION_WIDTH)}
						</span>
						{"  "}
						<span className="feed-mark">{row.failed === true ? "✗" : " "}</span>{" "}
						<span className="feed-detail" data-failed={row.failed === true ? "true" : undefined}>
							{row.detail}
						</span>
					</span>
				))}
			</pre>
		</div>
	);
}
