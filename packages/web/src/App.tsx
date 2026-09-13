import type { AgentStep, AgentSummary, Utterance } from "@squad/control-plane";
import { Blocks, ChevronRight, GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "./avatar.tsx";
import { Chat } from "./Chat.tsx";
import { Devices } from "./Devices.tsx";
import { FirstKey } from "./FirstKey.tsx";
import { nameOf } from "./face.ts";
import { Keys } from "./Keys.tsx";
import { Modal } from "./Modal.tsx";
import { Plugins } from "./Plugins.tsx";
import { browserWire, Plane, roomChannel, type Room as Standing } from "./plane.ts";
import { RailHead } from "./RailHead.tsx";
import { Repos } from "./Repos.tsx";
import { Room } from "./Room.tsx";
import { Setup } from "./Setup.tsx";
import { Spin } from "./spin.tsx";
import { Tasks } from "./Tasks.tsx";
import { until } from "./until.ts";

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
	"/repos": "repos",
	"/keys": "keys",
} as const;

type Place = (typeof PLACES)[keyof typeof PLACES];

/** Which screen an address names, or none for an address that names no screen. */
function placeAt(pathname: string): Place | "none" {
	return PLACES[pathname as keyof typeof PLACES] ?? "none";
}

/**
 * Where a conversation lives, under a prefix rather than at the top.
 *
 * `/scout` would have been shorter and would have made every agent a claim on a path this page may
 * want for something else — `plugins` is a legal name for an agent, and an agent called that would
 * have taken the plugins screen with it. A prefix costs seven characters and settles it forever.
 */
const AGENTS = "/agents/";

/** Whose conversation an address names, or nobody for an address that names none. */
function agentAt(pathname: string): string | undefined {
	if (!pathname.startsWith(AGENTS)) return undefined;
	const id = decodeURIComponent(pathname.slice(AGENTS.length));
	return id === "" ? undefined : id;
}

/**
 * Where a room lives. `channels` rather than `rooms` in the address, because that is the word on
 * the screen — what a person would type is what they were shown.
 */
const ROOMS = "/channels/";

/** Which room an address names, or none. */
function roomAt(pathname: string): string | undefined {
	if (!pathname.startsWith(ROOMS)) return undefined;
	const name = decodeURIComponent(pathname.slice(ROOMS.length));
	return name === "" ? undefined : name;
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
	/**
	 * Which screen is up over the conversation, if any.
	 *
	 * There is one plane: the one that served this page. What used to be here as well was a list of
	 * machines and the screens for keeping it — added, named, handed over as a pasted code, picked
	 * between on every open — and it is gone until running one squad is simple enough to be worth
	 * pointing at several.
	 */
	const [showing, setShowing] = useState<
		"none" | "keys" | "plugins" | "repos" | "devices" | "first-key"
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
	// Read off the address, so a link to a conversation opens that conversation.
	const [chosen, setChosen] = useState<string | undefined>(() => agentAt(window.location.pathname));
	const [making, setMaking] = useState(false);
	/** The rooms, and which one is open. A room is a place like a conversation, not a screen over one. */
	const [rooms, setRooms] = useState<readonly Standing[]>([]);
	const [inRoom, setInRoom] = useState<string | undefined>(() => roomAt(window.location.pathname));
	const [makingRoom, setMakingRoom] = useState(false);
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
	const show = useCallback(
		(next: typeof showing, who?: string | null): void => {
			setShowing(next);
			// A screen and a room are the two things that can hold the pane, and only one of them can:
			// opening either is leaving the other, and a rail that stayed lit on both would be lying
			// about where you are.
			setInRoom(undefined);
			setMakingRoom(false);
			// Putting a screen away is going back to what the pane was showing, which is a conversation
			// or nobody — and `null` is how a caller says nobody while somebody is still selected.
			const at = who === undefined ? chosen : (who ?? undefined);
			const address =
				next === "none" ? (at === undefined ? "/" : `${AGENTS}${at}`) : addressOf(next);
			if (address === undefined || address === window.location.pathname) return;
			window.history.pushState(null, "", `${address}${window.location.search}`);
		},
		[chosen],
	);

	// The other direction: back and forward are the same two keys everywhere else on the web, and a
	// page that answers to an address has to answer to them or the address is decoration.
	useEffect(() => {
		// Screen and conversation together, because they are one thing on the screen: walking back out
		// of the plugins and walking back into the last conversation are the same key, and it has to
		// land on what the address says rather than on half of it.
		const walked = (): void => {
			const at = window.location.pathname;
			setShowing(placeAt(at));
			setChosen(agentAt(at));
			setInRoom(roomAt(at));
			setMaking(false);
			setMakingRoom(false);
			setSetting(false);
		};
		window.addEventListener("popstate", walked);
		return () => window.removeEventListener("popstate", walked);
	}, []);

	useEffect(() => {
		let alive = true;
		const client = new Plane(browserWire());
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
					// A roster changed, here or at another console. Asked for again rather than patched:
					// four names cost nothing to fetch and there is one true answer.
					case "rooms":
						void held.current?.rooms().then(
							(all) => alive && setRooms(all),
							() => {},
						);
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
			await client.rooms().then(
				(all) => alive && setRooms(all),
				// An older plane does not know what a room is, and a console talking to one shows none.
				() => {},
			);
		})();

		return () => {
			alive = false;
			held.current = undefined;
			client.close();
			setPlane(undefined);
		};
	}, []);

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
	// The open room as the plane last described it, so adding somebody to it redraws the roster
	// under the thread rather than only in the rail.
	const room = useMemo(() => rooms.find((one) => one.name === inRoom), [rooms, inRoom]);

	// A refusal, which is the one thing the plane does not write down: it comes back as the failed
	// answer to the request that asked, on the connection that asked, so no event carries it and no
	// other console would show it. Everything that succeeded is on the feed already.
	const local = useCallback((agentId: string, one: Utterance) => {
		setTalk((was) => ({ ...was, [agentId]: [...(was[agentId] ?? []), one] }));
	}, []);

	const create = useCallback(
		async (name: string) => {
			const client = held.current;
			if (client === undefined) return;
			const made = await client.create(name);
			setAgents((was) => [...was.filter((one) => one.id !== made.id), made]);
			setChosen(made.id);
			setMaking(false);
			show("none", made.id);
		},
		[show],
	);

	/**
	 * Opens a room, which is a place and so has an address.
	 *
	 * Its own function rather than another argument to `show`, because a room is not a screen over
	 * the conversation: it is the thing in the pane, the way a conversation is. What they share is
	 * that opening either one puts the other away.
	 */
	const openRoom = useCallback((name: string): void => {
		setInRoom(name);
		setShowing("none");
		setChosen(undefined);
		setMaking(false);
		setMakingRoom(false);
		setSetting(false);
		const address = `${ROOMS}${name}`;
		if (address !== window.location.pathname) {
			window.history.pushState(null, "", `${address}${window.location.search}`);
		}
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
					<RailHead
						connected={plane !== undefined}
						onKeys={() => show("keys")}
						onPlugins={() => show("plugins")}
						onAccess={() => show("devices")}
					/>
				</div>

				<div className="rail-scroll">
					{/* Above the agents, because it is not one of them: the plugins are the plane's, and the
					    list below has no end anybody scrolls to. */}
					<button
						type="button"
						className="rail-screen"
						data-here={showing === "plugins"}
						disabled={plane === undefined}
						onClick={() => show("plugins")}
					>
						<span className="row-icon">
							<Blocks className="size-4" />
						</span>
						<span className="row-name">Plugins</span>
					</button>
					<button
						type="button"
						className="rail-screen"
						data-here={showing === "repos"}
						disabled={plane === undefined}
						onClick={() => show("repos")}
					>
						<span className="row-icon">
							<GitBranch className="size-4" />
						</span>
						<span className="row-name">Repositories</span>
					</button>

					<div className="rail-group">Agents</div>
					{agents.map((one) => (
						<AgentRow
							key={one.id}
							plane={plane}
							agent={one}
							live={live[one.id] ?? QUIET}
							onChanged={() => void look()}
							// Where you are, not what you last opened: the plugins take the pane, so while they
							// are up nothing in this list is the thing on screen. A dialog is different — the
							// conversation is still behind it, and that is still where you are.
							here={one.id === chosen && showing === "none" && !making}
							onPick={() => {
								setChosen(one.id);
								setMaking(false);
								setSetting(false);
								show("none", one.id);
							}}
						/>
					))}
					<button
						type="button"
						className="row row-line"
						data-here={making}
						onClick={() => {
							setMaking(true);
							setChosen(undefined);
							show("none", null);
						}}
					>
						<span className="row-icon">+</span>
						<span className="row-name">New agent</span>
					</button>

					{/* Below the agents, because a room is made out of them: you have agents, and then you
					    put some of them in a room together. */}
					<div className="rail-group">Channels</div>
					{rooms.map((one) => (
						<button
							key={one.name}
							type="button"
							className="row row-line"
							data-here={one.name === inRoom}
							onClick={() => openRoom(one.name)}
						>
							<span className="row-icon row-hash">#</span>
							<span className="row-name">{one.name}</span>
							{/* Who is in it, small. A room is its members, and a list of names with no faces
							    is a list of rooms nobody can tell apart. */}
							<span className="row-faces">
								{one.members.slice(0, 3).map((id) => (
									<Avatar key={id} id={id} size={16} />
								))}
								{one.members.length > 3 && (
									<span className="row-note">+{one.members.length - 3}</span>
								)}
							</span>
						</button>
					))}
					<button
						type="button"
						className="row row-line"
						data-here={makingRoom}
						disabled={plane === undefined}
						onClick={() => {
							setMakingRoom(true);
							setInRoom(undefined);
						}}
					>
						<span className="row-icon">+</span>
						<span className="row-name">New channel</span>
					</button>
				</div>
			</nav>

			<main className="pane">
				{down !== undefined && (
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
							This plane holds no key yet, so a turn stops at the model.
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
				) : room !== undefined && plane !== undefined ? (
					<Room
						key={room.name}
						plane={plane}
						room={room}
						agents={agents}
						said={talk[roomChannel(room.name)] ?? []}
						live={live}
						onGone={() => show("none", null)}
					/>
				) : showing === "plugins" && plane !== undefined ? (
					<Plugins plane={plane} agents={agents} />
				) : showing === "repos" && plane !== undefined ? (
					<Repos plane={plane} agents={agents} />
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
			{makingRoom && plane !== undefined && (
				<NewRoom
					agents={agents}
					onClose={() => setMakingRoom(false)}
					onMake={async (name, members) => {
						await plane.makeRoom(name, members);
						setRooms(await plane.rooms());
						openRoom(name);
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
			{/* One agent's, so it goes with that agent: picking another closes it rather than quietly
			    setting a limit on somebody else. */}
			{setting && plane !== undefined && agent !== undefined && (
				<Setup
					plane={plane}
					agent={agent}
					agents={agents}
					onChanged={() => void look()}
					onClose={() => setSetting(false)}
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
	onChanged,
}: {
	plane: Plane | undefined;
	agent: AgentSummary;
	live: Live;
	here: boolean;
	onPick: () => void;
	onChanged: () => void;
}) {
	// Shut, and per row: an agent's week is worth a look when you are thinking about that agent, and
	// twelve of them open at once is a wall. Whether it is open is this console's business and not
	// the plane's, so it is state here and nothing is remembered about it anywhere.
	const [open, setOpen] = useState(false);
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
	// The word for it, since the dot itself is a colour. On the dot rather than in the row: four
	// states in four colours is legible at a glance and unreadable to somebody who needs the word.
	const says = {
		asking: "waiting on you",
		busy: "working",
		running: "running",
		stopped: "stopped",
	}[state];
	const heat =
		agent.limitUsd === undefined
			? undefined
			: agent.spentUsd >= agent.limitUsd
				? "hot"
				: agent.spentUsd >= agent.limitUsd * 0.8
					? "warm"
					: undefined;

	return (
		// The row is the container and the name is the button, because the chevron beside it is a
		// button too and one cannot be inside the other. They are two things anyway: one opens the
		// conversation and the other opens what the agent is going to do without leaving the one you
		// are reading.
		<>
			<div className="row" data-here={here} data-open={open}>
				<button type="button" className="row-pick" onClick={onPick}>
					{/* On the face rather than beside it. A column of its own put every name in this rail
					    fourteen pixels further from the edge to say a thing that fits in the corner of
					    the picture it is about — which is where every program that has ever drawn who is
					    online puts it. */}
					<span className="row-icon">
						<Avatar id={agent.id} />
						<span className="mark" data-state={state} title={says} />
					</span>
					<span className="row-name">{nameOf(agent.id)}</span>
				</button>
				{/* When it comes back, which is the one thing about a sleeping agent worth knowing and
				    the only thing nothing else on this screen says. Before the spend, because it is a
				    fact about the future and the spend is one about the day. */}
				{agent.wakeAt !== undefined && <span className="row-note when">{until(agent.wakeAt)}</span>}
				{agent.spentUsd > 0 && (
					<span className="row-note" data-heat={heat}>
						${agent.spentUsd.toFixed(2)}
					</span>
				)}
				<button
					type="button"
					className="row-open"
					aria-label={`${nameOf(agent.id)}'s tasks`}
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				>
					<ChevronRight className="size-3.5" />
				</button>
			</div>
			{open && <Tasks plane={plane} agentId={agent.id} onChanged={onChanged} />}
		</>
	);
}

/**
 * Making a room: a name, and who is in it.
 *
 * Both at once rather than a room first and members after, because a room with nobody in it does
 * nothing at all — the first thing anybody would type into it goes nowhere — and the question "who
 * is this for" is the one that makes a person pick a name.
 */
function NewRoom({
	agents,
	onMake,
	onClose,
}: {
	agents: readonly AgentSummary[];
	onMake: (name: string, members: readonly string[]) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [members, setMembers] = useState<readonly string[]>([]);
	const [why, setWhy] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const ok = /^[a-z0-9][a-z0-9-]{0,30}$/.test(name);

	return (
		<Modal wide title="New channel" onClose={onClose}>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!ok || busy) return;
					setBusy(true);
					setWhy(undefined);
					void onMake(name, members).catch((error: Error) => {
						setWhy(error.message);
						setBusy(false);
					});
				}}
			>
				<label className="flex flex-col gap-1.5">
					<span className="text-[0.78rem] text-muted">Name</span>
					<div className="flex items-center gap-2">
						<span className="room-hash">#</span>
						<input
							className="field font-mono"
							value={name}
							// biome-ignore lint/a11y/noAutofocus: a dialog with one first field, opened on purpose
							autoFocus
							placeholder="standup"
							spellCheck={false}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					{name.length > 0 && !ok && (
						<span className="why">
							Lowercase letters, digits and dashes, starting with a letter or digit.
						</span>
					)}
				</label>
				<div className="flex flex-col gap-1.5">
					<span className="text-[0.78rem] text-muted">Who is in it</span>
					<div className="flex flex-wrap gap-1.5">
						{agents.map((one) => (
							<button
								key={one.id}
								type="button"
								className="pill"
								data-yes={members.includes(one.id)}
								onClick={() =>
									setMembers((was) =>
										was.includes(one.id) ? was.filter((id) => id !== one.id) : [...was, one.id],
									)
								}
							>
								<Avatar id={one.id} size={18} />
								{nameOf(one.id)}
							</button>
						))}
					</div>
					<span className="text-[0.78rem] text-muted leading-relaxed">
						Everything said in a channel is said in front of all of them. Naming one with{" "}
						<code>@</code> is what asks it for something: that one takes a turn, nobody else does,
						and the same is true of what they say to each other in there.
					</span>
				</div>
				{why !== undefined && <span className="why">{why}</span>}
				<div className="flex gap-2">
					<button type="submit" className="pill" data-yes="true" disabled={!ok || busy}>
						{busy && <Spin />}
						{busy ? "making…" : "make it"}
					</button>
					<button type="button" className="pill" onClick={onClose}>
						cancel
					</button>
				</div>
			</form>
		</Modal>
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
