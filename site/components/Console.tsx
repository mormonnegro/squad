// The console drawn as elements rather than as the box-drawing capture from the README. The same
// picture pasted into a browser goes ragged: a proportional fallback for ● ◐ ○ is a cell and a half
// wide and every border after it moves.
//
// Everything else is the console as `console.ts` draws it, because a picture that behaves like the
// program is worth more than a prettier one: the operator's own line is cyan and everything that
// arrived from somewhere else wears the channel that carried it, in the yellow the agents column
// paints a booked wakeup; what the turn is on is the row under the conversation and never the
// prompt, which is the one row a hand is on; and the tools are not in the chat pane at all, because
// in the console they are in the feed.

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useReveal } from "../lib/reveal";

// One agent per job, because that is what a plane looks like: the sidebar is the set of examples,
// and every case opens with the thing an operator asked for — the part a visitor is deciding about.
type Use = {
	name: string;
	label: string;
	spend: string;
	// A spend is dim until it is worth reading: amber at four fifths of the ceiling, red at it.
	heat?: "warn";
	// The turn it has booked, counted down: a standing weekday and hour, or a plain offset.
	next?: string | { day: number; hour: number };
	model: string;
	limit: string;
	// The channel the ask arrived by, when it was not typed at this console.
	via?: string;
	ask: string;
	// What fired this particular turn, days after the ask: its own wakeup, or something outside.
	woke?: [string, string];
	// What it reached for, as the row under the conversation says it: what it is, and what it is on.
	steps?: [string, string][];
	// How long the turn took, for the clock that row carries.
	took?: number;
	// Where the answer went, when it went anywhere but this pane.
	to?: string;
	reply: string[];
	// Typed at it while it was still working, and waiting where the hand left it.
	queued?: string;
};

const USES: [Use, ...Use[]] = [
	{
		name: "rival",
		label: "track a competitor",
		spend: "$1.10",
		next: { day: 1, hour: 8 },
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "every monday at 8, diff the other three's pricing and changelogs and mail me what moved",
		woke: ["wake", "monday: diff the three, mail what moved"],
		steps: [
			["fetch", "three pricing pages, three changelogs"],
			["read", "memory/reference/rivals.md"],
			["write", "memory/reference/rivals.md"],
			["email", "you · “Monday: two of them moved”"],
		],
		took: 192,
		to: "email",
		reply: [
			"Two moved. One put a seat price on the plan that was flat before, at $29; the other took the free tier down to a trial and said so nowhere but the pricing page.",
		],
	},
	{
		name: "ci",
		label: "fix a failing check",
		spend: "$4.80",
		heat: "warn",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "when checks fail on a pull request, find out why and fix it",
		woke: ["github", "pull_request #212 · checks failed"],
		steps: [
			["bash", "pnpm -r test"],
			["read", "packages/control-plane/src/turn.ts"],
			["write", "test/turn.test.ts"],
			["bash", "git commit && git push"],
		],
		took: 98,
		queued: "does the same test fail on main?",
		reply: [
			"The new test asserts the error string I changed on Tuesday, not the behaviour. Fixed the assertion, pushed to the branch, and said as much on the pull request.",
			"The issue body it came from is quoted, never obeyed — nobody who can open a pull request can give me an instruction.",
		],
	},
	{
		name: "desk",
		label: "connect an MCP",
		spend: "$0.42",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "/mcp add linear",
		reply: [
			"Connected. It runs in the sandbox next to notion and playwright, and reaches Linear through the proxy — which is what holds the key. The agent got the tool, never the secret.",
			"On the shelf: github, sentry, slack, postgres, stripe. Nothing was woken to answer this, and nothing was spent.",
		],
	},
	{
		name: "errand",
		label: "from your phone",
		spend: "$0.18",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		via: "telegram",
		ask: "deploy the site when CI goes green",
		woke: ["wake", "check CI again"],
		steps: [
			["bash", "gh run watch"],
			["bash", "./deploy.sh"],
		],
		took: 242,
		to: "telegram",
		reply: [
			"Green at 09:12, and it is live. I answered in the thread you wrote from — anyone else on this bot is heard, not obeyed.",
		],
	},
	{
		name: "ops",
		label: "ask it anything",
		spend: "$0.06",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		ask: "what is eating the disk on this box",
		steps: [["bash", "df -h && docker system df"]],
		took: 18,
		reply: [
			"38 of the 40 GB is /var/lib/docker, and 21 of those are build cache for images nothing tags any more.",
			"Say the word and I prune it.",
		],
	},
];

// Braille, because it turns in place: every frame is one column wide, so the line beside it does
// not move. The same ten frames the console spins.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** What the working row says of a turn that has not reached its first tool yet. */
const THINKING = "thinking";

// The clock the pane is printed on, in characters: one unit is one character of a streamed line, a
// line a person types is charged more per character, and a line that arrives lands whole after a beat.
const MS = 6;
const BEAT = 26;
const TYPED = 2.4;
const ALL = Number.POSITIVE_INFINITY;
/** How many units of that clock one frame of the spinner lasts, so it turns at a terminal's pace. */
const SPIN = 13;

/**
 * How long until an instant, in the coarsest unit that still says it — `until` in console.ts, which
 * is what the column being copied here prints.
 */
function until(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** The next time that weekday comes round at that hour, which for `rival` is really monday at 8. */
function booked(at: { day: number; hour: number }, now: number): number {
	const when = new Date(now);
	when.setHours(at.hour, 0, 0, 0);
	let days = (at.day - when.getDay() + 7) % 7;
	if (days === 0 && when.getTime() <= now) days = 7;
	when.setDate(when.getDate() + days);
	return when.getTime();
}

/** What a row says in its wake column, once there is a clock to count a standing turn down from. */
function wake(next: Use["next"], now: number | null): string | null {
	if (next === undefined) return null;
	if (typeof next === "string") return next;
	return now === null ? null : until(booked(next, now) - now);
}

/** The text up to the cursor, with the rest still in the markup for whoever has no script running. */
function Typed({ text, chars }: { text: string; chars: number }) {
	const at = Math.min(Math.max(Math.floor(chars), 0), text.length);
	return (
		<>
			{text.slice(0, at)}
			<span className="mock-off">{text.slice(at)}</span>
		</>
	);
}

/** A line that did not come from the keyboard, marked for what carried it. It arrives whole. */
function Came({ via, text, here }: { via: string; text: string; here: boolean }) {
	return (
		<p className="mock-came" data-off={here ? undefined : "true"}>
			<span className="mock-via">‹{via}›</span> <Typed text={text} chars={here ? ALL : 0} />
		</p>
	);
}

export function Console() {
	const [ref, shown] = useReveal<HTMLDivElement>();
	const [use, setUse] = useState<Use>(USES[0]);
	const [n, setN] = useState(0);
	// The clock the standing appointment is counted down from, read after mounting rather than at
	// build time: this page is exported once, and the monday it was exported before has gone by.
	const [now, setNow] = useState<number | null>(null);

	useEffect(() => {
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(id);
	}, []);

	const script = useMemo(() => {
		let at = 0;
		const take = (cost: number) => {
			const start = at;
			at += cost;
			return start;
		};
		// A line typed at this prompt is typed; one that arrived from somewhere else lands whole.
		const ask = {
			text: use.ask,
			start: take(use.via === undefined ? use.ask.length * TYPED : BEAT),
		};
		const woke =
			use.woke === undefined ? null : { via: use.woke[0], text: use.woke[1], start: take(BEAT) };
		// Where the turn begins, which is what the clock under the conversation counts from.
		const from = at;
		const steps = (use.steps ?? []).map(([action, detail]) => ({
			text: `${action} ${detail}`,
			start: take(BEAT),
		}));
		const reply = use.reply.map((text) => ({ text, start: take(text.length) }));
		return { ask, woke, steps, reply, from, total: at };
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

	// A turn is being taken while the pane is still printing one, and only where one was woken at all.
	const busy = use.took !== undefined && n >= script.from && n < script.total;
	const landed = script.steps.filter((s) => n > s.start);
	const working = !busy
		? null
		: {
				frame: SPINNER[Math.floor(n / SPIN) % SPINNER.length] ?? SPINNER[0],
				seconds: Math.floor(((n - script.from) / (script.total - script.from)) * (use.took ?? 0)),
				step: landed[landed.length - 1]?.text ?? THINKING,
			};

	const keys: [string, string][] = [
		["^N^P", "agent"],
		["^U^D", "scroll"],
		["↑↓", "history"],
		["tab", "logs"],
		["/", "commands"],
		["!", "shell"],
		["^C", "quit"],
		// Last, so the rest of the row does not move as it comes and goes, and only while there is
		// something to stop: a hint for a key that does nothing is a hint that lies.
		...(busy ? ([["esc", "stop"]] as [string, string][]) : []),
	];

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
					{USES.map((u, i) => {
						const due = wake(u.next, now);
						return (
							<button
								type="button"
								key={u.name}
								className="mock-agent mock-in"
								data-state={busy && u === use ? "thinking" : "up"}
								data-here={u === use ? "true" : undefined}
								style={{ "--i": i } as CSSProperties}
								onClick={() => pick(u)}
							>
								<span className="mock-dot" aria-hidden="true" />
								<span className="mock-name">{u.name}</span>
								{due === null ? null : <span className="mock-wake">{due}</span>}
								<span className="mock-spend" data-heat={u.heat}>
									{u.spend}
								</span>
							</button>
						);
					})}
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
							<span className="mock-spend" data-heat={use.heat}>
								{use.spend} / {use.limit}
							</span>
						</span>
					</div>

					{/* Resting on the prompt rather than hanging from the top: an answer arrives where the
					    next question is being typed, instead of at the far end of a pane of blank rows. */}
					<div className="mock-body">
						{use.via === undefined ? (
							<p className="mock-said">
								<span className="mock-mark">&gt;</span>{" "}
								<Typed text={script.ask.text} chars={(n - script.ask.start) / TYPED} />
							</p>
						) : (
							<Came via={use.via} text={script.ask.text} here={n > script.ask.start} />
						)}
						{script.woke === null ? null : (
							<Came via={script.woke.via} text={script.woke.text} here={n > script.woke.start} />
						)}
						{script.reply.map((r, i) => (
							<p key={r.text} data-off={n > r.start ? undefined : "true"}>
								{use.to === undefined || i > 0 ? null : (
									<>
										<span className="mock-via">‹→ {use.to}›</span>{" "}
									</>
								)}
								<Typed text={r.text} chars={n - r.start} />
							</p>
						))}
					</div>

					{/* Under the conversation and outside the prompt, which is a hand's own row and has to
					    stay clear enough to type a second question into while the first is being answered. */}
					{working === null ? null : (
						<p className="mock-working">
							<span className="mock-clock">
								<span className="mock-spin">{working.frame}</span> {working.seconds}s
							</span>{" "}
							<span className="mock-step">{working.step}</span>
						</p>
					)}
					{use.queued === undefined || !busy ? null : (
						<p className="mock-queued">
							<span className="mock-dots">⋯</span> {use.queued}
						</p>
					)}

					<div className="mock-prompt">
						<span className="mock-mark">&gt;</span>
						<span className="mock-caret" aria-hidden="true" />
					</div>
				</div>
			</div>
			<div className="mock-keys">
				{keys.map(([key, label]) => (
					<span key={label}>
						<kbd>{key}</kbd> {label}
					</span>
				))}
			</div>
		</div>
	);
}
