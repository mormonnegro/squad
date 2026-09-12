import type { AgentStep, AgentSummary, Utterance } from "@squad/control-plane";
import { Blocks } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat } from "./Chat.tsx";
import { type Connection, HERE, keyOf, readConnections, SERVED_BY_A_PLANE } from "./connections.ts";
import { Devices } from "./Devices.tsx";
import { AddEnvironment, Environments, Picker } from "./Environments.tsx";
import { FirstKey } from "./FirstKey.tsx";
import { faceOf, nameOf } from "./face.ts";
import { Keys } from "./Keys.tsx";
import { Plugins } from "./Plugins.tsx";
import { Plane, wireTo } from "./plane.ts";
import { Setup } from "./Setup.tsx";
import { When } from "./When.tsx";

/** How often the agent list is asked for. What the console uses, for the same reason. */
const POLL_MS = 2000;

/**
 * The screens that are places rather than dialogs, and the address each one is at.
 *
 * A screen you would send somebody to needs an address: "the plugins" is a thing to link to, to
 * bookmark, to type. The rest — adding an environment, the first key — are questions raised over
 * whatever you were doing, and a question has no address.
 *
 * Not `/devices`: the plane answers that one itself, with the door a browser is let in through, and
 * a page that claimed the same path would be a page the plane never serves.
 */
const PLACES = {
	"/plugins": "plugins",
	"/keys": "keys",
} as const;

type Place = (typeof PLACES)[keyof typeof PLACES];

/** Which screen an address names, or none for an address that names no screen. */
function placeAt(pathname: string): Place | "none" {
	return PLACES[pathname as keyof typeof PLACES] ?? "none";
}

/** Where a screen lives, or nothing for the ones that are questions rather than places. */
function addressOf(showing: string): string | undefined {
	if (showing === "none") return "/";
	const found = Object.entries(PLACES).find(([, screen]) => screen === showing);
	return found?.[0];
}

/** A turn in flight: what it has said so far and what it has done to say it. */
export interface Live {
	readonly thinking: boolean;
	readonly text: string;
	readonly steps: readonly AgentStep[];
}

const QUIET: Live = { thinking: false, text: "", steps: [] };

export function App() {
	const [planes, setPlanes] = useState<readonly Connection[]>(() => readConnections());
	const [at, setAt] = useState<Connection>(() => readConnections()[0] ?? HERE);
	// The connection screens: where a first one is made, and where the rest are managed.
	const [showing, setShowing] = useState<
		"none" | "connect" | "planes" | "keys" | "plugins" | "devices" | "first-key"
	>(() => placeAt(window.location.pathname));
	/**
	 * Whether the selected agent's own settings are open.
	 *
	 * Kept apart from the screens above because it is not one: those are the environment's and this
	 * is one agent's, and it closes by itself when the conversation moves to another.
	 */
	const [setting, setSetting] = useState(false);
	/**
	 * Whether the first-key screen has been put away.
	 *
	 * Kept so that closing it closes it. Raised on its own because a plane that cannot pay for a
	 * model is not in a state anybody chose and the banner alone was a line of text competing with
	 * an empty screen — but a screen that comes back every render is not a screen, it is a wall.
	 */
	const [askedForKey, setAskedForKey] = useState(false);
	const [plane, setPlane] = useState<Plane | undefined>();
	const [down, setDown] = useState<string | undefined>();
	const [agents, setAgents] = useState<readonly AgentSummary[]>([]);
	const [talk, setTalk] = useState<Record<string, readonly Utterance[]>>({});
	const [live, setLive] = useState<Record<string, Live>>({});
	const [chosen, setChosen] = useState<string | undefined>();
	const [making, setMaking] = useState(false);
	/**
	 * Whether this plane can pay for any of the models it is configured with.
	 *
	 * Asked because the install no longer does: a fresh environment comes up holding nothing, and
	 * the way that failure arrives without this is a turn that dies at the proxy with a message
	 * about a connection. The one screen that can fix it is two clicks away and unfindable if you
	 * do not already know it is there.
	 */
	const [keyless, setKeyless] = useState(false);

	// Held in a ref as well so the event handler, which is registered once, never closes over a stale
	// one. The state copy is what the screen reads; this is what the handler writes through.
	const held = useRef<Plane | undefined>(undefined);

	/**
	 * Opens a screen, and moves the address with it where the screen has one.
	 *
	 * One function rather than two calls at every call site, because the two halves drifting apart is
	 * the whole failure: a screen opened without the address is one nobody can link to, and an address
	 * pushed without the screen is a back button that does nothing.
	 *
	 * The query is carried along. It is where the token arrives, and dropping it on the way to a
	 * screen would be logging somebody out for opening one.
	 */
	const show = useCallback((next: typeof showing): void => {
		setShowing(next);
		const address = addressOf(next);
		if (address === undefined || address === window.location.pathname) return;
		window.history.pushState(null, "", `${address}${window.location.search}`);
	}, []);

	// The other direction: back and forward are the same two keys everywhere else on the web, and a
	// page that answers to an address has to answer to them or the address is decoration.
	useEffect(() => {
		const walked = (): void => setShowing(placeAt(window.location.pathname));
		window.addEventListener("popstate", walked);
		return () => window.removeEventListener("popstate", walked);
	}, []);

	useEffect(() => {
		// A hosted copy has no plane at its own address, so before the first environment is added
		// there is nothing here to knock on. Knocking anyway spends a request to be told something
		// this build already knows, and answers the first screen somebody sees with an error about a
		// connection they never asked for.
		if (!SERVED_BY_A_PLANE && at.origin === "") return;

		let alive = true;
		const client = new Plane(wireTo(at));
		client.onDown((why) => alive && setDown(why.message));
		// The transport repairs itself, so a gap has two ends and the screen has to hear both. Without
		// this the banner said the plane was gone for as long as the page stayed open, over a console
		// that had been answering again since a second after it appeared.
		client.onUp(() => alive && setDown(undefined));

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

	const goTo = useCallback(
		(one: Connection) => {
			// Nothing survives the move. Two planes have two sets of agents with two sets of names, and a
			// transcript left on screen from the last one would be a conversation attributed to a stranger.
			setAt(one);
			setChosen(undefined);
			setAgents([]);
			setTalk({});
			setLive({});
			show("none");
		},
		[show],
	);

	const create = useCallback(async (name: string) => {
		const client = held.current;
		if (client === undefined) return;
		const made = await client.create(name);
		setAgents((was) => [...was.filter((one) => one.id !== made.id), made]);
		setChosen(made.id);
		setMaking(false);
	}, []);

	const look = useCallback(async (): Promise<void> => {
		if (plane === undefined) return;
		try {
			const providers = await plane.providers();
			// Only the ones a configured model names. A plane holding no key for a provider nothing
			// here spends is a plane with nothing wrong with it.
			const spent = providers.filter((one) => one.models.length > 0);
			setKeyless(spent.length > 0 && !spent.some((one) => one.held));
		} catch {
			// An older plane does not answer this, and a plane that cannot be asked is one whose
			// other problems are already on the screen.
			setKeyless(false);
		}
	}, [plane]);

	useEffect(() => {
		void look();
	}, [look]);

	return (
		<div className="app">
			<nav className="rail">
				<div className="rail-head">
					<Picker
						all={planes}
						at={at}
						connected={plane !== undefined}
						onPick={goTo}
						onAdd={() => show("connect")}
						onKeys={() => show("keys")}
						onPlugins={() => show("plugins")}
						onDevices={() => show("devices")}
						hasDoor={plane?.hasDoor ?? false}
						onManage={() => show("planes")}
					/>
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
								setSetting(false);
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
					{/* At the foot of the plane's own column, because that is what plugins belong to: not to
					    the agent that happens to be selected, and not inside a menu that has to be opened
					    before it can be found. */}
					<button
						type="button"
						className="foot-row"
						data-here={showing === "plugins"}
						disabled={plane === undefined}
						onClick={() => show("plugins")}
					>
						<Blocks className="size-4 flex-none" />
						<span className="row-name">Plugins</span>
					</button>
					{/* What this whole column is about, said where a column ends. The picker at the top is
					    where it is changed; this is where it is confirmed without looking up. */}
					<span className="foot-where">{at.origin === "" ? "on this computer" : at.origin}</span>
				</div>
			</nav>

			<main className="pane">
				{down !== undefined && planes.length > 1 && (
					<div className="down" role="status">
						{down} — it will come back on its own.
					</div>
				)}
				{keyless && down === undefined && (
					<div
						role="status"
						className="flex items-center gap-2 border-working/40 border-b bg-working/10 px-5 py-2 text-[0.82rem] text-working"
					>
						<span className="flex-1">
							This environment holds no key yet, so a turn stops at the model.
						</span>
						<button
							type="button"
							className="font-medium underline underline-offset-2"
							onClick={() => show("first-key")}
						>
							Add one
						</button>
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
						onSetup={() => setSetting(true)}
					/>
				) : (
					<Nothing onMake={() => setMaking(true)} />
				)}
			</main>

			{showing === "connect" && (
				<AddEnvironment
					first={planes.length <= 1}
					onAdded={(made, all) => {
						setPlanes(all);
						goTo(made);
					}}
					// Always, because this one was opened on purpose from the picker. A screen somebody
					// asked for is a screen they can change their mind about, however many environments
					// they have — the only dialog here with no way out is the first question, and only
					// while there is genuinely nothing behind it.
					onClose={() => show("none")}
				/>
			)}
			{/* Raised by itself the first time, because this is the one thing missing between a plane
			    that is running and an agent that can answer. */}
			{plane !== undefined && keyless && !askedForKey && showing === "none" && (
				<FirstKey
					plane={plane}
					onClose={() => setAskedForKey(true)}
					onDone={() => {
						setAskedForKey(true);
						void look();
					}}
				/>
			)}
			{showing === "first-key" && plane !== undefined && (
				<FirstKey
					plane={plane}
					onClose={() => show("none")}
					onDone={() => {
						show("none");
						void look();
					}}
				/>
			)}
			{showing === "devices" && plane !== undefined && (
				<Devices plane={plane} onClose={() => show("none")} />
			)}
			{showing === "keys" && plane !== undefined && (
				<Keys
					plane={plane}
					onClose={() => {
						show("none");
						void look();
					}}
				/>
			)}
			{showing === "plugins" && plane !== undefined && (
				<Plugins
					plane={plane}
					agents={agents}
					onClose={() => {
						show("none");
						void look();
					}}
				/>
			)}
			{/* One agent's, so it goes with that agent: picking another closes it rather than quietly
			    setting a limit on somebody else. */}
			{setting && plane !== undefined && agent !== undefined && (
				<Setup
					plane={plane}
					agent={agent}
					onChanged={() => void look()}
					onClose={() => setSetting(false)}
				/>
			)}
			{showing === "planes" && (
				<Environments
					all={planes}
					at={at}
					onPick={goTo}
					onForget={(all) => {
						setPlanes(all);
						if (!all.some((one) => keyOf(one) === keyOf(at))) goTo(all[0] ?? HERE);
					}}
					onAdd={() => show("connect")}
					onClose={() => show("none")}
				/>
			)}
			{/* Nothing connected and nothing to fall back to: this is not an error, it is the first
			    question, and it is the whole of what this page can usefully show. Two ways to be in
			    that state — a plane that served this page and has stopped answering, and a hosted copy
			    that has never been given an environment, which is not a failure and has no error to
			    wait for.

			    `plane === undefined` is load-bearing and was missing. A connection that dropped once
			    sets `down` and leaves the client in place, so this was raising a modal with no way out
			    over a working console, with the agents visible behind it. A screen that has a plane has
			    nothing to ask. */}
			{showing === "none" &&
				plane === undefined &&
				(planes.length === 0 || (down !== undefined && planes.length <= 1)) && (
					<AddEnvironment
						first
						onAdded={(made, all) => {
							setPlanes(all);
							goTo(made);
						}}
						// A way out as soon as there is anywhere to go. With an environment in the list
						// there is a picker behind this and another machine to try; with none there is
						// nothing this page can do but ask, and a dismissable dialog over an empty screen
						// is a dead end with a close button on it.
						onClose={planes.length > 0 ? () => show("none") : undefined}
					/>
				)}
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
