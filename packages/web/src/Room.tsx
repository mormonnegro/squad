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
	onGone,
}: {
	plane: Plane;
	room: Standing;
	/** Every agent this plane has, so somebody can be added without leaving the room to find them. */
	agents: readonly AgentSummary[];
	said: readonly Utterance[];
	/** What each agent is doing, so a room of three says which of the three is working. */
	live: Record<string, Live>;
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
									? "Put some agents in it, and what you say here is said to all of them."
									: `What you say here is said to ${room.members.map((id) => nameOf(id)).join(", ")} at once — each of them takes a turn on it, and every answer lands in this thread.`}
							</p>
							<p className="room-note">
								They can reach each other from in here: an agent that writes <code>@name</code> in
								its answer wakes that one, and nobody else.
							</p>
						</div>
					)}
					{said.map((one, index) => (
						// Append-only, and nothing in an utterance is unique. The position is the identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: append-only, and there is no id
						<Said key={index} said={one} agentId={one.via ?? ""} />
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

/** The box, which says who is about to be woken, because in a room that is several agents. */
function Ask({ room, onSay }: { room: Standing; onSay: (text: string) => Promise<void> }) {
	const [draft, setDraft] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);

	const send = (): void => {
		const said = draft.trim();
		if (said.length === 0 || room.members.length === 0) return;
		setDraft("");
		const field = box.current;
		if (field !== null) field.style.height = "auto";
		// Not awaited: the answers arrive as events, and the box should be empty and ready the moment
		// the message has gone. A refusal lands in the room's own thread, where it was asked for.
		void onSay(said).catch(() => {});
	};

	return (
		<div className="composer">
			<div className="box" data-mode="say">
				<span className="box-mark">#</span>
				<textarea
					ref={box}
					rows={1}
					value={draft}
					placeholder={
						room.members.length === 0
							? "Nobody is in this room yet"
							: `Say something to ${room.members.length} agent${room.members.length === 1 ? "" : "s"}`
					}
					onChange={(event) => {
						setDraft(event.target.value);
						const field = event.target;
						field.style.height = "auto";
						field.style.height = `${field.scrollHeight}px`;
					}}
					onKeyDown={(event) => {
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
