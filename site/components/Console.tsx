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
import { type Lang, type Text, useLang } from "../lib/lang";
import { useReveal } from "../lib/reveal";

// Anything the pane prints: a pair when it is something a person or an agent said, and a bare string
// when it reads the same in either language — a command, a path, a tool's own name.
type Say = string | Text;

function say(what: Say, lang: Lang): string {
	return typeof what === "string" ? what : what[lang];
}

// One line of the pane, in the order it appeared: typed at this console, arrived from a channel, or
// the agent answering. A case is a sequence rather than a question and an answer, because what a
// visitor is deciding about is the middle — the part where nobody was at the keyboard.
type Line = { said: Say } | { via: string; text: Say } | { text: Say; to?: string };

/** That same line with its language already chosen, which is what the pane prints and measures. */
type Read = { said: string } | { via: string; text: string } | { text: string; to?: string };

// One agent per job, because that is what a plane looks like: the sidebar is the set of examples,
// and every case opens with the thing an operator asked for — the part a visitor is deciding about.
type Use = {
	name: string;
	// The tab is the site's own word for the example, not something the console prints, so it is
	// written in both languages while everything inside the pane stays as the program says it.
	label: Text;
	spend: string;
	// A spend is dim until it is worth reading: amber at four fifths of the ceiling, red at it.
	heat?: "warn";
	// The turn it has booked, counted down: an hour every day, an hour on a weekday, or a plain offset.
	next?: string | { day?: number; hour: number };
	model: string;
	limit: string;
	lines: [Line, ...Line[]];
	// What it reached for, as the row under the conversation says it: what it is, and what it is on.
	// They belong to the last turn of the case, which is the one the pane is still printing.
	steps?: [string, Say][];
	// How long the turn took, for the clock that row carries.
	took?: number;
	// Typed at it while it was still working, and waiting where the hand left it.
	queued?: Say;
};

const USES: [Use, ...Use[]] = [
	{
		name: "brief",
		label: { en: "the morning brief", es: "el resumen de la mañana" },
		spend: "$1.10",
		next: { hour: 8 },
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{
				said: {
					en: "every morning at 8, read the board and mail me the things that are stuck on me",
					es: "todas las mañanas a las 8, lee el tablero y mándame por correo lo que está frenado en mí",
				},
			},
			{
				text: {
					en: "Booked for 08:00, every day. I keep what I sent yesterday, so tomorrow's is what changed rather than the same list again.",
					es: "Agendado para las 08:00, todos los días. Guardo lo que te mandé ayer, así lo de mañana es lo que cambió y no la misma lista otra vez.",
				},
			},
			{
				via: "wake",
				text: {
					en: "08:00 · read the board, mail the short list",
					es: "08:00 · leer el tablero, mandar la lista corta",
				},
			},
			{
				to: "email",
				text: {
					en: "Two things. ENG-403 has been waiting on your review since Tuesday, and the release branch has had a red check since Friday with nobody on it. The other nine are moving.",
					es: "Dos cosas. ENG-403 espera tu revisión desde el martes, y la rama de release tiene un check en rojo desde el viernes sin nadie encima. Las otras nueve avanzan.",
				},
			},
		],
		steps: [
			["linear", "list_issues · ENG"],
			["github", "list_pull_requests · squad"],
			["read", "memory/brief/yesterday.md"],
			["email", { en: "you · “Two things are on you”", es: "a ti · «Dos cosas dependen de ti»" }],
		],
		took: 141,
	},
	{
		name: "builds",
		label: { en: "fix a failing check", es: "arreglar un check roto" },
		spend: "$4.80",
		heat: "warn",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{
				said: {
					en: "when a check fails on a pull request, work out why and fix it",
					es: "cuando falle un check en un pull request, averigua por qué y arréglalo",
				},
			},
			{
				text: {
					en: "Watching. GitHub calls my webhook the moment one goes red, and that is what wakes me — nobody has to be at this console.",
					es: "Ya lo vigilo. GitHub llama a mi webhook en cuanto uno se pone en rojo, y eso es lo que me despierta: nadie tiene que estar en esta consola.",
				},
			},
			{
				via: "github",
				text: {
					en: "pull_request #212 · checks failed",
					es: "pull_request #212 · checks en rojo",
				},
			},
			{
				text: {
					en: "The new test asserts the error string I changed on Tuesday, not the behaviour. Fixed the assertion, pushed to the branch, and said as much on the pull request.",
					es: "El test nuevo comprueba el mensaje de error que cambié el martes, no el comportamiento. Corregí la comprobación, la subí a la rama y lo dejé dicho en el pull request.",
				},
			},
			{
				text: {
					en: "The issue body it came from is quoted, never obeyed — nobody who can open a pull request can give me an instruction.",
					es: "El texto del issue del que salió se cita, nunca se obedece: quien puede abrir un pull request no puede darme una instrucción.",
				},
			},
		],
		steps: [
			["bash", "pnpm -r test"],
			["read", "packages/control-plane/src/turn.ts"],
			["write", "test/turn.test.ts"],
			["bash", "git commit && git push"],
		],
		took: 98,
		queued: { en: "does the same test fail on main?", es: "¿el mismo test falla en main?" },
	},
	{
		name: "tickets",
		label: { en: "reproduce a bug", es: "reproducir un bug" },
		spend: "$0.42",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{
				said: {
					en: "when a bug lands on the ENG board, try to reproduce it before I look at it",
					es: "cuando entre un bug al tablero ENG, intenta reproducirlo antes de que yo lo mire",
				},
			},
			{
				text: {
					en: "Watching. Reproducing it means running it — the repository is on this machine and I am root on it, so I can install whatever the steps ask for.",
					es: "Ya lo vigilo. Reproducirlo es ejecutarlo: el repositorio está en esta máquina y soy root en ella, así que puedo instalar lo que pidan los pasos.",
				},
			},
			{
				via: "linear",
				text: {
					en: "ENG-419 · “export hangs on files over 50 MB”",
					es: "ENG-419 · «la exportación se cuelga con archivos de más de 50 MB»",
				},
			},
			{
				to: "linear",
				text: {
					en: "Not the size. A row with no trailing newline hangs the parser, at any size — the shortest file that does it is on the ticket, and so is the failing test.",
					es: "No es el tamaño. Una fila sin salto de línea al final cuelga el parser, mida lo que mida: el archivo más corto que lo provoca está en el ticket, y el test que falla también.",
				},
			},
		],
		steps: [
			["linear", "get_issue · ENG-419"],
			["bash", "pnpm build && ./export fixtures/rows.csv"],
			["write", "test/export.test.ts"],
			["linear", "create_comment · ENG-419"],
		],
		took: 260,
	},
	{
		name: "sales",
		label: { en: "draft the outbound", es: "escribir el primer mail" },
		spend: "$2.40",
		next: { hour: 9 },
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{
				said: {
					en: "every signup on a company domain: find out what they do and draft me the first mail",
					es: "cada alta con dominio de empresa: averigua a qué se dedican y escríbeme el primer correo",
				},
			},
			{
				text: {
					en: "I will send none of them. You get the drafts and press send — I hold the mailbox, you hold that button.",
					es: "No voy a enviar ninguno. Los borradores te llegan a ti y tú das a enviar: el buzón es mío, ese botón es tuyo.",
				},
			},
			{
				via: "wake",
				text: {
					en: "09:00 · eleven signups since yesterday",
					es: "09:00 · once altas desde ayer",
				},
			},
			{
				to: "email",
				text: {
					en: "Four worth writing to, drafted below, each with the line I would open on and where I read it. The other seven are personal addresses or already paying.",
					es: "Cuatro valen la pena, con el borrador abajo, cada uno con la frase con la que abriría y dónde la leí. Las otras siete son direcciones personales o ya pagan.",
				},
			},
		],
		steps: [
			[
				"web_search",
				{
					en: "acme.io · pricing, changelog, who they hired",
					es: "acme.io · precios, changelog, a quién contrataron",
				},
			],
			["hubspot", "search_contacts · acme.io"],
			["write", "memory/sales/2026-08-28.md"],
			[
				"email",
				{
					en: "you · “Four drafts, ready to send”",
					es: "a ti · «Cuatro borradores, listos para enviar»",
				},
			],
		],
		took: 318,
	},
	{
		name: "server",
		label: { en: "ask it anything", es: "preguntarle lo que sea" },
		spend: "$0.06",
		model: "deepseek-v4-flash",
		limit: "$5.00",
		lines: [
			{
				said: {
					en: "what is eating the disk on this box",
					es: "qué se está comiendo el disco en esta máquina",
				},
			},
			{
				text: {
					en: "38 of the 40 GB is /var/lib/docker, and 21 of those are build cache for images nothing tags any more.",
					es: "38 de los 40 GB son /var/lib/docker, y 21 de esos son caché de build de imágenes que ya nadie etiqueta.",
				},
			},
			{ said: { en: "prune it", es: "límpialo" } },
			{
				text: {
					en: "21 GB back, and the box is at 45%. That ran as root on this agent's own machine, so there was nothing outside it to get wrong.",
					es: "21 GB de vuelta, y la máquina está al 45%. Eso corrió como root en la máquina propia de este agente, así que no había nada fuera de ella que estropear.",
				},
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

/** The next time that hour comes round, on any day or on the one weekday the appointment names. */
function booked(at: { day?: number; hour: number }, now: number): number {
	const when = new Date(now);
	when.setHours(at.hour, 0, 0, 0);
	if (at.day === undefined) {
		if (when.getTime() <= now) when.setDate(when.getDate() + 1);
		return when.getTime();
	}
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
	const { lang } = useLang();
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
		// Read in the language the page is in, before any of it is measured: a line takes as long to
		// print as it is long, and the same sentence is not the same length twice.
		const said: Read[] = use.lines.map((line) =>
			"said" in line
				? { said: say(line.said, lang) }
				: "via" in line
					? { via: line.via, text: say(line.text, lang) }
					: { text: say(line.text, lang), to: line.to },
		);
		// The last turn is the one the pane is still taking, so the tools belong after the last line
		// that arrived — everything before that has already been answered.
		const last = said.reduce((at, line, i) => ("text" in line && !("via" in line) ? at : i), 0);
		let at = 0;
		let from = 0;
		const steps: { text: string; start: number }[] = [];
		// A line typed at this prompt is typed; one that arrived from somewhere else lands whole; an
		// answer prints at the speed a model streams it.
		const lines = said.map((line, i) => {
			if (i === last + 1) {
				from = at;
				for (const [action, detail] of use.steps ?? []) {
					steps.push({ text: `${action} ${say(detail, lang)}`, start: at });
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
	}, [use, lang]);

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
						{u.label[lang]}
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
							<span className="mock-dots">⋯</span> {say(use.queued, lang)}
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
