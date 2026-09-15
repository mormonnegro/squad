/**
 * Bytes off the wire, which arrive as base64 wherever they come from a box.
 *
 * Two screens read out of a sandbox now — the files and what a served port is printing — and both
 * are handed the same thing: a chunk of a file, encoded, because the protocol carries lines and half
 * of what is worth looking at is not text. The decoding is the same four lines in both, which is
 * three too many to have twice.
 */

export function bytesOf(base64: string): Uint8Array {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
	return out;
}

export function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
