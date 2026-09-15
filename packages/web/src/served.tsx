import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { Plane } from "./plane.ts";

/**
 * Where the console sends somebody who wants to see what an agent is serving.
 *
 * Two addresses for one port, and which one is drawn matters. The path is the one that always
 * works: it hangs off whatever address this console is read at, and the door turns it into a name
 * of that port's own on the way through. The name is the one worth showing, because a link is
 * hovered, copied, read and sent before it is clicked — and a link whose address is this console's
 * says the page it opens is this console's, which is the one thing it is not.
 *
 * So the path is what is drawn until the door has said the name, and the name from then on. Asked
 * once per port and kept for as long as the page is open: the answer is about the address this
 * console is read at, and that does not change while it is being read.
 */
const known = new Map<string, string | undefined>();

/** What the door is asked at, and what stands in until it has answered. */
export function servedPath(agentId: string, port: number): string {
	return `/at/${agentId}/${port}/`;
}

/** A port written into a sentence, which is how `/serve` hands one over. */
export const SERVED_IN_TEXT = /^\/at\/([a-z0-9][a-z0-9-]*)\/([0-9]{1,5})\/?/;

/**
 * Where each port is read, for everything on the screen that draws one.
 *
 * A function rather than a list, because the ports that need an address are not known in advance:
 * two of them are beside the agent, and the rest are wherever `/serve` was answered in a
 * conversation somebody has scrolled back to.
 */
export function useServedLinks(
	/** Absent until the wire is up, which is a rail already drawn: the path stands in until then. */
	plane: Plane | undefined,
): (agentId: string, port: number) => string {
	const [, answered] = useState(0);
	const asking = useRef(new Set<string>());

	// Every render rather than on a dependency, because what changes is which ports have been drawn
	// since the last one, and that is a set filled in while drawing. It settles in one more pass: the
	// answers come back, the screen is redrawn, and by then there is nothing left to ask.
	useEffect(() => {
		if (plane === undefined) return;
		const wanted = [...asking.current].filter((key) => !known.has(key));
		if (wanted.length === 0) return;
		let reading = true;
		void (async () => {
			for (const key of wanted) {
				const [agentId = "", said = ""] = key.split(":");
				// Kept even when it is nothing, because "this console can have no names under it" is an
				// answer, and asking again on the next render would be asking it forever.
				known.set(key, await plane.servedAt(agentId, Number(said)).catch(() => undefined));
			}
			if (reading) answered((count) => count + 1);
		})();
		return () => {
			reading = false;
		};
	});

	return (agentId, port) => {
		const key = `${agentId}:${port}`;
		if (!known.has(key)) asking.current.add(key);
		return known.get(key) ?? servedPath(agentId, port);
	};
}

/**
 * Held as context for the same reason the box is: what draws one of these is four levels under
 * whoever holds the connection — a message, its markdown, a line, a word in the line.
 */
const Where = createContext<((agentId: string, port: number) => string) | undefined>(undefined);

export const ServedIs = Where.Provider;

/** The same answer, for a screen that draws a port directly rather than through a sentence. */
export function useServedAt(): (agentId: string, port: number) => string {
	return useContext(Where) ?? servedPath;
}

/** A port an agent opened, named in a sentence, as the address that opens it. */
export function ServedLink({
	agentId,
	port,
	children,
}: {
	agentId: string;
	port: number;
	children: ReactNode;
}) {
	const where = useContext(Where);
	// Nothing to resolve it with is a screen with no connection behind it, and then it is what it
	// was: the characters somebody wrote. A link to a path that only this console can complete
	// would be a link that goes to this console.
	if (where === undefined) return <>{children}</>;
	return (
		<a
			href={where(agentId, port)}
			target="_blank"
			rel="noreferrer noopener"
			title={`what ${agentId} is serving on ${port}`}
		>
			{children}
		</a>
	);
}
