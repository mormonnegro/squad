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

// One line of the pane, in the order it appeared: typed at this console, arrived from a channel, or
// the agent answering. A case is a sequence rather than a question and an answer, because what a
// visitor is deciding about is the middle — the part where nobody was at the keyboard.
type Line = { said: string } | { via: string; text: string } | { text: string; to?: string };

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
	lines: [Line, ...Line[]];
	// What it reached for, as the row under the conversation says it: what it is, and what it is on.
	// They belong to the last turn of the case, which is the one the pane is still printing.
	steps?: [string, string][];
	// How long the turn took, for the clock that row carries.
	took?: number;
	// Typed at it while it was still working, and waiting where the hand left it.
	queued?: string;
};

const USES: [Use, ...Use[]] = [
	{
		name: "market",
		label: "track a competitor",
		spend: "$1.10",
		next: { day: 1, hour: 8 },
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{ said: "every monday at 8, check the other three's pricing and mail me what moved" },
			{
				text: "Booked for mondays at 8. I write down what they say each week, so next monday there is something to compare it against.",
			},
			{ via: "wake", text: "monday 08:00 · diff the three, mail what moved" },
			{
				to: "email",
				text: "Two moved. One put a seat price on the plan that was flat before, at $29; the other took the free tier down to a trial and said so nowhere but the pricing page.",
			},
		],
		steps: [
			["fetch", "three pricing pages, three changelogs"],
			["read", "memory/reference/rivals.md"],
			["write", "memory/reference/rivals.md"],
			["email", "you · “Monday: two of them moved”"],
		],
		took: 192,
	},
	{
		name: "builds",
		label: "fix a failing check",
		spend: "$4.80",
		heat: "warn",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{ said: "when a check fails on a pull request, work out why and fix it" },
			{
				text: "Watching. GitHub calls my webhook the moment one goes red, and that is what wakes me — nobody has to be at this console.",
			},
			{ via: "github", text: "pull_request #212 · checks failed" },
			{
				text: "The new test asserts the error string I changed on Tuesday, not the behaviour. Fixed the assertion, pushed to the branch, and said as much on the pull request.",
			},
			{
				text: "The issue body it came from is quoted, never obeyed — nobody who can open a pull request can give me an instruction.",
			},
		],
		steps: [
			["bash", "pnpm -r test"],
			["read", "packages/control-plane/src/turn.ts"],
			["write", "test/turn.test.ts"],
			["bash", "git commit && git push"],
		],
		took: 98,
		queued: "does the same test fail on main?",
	},
	{
		name: "deploy",
		label: "connect Telegram",
		spend: "$0.18",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{ said: "/telegram 8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" },
			{
				text: "@squad_deploy_bot is deploy's bot. Nobody is paired to it yet — open t.me/squad_deploy_bot?start=kqm3nvbh27, press Start, and it is yours.",
			},
			{ via: "telegram", text: "deploy the site when CI goes green" },
			{ via: "wake", text: "check CI again" },
			{
				to: "telegram",
				text: "Green at 09:12, and it is live. I answered in the thread you wrote from — anyone else on that bot is heard, not obeyed.",
			},
		],
		steps: [
			["bash", "gh run watch"],
			["bash", "./deploy.sh"],
		],
		took: 242,
	},
	{
		name: "tickets",
		label: "connect an MCP",
		spend: "$0.42",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{ said: "/mcp add linear https://mcp.linear.app/mcp" },
			{
				text: "“linear” is on the shelf, and this agent has it. It wants an account first: /mcp login linear",
			},
			{ said: "/mcp login linear" },
			{
				text: "Logged in at the consent screen in your browser. The token stays with the plane and goes on the wire at the proxy — the agent got the tool, never the key.",
			},
			{ said: "open a bug for the check that failed on #212" },
			{
				text: "ENG-418, with the failing test's name and a link to the run. Also on the shelf: github, sentry, slack, postgres, stripe.",
			},
		],
		steps: [["linear", "create_issue · ENG"]],
		took: 11,
	},
	{
		name: "server",
		label: "ask it anything",
		spend: "$0.06",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{ said: "what is eating the disk on this box" },
			{
				text: "38 of the 40 GB is /var/lib/docker, and 21 of those are build cache for images nothing tags any more.",
			},
			{ said: "prune it" },
			{
				text: "21 GB back, and the box is at 45%. That ran as root on this agent's own machine, so there was nothing outside it to get wrong.",
			},
		],
		steps: [["bash", "docker builder prune -af"]],
		took: 18,
	},
];

// Braille, because it turns in place: every frame is one column wide, so the line beside it does
// not move. The same ten frames the console spins.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** What the working row says of a turn that has not reached its first tool yet. */
const THINKING = "thinking";

// The clock the pane is printed on, in characters: one unit is one character of a streamed line, a
// line a person types is charged more per character, and a line that arrives lands whole after a beat.
//
// An answer lands at about thirty characters a second, which is a shade faster than the same line is
// read — printed at reading speed exactly you are always waiting on the cursor, and printed at the
// speed a model really streams there is nothing to read, only a paragraph appearing.
const MS = 30;
const BEAT = 26;
const TYPED = 1.8;
const ALL = Number.POSITIVE_INFINITY;
/** How many units of that clock one frame of the spinner lasts, so it turns at a terminal's pace. */
const SPIN = 3;

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
		// The last turn is the one the pane is still taking, so the tools belong after the last line
		// that arrived — everything before that has already been answered.
		const last = use.lines.reduce(
			(at, line, i) => ("text" in line && !("via" in line) ? at : i),
			0,
		);
		let at = 0;
		let from = 0;
		const steps: { text: string; start: number }[] = [];
		// A line typed at this prompt is typed; one that arrived from somewhere else lands whole; an
		// answer prints at the speed a model streams it.
		const lines = use.lines.map((line, i) => {
			if (i === last + 1) {
				from = at;
				for (const [action, detail] of use.steps ?? []) {
					steps.push({ text: `${action} ${detail}`, start: at });
					at += BEAT;
				}
			}
			const start = at;
			// A line that arrived lands whole rather than a character at a time, so the clock is the only
			// thing that can give it its reading: a beat for the arriving, and then as long as printing
			// it would have taken before anything else moves.
			at +=
				"said" in line ? line.said.length * TYPED : line.text.length + ("via" in line ? BEAT : 0);
			return { line, start };
		});
		return { lines, steps, from, total: at };
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
		["↑↓", "agents"],
		["←→", "history"],
		["^U^D", "scroll"],
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
					{/* The plane's own screens, under the agents because neither is about an agent and
					    neither is what you came here for: one feed with every agent in it, and one set of
					    keys and models. */}
					<div className="mock-plane">logs</div>
					<div className="mock-plane">config</div>
					{/* A list nothing points at does not say how to walk it, so the column says so itself. It
					    names the key that walks it from where the keyboard already is: the arrows on a
					    conversation, which is the only row this mock ever stands on. */}
					<div className="mock-how">
						<b>↑↓</b> moves
					</div>
				</div>

				<div className="mock-main">
					<div className="mock-title">
						{/* The title says which row of the column it belongs to, and nothing else: the
						    breadcrumb that stood here was a second copy of a selection the column draws. */}
						<span>
							<b>{use.name}</b>
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
						{script.lines.map(({ line, start }) => {
							const here = n > start;
							if ("said" in line) {
								return (
									<p className="mock-said" key={line.said} data-off={here ? undefined : "true"}>
										<span className="mock-mark">&gt;</span>{" "}
										<Typed text={line.said} chars={(n - start) / TYPED} />
									</p>
								);
							}
							if ("via" in line) {
								return <Came key={line.text} via={line.via} text={line.text} here={here} />;
							}
							return (
								<p key={line.text} data-off={here ? undefined : "true"}>
									{line.to === undefined ? null : (
										<>
											<span className="mock-via">‹→ {line.to}›</span>{" "}
										</>
									)}
									<Typed text={line.text} chars={n - start} />
								</p>
							);
						})}
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
