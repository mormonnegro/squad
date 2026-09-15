import type { AgentSummary, Utterance } from "@squad/control-plane";
import { FolderOpen, Settings2, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Live } from "./App.tsx";
import { Avatar } from "./avatar.tsx";
import { BoxIs, paths } from "./box.tsx";
import { type Command, completing, completions, isCommand, isShell } from "./commands.ts";
import { FILES_HOME } from "./Files.tsx";
import { nameOf } from "./face.ts";
import { Markdown } from "./markdown.tsx";
import type { Plane } from "./plane.ts";
import { safeEnd } from "./safe-end.ts";
import { useServedAt } from "./served.tsx";
import { Spin } from "./spin.tsx";

/** Enough marks to say who was read, before the row turns into the list it is summarising. */
const MOST_MARKS = 5;

export function Chat({
	plane,
	agent,
	said,
	live,
	onLocal,
	onSetup,
	onFiles,
}: {
	plane: Plane;
	agent: AgentSummary;
	said: readonly Utterance[];
	live: Live;
	onLocal: (agentId: string, said: Utterance) => void;
	onSetup: () => void;
	/**
	 * What it has in its box: what it built, what it wrote down, what you left it.
	 *
	 * Takes the agent and the folder rather than neither, because the button in the header is no
	 * longer the only way in here: every path in every message is one, and it opens the folder that
	 * message named. The agent is an argument for the same reason a room needs it to be — what is
	 * said in one is said by several, and a path in it leads into whichever of them wrote it.
	 */
	onFiles: (agentId: string, path: string) => void;
}) {
	// Where each port it opened is read: the same answer the rail draws and the same one a `/serve`
	// in the conversation below is drawn with, asked once and held for the page.
	const servedAt = useServedAt();
	const floor = useRef<HTMLDivElement>(null);
	// Whether the bottom is what is being read. It is, until somebody scrolls away from it.
	const [following, setFollowing] = useState(true);

	// Before paint rather than after, so a turn arriving never shows the previous bottom of the
	// conversation for a frame on its way past. And only while the bottom is where the reader is:
	// an agent that wakes itself every minute posts while somebody is reading upward, and a pane
	// that jumps on every event is one that cannot be read at all.
	// biome-ignore lint/correctness/useExhaustiveDependencies: what changed is why it must scroll
	useLayoutEffect(() => {
		if (!following) return;
		floor.current?.scrollTo({ top: floor.current.scrollHeight });
	}, [said, live, following]);

	return (
		<>
			<header className="pane-head">
				<Avatar id={agent.id} />
				<span className="pane-title">{nameOf(agent.id)}</span>
				<div className="pane-facts">
					{agent.model !== undefined && <span>{agent.model}</span>}
					{/* An agent that booked its own next turn is not idle, it is waiting, and those read
					    identically on a screen that only says whether it is running. */}
					{/* A name of that port's own, and never this console's: a page an agent wrote, read at
					    the address this console is read at, is a page the browser would hand this session
					    to. The door says which name, because it is built out of the address the door is
					    reached at and that is not always the address this page is read at. */}
					{agent.served.map((one) => (
						<a
							key={one.port}
							href={servedAt(agent.id, one.port)}
							target="_blank"
							rel="noreferrer"
							title={`what ${nameOf(agent.id)} is serving on ${one.port}`}
						>
							:{one.port}
						</a>
					))}
					<span>
						${agent.spentUsd.toFixed(2)}
						{agent.limitUsd !== undefined && ` / $${agent.limitUsd.toFixed(2)}`}
					</span>
					{/* The facts to the left of this are the ones this button sets: the model it thinks
					    with and the ceiling it spends against are read here and changed there, which is
					    why it sits at the end of them rather than anywhere else on the screen. */}
					{/* Beside the settings because they are the two other rooms of the same agent: what it
					    is set to, and what it has got. The conversation says what it did; this is where
					    what it did ended up. */}
					<button
						type="button"
						className="pane-gear"
						onClick={() => onFiles(agent.id, FILES_HOME)}
						title="Files"
					>
						<FolderOpen className="size-3.5" />
					</button>
					<button type="button" className="pane-gear" onClick={onSetup} title="Settings">
						<Settings2 className="size-3.5" />
					</button>
				</div>
			</header>

			<div className="floor">
				<div
					className="scroll"
					ref={floor}
					onScroll={(event) => setFollowing(atFloor(event.currentTarget))}
				>
					{said.map((one, index) => (
						// Nothing in an utterance is unique — the same agent can say the same word twice in a
						// row — and the list only ever grows at the end, so the position is the identity.
						<Said
							// biome-ignore lint/suspicious/noArrayIndexKey: append-only, and there is no id
							key={index}
							said={one}
							agentId={agent.id}
							onFiles={onFiles}
							// Whether it stands alone is not something a line knows about itself: it is the
							// two beside it that decide, and this is the only place both are in hand.
							run={sameRun(said[index - 1], one)}
							ends={!sameRun(one, said[index + 1])}
						/>
					))}

					{(live.thinking || live.steps.length > 0 || live.text.length > 0) && (
						<Turn agentId={agent.id} live={live} onFiles={onFiles} />
					)}

					{agent.asking.map((host) => (
						<Ask
							key={`reach:${host}`}
							what={
								<>
									<strong>{nameOf(agent.id)}</strong> wants to reach <code>{host}</code> on its way
									out.
								</>
							}
							onAnswer={(open) => void plane.answerReach(agent.id, host, open)}
						/>
					))}
					{agent.wants.map((to) => (
						<Ask
							key={`talk:${to}`}
							what={
								<>
									<strong>{nameOf(agent.id)}</strong> wants to write to <code>{to}</code>. A message
									wakes that agent and spends its ceiling.
								</>
							}
							onAnswer={(open) => void plane.answerTalk(agent.id, to, open)}
						/>
					))}
					{/* Written, and waiting. Unlike the two above it, what is being decided here is not
					    whether a door opens but whether these exact words leave — so they are on the
					    screen, whole, above the keys. */}
					{agent.sending.map((held, index) => (
						<Ask
							// The place in the list is the identity: the same sentence can be held twice.
							// biome-ignore lint/suspicious/noArrayIndexKey: the list is what is being answered
							key={`send:${index}`}
							keys={["y send it", "n drop it"]}
							what={
								<>
									<strong>{nameOf(agent.id)}</strong> would send this {outOf(held.channel)}, in your
									name. Nothing has gone.
									<span className="ask-said">{held.body}</span>
								</>
							}
							onAnswer={(send) => void plane.answerSend(agent.id, index, send)}
						/>
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

			<Composer
				plane={plane}
				agent={agent}
				busy={live.thinking}
				onLocal={onLocal}
				onStop={() => void plane.stop(agent.id)}
			/>
		</>
	);
}

/**
 * Who said it, as the mark beside it — for the voices that have a name.
 *
 * An agent has a face of its own, derived from its name, and the same on every machine that ever
 * draws it. A peer's message gets that peer's own face, by the same hash of the same name, so a
 * message from `ledger` looks like `ledger` wherever it is read. The plane gets the mark this
 * program is drawn with everywhere else — the same one at the head of the column and on the empty
 * screen.
 *
 * The other two are not drawn at all, because they are not a third and a fourth agent. What you
 * typed is on your own side of the column and the side is the name: no messaging app anybody has
 * used puts a face on your own line, and the one here was a grey person icon saying "you" beside
 * every line you had just written yourself. The sandbox is not a voice either — it is what a
 * command printed — and it takes the width of the column as the block of output it is.
 */
function markOf(said: Utterance, agentId: string): { mark: React.ReactNode; tint: string } {
	if (said.from === "agent") {
		return { mark: <Avatar id={agentId} size={34} />, tint: "inherit" };
	}
	if (said.from === "other") {
		return { mark: <Avatar id={said.via ?? ""} size={34} />, tint: "inherit" };
	}
	return { mark: "◇", tint: "var(--cyan)" };
}

/**
 * Which side of the column a line is read on.
 *
 * Question on one side, answer on the other: the shape of every conversation anybody has had on a
 * telephone, and the thing a screen of evenly stacked paragraphs never says — which of these did I
 * ask for. `printed` is the third case and it is not a side: the sandbox's output is not somebody
 * talking, so it is neither asked nor answered and sits across the whole column.
 */
function sideOf(said: Utterance): "you" | "them" | "printed" {
	if (said.from === "operator") return "you";
	if (said.from === "shell") return "printed";
	return "them";
}

/** How far apart two lines can be and still be one run of talking. */
const ONE_RUN = 5 * 60 * 1000;

/**
 * Whether this line goes on under the one before it, which is what lets it drop the face and the
 * name.
 *
 * Everything the name row says has to match, because the name row is what is being taken away: the
 * same mouth, the door it came in by, where it went, and whether it is bad news. Time as well — an
 * agent that answers you now and again at three in the morning is not one run, and grouping the two
 * would hide the only interesting thing about the second one.
 *
 * Exported for the same reason `Said` is: a room is this conversation with more voices in it, and
 * two answers to what counts as one run would drift the first time either was touched.
 */
export function sameRun(before: Utterance | undefined, said: Utterance | undefined): boolean {
	if (before === undefined || said === undefined) return false;
	if (before.from !== said.from || before.via !== said.via) return false;
	if (before.to !== said.to || before.tone !== said.tone) return false;
	if (before.at === undefined || said.at === undefined) return true;
	const apart = new Date(said.at).getTime() - new Date(before.at).getTime();
	return Number.isNaN(apart) || apart < ONE_RUN;
}

/**
 * One line of a conversation, whoever said it.
 *
 * Exported because a room is the same conversation with more voices in it: the operator, and several
 * agents each drawn as itself. A second copy of this for rooms would be a second answer to what a
 * message looks like, and the two would drift the first time either was touched.
 */
export function Said({
	said,
	agentId,
	onFiles,
	run = false,
	ends = true,
}: {
	said: Utterance;
	agentId: string;
	/**
	 * Where a path in this message leads, or nothing on a screen with no box behind it.
	 *
	 * Whoever's face is beside the message is whose box it is. An agent writes about its own files
	 * and a peer writing into this conversation writes about the ones in its own, which is the same
	 * rule the face follows — so a path in a message from `ledger` opens `ledger`'s box, on whatever
	 * screen the message is being read.
	 */
	onFiles?: (agentId: string, path: string) => void;
	/** Whether the line above it was the same voice saying the same thing a moment earlier. */
	run?: boolean;
	/** Whether the run stops here, which is where the time it was said goes. */
	ends?: boolean;
}) {
	const face = markOf(said, agentId);
	const whose = said.from === "other" ? (said.via ?? agentId) : agentId;
	const box = useMemo(
		() =>
			onFiles === undefined || whose === ""
				? undefined
				: { open: (path: string) => onFiles(whose, path) },
		[onFiles, whose],
	);
	// Never asked for your own lines: the side they are on is the answer, and nothing on this screen
	// says "You" any more.
	const who =
		said.from === "agent"
			? nameOf(agentId)
			: said.from === "shell"
				? "sandbox"
				: said.from === "other"
					? (said.via ?? "another agent")
					: "squad";
	const side = sideOf(said);
	// The sandbox wears its name down here, because it has no face up there to carry one.
	const marked =
		side === "printed" || said.via !== undefined || said.to !== undefined || said.at !== undefined;

	return (
		<article
			className="said"
			data-from={said.from}
			data-tone={said.tone}
			data-side={side}
			data-run={run}
		>
			{side === "them" && !run && (
				<span className="face" data-size="big" style={{ color: face.tint }} aria-hidden="true">
					{face.mark}
				</span>
			)}
			<div className="said-turn">
				{side === "them" && !run && (
					<div className="said-who">
						<span className="said-name">{who}</span>
					</div>
				)}
				{/* The sandbox's own output is not prose: it is whatever the command printed, and a `*`
				    in it is a glob. Everything else is written by something that writes markdown. */}
				<div className="bubble" title={said.at === undefined ? undefined : full(said.at)}>
					<BoxIs value={box}>
						{said.from === "shell" ? (
							// Not prose, and read for one thing only: a `!ls` answers in paths, and the whole
							// point of typing it was to find out what is in there.
							<div className="said-body">{paths(said.text, undefined)}</div>
						) : (
							<Markdown text={said.text} />
						)}
					</BoxIs>
				</div>
				{/* Under the last thing said rather than over the first, and only once for the run: a
				    clock on every line of a stack is the same number four times, and the question it
				    answers — when did this happen — is asked of the end of what was said. Where it came
				    from and where it went are here for the same reason: a message that left this agent
				    is a thing it did, and this is the line that says what became of what is above it. */}
				{ends && marked && (
					<div className="said-stamp">
						{side === "printed" && <span className="said-name">{who}</span>}
						{said.via !== undefined && said.from !== "other" && (
							<span className="said-via">‹{said.via}›</span>
						)}
						{said.to !== undefined && <span className="said-via">→ {said.to}</span>}
						{said.at !== undefined && <span className="said-when">{clock(said.at)}</span>}
					</div>
				)}
			</div>
		</article>
	);
}

/** The turn as it happens: what it is doing, and the answer arriving a piece at a time. */
function Turn({
	agentId,
	live,
	onFiles,
}: {
	agentId: string;
	live: Live;
	onFiles: (agentId: string, path: string) => void;
}) {
	// An answer half arrived is still an answer, and the path it has already written is already the
	// file it is about. Nothing waits for the turn to end.
	const box = useMemo(
		() => ({ open: (path: string) => onFiles(agentId, path) }),
		[onFiles, agentId],
	);
	return (
		<article className="said" data-from="agent" data-side="them" data-run={false}>
			<Avatar id={agentId} size={34} />
			<div className="said-turn">
				<div className="said-who">
					<span className="said-name">{nameOf(agentId)}</span>
				</div>
				{/* The same bubble the finished answer will be read in, so nothing moves when the turn
				    ends: what is in it is replaced, and the shape around it was right all along. */}
				<div className="bubble">
					{/*
					 * Under the name, where the answer is going to be.
					 *
					 * It is what this turn has so far, which is the same thing the steps are and the same
					 * thing the text is — so it stands where they will stand and is replaced by them, rather
					 * than sitting up in the name row as a label on the agent. A turn takes minutes and a
					 * still line through all of them reads like a line something left behind, so it turns;
					 * it stops the moment there is anything truer to show.
					 */}
					{live.text.length === 0 && live.steps.length === 0 && (
						<div className="working">
							<Spin />
							working…
						</div>
					)}
					{/* Only as far as the marks have closed. Drawing an unclosed `**` eagerly puts two
					    asterisks on screen that no later delta can take away, so the answer arrives a
					    settled piece at a time rather than a character at a time. */}
					{live.text.length > 0 && (
						<BoxIs value={box}>
							<Markdown text={live.text.slice(0, safeEnd(live.text))} />
						</BoxIs>
					)}
					{live.steps.length > 0 && (
						<div className="steps">
							{live.steps.slice(-8).map((step, index, shown) => (
								<div
									className="step"
									// biome-ignore lint/suspicious/noArrayIndexKey: append-only within one turn
									key={index}
									data-failed={step.failed === true}
									// The last one is the one still running, so far as this screen can know: a step
									// is written down when it starts, and the next one arriving is what says the one
									// before it finished.
									data-now={live.thinking && index === shown.length - 1}
									// The tool and the argument it was called with, for whoever wants them. The row
									// says what is happening; this is the same thing in the terms it happened in, and
									// it belongs a hover away rather than in front of somebody waiting for an answer.
									title={`${step.action} ${step.detail}`}
								>
									{/* Beside the marks rather than instead of them: what it has read so far is not
									    something to take off the screen because it has not finished reading. */}
									{live.thinking && index === shown.length - 1 && step.failed !== true && <Spin />}
									<Sources urls={step.sources ?? []} />
									<span className="step-say">{step.say || step.detail}</span>
									{step.failed === true && <span className="step-why">✗ {step.detail}</span>}
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</article>
	);
}

/**
 * Who a step read, drawn as the marks of the sites themselves.
 *
 * A row that says "reading infobae.com" is already true, and the icon beside it is what actually
 * gets read: a person recognises a masthead before they have finished the first word of a sentence,
 * and "which of these am I being told by" is the question behind watching an agent look things up.
 */
function Sources({ urls }: { urls: readonly string[] }) {
	const hosts: string[] = [];
	for (const url of urls) {
		const host = hostOf(url);
		// One mark per site. A loop over eight pages of one newspaper is one masthead, eight times,
		// which says nothing the first one did not.
		if (host.length > 0 && !hosts.includes(host)) hosts.push(host);
	}
	if (hosts.length === 0) return null;
	return (
		<span className="sources">
			{hosts.slice(0, MOST_MARKS).map((host) => (
				<Source key={host} host={host} />
			))}
		</span>
	);
}

/**
 * One site's mark, asked of the site.
 *
 * From the site itself rather than from a favicon service, which would be the shorter line and
 * would hand a third party every page an agent read on somebody's behalf — the one thing this plane
 * is careful about everywhere else. A site that serves no icon there gets its initial instead,
 * because a row that reflows when an image fails is worse than a row that never had one.
 */
function Source({ host }: { host: string }) {
	const [drawn, setDrawn] = useState(true);
	if (!drawn) {
		return (
			<span className="source" data-letter="true" title={host}>
				{host.slice(0, 1).toUpperCase()}
			</span>
		);
	}
	return (
		<img
			className="source"
			src={`https://${host}/favicon.ico`}
			alt={host}
			title={host}
			loading="lazy"
			onError={() => setDrawn(false)}
		/>
	);
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * A question the agent raised, where it raised it.
 *
 * The agent writes the question and never the answer: this draws what it asked for and the two keys
 * that answer it, and neither of them is something the agent can press.
 */
function Ask({
	what,
	keys = ["y open", "n keep it shut"],
	onAnswer,
}: {
	what: React.ReactNode;
	/** What the two answers are called, because opening a host and sending a mail are not the same. */
	keys?: readonly [string, string];
	onAnswer: (open: boolean) => void;
}) {
	return (
		<div className="ask">
			<div className="ask-what">{what}</div>
			<div className="ask-keys">
				<button type="button" className="key" data-yes="true" onClick={() => onAnswer(true)}>
					{keys[0]}
				</button>
				<button type="button" className="key" onClick={() => onAnswer(false)}>
					{keys[1]}
				</button>
			</div>
		</div>
	);
}

/** Which door this would go out of, in the words somebody would use for it. */
function outOf(channel: string): string {
	const prefix = channel.split(":")[0];
	if (prefix === "email") return "by mail";
	if (prefix === "telegram") return "on Telegram";
	return `on ${prefix}`;
}

function Composer({
	onStop,
	plane,
	agent,
	busy,
	onLocal,
}: {
	plane: Plane;
	agent: AgentSummary;
	busy: boolean;
	onLocal: (agentId: string, said: Utterance) => void;
	/** Ends the turn in flight where it is. The half it wrote is kept; nothing takes it again. */
	onStop: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [pick, setPick] = useState(0);
	const [cwd, setCwd] = useState<string | undefined>();
	const box = useRef<HTMLTextAreaElement>(null);
	const menu: readonly Command[] = completions(draft);
	const shell = isShell(draft);

	// Grows with what is in it, up to the ceiling the stylesheet sets. A box that scrolls at three
	// lines hides the paragraph somebody is still writing.
	useEffect(() => {
		const field = box.current;
		if (field === null) return;
		field.style.height = "auto";
		field.style.height = `${field.scrollHeight}px`;
	}, []);

	const send = async (): Promise<void> => {
		const line = draft.trim();
		if (line.length === 0) return;
		setDraft("");
		setPick(0);
		// A command and a shell line are answered to whoever asked, on the connection they asked over,
		// and the plane records only the asking. So the answer is put into the conversation here —
		// without it a `/limit` that worked looks exactly like one that did nothing.
		try {
			/*
			 * Both halves of a command come back on the feed, so neither is said here.
			 *
			 * The plane writes down what was typed and what it answered, and announces both — which is
			 * how a command typed in a terminal console shows up in this one. Saying it here as well
			 * put every answer on screen twice: once from the feed, without a time on it, and once
			 * from this, with one. It survived being unnoticed because a reload showed the transcript,
			 * which has one of them, and `/clear` is the command that empties the screen first and
			 * leaves the two side by side with nothing above them.
			 *
			 * What comes back is used for the one thing the feed does not carry: which directory the
			 * next `!` line starts in.
			 */
			if (isShell(line)) {
				setCwd((await plane.shell(agent.id, line.slice(1))).cwd);
			} else if (isCommand(line)) {
				await plane.command(agent.id, line);
			} else {
				// Not awaited for its text: the answer arrives as events, and the turn is longer than
				// anybody wants a prompt to be locked for. A turn that fails fails this too, and it is
				// caught rather than said — the plane records the failure against the agent, so it is
				// already on its way to the conversation and saying it twice is two failures for one.
				plane.wake(agent.id, line).catch(() => {});
			}
		} catch (error) {
			// A refusal is the one thing that is not on the feed: it comes back as the failed answer to
			// the request and is never written down, so this is the only place it can be said. `tone`
			// is what draws it as bad news.
			onLocal(agent.id, {
				from: "plane",
				text: (error as Error).message,
				tone: "bad",
				at: new Date().toISOString(),
			});
		}
	};

	return (
		<div className="composer">
			{menu.length > 0 && (
				<div className="menu">
					{menu.map((command, index) => (
						<button
							type="button"
							key={command.name}
							className="menu-row"
							data-here={index === pick}
							onMouseEnter={() => setPick(index)}
							onClick={() => {
								setDraft(command.takes.length > 0 ? `${command.name} ` : command.name);
								box.current?.focus();
							}}
						>
							<span className="menu-name">
								{command.name} {command.takes}
							</span>
							<span className="menu-does">{command.does}</span>
						</button>
					))}
				</div>
			)}
			<div className="box" data-mode={shell ? "shell" : "say"}>
				<span className="box-mark">{shell ? (cwd ?? "!") : ">"}</span>
				<textarea
					ref={box}
					rows={1}
					value={draft}
					placeholder={busy ? `${nameOf(agent.id)} is working — this will queue` : "Say something"}
					onChange={(event) => {
						setDraft(event.target.value);
						setPick(0);
						const field = event.target;
						field.style.height = "auto";
						field.style.height = `${field.scrollHeight}px`;
					}}
					onKeyDown={(event) => {
						// The key the terminal console stops a turn with, in the one place a hand already
						// is. Only while there is something to stop: at any other moment it is a key
						// pressed at nothing, and a box that swallowed it would be a box with a mode.
						if (event.key === "Escape" && busy && menu.length === 0) {
							event.preventDefault();
							onStop();
							return;
						}
						if (menu.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
							event.preventDefault();
							setPick(
								(was) => (was + (event.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length,
							);
							return;
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							// Enter on an open menu chooses the row rather than sending — while there is
							// something to choose. What is in the box is half a command, and sending half a
							// command is an error message for a keystroke; but a command with nothing after
							// it is whole the moment it is typed, and the menu goes on matching it.
							const completed = completing(draft, menu[pick]);
							if (completed !== undefined) {
								setDraft(completed);
								return;
							}
							void send();
						}
					}}
				/>
				{/*
				 * The way out of a turn, at the end of the row it is holding up.
				 *
				 * Not a report — the spinner and what it is doing stay in the conversation above, where
				 * they belong — but a thing to press, and the moment somebody wants it they are already
				 * here, typing the message they were about to queue. `esc` does the same, which is the
				 * key the terminal console has always used.
				 */}
				{busy && (
					<button type="button" className="box-stop" title="stop this turn (esc)" onClick={onStop}>
						<Square className="size-3" />
						stop
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * Whether the bottom is close enough to count as being there.
 *
 * A few pixels of slack rather than an exact match, because a fractional scroll height — which is
 * what any zoom that is not 100% produces — never equals the number it is compared against, and
 * following would switch itself off the first time anything arrived.
 */
function atFloor(box: HTMLElement): boolean {
	return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}

function clock(at: string): string {
	const when = new Date(at);
	return Number.isNaN(when.getTime())
		? ""
		: when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The whole of when it was said, a hover away.
 *
 * A run of lines carries one clock, under the last of them, and the day is nowhere on the screen at
 * all — a conversation read from the bottom is read in hours, not in dates. Both are still true of
 * every line taken on its own, and this is where that is kept: nothing spent on the screen, and an
 * answer for anybody who goes looking.
 */
function full(at: string): string | undefined {
	const when = new Date(at);
	return Number.isNaN(when.getTime()) ? undefined : when.toLocaleString();
}
