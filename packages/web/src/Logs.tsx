import type { AgentSummary } from "@squad/control-plane";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "./avatar.tsx";
import { bytesOf, decode } from "./bytes.ts";
import { nameOf } from "./face.ts";
import type { Plane, Printed } from "./plane.ts";
import { useServedAt } from "./served.tsx";
import { Spin } from "./spin.tsx";

/**
 * What the server behind a served port is printing.
 *
 * The other half of `/serve`. A port is a link to something the agent started, and the moment that
 * link opens onto a white page or a stack trace, the question is what the thing behind it said —
 * which until now was a turn spent asking the agent to read its own log out loud. A log is not a
 * conversation and reading one is not work anybody should be woken for.
 *
 * It follows rather than answering once, because the reason you have a log open is that something
 * is about to happen: a page reloaded, a request made, a file saved. A screen that had to be asked
 * again for each of those is a screen you watch by clicking.
 */

/** How often it is asked for again while it is open. A dev server prints in bursts, not in a stream. */
const POLL_MS = 2_000;

/** How far off the bottom counts as having scrolled away, so that following stops being helpful. */
const AT_BOTTOM = 40;

export function Logs({
	plane,
	agent,
	port,
	onClose,
}: {
	plane: Plane;
	agent: AgentSummary;
	port: number;
	/** Back to the conversation, which is where this was opened from. */
	onClose: () => void;
}) {
	const [said, setSaid] = useState<Printed | undefined>();
	const [text, setText] = useState("");
	const [why, setWhy] = useState<string | undefined>();
	const servedAt = useServedAt();
	/** Where the next read starts. Below zero is the end of the file, which is where a log opens. */
	const from = useRef(-1);
	const asking = useRef(false);
	const body = useRef<HTMLPreElement>(null);
	/**
	 * Whether the reader is at the bottom, which is what decides if new lines scroll into view.
	 *
	 * A log that jumped to the end while somebody was reading the middle of it would be a log nobody
	 * can read the middle of. Every terminal does this, and it is the one thing that makes following
	 * bearable.
	 */
	const stuck = useRef(true);

	const look = useCallback(async (): Promise<void> => {
		if (asking.current) return;
		asking.current = true;
		try {
			const printed = await plane.printing(agent.id, port, from.current);
			setSaid(printed);
			setWhy(undefined);
			// Nothing to read: the port is empty, or what holds it writes somewhere nobody can follow.
			// Back to the end, so that a server started a minute from now is read from its own tail
			// rather than from wherever this reader happened to have left off.
			if (printed.at === undefined) {
				from.current = -1;
				setText("");
				return;
			}
			const bytes = bytesOf(printed.data);
			// The first read of a file lands in the middle of whatever line was at the cut, and half a
			// line at the top of a log reads as a log that is missing something.
			const fresh = from.current < 0 || printed.restarted;
			const arrived = decode(bytes);
			const whole = fresh && printed.from > 0 ? arrived.slice(arrived.indexOf("\n") + 1) : arrived;
			from.current = printed.from + bytes.length;
			if (fresh) setText(shown(whole));
			else if (bytes.length > 0) setText((held) => held + shown(whole));
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			asking.current = false;
		}
	}, [plane, agent.id, port]);

	useEffect(() => {
		void look();
		const timer = setInterval(() => void look(), POLL_MS);
		return () => clearInterval(timer);
	}, [look]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: what this runs on is new text arriving — it reads nothing out of it, and an honest list of what it reads is a list that never fires
	useEffect(() => {
		const pane = body.current;
		if (pane === null || !stuck.current) return;
		pane.scrollTop = pane.scrollHeight;
	}, [text]);

	const link = servedAt(agent.id, port);
	const holds = said?.pid !== undefined;

	return (
		<>
			<header className="pane-head">
				<button type="button" className="pane-back" onClick={onClose} title="back">
					<ArrowLeft className="size-4" />
				</button>
				<Avatar id={agent.id} />
				<span className="pane-title">{nameOf(agent.id)}</span>
				<div className="pane-facts">
					<span>:{port}</span>
					{said !== undefined && <span>{said.listening ? "listening" : "nothing listening"}</span>}
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4 pb-5">
				<div className="flex flex-wrap items-center gap-1.5">
					{/* Whose output this is. The command rather than the port, because two ports of one
					    agent are two programs and the port is already written above. */}
					<span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] text-muted">
						{said === undefined
							? "asking…"
							: holds
								? `${said.cmd} · pid ${said.pid}`
								: `nothing in ${nameOf(agent.id)} holds :${port}`}
					</span>
					<button type="button" className="pill" title="ask again" onClick={() => void look()}>
						<RefreshCw className="size-3.5" />
					</button>
					<a className="pill" href={link} target="_blank" rel="noreferrer">
						<ExternalLink className="size-3.5" />
						open :{port}
					</a>
				</div>

				{why !== undefined && <p className="why">{why}</p>}

				{/* Where it is writing, said under the log rather than over it — it is the answer to
				    "where is this coming from", which is a question asked once and then never again. */}
				{said?.at !== undefined && !said.listening && (
					<p className="text-[0.82rem] text-working">
						Nothing is listening on :{port} any more. This is what it left behind in {said.at}.
					</p>
				)}

				{said !== undefined && said.at === undefined && (
					<Unreadable agent={agent.id} port={port} said={said} />
				)}

				{said?.at !== undefined && (
					<pre
						ref={body}
						onScroll={(event) => {
							const pane = event.currentTarget;
							stuck.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < AT_BOTTOM;
						}}
						className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunk px-4 py-3 font-mono text-[0.78rem] leading-relaxed shadow-[var(--shadow-border)]"
					>
						{text.length > 0 ? (
							text
						) : (
							<span className="text-muted">
								{said.size === 0 ? "It has printed nothing yet." : "reading…"}
							</span>
						)}
					</pre>
				)}

				{said === undefined && why === undefined && (
					<p className="flex items-center gap-2 text-[0.88rem] text-muted">
						<Spin />
						looking in {nameOf(agent.id)}…
					</p>
				)}
			</div>
		</>
	);
}

/**
 * The two states with nothing to show, each said as the different thing it is.
 *
 * Both used to be one empty box. An empty box in front of somebody looking for a stack trace is a
 * screen that looks broken, and the difference between "nothing is running" and "it is running and
 * throwing its output away" is the whole of what to do next.
 */
function Unreadable({ agent, port, said }: { agent: string; port: number; said: Printed }) {
	if (!said.listening) {
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-raised px-4 py-3 shadow-[var(--shadow-border)]">
				<p className="text-[0.88rem]">
					Nothing is listening on :{port} inside {nameOf(agent)}.
				</p>
				<p className="text-[0.82rem] text-muted">
					The door stays open either way — it starts working the moment something binds that port in
					there, and this screen starts reading the moment that something writes a line.
				</p>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-raised px-4 py-3 shadow-[var(--shadow-border)]">
			<p className="text-[0.88rem]">
				Its output goes to <span className="font-mono text-[0.82rem]">{said.to}</span>, which is not
				a file.
			</p>
			<p className="text-[0.82rem] text-muted">
				A pipe has one reader and reading it here would take the bytes out of whoever is holding the
				other end. Started with a log instead, this screen follows it — and so does the agent, which
				is the other half of why a server in a box should write one:
			</p>
			<code className="rounded bg-sunk px-3 py-2 font-mono text-[0.78rem] text-said">
				pnpm dev &gt; ~/dev.log 2&gt;&amp;1 &amp;
			</code>
		</div>
	);
}

/**
 * The two bytes a terminal acts on and a reader has no use for, kept out of the source as the
 * characters they are: written into a regular expression they are a control character in a file
 * somebody has to open in an editor.
 */
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

/** A window title or a hyperlink: escape, `]`, anything, and a bell or a string terminator. */
const TITLE = new RegExp(`${ESCAPE}\\][^${ESCAPE}${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`, "g");

/** Colours, cursor moves — everything written for a terminal to act on rather than to show. */
const CONTROL = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ALONE = new RegExp(`${ESCAPE}[@-Z\\\\-_]`, "g");

/**
 * A log as a terminal would have shown it, which is not what is in the file.
 *
 * A dev server writes for a terminal: colours as escape sequences, and a line rewritten in place by
 * returning to the start of it. Drawn as they are, a build is a page of `[32m` and forty copies of
 * the same progress line — so the colours come off, and a rewritten line is shown as the last thing
 * it was rewritten to, which is what somebody watching it would have been left looking at.
 */
export function shown(text: string): string {
	return text
		.replace(TITLE, "")
		.replace(CONTROL, "")
		.replace(ALONE, "")
		.split("\n")
		.map(
			(line) =>
				line
					.split("\r")
					.filter((part) => part.length > 0)
					.pop() ?? "",
		)
		.join("\n");
}
