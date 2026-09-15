import type { AgentSummary } from "@squad/control-plane";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useServedAt } from "./served.tsx";

/**
 * Where an agent's browser is watched from, copied here because the browser cannot import the
 * plane's own packages: the one that names this number reaches for node:http on its first line.
 * A test in a node environment holds both and refuses to let the two drift.
 */
export const SCREEN_VIEW_PORT = 7180;

/**
 * Whether this agent has a browser right now.
 *
 * Read off the ports it is serving rather than asked for separately, because that is what the
 * plane already publishes and what the screen actually is from out here: one port, opened by the
 * plane rather than by the agent, that answers with a live view of a browser.
 */
export function hasScreen(agent: AgentSummary): boolean {
	return agent.served.some((one) => one.port === SCREEN_VIEW_PORT);
}

/**
 * The agent's browser, in the console, over the conversation it belongs to.
 *
 * Here rather than behind a door in the rail, and that is the whole point of it: what this is for
 * is the moment an agent says it cannot get past a sign-in. Reading that sentence and doing
 * something about it are one action, and a browser in another tab makes them two — you leave the
 * conversation to act, and come back to find out whether it worked.
 *
 * In an iframe, which keeps the separation the plane went to some trouble for: the page inside is
 * served from an origin of its own, so nothing the agent put on that screen can read the session
 * this console is held open with. It also means the bar inside it — whose screen, who has the
 * keyboard, where it is pointed — is that page's own, and is not drawn twice out here.
 */
export function Screen({ agentId }: { agentId: string }) {
	const servedAt = useServedAt();
	const [open, setOpen] = useState(true);
	const at = servedAt(agentId, SCREEN_VIEW_PORT);

	return (
		<section className="flex flex-none flex-col border-line border-b" aria-label="screen">
			<div className="flex items-center gap-2 px-5 py-1.5 text-[0.78rem] text-muted">
				<button
					type="button"
					className="flex flex-1 items-center gap-1.5 text-left hover:text-say"
					onClick={() => setOpen(!open)}
					title={open ? "put the screen away" : "show the screen"}
				>
					{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
					<span>screen</span>
				</button>
				{/*
				 * The way out to a window of its own, for the work that wants one: signing into
				 * something with a two-factor code, or reading a page at the size it was designed at.
				 * Written as a link rather than a button because it is one, and it opens the same
				 * address this frame is already showing.
				 */}
				<a
					className="flex items-center gap-1.5 hover:text-say"
					href={at}
					target="_blank"
					rel="noreferrer noopener"
					title={`${agentId}'s browser, in a window of its own`}
				>
					<ExternalLink className="size-3.5" />
					<span>open</span>
				</a>
			</div>
			{open && (
				// Tall enough to be a browser and short enough to leave a conversation under it. The
				// page inside scales what it draws to whatever width it is given, so this only has to
				// decide the height.
				<iframe
					key={agentId}
					title={`${agentId}'s screen`}
					src={at}
					className="h-[min(46vh,30rem)] w-full border-line border-t bg-ground"
				/>
			)}
		</section>
	);
}
