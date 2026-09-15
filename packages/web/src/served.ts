import { useEffect, useState } from "react";
import type { Plane } from "./plane.ts";

/**
 * Where the console sends somebody who wants to see what an agent is serving.
 *
 * Two addresses for one port, and which one is drawn matters. The path is the one that always
 * works: it hangs off whatever address this console is read at, and the door turns it into a name
 * of that port's own on the way through. The name is the one worth showing, because a link is
 * hovered, copied, read and sent before it is clicked — and a link whose address is this console's
 * is a link that says the page it opens is this console's, which is the one thing it is not.
 *
 * So the path is what is drawn until the door has said the name, and the name from then on. Asked
 * once per port and kept for as long as the page is open: the answer is about the address this
 * console is read at, and that does not change while it is being read.
 */
const known = new Map<string, string | undefined>();

/** The path, which is what the door is asked at and what is drawn until it has answered. */
export function servedPath(agentId: string, port: number): string {
	return `/at/${agentId}/${port}/`;
}

export function useServedAt(
	/** Absent until the wire is up, which is a rail already drawn: the path stands in until then. */
	plane: Plane | undefined,
	agentId: string,
	served: readonly { readonly port: number }[],
): (port: number) => string {
	// The ports as one string, so this asks again when an agent opens a port and not on every render
	// that happens to hand it a new array of the same numbers.
	const ports = served.map((one) => one.port).join(",");
	const [, answered] = useState(0);

	useEffect(() => {
		if (plane === undefined) return;
		let reading = true;
		void (async () => {
			for (const said of ports.split(",").filter((one) => one.length > 0)) {
				const port = Number(said);
				const key = `${agentId}:${port}`;
				if (known.has(key)) continue;
				// Kept even when it is nothing, because "this console can have no names under it" is an
				// answer and asking again on every render would be asking the same question forever.
				known.set(key, await plane.servedAt(agentId, port).catch(() => undefined));
				if (reading) answered((count) => count + 1);
			}
		})();
		return () => {
			reading = false;
		};
	}, [plane, agentId, ports]);

	return (port) => known.get(`${agentId}:${port}`) ?? servedPath(agentId, port);
}
