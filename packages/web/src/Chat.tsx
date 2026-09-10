import type { AgentSummary, Utterance } from "@squad/control-plane";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Live } from "./App.tsx";
import { type Command, completions, isCommand, isShell } from "./commands.ts";
import { faceOf, nameOf } from "./face.ts";
import { Markdown } from "./markdown.tsx";
import type { Plane } from "./plane.ts";
import { safeEnd } from "./safe-end.ts";

export function Chat({
	plane,
	agent,
	said,
	live,
	onLocal,
}: {
	plane: Plane;
	agent: AgentSummary;
	said: readonly Utterance[];
	live: Live;
	onLocal: (agentId: string, said: Utterance) => void;
}) {
	const face = faceOf(agent.id);
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
				<span className="face" style={{ color: `var(--${face.accent})` }} aria-hidden="true">
					{face.glyph}
				</span>
				<span className="pane-title">{nameOf(agent.id)}</span>
				<div className="pane-facts">
					{agent.model !== undefined && <span>{agent.model}</span>}
					{/* An agent that booked its own next turn is not idle, it is waiting, and those read
					    identically on a screen that only says whether it is running. */}
					{agent.served.map((one) => (
						<a
							key={one.port}
							href={`http://${agent.id}.localhost:${one.at}`}
							target="_blank"
							rel="noreferrer"
						>
							:{one.port}
						</a>
					))}
					<span>
						${agent.spentUsd.toFixed(2)}
						{agent.limitUsd !== undefined && ` / $${agent.limitUsd.toFixed(2)}`}
					</span>
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

			<Composer plane={plane} agent={agent} busy={live.thinking} onLocal={onLocal} />
		</>
	);
}

function Said({ said, agentId }: { said: Utterance; agentId: string }) {
	const mine = said.from === "agent";
	const face = faceOf(agentId);
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
			<span
				className="face"
				data-size="big"
				style={{ color: mine ? `var(--${face.accent})` : "var(--muted)" }}
				aria-hidden="true"
			>
				{mine ? face.glyph : said.from === "operator" ? "◍" : "·"}
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
	const face = faceOf(agentId);
	return (
		<article className="said" data-from="agent">
			<span
				className="face"
				data-size="big"
				style={{ color: `var(--${face.accent})` }}
				aria-hidden="true"
			>
				{face.glyph}
			</span>
			<div>
				<div className="said-who">
					<span className="said-name">{nameOf(agentId)}</span>
					{live.thinking && live.text.length === 0 && <span className="said-when">working…</span>}
				</div>
				{/* Only as far as the marks have closed. Drawing an unclosed `**` eagerly puts two
				    asterisks on screen that no later delta can take away, so the answer arrives a
				    settled piece at a time rather than a character at a time. */}
				{live.text.length > 0 && <Markdown text={live.text.slice(0, safeEnd(live.text))} />}
				{live.steps.length > 0 && (
					<div className="steps">
						{live.steps.slice(-8).map((step, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: append-only within one turn
							<div className="step" key={index} data-failed={step.failed === true}>
								<span className="step-action">{step.action}</span>
								<span className="step-detail">
									{step.failed === true && "✗ "}
									{step.detail}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</article>
	);
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
	plane,
	agent,
	busy,
	onLocal,
}: {
	plane: Plane;
	agent: AgentSummary;
	busy: boolean;
	onLocal: (agentId: string, said: Utterance) => void;
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
