import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-agent-dive-signature";
export const TIMESTAMP_HEADER = "x-agent-dive-timestamp";

/**
 * Signs the timestamp together with the body.
 *
 * Signing the body alone would make every request replayable forever by anyone who saw it once,
 * which for an agent means an old "deploy failed" can be re-fired at will.
 */
export function sign(secret: string, timestamp: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verify(
	secret: string,
	timestamp: string,
	body: string,
	presented: string,
): boolean {
	const expected = Buffer.from(sign(secret, timestamp, body));
	const actual = Buffer.from(presented);
	// timingSafeEqual throws on a length mismatch, which would itself leak the expected length.
	return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function isFresh(timestamp: string, now: Date, toleranceSeconds: number): boolean {
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds)) return false;
	return Math.abs(now.getTime() / 1000 - seconds) <= toleranceSeconds;
}
