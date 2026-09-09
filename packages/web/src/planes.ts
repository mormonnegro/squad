/**
 * The planes this browser knows how to reach, and how.
 *
 * Kept here rather than on a server because it is the answer to "whose agents are these" and that
 * answer is the operator's. A hosted page that held the list would be a hosted page that knows every
 * machine every customer runs, which is a thing to be breached rather than a feature.
 */

export type Reach =
	/** A plane on the machine this browser is running on, answering on its own port. */
	| { readonly kind: "here"; readonly origin: string }
	/**
	 * A plane that dialled out to a relay, and is spoken to through it.
	 *
	 * The relay routes and nothing else: the frames it carries are sealed between this browser and
	 * that plane, so what it holds is who talks to whom and when. `planeId` is public — it names a
	 * destination, and knowing it grants nothing without the key this browser keeps.
	 */
	| { readonly kind: "relayed"; readonly relay: string; readonly planeId: string };

export interface KnownPlane {
	/** This browser's name for it. Only ever printed. */
	readonly name: string;
	readonly reach: Reach;
	/** When it last answered, so a list of five can say which one is worth opening. */
	readonly seenAt?: string;
}

const KEY = "squad.planes";

/**
 * The plane every install has before it has paired anything.
 *
 * Offered rather than assumed: a browser open on a laptop with no plane on it should not spend its
 * first five seconds failing to connect to one. It is in the list, and it says what it is.
 */
export const HERE: KnownPlane = {
	name: "This computer",
	reach: { kind: "here", origin: "" },
};

export function planeKey(reach: Reach): string {
	return reach.kind === "here" ? `here:${reach.origin}` : `relayed:${reach.relay}:${reach.planeId}`;
}

export function readPlanes(): readonly KnownPlane[] {
	try {
		const held: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		if (!Array.isArray(held)) return [HERE];
		const known = held.filter((one): one is KnownPlane => isPlane(one));
		// The local one is never removed from the list, only pushed down it. A browser whose storage
		// was cleared should still find the plane on the machine it is running on.
		return known.some((one) => one.reach.kind === "here") ? known : [...known, HERE];
	} catch {
		return [HERE];
	}
}

export function writePlanes(planes: readonly KnownPlane[]): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(planes));
	} catch {
		// A browser refusing storage is a browser that will ask again next time, which is worse than
		// remembering and better than not opening.
	}
}

export function rememberPlane(plane: KnownPlane): readonly KnownPlane[] {
	const key = planeKey(plane.reach);
	const kept = readPlanes().filter((one) => planeKey(one.reach) !== key);
	const planes = [plane, ...kept];
	writePlanes(planes);
	return planes;
}

export function forgetPlane(reach: Reach): readonly KnownPlane[] {
	const key = planeKey(reach);
	const planes = readPlanes().filter((one) => planeKey(one.reach) !== key);
	writePlanes(planes);
	return planes;
}

function isPlane(value: unknown): value is KnownPlane {
	if (typeof value !== "object" || value === null) return false;
	const { name, reach } = value as Record<string, unknown>;
	if (typeof name !== "string" || typeof reach !== "object" || reach === null) return false;
	const { kind } = reach as Record<string, unknown>;
	return kind === "here" || kind === "relayed";
}
