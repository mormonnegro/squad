/**
 * What a browser event means for an action that has just been taken.
 *
 * Its own file because this is the thing that was got wrong twice, in the same afternoon, each time
 * by watching for one event and missing the two others that mean the same. What an action needs to
 * know is only ever "has the page finished doing what I made it do", and the web answers that in
 * three different ways depending on how the page was written and how it got there.
 */

/** One CDP event, cut down to the two fields that decide anything here. */
export interface Happened {
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

/**
 * The three ways a page says it has arrived, and the one way it says it is going somewhere.
 *
 *  - `began`: a navigation was announced. Something is coming, so it is worth waiting for.
 *  - `done`: the page finished. A real load fires `loadEventFired`; an application that swapped its
 *    own page fires `navigatedWithinDocument` and never fires a load at all; a page restored from
 *    the back-forward cache fires neither, and only its frame stopping says so.
 *
 * The last one is held to the top frame, because an advert in an iframe finishing is not the page
 * arriving — and on an ordinary news site that iframe finishes first.
 */
export function meaningOf(
	event: Happened,
	mainFrame: string | undefined,
): "began" | "done" | undefined {
	if (event.method === "Page.frameStartedLoading") return "began";
	if (event.method === "Page.loadEventFired") return "done";
	if (event.method === "Page.navigatedWithinDocument") return "done";
	if (event.method !== "Page.frameStoppedLoading") return undefined;
	const frameId = event.params?.frameId;
	// Unknown top frame means this is the first navigation of the tab, and the only frame there is.
	if (mainFrame === undefined || frameId === mainFrame) return "done";
	return undefined;
}
