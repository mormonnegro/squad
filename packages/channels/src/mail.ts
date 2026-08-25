import { baseAddress } from "./autoconfig.ts";

/** Header names folded to lower case, which is how a reader wants them and not how they arrive. */
export type MailHeaders = Readonly<Record<string, string | undefined>>;

/** An address off a header, and the name it was written under if it was written under one. */
export interface Sender {
	readonly address: string;
	readonly name?: string;
}

/**
 * Reads one address, with or without the name in front of it.
 *
 * Folded to lower case because an address is compared here far more often than it is shown, and the
 * comparisons decide who is trusted — a provider that echoes `Nico@` where it was told `nico@` must
 * not be the difference between an operator and a stranger.
 */
export function parseAddress(value: string): Sender | undefined {
	const trimmed = value.trim();
	const angled = /<([^<>]*)>[^<>]*$/.exec(trimmed);
	const address = (angled?.[1] ?? trimmed).trim().toLowerCase();
	if (!address.includes("@") || /\s/.test(address)) return undefined;

	const name =
		angled === null ? "" : trimmed.slice(0, angled.index).trim().replace(/^"|"$/g, "").trim();
	return name === "" ? { address } : { address, name };
}

/**
 * Every address in a `To:` or `Cc:`, split where the header actually splits.
 *
 * Not on commas: a display name is allowed to contain one, and `"Doe, John" <j@d.com>` is ordinary
 * enough that splitting naively turns one recipient into two, neither of which parses.
 */
export function addressesIn(value: string): readonly string[] {
	const found: string[] = [];
	let current = "";
	let quoted = false;
	let angled = false;

	const take = (): void => {
		const one = parseAddress(current);
		if (one !== undefined) found.push(one.address);
		current = "";
	};

	for (const character of value) {
		if (character === '"' && !angled) quoted = !quoted;
		else if (character === "<" && !quoted) angled = true;
		else if (character === ">" && !quoted) angled = false;
		else if (character === "," && !quoted && !angled) {
			take();
			continue;
		}
		current += character;
	}
	take();
	return found;
}

/**
 * Which agent a message was addressed to, read off the `+tag` the recipient carries.
 *
 * This is the whole reason one mailbox serves a whole plane: `you+scout@` and `you+clerk@` are the
 * same account to the provider and two different agents here, so an operator connects a mailbox once
 * and every agent has an address without connecting anything.
 *
 * The recipients are looked at rather than just the `To:`, because a message may reach the mailbox
 * without naming it anywhere a person can see — a Bcc, a forward, a list — and `Delivered-To:` is
 * then the only header that says which address it actually arrived at.
 */
export function agentFor(recipients: readonly string[], mailbox: string): string | undefined {
	const account = baseAddress(mailbox.trim().toLowerCase());

	for (const recipient of recipients) {
		const address = recipient.trim().toLowerCase();
		if (baseAddress(address) !== account) continue;

		const local = address.slice(0, address.lastIndexOf("@"));
		const plus = local.indexOf("+");
		const tag = plus === -1 ? "" : local.slice(plus + 1);
		if (tag !== "") return tag;
	}
	return undefined;
}

/** Whether an address is the connected mailbox itself, tag or no tag. */
export function isOwnAddress(address: string, mailbox: string): boolean {
	return baseAddress(address.trim().toLowerCase()) === baseAddress(mailbox.trim().toLowerCase());
}

/**
 * Whether the provider vouched for the domain this message says it is from.
 *
 * `From:` is a line of text the sender chose, and an agent that took operator instructions from
 * whoever typed the right address in it would take them from anybody. Something has to prove the
 * domain, and that something is DKIM.
 *
 * It is read rather than checked because it was already checked. The receiving provider verified the
 * signature at the moment of delivery, when the sender's keys were still the keys it signed with, and
 * wrote down what it found; re-verifying days later against DNS that has since rotated is a worse
 * answer arrived at more expensively. RFC 8601 requires a provider to strip these headers on the way
 * in so its own is the only one, and it is read off that provider's own server over TLS — so only the
 * first is looked at, which is the one the provider put there.
 */
export function authenticated(results: readonly string[], from: string): boolean {
	const first = results[0];
	if (first === undefined) return false;

	const domain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();

	for (const part of first.split(";")) {
		const verdict = /\b(dkim|dmarc)\s*=\s*(\w+)/i.exec(part);
		if (verdict?.[2]?.toLowerCase() !== "pass") continue;

		// DMARC is alignment by definition: it passes only when a passing signature names the domain the
		// message says it came from, which is the whole of the question being asked here.
		if (verdict[1]?.toLowerCase() === "dmarc") {
			const stated = /header\.from\s*=\s*<?([^\s;>)]+)/i.exec(part)?.[1]?.toLowerCase();
			if (stated === undefined || stated === domain) return true;
			continue;
		}

		const signed = /header\.[di]\s*=\s*@?([^\s;>)]+)/i.exec(part)?.[1]?.toLowerCase();
		// A subdomain signed by its parent is aligned. `mail.example.com` under `example.com` is the
		// ordinary arrangement, not somebody else's domain.
		if (signed !== undefined && (signed === domain || domain.endsWith(`.${signed}`))) return true;
	}
	return false;
}

const BULK = /^(?:bulk|list|junk|auto_reply)$/i;

/**
 * Why this message must not be answered, or nothing if it may be.
 *
 * Email is the one channel that answers back on its own. A holiday autoresponder and an agent that
 * replies to everything will write to each other until somebody notices, and every message in that
 * exchange is a turn that costs money. Every check here is a header whose entire purpose is to say
 * "do not reply to this", and the cost of honouring them is a handful of string comparisons.
 */
export function automated(headers: MailHeaders): string | undefined {
	const submitted = headers["auto-submitted"]?.trim().toLowerCase();
	// RFC 3834: anything but `no` is a machine, and the value names which kind.
	if (submitted !== undefined && submitted !== "" && !submitted.startsWith("no")) {
		return `auto-submitted: ${submitted}`;
	}

	if (headers["list-id"] !== undefined || headers["list-unsubscribe"] !== undefined) {
		return "a mailing list";
	}

	const precedence = headers.precedence?.trim();
	if (precedence !== undefined && BULK.test(precedence)) {
		return `precedence: ${precedence.toLowerCase()}`;
	}

	if (headers["x-autoreply"] !== undefined || headers["x-autorespond"] !== undefined) {
		return "an autoresponder";
	}

	// An empty return path is the envelope of a bounce, which is a report about a message rather than
	// one somebody sent. Replying to it writes to the null sender and bounces again.
	if (headers["return-path"]?.trim() === "<>") return "a bounce";
	if (headers["content-type"]?.toLowerCase().includes("multipart/report") === true) {
		return "a delivery report";
	}

	return undefined;
}

const QUOTED = /^\s*>/;
const SIGNATURE = /^--[ \t]*$/;
const SEPARATOR =
	/^\s*(?:[-_]{2,}[ \t]*(?:original message|mensaje original|forwarded message|mensaje reenviado|weitergeleitete nachricht|messaggio originale|message d'origine)[ \t]*[-_]{2,}|_{20,})[ \t]*$/i;
const MOBILE =
	/^\s*(?:sent from my\b|enviado desde mi\b|get outlook for\b|obtener outlook para\b|von meinem\b|envoyé de mon\b)/i;
const WROTE = /\b(?:wrote|escribi[oó]|a[\s ]*écrit|schrieb|ha scritto|schreef)\s*:[ \t]*$/i;
const OPENER = /^\s*(?:on|el|le|am|il|op)\b/i;
const HEADER_FROM = /^\s*(?:from|de|von|da)[ \t]*:[ \t]*.*@/i;
const HEADER_NEXT =
	/^\s*(?:sent|date|enviado|fecha|to|para|an|cc|subject|asunto|betreff|objet)[ \t]*:/i;

/**
 * The message with the conversation it was replying to taken off the bottom.
 *
 * Worth the trouble because the trail is usually the larger half. A fourth reply in a thread carries
 * the three before it, and handing all of it over every turn spends the money on re-reading what the
 * agent itself said and leaves an agent answering a question from three messages ago because that is
 * what was at the bottom of the text.
 *
 * Nothing here cuts blindly. An inline reply — answers written in among the quoted questions — keeps
 * its quotes, because there the quote is what the answers are answering; and a message that turns out
 * to be nothing but a trail is handed over whole, because a bare forward is a message whose content
 * is the thing being forwarded.
 */
export function withoutTrail(body: string): string {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");

	let cut = lines.length;
	for (let index = 0; index < lines.length; index += 1) {
		if (hardMarker(lines, index)) {
			cut = index;
			break;
		}
	}

	for (let index = 0; index < cut; index += 1) {
		const start = attributionStart(lines, index);
		if (start !== undefined && quotedThrough(lines, index + 1, cut)) {
			cut = start;
			break;
		}
	}

	while (cut > 0 && trailing(lines[cut - 1] ?? "")) cut -= 1;

	const kept = lines.slice(0, cut).join("\n").trim();
	return kept === "" ? body.trim() : kept;
}

function trailing(line: string): boolean {
	return line.trim() === "" || QUOTED.test(line);
}

function quotedThrough(lines: readonly string[], from: number, to: number): boolean {
	let quotes = 0;
	for (let index = from; index < to; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() === "") continue;
		if (!QUOTED.test(line)) return false;
		quotes += 1;
	}
	return quotes > 0;
}

/** A line below which nothing is ever the person's own message, whatever follows it. */
function hardMarker(lines: readonly string[], index: number): boolean {
	const line = lines[index] ?? "";
	if (SIGNATURE.test(line) || SEPARATOR.test(line) || MOBILE.test(line)) return true;

	// Outlook pastes the original's headers with nothing to introduce them, so the block is the mark.
	if (!HEADER_FROM.test(line)) return false;
	return [1, 2, 3].some((ahead) => HEADER_NEXT.test(lines[index + ahead] ?? ""));
}

/**
 * Where the `On … wrote:` line begins, if this line ends one.
 *
 * Two lines are looked at because clients wrap it. Gmail routinely leaves `wrote:` alone on a line of
 * its own, and cutting at that line keeps the half of the attribution above it — a stray date and a
 * stranger's address at the bottom of every message.
 */
function attributionStart(lines: readonly string[], index: number): number | undefined {
	const line = lines[index] ?? "";
	if (line.length > 400 || !WROTE.test(line)) return undefined;

	// It has to say who and when. A paragraph opening "As I wrote:" ends the same way and is not one.
	if (OPENER.test(line) || line.includes("@") || /\d/.test(line)) return index;

	const previous = lines[index - 1];
	return previous !== undefined && OPENER.test(previous) ? index - 1 : undefined;
}

const ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * The words out of an HTML part, for the messages that arrive with no plain text at all.
 *
 * Not a parse, and it does not need to be: nothing here is rendered or executed, the output goes into
 * a prompt as untrusted data, and what is wanted is the text between the tags. A real HTML parser
 * would be a dependency carried for one fallback path.
 */
export function readableText(html: string): string {
	const stripped = html
		.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
		.replace(/<[^>]+>/g, "");

	return decodeEntities(stripped)
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, body: string) => {
		if (!body.startsWith("#")) return ENTITIES[body.toLowerCase()] ?? whole;

		const hex = body[1]?.toLowerCase() === "x";
		const code = hex ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
		return Number.isInteger(code) && code > 0 && code <= 0x10ffff
			? String.fromCodePoint(code)
			: whole;
	});
}
