import type { AgentSummary, Utterance } from "@squad/control-plane";
import { Settings2, Square, Terminal, User } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Live } from "./App.tsx";
import { Avatar } from "./avatar.tsx";
import { type Command, completions, isCommand, isShell } from "./commands.ts";
import { nameOf } from "./face.ts";
import { Markdown } from "./markdown.tsx";
import type { Plane } from "./plane.ts";
import { safeEnd } from "./safe-end.ts";
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
}: {
	plane: Plane;
	agent: AgentSummary;
	said: readonly Utterance[];
	live: Live;
	onLocal: (agentId: string, said: Utterance) => void;
	onSetup: () => void;
}) {
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
					{/* Off this console's own address, which is the one address that is certainly
					    reachable: you are reading this through it. The link used to point at
					    `<agent>.localhost`, which is a real port only while a terminal console is running
					    on the machine the browser is — and a lie every other time. */}
					{agent.served.map((one) => (
						<a
							key={one.port}
							href={`/at/${agent.id}/${one.port}/`}
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
						// biome-ignore lint/suspicious/noArrayIndexKey: append-only, and there is no id
						<Said key={index} said={one} agentId={agent.id} />
					))}

					{(live.thinking || live.steps.length > 0 || live.text.length > 0) && (
						<Turn agentId={agent.id} live={live} />
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
 * Who said it, as the mark beside it.
 *
 * An agent has a face of its own, derived from its name, and the same on every machine that ever
 * draws it. The other three voices were all one grey dot, which said only "not the agent" — and
 * they are not one thing: the plane answering a command is this program speaking, the sandbox is
 * what a command printed, and the third is you.
 *
 * So the plane gets the mark this program is drawn with everywhere else — the same one at the head
 * of the column and on the empty screen — the sandbox gets a terminal, and you get a person. A
 * peer's message gets that peer's own face, by the same hash of the same name, so a message from
 * `ledger` looks like `ledger` wherever it is read.
 */
function markOf(said: Utterance, agentId: string): { mark: React.ReactNode; tint: string } {
	if (said.from === "agent") {
		return { mark: <Avatar id={agentId} size={34} />, tint: "inherit" };
	}
	if (said.from === "operator") {
		return { mark: <User className="size-4" />, tint: "var(--text-strong)" };
	}
	if (said.from === "shell") {
		return { mark: <Terminal className="size-3.5" />, tint: "var(--muted)" };
	}
	// A peer's own picture, by the same name and the same arithmetic, so `ledger` looks like `ledger`
	// wherever it is read.
	if (said.from === "other") {
		return { mark: <Avatar id={said.via ?? ""} size={34} />, tint: "inherit" };
	}
	return { mark: "◇", tint: "var(--cyan)" };
}

function Said({ said, agentId }: { said: Utterance; agentId: string }) {
	const face = markOf(said, agentId);
	const who =
		said.from === "operator"
			? "You"
			: said.from === "agent"
				? nameOf(agentId)
				: said.from === "shell"
					? "sandbox"
					: said.from === "other"
						? (said.via ?? "another agent")
						: "squad";

	return (
		<article className="said" data-from={said.from} data-tone={said.tone}>
			<span className="face" data-size="big" style={{ color: face.tint }} aria-hidden="true">
				{face.mark}
			</span>
			<div>
				<div className="said-who">
					<span className="said-name">{who}</span>
					{/* Where it came from, or where it went. A message that left this agent is a thing it
					    did, and the pane it was typed in is where a person looks for it. */}
					{said.via !== undefined && said.from !== "other" && (
						<span className="said-via">‹{said.via}›</span>
					)}
					{said.to !== undefined && <span className="said-via">→ {said.to}</span>}
					{said.at !== undefined && <span className="said-when">{clock(said.at)}</span>}
				</div>
				{/* The sandbox's own output is not prose: it is whatever the command printed, and a `*`
				    in it is a glob. Everything else is written by something that writes markdown. */}
				{said.from === "shell" ? (
					<div className="said-body">{said.text}</div>
				) : (
					<Markdown text={said.text} />
				)}
			</div>
		</article>
	);
}

/** The turn as it happens: what it is doing, and the answer arriving a piece at a time. */
function Turn({ agentId, live }: { agentId: string; live: Live }) {
	return (
		<article className="said" data-from="agent">
			<Avatar id={agentId} size={34} />
			<div>
				<div className="said-who">
					<span className="said-name">{nameOf(agentId)}</span>
					{/* Turning, because a turn takes minutes and a still line through all of them reads
					    like a line something left behind. It goes when the answer starts arriving: text
					    appearing a piece at a time is the same fact, said better.
					    
					    And it goes as soon as there is a step, because the step below is turning and one
					    thing moving is a screen saying something. Two is a screen fidgeting. */}
					{live.thinking && live.text.length === 0 && live.steps.length === 0 && (
						<span className="said-when inline-flex items-center gap-1.5">
							<Spin />
							working…
						</span>
					)}
					{live.thinking && live.text.length === 0 && live.steps.length > 0 && (
						<span className="said-when">working…</span>
					)}
				</div>
				{/* Only as far as the marks have closed. Drawing an unclosed `**` eagerly puts two
				    asterisks on screen that no later delta can take away, so the answer arrives a
				    settled piece at a time rather than a character at a time. */}
				{live.text.length > 0 && <Markdown text={live.text.slice(0, safeEnd(live.text))} />}
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
function Ask({ what, onAnswer }: { what: React.ReactNode; onAnswer: (open: boolean) => void }) {
	return (
		<div className="ask">
			<div className="ask-what">{what}</div>
			<div className="ask-keys">
				<button type="button" className="key" data-yes="true" onClick={() => onAnswer(true)}>
					y open
				</button>
				<button type="button" className="key" onClick={() => onAnswer(false)}>
					n keep it shut
				</button>
			</div>
		</div>
	);
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
			if (isShell(line)) {
				const answered = await plane.shell(agent.id, line.slice(1));
				setCwd(answered.cwd);
				if (answered.text.length > 0) {
					onLocal(agent.id, { from: "shell", text: answered.text, at: new Date().toISOString() });
				}
			} else if (isCommand(line)) {
				const text = await plane.command(agent.id, line);
				if (text.length > 0) {
					onLocal(agent.id, { from: "plane", text, at: new Date().toISOString() });
				}
			} else {
				// Not awaited for its text: the answer arrives as events, and the turn is longer than
				// anybody wants a prompt to be locked for. A turn that fails fails this too, and it is
				// caught rather than said — the plane records the failure against the agent, so it is
				// already on its way to the conversation and saying it twice is two failures for one.
				plane.wake(agent.id, line).catch(() => {});
			}
		} catch (error) {
			// Refusals come back as the failed answer to the request rather than down the feed, so this
			// is the only place they can be said. `tone` is what draws it as bad news.
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
							const chosen = menu[pick];
							// Enter on an open menu chooses the row rather than sending. What is in the box is
							// half a command, and sending half a command is an error message for a keystroke.
							if (chosen !== undefined) {
								setDraft(chosen.takes.length > 0 ? `${chosen.name} ` : chosen.name);
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
