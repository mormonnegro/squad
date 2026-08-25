import { randomBytes } from "node:crypto";

/** No vowels, so it cannot come out as a word, and none of the letters a digit is mistaken for. */
const CODE_ALPHABET = "bcdfghjkmnpqrstvwxz23456789";

/**
 * A phrase that binds whoever sends it back as the operator of what it was issued for.
 *
 * The same phrase serves a bot and a mailbox because the job is the same in both: something the
 * console prints once, that arrives over the channel itself and proves the person holding the console
 * is the person on the other end of it.
 *
 * In the alphabet a Telegram `/start` deep link allows, so the console can offer it as a link to tap
 * rather than a code to copy across to a phone — which is where Telegram is, and where a keyboard is
 * not.
 */
export function pairingPhrase(): string {
	return Array.from(randomBytes(10), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}
