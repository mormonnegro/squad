// The console drawn as elements rather than as the box-drawing capture from the README. The same
// picture pasted into a browser goes ragged: a proportional fallback for ● ◐ ○ is a cell and a half
// wide and every border after it moves.
//
// The colours are the ones the console actually paints: cyan for the agent being looked at, green
// for what is up, amber for what is working or nearing its ceiling, and dim for everything that is
// only there to be read past.

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useReveal } from "../lib/reveal";

// One agent per job, because that is what a plane looks like: the sidebar is the set of examples,
// and every case opens with the thing an operator asked for — the part a visitor is deciding about.
// Under it is one turn of the agent doing it: what woke it, if the ask was a standing one, then the
// tools it reached for, then what it said back.
type Use = {
	name: string;
	label: string;
	state: "up" | "thinking" | "stopped";
	spend: string;
	// A spend is dim until it is worth reading: amber at four fifths of the ceiling, red at it.
	heat?: "warn";
	// The appointment it has booked, when it has one, and how long it has been at this turn.
	next?: string;
	wait?: string;
	model: string;
	limit: string;
	// Where the ask arrived from, when it was not typed at this console.
	from?: string;
	ask: string;
	// The event that fired this particular turn, days after the ask.
	woke?: string;
	did?: [string, string][];
	reply: string[];
	// Absent when nothing was woken: a slash command is answered by the plane itself.
	cost?: string;
};

const USES: [Use, ...Use[]] = [
	{
		name: "rival",
		label: "track a competitor",
		state: "up",
		spend: "$1.10",
		next: "mon 08:00",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "every monday at 8, diff the other three's pricing and changelogs and mail me what moved",
		woke: "wake_me · monday 08:00",
		did: [
			["fetch", "three pricing pages, three changelogs"],
			["read", "memory/reference/rivals.md"],
			["write", "memory/reference/rivals.md"],
			["email", "you · “Monday: two of them moved”"],
		],
		reply: [
			"Two moved. One put a seat price on the plan that was flat before, at $29; the other took the free tier down to a trial and said so nowhere but the pricing page.",
		],
		cost: "3m12s · 210k tokens · $0.04",
	},
	{
		name: "ci",
		label: "fix a failing check",
		state: "thinking",
		spend: "$4.80",
		heat: "warn",
		wait: "15m",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "when checks fail on a pull request, find out why and fix it",
		woke: "webhook · github · pull_request #212",
		did: [
			["bash", "pnpm -r test"],
			["read", "packages/control-plane/src/turn.ts"],
			["write", "test/turn.test.ts"],
			["bash", "git commit && git push"],
		],
		reply: [
			"The new test asserts the error string I changed on Tuesday, not the behaviour. Fixed the assertion, pushed to the branch, and said as much on the pull request.",
			"The issue body it came from is quoted, never obeyed — nobody who can open a pull request can give me an instruction.",
		],
		cost: "1m38s · 91.2k tokens · $0.02",
	},
	{
		name: "desk",
		label: "connect an MCP",
		state: "up",
		spend: "$0.42",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "/mcp add linear",
		did: [
			["ask", "Linear API key · ····································"],
			["grant", "linear.app · desk only"],
		],
		reply: [
			"Connected. It runs in the sandbox next to notion and playwright, and reaches Linear through the proxy — which is what holds the key. The agent got the tool, never the secret.",
			"On the shelf: github, sentry, slack, postgres, stripe. Nothing was woken to answer this, and nothing was spent.",
		],
	},
	{
		name: "errand",
		label: "from your phone",
		state: "up",
		spend: "$0.18",
		next: "in 5m",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		from: "telegram · you",
		ask: "deploy the site when CI goes green",
		did: [
			["wake_me", "in 5m · “check CI again”"],
			["bash", "gh run watch"],
			["bash", "./deploy.sh"],
		],
		reply: [
			"Green at 09:12, and it is live. I answered in the thread you wrote from — anyone else on this bot is heard, not obeyed.",
		],
		cost: "4m02s · 38.1k tokens · $0.01",
	},
	{
		name: "ops",
		label: "ask it anything",
		state: "up",
		spend: "$0.06",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "what is eating the disk on this box",
		did: [["bash", "df -h && docker system df"]],
		reply: [
			"38 of the 40 GB is /var/lib/docker, and 21 of those are build cache for images nothing tags any more.",
			"Say the word and I prune it.",
		],
		cost: "18s · 9.4k tokens · $0.002",
	},
];

const KEYS: [string, string][] = [
	["↑↓", "agent"],
	["^U^D", "scroll"],
	["tab", "logs"],
	["/", "commands"],
	["!", "shell"],
	["^C", "quit"],
];

// The clock the pane is printed on, in characters: one unit is one character of a streamed line, a
// line a person types is charged more per character, and a tool line lands whole after a beat.
const MS = 6;
const BEAT = 26;
const TYPED = 2.4;
const ALL = Number.POSITIVE_INFINITY;

/** The text up to the cursor, with the rest kept in the layout so nothing moves as it arrives. */
function Typed({ text, chars }: { text: string; chars: number }) {
	const at = Math.min(Math.max(Math.floor(chars), 0), text.length);
	return (
		<>
			{text.slice(0, at)}
			<span className="mock-off">{text.slice(at)}</span>
		</>
	);
}

export function Console() {
	const [ref, shown] = useReveal<HTMLDivElement>();
	const [use, setUse] = useState<Use>(USES[0]);
	const [n, setN] = useState(0);

	const script = useMemo(() => {
		let at = 0;
		const take = (cost: number) => {
			const start = at;
			at += cost;
			return start;
		};
		const ask = { text: use.ask, start: take(use.ask.length * TYPED) };
		const lines = [
			...(use.woke === undefined
				? []
				: [{ verb: "woke", rest: use.woke, woke: true, start: take(BEAT) }]),
			...(use.did ?? []).map(([verb, rest]) => ({ verb, rest, woke: false, start: take(BEAT) })),
		];
		const reply = use.reply.map((text) => ({ text, start: take(text.length) }));
		const cost = use.cost === undefined ? null : { text: use.cost, start: take(BEAT) };
		return { ask, lines, reply, cost, total: at };
	}, [use]);

	const pick = (next: Use) => {
		setUse(next);
		setN(0);
	};

	useEffect(() => {
		if (!shown) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setN(script.total);
			return;
		}
		let raf = 0;
		const started = performance.now();
		const tick = (now: number) => {
			const at = (now - started) / MS;
			setN(at);
			if (at < script.total) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [shown, script]);

	return (
		<div className="mock" ref={ref} data-reveal={shown}>
			<div className="uses">
				{USES.map((u) => (
					<button
						type="button"
						key={u.name}
						className="use"
						data-on={u === use}
						aria-pressed={u === use}
						onClick={() => pick(u)}
					>
						{u.label}
					</button>
				))}
			</div>

			<div className="mock-frame">
				<div className="mock-side">
					<div className="mock-side-head">agents</div>
					{USES.map((u, i) => (
						<button
							type="button"
							key={u.name}
							className="mock-agent mock-in"
							data-state={u.state}
							data-here={u === use ? "true" : undefined}
							style={{ "--i": i } as CSSProperties}
							onClick={() => pick(u)}
						>
							<span className="mock-dot" aria-hidden="true" />
							<span className="mock-name">{u.name}</span>
							{u.next === undefined ? null : <span className="mock-next">{u.next}</span>}
							{u.wait === undefined ? null : <span className="mock-wait">{u.wait}</span>}
							<span className="mock-spend" data-heat={u.heat}>
								{u.spend}
							</span>
						</button>
					))}
					<div
						className="mock-agent mock-new mock-in"
						style={{ "--i": USES.length } as CSSProperties}
					>
						<span className="mock-plus">+</span>
						<span className="mock-name">new agent</span>
					</div>
				</div>

				<div className="mock-main">
					<div className="mock-title">
						<span>
							<b>{use.name}</b>
							<span className="mock-tabs">
								<span data-on="true">chat</span>
								<span className="mock-sep"> · </span>
								<span>logs</span>
								<span className="mock-sep"> · </span>
								<span>setup</span>
							</span>
						</span>
						<span className="mock-title-right">
							{use.model}{" "}
							<span className="mock-spend">
								{use.spend} / {use.limit}
							</span>
						</span>
					</div>
					<div className="mock-body">
						<p className="mock-said">
							{use.from === undefined ? (
								<span className="mock-mark">&gt;</span>
							) : (
								<span className="mock-via">{use.from}</span>
							)}{" "}
							<Typed text={script.ask.text} chars={(n - script.ask.start) / TYPED} />
						</p>
						{script.lines.length === 0 ? null : (
							<div className="mock-did">
								{script.lines.map((l) => (
									<p key={l.verb + l.rest}>
										<span className="mock-verb" data-woke={l.woke}>
											<Typed text={l.verb} chars={n > l.start ? ALL : 0} />
										</span>
										<Typed text={l.rest} chars={n > l.start ? ALL : 0} />
									</p>
								))}
							</div>
						)}
						{script.reply.map((r) => (
							<p key={r.text}>
								<Typed text={r.text} chars={n - r.start} />
							</p>
						))}
						{script.cost === null ? null : (
							<p className="mock-cost">
								<Typed text={script.cost.text} chars={n > script.cost.start ? ALL : 0} />
							</p>
						)}
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
