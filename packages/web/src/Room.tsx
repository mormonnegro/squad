import type { AgentSummary, Utterance } from "@squad/control-plane";
import { Trash2, UserMinus, UserPlus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Live } from "./App.tsx";
import { Avatar } from "./avatar.tsx";
import { Said } from "./Chat.tsx";
import { nameOf } from "./face.ts";
import type { Plane, Room as Standing } from "./plane.ts";
import { Spin } from "./spin.tsx";

/**
 * A room, read the way a conversation is read.
 *
 * The same thread, with more than one voice in it. Everything an operator says here is said to
 * everybody in the room and every one of them takes a turn on it, which is the whole point: a brief
 * given once, and the answers side by side where they can be compared instead of held in a head.
 *
 * What an agent answers is posted here and wakes whoever it named — nobody else. A room where every
 * answer woke everybody would be three agents being polite at each other all night, and the first
 * anybody would hear of it is the bill.
 */
export function Room({
	plane,
	room,
	agents,
	said,
	live,
	onFiles,
	onGone,
}: {
	plane: Plane;
	room: Standing;
	/** Every agent this plane has, so somebody can be added without leaving the room to find them. */
	agents: readonly AgentSummary[];
	said: readonly Utterance[];
	/** What each agent is doing, so a room of three says which of the three is working. */
	live: Record<string, Live>;
	/** Where a path named in here leads, which is into the box of whichever agent named it. */
	onFiles: (agentId: string, path: string) => void;
	/** The room is gone, so the pane has to be showing something else. */
	onGone: () => void;
}) {
	const floor = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);
	const [adding, setAdding] = useState(false);
	const [dropping, setDropping] = useState(false);
	const [why, setWhy] = useState<string | undefined>();

	// The same rule the conversation follows: keep the bottom in view while the bottom is what is
	// being read, and never move the page under somebody who has scrolled up.
	// biome-ignore lint/correctness/useExhaustiveDependencies: what changed is why it must scroll
	useLayoutEffect(() => {
		if (!following) return;
		floor.current?.scrollTo({ top: floor.current.scrollHeight });
	}, [said, live, following]);

	const working = room.members.filter((id) => live[id]?.thinking === true);
	const outside = agents.filter((agent) => !room.members.includes(agent.id));

	const run = (work: Promise<unknown>): void => {
		setWhy(undefined);
		void work.catch((error: Error) => setWhy(error.message));
	};

	return (
		<>
			<header className="pane-head">
				<span className="room-hash">#</span>
				<span className="pane-title">{room.name}</span>
				<div className="pane-facts">
					{/* Who is in it, as their own faces. A roster of three names is read at a glance as
					    three pictures and not at all as a sentence. */}
					<div className="room-who">
						{room.members.map((id) => (
							<button
								key={id}
								type="button"
								className="room-one"
								title={`${nameOf(id)} — take out of #${room.name}`}
								onClick={() => run(plane.leaveRoom(room.name, id))}
							>
								<Avatar id={id} size={22} />
								<span>{nameOf(id)}</span>
								<UserMinus className="size-3 room-off" />
							</button>
						))}
						{outside.length > 0 && (
							<button
								type="button"
								className="room-add"
								title="put another agent in this room"
								onClick={() => setAdding(!adding)}
								aria-expanded={adding}
							>
								<UserPlus className="size-3.5" />
							</button>
						)}
					</div>
					{/* Taking the room away takes its thread with it, which is why it asks. Asked here
					    rather than in a dialog over everything: the thing it is about is on the screen
					    behind the question, and reading it is most of the answer. */}
					{dropping ? (
						<span className="room-sure">
							<span>Delete #{room.name} and everything said in it?</span>
							<button
								type="button"
								className="pill"
								data-no="true"
								onClick={() => {
									setDropping(false);
									run(plane.dropRoom(room.name).then(onGone));
								}}
							>
								delete
							</button>
							<button type="button" className="pill" onClick={() => setDropping(false)}>
								keep it
							</button>
						</span>
					) : (
						<button
							type="button"
							className="room-add"
							title={`delete #${room.name}`}
							onClick={() => setDropping(true)}
						>
							<Trash2 className="size-3.5" />
						</button>
					)}
				</div>
			</header>

			{adding && outside.length > 0 && (
				<div className="room-pick">
					{outside.map((agent) => (
						<button
							key={agent.id}
							type="button"
							className="pill"
							onClick={() => {
								setAdding(false);
								run(plane.joinRoom(room.name, agent.id));
							}}
						>
							<Avatar id={agent.id} size={18} />
							{nameOf(agent.id)}
						</button>
					))}
				</div>
			)}

			<div className="floor">
				<div
					className="scroll"
					ref={floor}
					onScroll={(event) => setFollowing(atFloor(event.currentTarget))}
				>
					{said.length === 0 && (
						<div className="room-empty">
							<p>
								<strong>#{room.name}</strong> is a room.{" "}
								{room.members.length === 0
									? "Put some agents in it, and everything said here is said in front of all of them."
									: `${room.members.map((id) => nameOf(id)).join(", ")} are in it, and everything said here is said in front of all of them.`}
							</p>
							<p className="room-note">
								Name somebody with <code>@</code> and that one takes a turn on it — nobody else
								does, and that is true of what they say to each other too. A line that names no one
								is still worth writing: it stays in the thread, and they read it the next time they
								are here.
							</p>
						</div>
					)}
					{said.map((one, index) => (
						// Append-only, and nothing in an utterance is unique. The position is the identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: append-only, and there is no id
						<Said key={index} said={one} agentId={one.via ?? ""} onFiles={onFiles} />
					))}
					{working.map((id) => (
						<article key={id} className="said" data-from="agent">
							<Avatar id={id} size={34} />
							<div>
								<div className="said-who">
									<span className="said-name">{nameOf(id)}</span>
								</div>
								<div className="working">
									<Spin />
									working…
								</div>
							</div>
						</article>
					))}
				</div>
				{!following && (
					<button
						type="button"
						className="latest"
						onClick={() => {
							setFollowing(true);
							floor.current?.scrollTo({ top: floor.current.scrollHeight, behavior: "smooth" });
						}}
					>
						↓ jump to latest
					</button>
				)}
			</div>

			{why !== undefined && <p className="room-why">{why}</p>}
			<Ask room={room} onSay={(text) => plane.sayInRoom(room.name, text)} />
		</>
	);
}

/** A name being typed at the end of the line, which is the only place one can be completed. */
const NAMING = /(?:^|\s)@([a-z0-9-]*)$/i;

/**
 * The box.
 *
 * Naming somebody is what asking them is, so the names are in the box: an `@` offers whoever is in
 * the room, the way a `/` offers the commands. Without it the rule is a thing to be remembered, and
 * a message that names nobody is silence with no explanation for it.
 */
function Ask({ room, onSay }: { room: Standing; onSay: (text: string) => Promise<void> }) {
	const [draft, setDraft] = useState("");
	const [pick, setPick] = useState(0);
	// Escape puts the list away without putting the `@` away: somebody writing an email address in
	// here is not asking for a menu, and should not have to delete the word to be rid of one.
	const [shut, setShut] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);

	const typed = NAMING.exec(draft)?.[1]?.toLowerCase();
	const menu =
		shut || typed === undefined
			? []
			: room.members.filter((id) => id.toLowerCase().startsWith(typed));

	const complete = (id: string): void => {
		setDraft(draft.replace(NAMING, (whole) => `${whole.startsWith("@") ? "" : " "}@${id} `));
		setPick(0);
		box.current?.focus();
	};

	const send = (): void => {
		const said = draft.trim();
		if (said.length === 0 || room.members.length === 0) return;
		setDraft("");
		setPick(0);
		const field = box.current;
		if (field !== null) field.style.height = "auto";
		// Not awaited: the answers arrive as events, and the box should be empty and ready the moment
		// the message has gone. A refusal lands in the room's own thread, where it was asked for.
		void onSay(said).catch(() => {});
	};

	return (
		<div className="composer">
			{menu.length > 0 && (
				<div className="menu">
					{menu.map((id, index) => (
						<button
							type="button"
							key={id}
							className="menu-row"
							data-here={index === pick}
							onMouseEnter={() => setPick(index)}
							onClick={() => complete(id)}
						>
							<span className="menu-name">
								<Avatar id={id} size={18} />@{id}
							</span>
						</button>
					))}
				</div>
			)}
			<div className="box" data-mode="say">
				<span className="box-mark">#</span>
				<textarea
					ref={box}
					rows={1}
					value={draft}
					placeholder={
						room.members.length === 0
							? "Nobody is in this room yet"
							: "Say something — @ to ask somebody for it"
					}
					onChange={(event) => {
						setDraft(event.target.value);
						setPick(0);
						setShut(false);
						const field = event.target;
						field.style.height = "auto";
						field.style.height = `${field.scrollHeight}px`;
					}}
					onKeyDown={(event) => {
						if (menu.length > 0) {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								setPick(
									(was) => (was + (event.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length,
								);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setShut(true);
								return;
							}
							if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
								const chosen = menu[pick];
								if (chosen !== undefined) {
									event.preventDefault();
									complete(chosen);
									return;
								}
							}
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							send();
						}
					}}
				/>
			</div>
		</div>
	);
}

/** A few pixels of slack, for the reason the conversation has them: fractional scroll heights. */
function atFloor(box: HTMLElement): boolean {
	return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}
