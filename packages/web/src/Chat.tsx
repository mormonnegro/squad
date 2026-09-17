import type { AgentSummary, Question, Utterance } from "@squad/control-plane";
import { Square } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Live } from "./App.tsx";
import { Avatar } from "./avatar.tsx";
import { BoxIs, paths } from "./box.tsx";
import { type Command, completing, completions, isCommand, isShell } from "./commands.ts";
import { nameOf } from "./face.ts";
import { here } from "./here.ts";
import { Markdown } from "./markdown.tsx";
import type { Plane } from "./plane.ts";
import { giveTheKeyboardBack, hasScreen, Screen, takeTheKeyboard } from "./Screen.tsx";
import { safeEnd } from "./safe-end.ts";
import { Spin } from "./spin.tsx";

/** Enough marks to say who was read, before the row turns into the list it is summarising. */
const MOST_MARKS = 5;

/**
 * A path picked out of the file browser, on its way into the box it will be asked about in.
 *
 * An object rather than the path, so that asking about the same file twice is two askings: what is
 * carried is the asking, and the way it is taken once is by which one it was.
 */
export interface Carried {
	readonly path: string;
}

export function Chat({
	plane,
	agent,
	said,
	live,
	onLocal,
	onFiles,
	carried,
	onCarried,
}: {
	plane: Plane;
	agent: AgentSummary;
	said: readonly Utterance[];
	live: Live;
	onLocal: (agentId: string, said: Utterance) => void;
	/**
	 * A path carried down from the file browser, to be asked about.
	 *
	 * The conversation is not mounted while that screen is open, so what comes back with the person
	 * cannot be held in the box they left — it is held above both and handed over here. Taken once
	 * and given back, so that walking into the files and out again does not paste it twice.
	 */
	carried: Carried | undefined;
	onCarried: () => void;
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
	const floor = useRef<HTMLDivElement>(null);
	// Whether the bottom is what is being read. It is, until somebody scrolls away from it.
	const [following, setFollowing] = useState(true);
	/**
	 * Whether the browser is showing, held here rather than inside the screen itself.
	 *
	 * Because the conversation opens it. An agent that has asked for a pair of hands puts a button in
	 * the conversation, and that button is worth nothing if the screen it is about is folded away
	 * behind a chevron — what it means is "come and do this", and it has to be able to show you the
	 * thing you are being asked to do it on.
	 */
	const [screen, setScreen] = useState(true);

	// Before paint rather than after, so a turn arriving never shows the previous bottom of the
	// conversation for a frame on its way past. And only while the bottom is where the reader is:
	// an agent that wakes itself every minute posts while somebody is reading upward, and a pane
	// that jumps on every event is one that cannot be read at all.
	// biome-ignore lint/correctness/useExhaustiveDependencies: what changed is why it must scroll
	useLayoutEffect(() => {
		if (!following) return;
		floor.current?.scrollTo({ top: floor.current.scrollHeight });
	}, [said, live, following]);

	/*
	 * A question arriving pulls the view down to itself, wherever the reader had got to.
	 *
	 * The one thing in this pane that overrides having scrolled away, and the only one that should:
	 * everything else here is news, and a pane that jumped on every event is a pane that cannot be
	 * read. This is addressed to the person reading it and is waiting on them — a card that appeared
	 * below the fold is a card nobody answers, and an agent stopped until somebody scrolls.
	 *
	 * On the count changing rather than on there being one, so the view is pulled once when it goes
	 * up and not again on every poll for as long as it stands.
	 */
	const asked = agent.questions.length;
	const stood = useRef(asked);
	useLayoutEffect(() => {
		if (asked > stood.current) {
			setFollowing(true);
			floor.current?.scrollTo({ top: floor.current.scrollHeight, behavior: "smooth" });
		}
		stood.current = asked;
	}, [asked]);

	return (
		<>
			{/*
			 * Who you are talking to, and the two facts that are true of the talking.
			 *
			 * Nothing else. The workspace, the settings and every port it opened are rows under this
			 * agent in the rail, where they are always visible and say which one you are on — and a
			 * second door to the same three rooms, in the bar over the conversation, is a second
			 * place to look for them and one more thing between the name and the words. What stays
			 * is what belongs to the conversation itself: the model doing the thinking, and what the
			 * thinking has cost against what it is allowed.
			 */}
			<header className="pane-head">
				<Avatar id={agent.id} />
				<span className="pane-title">{nameOf(agent.id)}</span>
				<div className="pane-facts">
					{agent.model !== undefined && <span>{agent.model}</span>}
					<span>
						${agent.spentUsd.toFixed(2)}
						{agent.limitUsd !== undefined && ` / $${agent.limitUsd.toFixed(2)}`}
					</span>
				</div>
			</header>

			{/*
			 * The conversation and, beside it, the browser it is about.
			 *
			 * Beside rather than above, which is the whole of why it is worth the split: what this is
			 * for is watching an agent work and typing to it about what you are watching, and a screen
			 * stacked over the column pushes the words you are answering off the bottom. Side by side
			 * they are one thing — the page on the right, what was said about it on the left, and the
			 * box to answer in still under your hands.
			 *
			 * And not a door in the rail like the workspace and the settings, because it is not a room
			 * to go to: it is the thing the next sentence is about.
			 */}
			<div className="flex min-h-0 flex-1">
				<div className="flex min-w-0 flex-1 flex-col">
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
											<strong>{nameOf(agent.id)}</strong> wants to reach <code>{host}</code> on its
											way out.
										</>
									}
									onAnswer={(open) => void plane.answerReach(agent.id, host, open)}
								/>
							))}
							{agent.logins.map((host) => (
								<Ask
									key={`login:${host}`}
									what={
										<>
											<strong>{nameOf(agent.id)}</strong> wants to sign into <code>{host}</code>{" "}
											out of your vault. It never sees the password — what crosses into the page is
											keystrokes.
										</>
									}
									onAnswer={(open) => void plane.answerSignIn(agent.id, host, open)}
								/>
							))}
							{agent.wants.map((to) => (
								<Ask
									key={`talk:${to}`}
									what={
										<>
											<strong>{nameOf(agent.id)}</strong> wants to write to <code>{to}</code>. A
											message wakes that agent and spends its ceiling.
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
											<strong>{nameOf(agent.id)}</strong> would send this {outOf(held.channel)}, in
											your name. Nothing has gone.
											<span className="ask-said">{held.body}</span>
										</>
									}
									onAnswer={(send) => void plane.answerSend(agent.id, index, send)}
								/>
							))}

							{/*
							 * What the agent asked, with the answers it wrote.
							 *
							 * Last of the four and nearest the box, because it is the only one that is not about
							 * permission. Those three are a plane holding something until somebody says yes;
							 * this is the agent one decision short of carrying on, and what answers it is a
							 * message — pressing an option sends that option, word for word, in your name.
							 * Which is why there is no yes and no no here, and no plane in the middle of it.
							 */}
							{agent.questions.map((question, index) => (
								<Asked
									// The place in the list is the identity, as it is for the held messages above: a
									// turn may put up three, and the same agent may ask the same thing twice after
									// looking at the same page again.
									// biome-ignore lint/suspicious/noArrayIndexKey: the list is what is being answered
									key={`ask:${index}`}
									who={agent.id}
									question={question}
									screen={hasScreen(agent)}
									onScreen={() => {
										setScreen(true);
										void takeTheKeyboard(agent.id);
									}}
									// Exactly what the box does with a typed line, because that is what this is — and
									// the hand-off is over, so the keyboard goes back to the agent with it. A
									// keyboard still held after the question is answered is the agent locked out of
									// its own screen by somebody who has already finished with it.
									onPick={(option) => {
										if (hasScreen(agent)) void giveTheKeyboardBack(agent.id);
										void plane.wake(agent.id, option).catch(() => {});
									}}
									// Nothing is sent and nobody is woken: the card is taken off this screen, and the
									// keyboard goes back if this was the card holding it — an agent locked out of its
									// own browser by a question somebody decided not to answer is the worse half of
									// this feature.
									onAway={() => {
										if (question.hands === true && hasScreen(agent)) {
											void giveTheKeyboardBack(agent.id);
										}
										void plane.dropQuestion(agent.id, index, question.text).catch(() => {});
									}}
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
						carried={carried}
						onCarried={onCarried}
						onStop={() => void plane.stop(agent.id)}
					/>
				</div>
				{hasScreen(agent) && <Screen agentId={agent.id} open={screen} onOpen={setScreen} />}
			</div>
		</>
	);
}

/**
 * Who said it, as the mark beside it — for everything that answers.
 *
 * An agent has a face of its own, derived from its name, and the same on every machine that ever
 * draws it. A peer's message gets that peer's own face, by the same hash of the same name, so a
 * message from `ledger` looks like `ledger` wherever it is read. The plane gets the mark this
 * program is drawn with everywhere else — the same one at the head of the column and on the empty
 * screen.
 *
 * The sandbox gets a prompt, because a prompt is what printed it. It is the one answer here that
 * nobody said: you typed a command and a machine printed back, and `>` is what that has looked
 * like on every screen since there were screens. Drawn as a mark like the others rather than left
 * bare — an answer with no face in a column where every other answer has one reads as a thing that
 * fell out of the conversation, and the eye stops on the hole instead of on the output.
 *
 * Your own lines are the only ones with no mark at all: they are on your own side of the column
 * and the side is the name. No messaging app anybody has used puts a face on your own line.
 */
function markOf(said: Utterance, agentId: string): { mark: React.ReactNode; tint: string } {
	if (said.from === "agent") {
		return { mark: <Avatar id={agentId} size={34} />, tint: "inherit" };
	}
	if (said.from === "other") {
		return { mark: <Avatar id={said.via ?? ""} size={34} />, tint: "inherit" };
	}
	if (said.from === "shell") {
		return { mark: ">", tint: "var(--violet)" };
	}
	return { mark: "◇", tint: "var(--cyan)" };
}

/**
 * Which side of the column a line is read on.
 *
 * Question on one side, answer on the other: the shape of every conversation anybody has had on a
 * telephone, and the thing a screen of evenly stacked paragraphs never says — which of these did I
 * ask for. What the sandbox printed is an answer like any other: it is on the side the answers are
 * on, under the mark of the prompt that printed it, and what makes it different from prose is how
 * it is drawn and not where it sits.
 */
function sideOf(said: Utterance): "you" | "them" {
	return said.from === "operator" ? "you" : "them";
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
	/*
	 * A command you ran in the box, which is not a message to the agent.
	 *
	 * Marked here rather than stored marked, which is what the terminal console does with the same
	 * line and for the same reason: the transcript keeps the words somebody typed, and how a
	 * console draws them is the console's business. The bang is a mark and not a word, so it comes
	 * off the front and the violet says what it was saying — the same violet the terminal console
	 * prints the line in, and the colour the box itself wears while it is in that mode.
	 */
	const ran = said.from === "operator" && isShell(said.text);
	const marked = said.via !== undefined || said.to !== undefined || said.at !== undefined;

	return (
		<article
			className="said"
			data-from={said.from}
			data-tone={said.tone}
			data-side={side}
			data-run={run}
			data-ran={ran}
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
						{said.from === "shell" || ran ? (
							// Not prose, and read for one thing only: a `!ls` answers in paths, and the whole
							// point of typing it was to find out what is in there. The command that asked is
							// not prose either — a `*` in it is a glob and never emphasis — so the question
							// and the answer are set in the same type.
							<div className="said-body">
								{paths(ran ? said.text.slice(1).trimStart() : said.text, undefined)}
							</div>
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

/**
 * A question the agent put up, and the answers it wrote for you.
 *
 * The card exists because of what it replaces. An agent one decision from carrying on used to write
 * the decision out as a paragraph — three fares, what each one includes, and a question mark at the
 * bottom — read twenty minutes later by somebody who then has to type an answer precise enough to
 * be acted on. Here the answers are the agent's own sentences and pressing one sends it, so there
 * is nothing to compose and nothing to match up: what arrives in the next turn is the line printed
 * on the button, word for word.
 *
 * Pressed once. Not because a second press would be dangerous — it would only be a second message —
 * but because the card stays on the screen until the plane's next poll notices the question is
 * answered, and two seconds of a live button under a decision somebody has already taken reads as a
 * click that did not land.
 */
function Asked({
	who,
	question,
	screen,
	onScreen,
	onPick,
	onAway,
}: {
	who: string;
	question: Question;
	/** Whether there is a browser to be handed. An agent without one cannot be asking for hands. */
	screen: boolean;
	onScreen: () => void;
	onPick: (option: string) => void;
	/** Takes the card down and says nothing to anybody, which is the one way out that is not an answer. */
	onAway: () => void;
}) {
	const [chosen, setChosen] = useState<string | undefined>();
	const [went, setWent] = useState(false);
	const hands = question.hands === true && screen;

	return (
		/*
		 * In the agent's column, under its own message, rather than across the pane.
		 *
		 * The other three cards are the plane stopping to ask something, and they stand clear of the
		 * conversation because they are not part of it. This one is: the question is the line directly
		 * above it, in the agent's voice, and the answers are the rest of that sentence. Drawn full
		 * width it read as the console interrupting — a banner about the agent instead of the agent
		 * asking. Marked as a continuation so it sits under the face of the message it belongs to.
		 */
		<div className="said" data-side="them" data-run="true">
			<div className="said-turn">
				<div className="asked">
					{/*
					 * What kind of thing this is, and not the question itself.
					 *
					 * The question is the line immediately above this card, written into the conversation where
					 * it will still be tomorrow. Repeating it here would be the same two sentences twice on one
					 * screen — and this is the part you act on rather than the part you read, so what it says is
					 * what pressing something will do.
					 */}
					<div className="ask-what">
						<strong>{nameOf(who)}</strong>{" "}
						{hands
							? "needs your hands on its screen. Take the keyboard, then say how it went."
							: "is asking. Pressing one answers, in your name."}
					</div>

					{/*
					 * The door, above the answers and drawn as something else entirely.
					 *
					 * It is not one of the answers and must not look like one: pressing it says nothing to the
					 * agent at all, it takes the keyboard off it and puts the browser in front of you. The
					 * answers are what you press afterwards, when you know how it went.
					 */}
					{hands && (
						<div className="ask-hands">
							<button
								type="button"
								className="pick pick-hands"
								onClick={() => {
									setWent(true);
									onScreen();
								}}
							>
								Take the keyboard
							</button>
							{went && (
								<span className="ask-hint">
									the screen is on the right — press one of these when you are done
								</span>
							)}
						</div>
					)}

					{question.options.length > 0 && (
						<div className="ask-picks">
							{question.options.map((option) => (
								<button
									key={option}
									type="button"
									className="pick"
									disabled={chosen !== undefined}
									data-chosen={option === chosen ? "true" : undefined}
									onClick={() => {
										setChosen(option);
										onPick(option);
									}}
								>
									{option}
								</button>
							))}
						</div>
					)}

					{/* Said only where it is not obvious: a card with nothing to press is one where the box
					    below is the only way to answer, and nothing on screen would otherwise say so. */}
					{question.options.length === 0 && (
						<span className="ask-hint">answer in the box below when you are done</span>
					)}

					{/*
					 * The way out that is not an answer.
					 *
					 * Every other thing on this card says something to the agent: an option is a message in
					 * your name, and so is a line typed in the box. This says nothing at all — the question
					 * was asked, it is not being answered, and a card nobody is going to press is in the way
					 * of the next one. Quiet, because it is the least consequential thing here and the
					 * answers above it should stay the obvious ones to reach for.
					 */}
					<button
						type="button"
						className="ask-away"
						disabled={chosen !== undefined}
						title={`${nameOf(who)} is not told — the card just goes`}
						onClick={onAway}
					>
						take it down
					</button>
				</div>
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
	carried,
	onCarried,
}: {
	plane: Plane;
	agent: AgentSummary;
	busy: boolean;
	onLocal: (agentId: string, said: Utterance) => void;
	/** A path from the file browser, put in the box rather than sent. */
	carried: Carried | undefined;
	onCarried: () => void;
	/** Ends the turn in flight where it is. The half it wrote is kept; nothing takes it again. */
	onStop: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [pick, setPick] = useState(0);
	const [cwd, setCwd] = useState<string | undefined>();
	/**
	 * Whether the box is in the sandbox.
	 *
	 * A mode rather than a character at the front of the line. `!ls` was a line that happened to
	 * start with a bang: it had to be typed again for the next command, the bang was in the message
	 * afterwards as though it were part of what was said, and nothing on the screen said you were
	 * anywhere — you were always talking to the agent, sometimes with a bang.
	 *
	 * Now the bang is a door. It is the same key it always was, so nothing has to be unlearned, and
	 * it opens on an empty box only: inside a line a bang is a bang. What is on the other side is a
	 * prompt that stays — the mark says which directory, every line goes to the box, and the way
	 * out is the key that was already emptying the line, one press past empty.
	 */
	const [shell, setShell] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	/** The last asking that was taken into the box, so it is taken once. */
	const took = useRef<Carried | undefined>(undefined);
	// Nothing to complete in the sandbox: a `/` there is the root of a filesystem, not the front of
	// a command this console knows the name of.
	const menu: readonly Command[] = shell ? [] : completions(draft);

	// Grows with what is in it, up to the ceiling the stylesheet sets. A box that scrolls at three
	// lines hides the paragraph somebody is still writing.
	useEffect(() => {
		const field = box.current;
		if (field === null) return;
		field.style.height = "auto";
		field.style.height = `${field.scrollHeight}px`;
	}, []);

	/**
	 * A path carried in from the files, dropped where the sentence about it is going to be written.
	 *
	 * Appended rather than substituted, because somebody who was halfway through a question when
	 * they went to find the name of the thing is somebody who wants both halves. The caret lands
	 * after it, which is where the rest of the sentence goes.
	 */
	useEffect(() => {
		// By which asking it was rather than by what it says, so that the same file asked about twice
		// is two askings — and so that an effect run twice on one mount is still one paste.
		if (carried === undefined || took.current === carried) return;
		took.current = carried;
		const path = carried.path;
		setDraft((was) => (was.trim() === "" ? `${path} ` : `${was.trimEnd()} ${path} `));
		onCarried();
		const field = box.current;
		if (field === null) return;
		field.focus();
		requestAnimationFrame(() => field.setSelectionRange(field.value.length, field.value.length));
	}, [carried, onCarried]);

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
			// The box is in the sandbox, or the line says it is: a `!ls` pasted in whole is still a
			// command, and the mode is a way of not typing the bang rather than the only way to mean
			// it. In the mode nothing is read as a bang — a `/` there is a path.
			if (shell) {
				setCwd((await plane.shell(agent.id, line)).cwd);
			} else if (isShell(line)) {
				setCwd((await plane.shell(agent.id, line.slice(1).trimStart())).cwd);
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
				{/* The prompt of the other console, to the character: a bang and the directory the next
				    command will run in, shortened the way a prompt shortens one. Until the first command
				    has come back there is nothing to name, and the bang stands on its own. */}
				<span className="box-mark">
					{shell ? (cwd === undefined ? "!" : `! ${here(cwd)}`) : ">"}
				</span>
				<textarea
					ref={box}
					rows={1}
					value={draft}
					placeholder={
						shell
							? `a command in ${nameOf(agent.id)}'s box — ⌫ leaves`
							: busy
								? `${nameOf(agent.id)} is working — this will queue`
								: "Say something"
					}
					onChange={(event) => {
						setDraft(event.target.value);
						setPick(0);
						const field = event.target;
						field.style.height = "auto";
						field.style.height = `${field.scrollHeight}px`;
					}}
					onKeyDown={(event) => {
						// The way in. Not a character here: at an empty box the bang is the door to the
						// sandbox, and it is the same key the line used to start with. Anywhere else in a
						// line it is what it looks like.
						if (
							event.key === "!" &&
							draft.length === 0 &&
							!shell &&
							!event.metaKey &&
							!event.ctrlKey &&
							!event.altKey
						) {
							event.preventDefault();
							setShell(true);
							return;
						}
						// And the way out, by the key that was already deleting. Empty the line and press
						// it once more and the mode goes the way the last character did — nothing new to
						// learn, and no way to be stuck somewhere you did not mean to be.
						if (event.key === "Backspace" && draft.length === 0 && shell) {
							event.preventDefault();
							setShell(false);
							return;
						}
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
