import { timingSafeEqual } from "node:crypto";

/**
 * What the agent has to say to be let in at its own screen's door.
 *
 * The door has to be on the sandbox network — that is where the agent is — and every other sandbox
 * on this plane is on that network too. Without this, `scout-screen:7181` is a browser any agent on
 * the plane can drive, including the one holding somebody's signed-in mail.
 *
 * The secret is the agent's own egress token, which both ends already hold and neither end had to
 * be given for this: the sandbox has it in its proxy URL because every request it makes carries it,
 * and the screen has it because the browser's requests carry it too. Reusing it rather than issuing
 * a second one is what makes this work on sandboxes that were created before screens existed —
 * a new variable would have meant recreating a container to turn a screen on.
 */
export function tokenIn(proxyUrl: string | undefined): string | undefined {
	if (proxyUrl === undefined || proxyUrl === "") return undefined;
	try {
		const password = decodeURIComponent(new URL(proxyUrl).password);
		return password === "" ? undefined : password;
	} catch {
		return undefined;
	}
}

/**
 * Whether the header presented is the token, compared in constant time.
 *
 * Constant time because the comparison is with something an attacker on this network can retry as
 * often as they like, and a `===` on a secret is the textbook way to hand out its first byte.
 */
export function presented(header: string | undefined, token: string | undefined): boolean {
	if (token === undefined) return false;
	const given = (header ?? "").startsWith("Bearer ") ? (header ?? "").slice("Bearer ".length) : "";
	const ours = Buffer.from(token);
	const theirs = Buffer.from(given);
	// Lengths differ is itself an answer, and timingSafeEqual throws rather than answering it.
	if (ours.byteLength !== theirs.byteLength) return false;
	return timingSafeEqual(ours, theirs);
}
