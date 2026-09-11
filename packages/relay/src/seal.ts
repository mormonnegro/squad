// WebCrypto is described in the DOM lib and implemented by both ends of this — a browser tab and a
// Node process — so the types are asked for here, in the one file that needs them, rather than in
// the tsconfig of everything that ever imports it. A package that pulled `lib: DOM` into the control
// plane to describe four functions would be paying for it everywhere.
/// <reference lib="dom" />

/**
 * What makes the relay blind.
 *
 * The relay's whole job is to put two sockets together and copy bytes between them, and the price of
 * that job is that somebody has to run it. This is what keeps the price from including reading the
 * traffic: both ends derive the same key from a secret the relay is never given, and what crosses it
 * is ciphertext with a room number on the outside.
 *
 * WebCrypto and nothing else, because the two ends are a Node process and a browser tab and this is
 * the one cryptographic interface both of them already have. No dependency, and one implementation
 * rather than two that have to agree.
 */

/** The secret both ends know, which is the plane's web token. Never sent to the relay. */
export type Secret = string;

const ROOM_INFO = "squad-relay-room";
const KEY_INFO = "squad-relay-key";

/**
 * The room, which is public, derived from the secret, which is not.
 *
 * One way on purpose: this is the only thing the relay is told, and it has to be enough to pair two
 * sockets and not enough to read what they say. HKDF gives exactly that — a relay operator holding
 * every room number it has ever seen can recover no token from any of them.
 */
export async function roomOf(secret: Secret): Promise<string> {
	const bits = await derive(secret, ROOM_INFO, 16);
	return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key the frames are sealed with, from the same secret and a different label. */
export async function keyOf(secret: Secret): Promise<CryptoKey> {
	const bits = await derive(secret, KEY_INFO, 32);
	return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function derive(secret: Secret, info: string, bytes: number): Promise<ArrayBuffer> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		"HKDF",
		false,
		["deriveBits"],
	);
	return crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			// No salt, because there is nothing here to put in one that both ends would agree on and the
			// relay would not see. The secret is already high-entropy — it is 32 random bytes the plane
			// generated — so what a salt buys against a low-entropy password does not apply.
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(info),
		},
		material,
		bytes * 8,
	);
}

/**
 * One end's outgoing frames.
 *
 * A nonce may never repeat under one key, and the two ends hold the same key, so the counter cannot
 * be the whole of it: both would start at zero and the first frame each sends would collide. Eight
 * random bytes per stream and a counter in the remaining four gives each direction — and each
 * reconnection — a space of its own, at the cost of a collision no more likely than one in 2^64.
 */
export class Sealer {
	readonly #key: CryptoKey;
	readonly #room: string;
	readonly #stream = crypto.getRandomValues(new Uint8Array(8));
	#counter = 0;

	constructor(key: CryptoKey, room: string) {
		this.#key = key;
		this.#room = room;
	}

	async seal(line: string): Promise<string> {
		if (this.#counter > 0xffffffff) throw new Error("This stream is spent; reconnect.");
		const nonce = new Uint8Array(12);
		nonce.set(this.#stream, 0);
		new DataView(nonce.buffer).setUint32(8, this.#counter++, false);
		const sealed = await crypto.subtle.encrypt(
			// The room is bound in rather than only carried alongside, so a frame lifted out of one room
			// and posted into another fails to open instead of arriving.
			{ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(this.#room) },
			this.#key,
			new TextEncoder().encode(line),
		);
		const frame = new Uint8Array(nonce.length + sealed.byteLength);
		frame.set(nonce, 0);
		frame.set(new Uint8Array(sealed), nonce.length);
		return base64url(frame);
	}
}

/**
 * The other end's frames, opened once each.
 *
 * Counters are remembered per stream and have to climb, which is what makes a frame the relay kept
 * and sent twice arrive once. Out of order is refused rather than buffered: this runs over one
 * ordered connection, so a frame arriving behind its successor is not lateness, it is somebody
 * replaying.
 */
export class Opener {
	readonly #key: CryptoKey;
	readonly #room: string;
	readonly #seen = new Map<string, number>();

	constructor(key: CryptoKey, room: string) {
		this.#key = key;
		this.#room = room;
	}

	async open(frame: string): Promise<string> {
		const bytes = unbase64url(frame);
		if (bytes.length <= 12) throw new Error("A frame that short carries nothing.");
		const nonce = bytes.subarray(0, 12);
		const stream = [...nonce.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
		const counter = new DataView(nonce.buffer, nonce.byteOffset).getUint32(8, false);
		const last = this.#seen.get(stream);
		if (last !== undefined && counter <= last) throw new Error("That frame has already arrived.");
		const line = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(this.#room) },
			this.#key,
			bytes.subarray(12),
		);
		// Only once it has opened. A frame that fails to authenticate must not move the counter, or
		// anyone able to post into the room could push it past the frames still to come.
		this.#seen.set(stream, counter);
		return new TextDecoder().decode(line);
	}
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The buffer is named as well as the view: WebCrypto takes a BufferSource backed by an ArrayBuffer,
// and the unparameterised Uint8Array could be sitting on a SharedArrayBuffer as far as the types
// know.
function unbase64url(text: string): Uint8Array<ArrayBuffer> {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
