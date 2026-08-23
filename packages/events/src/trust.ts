import { randomBytes } from "node:crypto";

/**
 * How much authority the author of a piece of content has over the agent.
 *
 * Only `operator` content may be read as instructions. Everything else is data the agent may
 * reason about but must not obey. The distinction exists because an agent that reads its
 * instructions and its inputs from the same undifferentiated text will follow whatever a stranger
 * writes into a channel, which is how public assistants have been made to leak private context
 * and move money on a stranger's say-so.
 */
export type TrustLevel = "operator" | "participant" | "public";

export const TRUST_LEVELS: readonly TrustLevel[] = ["operator", "participant", "public"];

export function isTrustLevel(value: unknown): value is TrustLevel {
	return typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value);
}

/** Only the operator may instruct. This is the single check the rest of the system relies on. */
export function mayInstruct(trust: TrustLevel): boolean {
	return trust === "operator";
}

const DESCRIPTIONS: Record<TrustLevel, string> = {
	operator: "the operator of this agent",
	participant: "an identified participant in an allowed channel",
	public: "an unauthenticated source",
};

export function describeTrust(trust: TrustLevel): string {
	return DESCRIPTIONS[trust];
}

/**
 * Wraps untrusted text in a delimiter the text cannot contain.
 *
 * A fixed delimiter is forgeable: content that includes the closing marker ends the block early
 * and everything after it is read as instructions. Deriving the delimiter from random bytes and
 * checking it against the payload removes that move, because the attacker would have to guess a
 * value chosen after their content was written.
 */
export function fence(content: string, label: string): string {
	let tag = randomBytes(9).toString("base64url");
	while (content.includes(tag)) tag = randomBytes(9).toString("base64url");

	return [`<<<${label} ${tag}`, content, `${tag} ${label}>>>`].join("\n");
}
