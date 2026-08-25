// The console drawn as elements rather than as the box-drawing capture from the README. The same
// picture pasted into a browser goes ragged: a proportional fallback for ● ◐ ○ is a cell and a half
// wide and every border after it moves.
//
// The colours are the ones the console actually paints: cyan for the agent being looked at, green
// for what is up, amber for what is working or nearing its ceiling, and dim for everything that is
// only there to be read past.

import type { CSSProperties } from "react";
import { useReveal } from "../lib/reveal";

const AGENTS: {
	name: string;
	state: "up" | "thinking" | "stopped";
	spend?: string;
	// A spend is dim until it is worth reading: amber at four fifths of the ceiling, red at it.
	heat?: "warn";
	wait?: string;
	here?: boolean;
}[] = [
	{ name: "demo", state: "up", spend: "$0.42", here: true },
	{ name: "maxi", state: "thinking", spend: "$4.80", heat: "warn", wait: "15m" },
	{ name: "scout", state: "stopped" },
];

const KEYS: [string, string][] = [
	["↑↓", "agent"],
	["^U^D", "scroll"],
	["tab", "logs"],
	["/", "commands"],
	["!", "shell"],
	["^C", "quit"],
];

export function Console() {
	const [ref, shown] = useReveal<HTMLDivElement>();

	return (
		<div className="mock" ref={ref} data-reveal={shown}>
			<div className="mock-frame">
				<div className="mock-side">
					<div className="mock-side-head">agents</div>
					{AGENTS.map((a, i) => (
						<div
							key={a.name}
							className="mock-agent mock-in"
							data-state={a.state}
							data-here={a.here === true ? "true" : undefined}
							style={{ "--i": i } as CSSProperties}
						>
							<span className="mock-dot" aria-hidden="true" />
							<span className="mock-name">{a.name}</span>
							{a.wait ? <span className="mock-wait">{a.wait}</span> : null}
							{a.spend ? (
								<span className="mock-spend" data-heat={a.heat}>
									{a.spend}
								</span>
							) : null}
						</div>
					))}
					<div
						className="mock-agent mock-new mock-in"
						style={{ "--i": AGENTS.length } as CSSProperties}
					>
						<span className="mock-plus">+</span>
						<span className="mock-name">new agent</span>
					</div>
				</div>

				<div className="mock-main">
					<div className="mock-title">
						<span>
							<b>demo</b>
							<span className="mock-tabs">
								<span data-on="true">chat</span>
								<span className="mock-sep"> · </span>
								<span>logs</span>
								<span className="mock-sep"> · </span>
								<span>setup</span>
							</span>
						</span>
						<span className="mock-title-right">
							deepseek-v4-flash <span className="mock-spend">$0.42 / $5.00</span>
						</span>
					</div>
					<div className="mock-body">
						<p className="mock-said mock-in" style={{ "--i": 1 } as CSSProperties}>
							<span className="mock-mark">&gt;</span> que es un webhook
						</p>
						<p className="mock-in" style={{ "--i": 3 } as CSSProperties}>
							Un webhook es una forma de comunicación automática entre servicios: cuando ocurre un
							evento en un sistema, ese sistema envía una petición HTTP a una URL configurada.
						</p>
					</div>
					<div className="mock-prompt">
						<span className="mock-mark">&gt;</span>
						<span className="mock-caret" aria-hidden="true" />
					</div>
				</div>
			</div>
			<div className="mock-keys">
				{KEYS.map(([key, label]) => (
					<span key={label}>
						<kbd>{key}</kbd> {label}
					</span>
				))}
			</div>
		</div>
	);
}
