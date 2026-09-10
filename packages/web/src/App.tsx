import type { AgentStep, AgentSummary, Utterance } from "@squad/control-plane";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat } from "./Chat.tsx";
import { faceOf, nameOf } from "./face.ts";
import { browserWire, Plane } from "./plane.ts";
import { HERE, type KnownPlane, planeKey, readPlanes } from "./planes.ts";
import { When } from "./When.tsx";

/** How often the agent list is asked for. What the console uses, for the same reason. */
const POLL_MS = 2000;

/** A turn in flight: what it has said so far and what it has done to say it. */
export interface Live {
	readonly thinking: boolean;
	readonly text: string;
	readonly steps: readonly AgentStep[];
}

const QUIET: Live = { thinking: false, text: "", steps: [] };

export function App() {
	const [planes] = useState<readonly KnownPlane[]>(() => readPlanes());
	const [at, setAt] = useState<KnownPlane>(() => readPlanes()[0] ?? HERE);
	const [plane, setPlane] = useState<Plane | undefined>();
	const [down, setDown] = useState<string | undefined>();
	const [agents, setAgents] = useState<readonly AgentSummary[]>([]);
	const [talk, setTalk] = useState<Record<string, readonly Utterance[]>>({});
	const [live, setLive] = useState<Record<string, Live>>({});
	const [chosen, setChosen] = useState<string | undefined>();
	const [making, setMaking] = useState(false);

	// Held in a ref as well so the event handler, which is registered once, never closes over a stale
	// one. The state copy is what the screen reads; this is what the handler writes through.
	const held = useRef<Plane | undefined>(undefined);

	useEffect(() => {
		let alive = true;
		const client = new Plane(browserWire(at.reach.kind === "here" ? at.reach.origin : ""));
		client.onDown((why) => alive && setDown(why.message));

		void (async () => {
			try {
				await client.connect();
			} catch (error) {
				if (alive) setDown((error as Error).message);
				return;
			}
			if (!alive) {
				client.close();
				return;
			}
			held.current = client;
			setPlane(client);
			setDown(undefined);

			client.watch((event) => {
				if (!alive) return;
				switch (event.kind) {
					case "thinking":
						setLive((was) => ({ ...was, [event.agentId]: { ...QUIET, thinking: true } }));
						break;
					case "step":
						setLive((was) => {
							const one = was[event.agentId] ?? QUIET;
							return { ...was, [event.agentId]: { ...one, steps: [...one.steps, event.step] } };
						});
						break;
					case "say":
						setLive((was) => {
							const one = was[event.agentId] ?? QUIET;
							return { ...was, [event.agentId]: { ...one, text: one.text + event.text } };
						});
						break;
					case "said":
						setTalk((was) => ({
							...was,
							[event.agentId]: [...(was[event.agentId] ?? []), event.said],
						}));
						// The turn's own words have landed in the transcript, so the copy being streamed
						// beside them would be the same paragraph twice.
						if (event.said.from === "agent") setLive((was) => ({ ...was, [event.agentId]: QUIET }));
						break;
					// The three ways a turn ends, and it has to be all three: a turn that answered, a
					// turn that threw, and the answer landing in the transcript. Clearing on only the
					// last one leaves "working…" under an agent that stopped working minutes ago —
					// which is the one thing a live indicator must never say.
					case "turn":
						setLive((was) => ({ ...was, [event.agentId]: QUIET }));
						break;
					case "error":
						setLive((was) =>
							was[event.context] === undefined ? was : { ...was, [event.context]: QUIET },
						);
						break;
					case "cleared":
						setTalk((was) => ({ ...was, [event.agentId]: [] }));
						setLive((was) => ({ ...was, [event.agentId]: QUIET }));
						break;
					case "open":
						// The agent asked for a browser and this is one. Opened rather than printed,
						// because a login that needs a copied URL is a login half the time nobody finishes.
						window.open(event.url, "_blank", "noopener");
						break;
					default:
						break;
				}
			});

			await client.transcripts().then(
				(all) => alive && setTalk(all),
				() => {},
			);
		})();

		return () => {
			alive = false;
			held.current = undefined;
			client.close();
			setPlane(undefined);
		};
	}, [at]);

	// Polled rather than pushed, because spend, ports and the questions an agent is waiting on change
	// for reasons that are not a turn — a schedule firing, a webhook, a grant answered elsewhere.
	useEffect(() => {
		if (plane === undefined) return;
		let alive = true;
		const ask = (): void => {
			void plane.agents().then(
				(all) => alive && setAgents(all),
				() => {},
			);
		};
		ask();
		const timer = setInterval(ask, POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [plane]);

	const agent = useMemo(() => agents.find((one) => one.id === chosen), [agents, chosen]);

	// What the plane answered a command or a shell line with. It is said to whoever asked, on the
	// connection they asked over, so no event carries it and no other console would show it.
	const local = useCallback((agentId: string, one: Utterance) => {
		setTalk((was) => ({ ...was, [agentId]: [...(was[agentId] ?? []), one] }));
	}, []);

	const create = useCallback(async (name: string) => {
		const client = held.current;
		if (client === undefined) return;
		const made = await client.create(name);
		setAgents((was) => [...was.filter((one) => one.id !== made.id), made]);
		setChosen(made.id);
		setMaking(false);
	}, []);

	return (
		<div className="app">
			<nav className="rail">
				<div className="rail-head">
					<span className="face" aria-hidden="true">
						◇
					</span>
					<strong style={{ fontSize: "0.92rem" }}>squad</strong>
				</div>

				<div className="rail-scroll">
					<div className="group">Agents</div>
					{agents.map((one) => (
						<AgentRow
							key={one.id}
							plane={plane}
							agent={one}
							live={live[one.id] ?? QUIET}
							here={one.id === chosen}
							onPick={() => {
								setChosen(one.id);
								setMaking(false);
							}}
						/>
					))}
					<button
						type="button"
						className="row"
						data-here={making}
						onClick={() => {
							setMaking(true);
							setChosen(undefined);
						}}
					>
						<span className="mark">+</span>
						<span className="row-name">New agent</span>
					</button>
				</div>

				<div className="rail-foot">
					<span className="mark" data-state={plane === undefined ? "stopped" : "running"}>
						●
					</span>
					{/* Which machine this is looking at. One application against several planes has to
					    say which one, every time, or every screen on it means something unknown. */}
					<span className="row-name" title={planeKey(at.reach)}>
						{at.name}
					</span>
					{planes.length > 1 && (
						<select
							aria-label="Plane"
							className="row-note"
							value={planeKey(at.reach)}
							onChange={(event) => {
								const next = planes.find((one) => planeKey(one.reach) === event.target.value);
								if (next !== undefined) {
									setAt(next);
									setChosen(undefined);
									setAgents([]);
									setTalk({});
								}
							}}
						>
							{planes.map((one) => (
								<option key={planeKey(one.reach)} value={planeKey(one.reach)}>
									{one.name}
								</option>
							))}
						</select>
					)}
				</div>
			</nav>

			<main className="pane">
				{down !== undefined && (
					<div className="down" role="status">
						{down} — it will come back on its own.
					</div>
				)}
				{making ? (
					<NewAgent onMake={create} />
				) : agent !== undefined && plane !== undefined ? (
					<Chat
						key={agent.id}
						plane={plane}
						agent={agent}
						said={talk[agent.id] ?? []}
						live={live[agent.id] ?? QUIET}
						onLocal={local}
					/>
				) : (
					<Nothing onMake={() => setMaking(true)} />
				)}
			</main>
		</div>
	);
}

function AgentRow({
	plane,
	agent,
	live,
	here,
	onPick,
}: {
	plane: Plane | undefined;
	agent: AgentSummary;
	live: Live;
	here: boolean;
	onPick: () => void;
}) {
	const face = faceOf(agent.id);
	// A question nobody has answered outranks everything else this row could say. It is the one
	// state where the agent is stopped and waiting on the person reading this.
	const state =
		agent.asking.length + agent.wants.length > 0
			? "asking"
			: live.thinking
				? "busy"
				: agent.running
					? "running"
					: "stopped";
	const glyph = { asking: "?", busy: "◐", running: "●", stopped: "○" }[state];
	const heat =
		agent.limitUsd === undefined
			? undefined
			: agent.spentUsd >= agent.limitUsd
				? "hot"
				: agent.spentUsd >= agent.limitUsd * 0.8
					? "warm"
					: undefined;

	return (
		// The row is the container and the name is the button, because the countdown beside it is a
		// button too and one cannot be inside the other. They are two things anyway: one opens the
		// conversation and the other says why the agent is coming back.
		<div className="row" data-here={here}>
			<button type="button" className="row-pick" onClick={onPick}>
				<span className="mark" data-state={state}>
					{glyph}
				</span>
				<span className="face" style={{ color: `var(--${face.accent})` }} aria-hidden="true">
					{face.glyph}
				</span>
				<span className="row-name">{nameOf(agent.id)}</span>
			</button>
			{/* When it comes back, which is the one thing about a sleeping agent worth knowing and the
			    only thing nothing else on this screen says. Before the spend, because it is a fact
			    about the future and the spend is one about the day. */}
			{agent.wakeAt !== undefined && (
				<When plane={plane} agentId={agent.id} wakeAt={agent.wakeAt} />
			)}
			{agent.spentUsd > 0 && (
				<span className="row-note" data-heat={heat}>
					${agent.spentUsd.toFixed(2)}
				</span>
			)}
		</div>
	);
}

function Nothing({ onMake }: { onMake: () => void }) {
	return (
		<div className="empty">
			<span className="face" data-size="big" style={{ color: "var(--cyan)" }} aria-hidden="true">
				◇
			</span>
			<h1>Nobody is selected</h1>
			<p>
				An agent here is a container that stays running and wakes up when something happens. Pick
				one on the left, or make one.
			</p>
			<div className="cards">
				<button type="button" className="card" onClick={onMake}>
					<span className="card-glyph">＋</span>
					<span className="card-name">Create an agent</span>
				</button>
			</div>
		</div>
	);
}

/** The whole of making an agent: a name. Everything else is configured afterwards, from here. */
function NewAgent({ onMake }: { onMake: (name: string) => Promise<void> }) {
	const [name, setName] = useState("");
	const [why, setWhy] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	// The plane's own rule, checked here so the answer arrives while the cursor is still in the field.
	const ok = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);

	// Taken once, when this screen replaces the conversation. The screen is a field and a button, and
	// arriving at it with the cursor somewhere else is one keystroke of nothing.
	useEffect(() => field.current?.focus(), []);

	return (
		<div className="empty">
			<h1>New agent</h1>
			<p>
				A name, and ⏎ builds it: a container, a repository of its own, and a conversation that
				starts empty.
			</p>
			<form
				style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}
				onSubmit={(event) => {
					event.preventDefault();
					if (!ok || busy) return;
					setBusy(true);
					setWhy(undefined);
					void onMake(name).catch((error: Error) => {
						setWhy(error.message);
						setBusy(false);
					});
				}}
			>
				<input
					ref={field}
					className="field"
					value={name}
					disabled={busy}
					placeholder="scout"
					onChange={(event) => setName(event.target.value)}
				/>
				{name.length > 0 && !ok && (
					<span className="why">
						Lowercase letters, digits and dashes, starting with a letter or digit.
					</span>
				)}
				{why !== undefined && <span className="why">{why}</span>}
				<div className="ask-keys">
					<button type="submit" className="key" data-yes="true" disabled={!ok || busy}>
						{busy ? "building…" : "⏎ build"}
					</button>
				</div>
			</form>
		</div>
	);
}
