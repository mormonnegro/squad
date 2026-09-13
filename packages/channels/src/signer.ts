import { createHmac, timingSafeEqual } from "node:crypto";
import { isFresh, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER, verify } from "./signature.ts";

/**
 * Who is at the other end of a hook, which decides how its signature is read.
 *
 * Every one of these is the same arithmetic — an HMAC over the body, usually with a timestamp mixed
 * in so an old delivery cannot be replayed forever — and they differ only in where the two numbers
 * are written down. So this is a list of spellings, not a list of protocols, and a new one is a
 * couple of lines rather than a new way of being authentic.
 *
 * `squad` is this plane's own, which is what anything we write posts with. The other two are there
 * because they are what people actually want to be woken by.
 */
export type Signer = "squad" | "stripe" | "github";

export const SIGNERS: readonly Signer[] = ["squad", "stripe", "github"];

export function isSigner(said: string): said is Signer {
	return (SIGNERS as readonly string[]).includes(said);
}

/** How each of them is described where somebody is choosing between them. */
export const SIGNER_SAID: Record<Signer, string> = {
	squad: "anything squad signs, and anything you write yourself",
	stripe: "Stripe, with the signing secret from its webhook page",
	github: "GitHub, with the secret from the repository's webhook",
};

export interface Presented {
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly body: string;
	readonly secret: string;
	readonly now: Date;
	readonly toleranceSeconds: number;
}

/** A constant-time compare that does not throw, and does not leak the expected length by throwing. */
function same(expected: string, presented: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function hmac(secret: string, payload: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Whether this delivery is really from who it says, on that sender's own terms.
 *
 * False for anything unreadable rather than throwing: a hook endpoint answers 401 to everything it
 * cannot accept, and a caller that had to tell "wrong signature" from "no signature" would be a
 * caller that answers differently to a prober.
 */
export function authentic(signer: Signer, presented: Presented): boolean {
	const { headers, body, secret, now, toleranceSeconds } = presented;

	if (signer === "squad") {
		const timestamp = headers[TIMESTAMP_HEADER];
		const signature = headers[SIGNATURE_HEADER];
		if (timestamp === undefined || signature === undefined) return false;
		if (!isFresh(timestamp, now, toleranceSeconds)) return false;
		return verify(secret, timestamp, body, signature);
	}

	if (signer === "stripe") {
		// `t=1492774577,v1=5257a869…`, and more than one `v1` while a secret is being rotated. The
		// signed string is the timestamp, a dot, and the body — the same thing squad signs, written
		// into one header instead of two.
		const said = headers["stripe-signature"];
		if (said === undefined) return false;
		const parts = said.split(",").map((one) => one.trim());
		const timestamp = parts.find((one) => one.startsWith("t="))?.slice(2);
		if (timestamp === undefined || !isFresh(timestamp, now, toleranceSeconds)) return false;
		const expected = hmac(secret, `${timestamp}.${body}`);
		return parts.filter((one) => one.startsWith("v1=")).some((one) => same(expected, one.slice(3)));
	}

	// GitHub signs the body and nothing else, so a delivery somebody kept is good forever. That is
	// GitHub's decision and not one this can fix; what it can do is not pretend otherwise.
	const said = headers["x-hub-signature-256"];
	if (said === undefined) return false;
	return same(`sha256=${hmac(secret, body)}`, said);
}

/** What kind of thing happened, and which delivery it was, as far as the sender says. */
export interface Delivery {
	/** The event type — `customer.subscription.deleted`, `pull_request` — when there is one. */
	readonly kind: string | undefined;
	/** The sender's own id for it, so the same one arriving twice can be recognised as the same. */
	readonly id: string | undefined;
}

export function deliveryIn(
	signer: Signer,
	headers: Readonly<Record<string, string | undefined>>,
	body: string,
): Delivery {
	// GitHub puts both in headers; Stripe puts both in the body; anything of ours is free to do
	// either, so both are read and the header wins for being the cheaper of the two to trust.
	if (signer === "github") {
		return { kind: headers["x-github-event"], id: headers["x-github-delivery"] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { kind: undefined, id: undefined };
	}
	if (typeof parsed !== "object" || parsed === null) return { kind: undefined, id: undefined };
	const { type, id } = parsed as Record<string, unknown>;
	return {
		kind: typeof type === "string" ? type : undefined,
		id: typeof id === "string" ? id : undefined,
	};
}

/**
 * Whether a kind of event is one of the ones asked for.
 *
 * A trailing `*` and nothing else, because the patterns people write here are `charge.*` and
 * `customer.subscription.deleted` — and a glob language would be a second thing to learn for the
 * one case it covers that this does not.
 *
 * An empty list means everything, which is what a hook with nothing said about it should do.
 */
export function asked(only: readonly string[], kind: string | undefined): boolean {
	if (only.length === 0) return true;
	if (kind === undefined) return false;
	return only.some((pattern) =>
		pattern.endsWith("*") ? kind.startsWith(pattern.slice(0, -1)) : kind === pattern,
	);
}

/** Signs an outgoing reply the way this plane signs everything, for hooks that take one. */
export function signedHeaders(
	secret: string,
	timestamp: string,
	body: string,
): Record<string, string> {
	return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: sign(secret, timestamp, body) };
}
