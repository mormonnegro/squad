/**
 * How long until an agent wakes itself, in the shortest true thing to say.
 *
 * Copied from the plane rather than imported, for the same reason the slash menu is: the module it
 * lives in reaches for node:crypto and would pull the whole plane into a browser bundle. A test
 * holds both and fails the day they disagree.
 *
 * A wakeup an hour out is not more useful for being told to the second, and the room it goes in is
 * whatever is left of a row once the name has taken its share.
 */
export function until(iso: string, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
