import { Resolver } from "node:dns/promises";

/** Where a mailbox is read from, which is all this channel needs to know to connect. */
export interface Incoming {
	readonly host: string;
	readonly port: number;
	/** The name to log in with. Usually the address, but iCloud wants the local part alone. */
	readonly username: string;
	/** How it was worked out, so an answer can say whether it was told or guessed. */
	readonly found: "known" | "autoconfig" | "well-known" | "ispdb" | "srv" | "guess";
}

/**
 * Where the same account's mail is handed in to be sent.
 *
 * The credential is the one already asked for: a provider issues an app password for the account,
 * not for a protocol, and the same one submits mail that reads it. That is the whole reason sending
 * costs nothing extra to set up — the alternative was a second account somewhere with a reputation
 * to build from zero, which is the part of email nobody can do quickly.
 */
export interface Outgoing {
	readonly host: string;
	readonly port: number;
}

/**
 * Where an account's mail is read and where it is handed in, as far as either could be found.
 *
 * Reading is required and sending is not. A mailbox that can only be read is a channel that works —
 * it was the whole channel until now — so a provider that says nothing about submission is a
 * provider whose mail is still worth reading.
 */
export interface Servers {
	readonly incoming: Incoming;
	readonly outgoing?: Outgoing;
}

/** The same pair before the account's own username is known: what one step of discovery answers. */
interface Found {
	readonly incoming?: Omit<Incoming, "username">;
	readonly outgoing?: Outgoing;
}

/**
 * A provider that will not take a password at all, and what to say instead of letting it fail.
 *
 * Both of these closed recently and neither says so at the protocol level: the login is simply
 * refused, with a message about credentials that sends whoever reads it back to check a password
 * that was never the problem. Naming it at the moment the address is typed is the only place this
 * costs nothing — every later place is somebody debugging the wrong thing.
 */
export interface Closed {
	readonly why: string;
}

const ISPDB = "https://autoconfig.thunderbird.net/v1.1";

/** How long any one step of discovery may take. The chain has five, and it runs while somebody waits. */
const STEP_MS = 3000;

/**
 * Providers worth knowing without asking, and the page where a password for them is made.
 *
 * The link is the point. Every provider buries this screen somewhere different and none of them
 * call it the same thing, so "make an app password" is an instruction that ends in a search box.
 * Handing over the URL turns the longest step of connecting a mailbox into a click.
 */
const KNOWN: Record<
	string,
	Incoming & { readonly appPasswords: string; readonly outgoing: Outgoing }
> = {
	"fastmail.com": {
		host: "imap.fastmail.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://app.fastmail.com/settings/security/apppasswords",
		outgoing: { host: "smtp.fastmail.com", port: 465 },
	},
	"gmail.com": {
		host: "imap.gmail.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://myaccount.google.com/apppasswords",
		outgoing: { host: "smtp.gmail.com", port: 465 },
	},
	"zoho.com": {
		host: "imappro.zoho.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://accounts.zoho.com/home#security",
		outgoing: { host: "smtppro.zoho.com", port: 465 },
	},
	"icloud.com": {
		host: "imap.mail.me.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://account.apple.com/account/manage",
		outgoing: { host: "smtp.mail.me.com", port: 587 },
	},
};

/** The two that no longer take a password, however correct the password is. */
const SHUT: Record<string, string> = {
	"outlook.com":
		"Microsoft retired password logins for IMAP. Outlook needs OAuth, which this cannot do yet.",
	"hotmail.com":
		"Microsoft retired password logins for IMAP. Hotmail needs OAuth, which this cannot do yet.",
	"live.com":
		"Microsoft retired password logins for IMAP. Live needs OAuth, which this cannot do yet.",
};

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * The address with any `+tag` taken off, which is the account the tag was a label on.
 *
 * Plus-addressing is how one mailbox serves every agent — `you+scout@` and `you+clerk@` land in the
 * same inbox — so the address an agent is reached at and the account it lives in are routinely not
 * the same string, and logging in wants the account.
 */
export function baseAddress(address: string): string {
	const at = address.lastIndexOf("@");
	if (at === -1) return address;
	const local = address.slice(0, at);
	const plus = local.indexOf("+");
	return plus === -1 ? address : local.slice(0, plus) + address.slice(at);
}

/**
 * Says a provider will refuse a password before one is asked for, or nothing if it will not.
 *
 * The domain table catches Microsoft, who took the door off their own names. Google is the harder
 * one and the one more people will hit: `gmail.com` still takes app passwords, while the same
 * company hosting a company's own domain has not since May 2025 — and the domain is whatever the
 * company is called, so nothing in the address says which of the two it is. The MX does.
 */
export async function closedTo(address: string): Promise<Closed | undefined> {
	const domain = domainOf(address);
	const why = SHUT[domain];
	if (why !== undefined) return { why };
	if (KNOWN[domain] !== undefined) return undefined;

	return (await hostedByGoogle(domain))
		? {
				why: [
					"That domain's mail is hosted by Google Workspace, which stopped accepting app passwords",
					"for IMAP in May 2025. Only personal @gmail.com accounts still take one. A Workspace",
					"mailbox needs OAuth, which this cannot do yet.",
				].join("\n"),
			}
		: undefined;
}

async function hostedByGoogle(domain: string): Promise<boolean> {
	try {
		const resolver = new Resolver({ timeout: STEP_MS, tries: 1 });
		const records = await resolver.resolveMx(domain);
		return records.some((one) => /(^|\.)google(mail)?\.com\.?$/i.test(one.exchange));
	} catch {
		// A domain that will not answer about its own mail is not evidence of anything. Let the login
		// be the thing that finds out, rather than refusing an address over a DNS timeout.
		return false;
	}
}

/**
 * Whether what was discovered points at this machine, which means a bridge rather than a server.
 *
 * Proton is the one that does this: its autoconfig honestly advertises `127.0.0.1:1143`, because the
 * mail is only reachable through a bridge the user runs on their own desktop. Correct, and useless
 * to a plane on a VPS — which would otherwise dial its own loopback and fail with something about
 * a connection refused, from an address that looked perfectly ordinary.
 */
export function needsBridge(incoming: Incoming): boolean {
	return (
		incoming.host === "localhost" ||
		incoming.host === "::1" ||
		/^127\./.test(incoming.host) ||
		incoming.host.endsWith(".localhost")
	);
}

/** The page where this provider makes app passwords, when it is one we know. */
export function appPasswordPage(address: string): string | undefined {
	return KNOWN[domainOf(address)]?.appPasswords;
}

/**
 * Works out where to read an address's mail, asking cheaper sources before dearer ones.
 *
 * Five steps because no one of them covers the field: Fastmail is absent from the ISPDB and present
 * in SRV, Zoho is the other way round, and a company that runs its own mail is usually in neither.
 * The last step is a guess at the conventional name, which is right often enough to be worth making
 * and is marked as a guess so an answer can say so rather than presenting it as fact.
 */
export async function discover(address: string, fetcher = globalThis.fetch): Promise<Servers> {
	const domain = domainOf(address);
	const known = KNOWN[domain];
	// Named rather than spread: the table carries the app-password page too, and that is something to
	// tell a person rather than something to connect with.
	if (known !== undefined) {
		return {
			incoming: {
				host: known.host,
				port: known.port,
				username: usernameFor(domain, address),
				found: known.found,
			},
			outgoing: known.outgoing,
		};
	}

	const fromXml =
		(await fromAutoconfig(
			`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address)}`,
			"autoconfig",
			fetcher,
		)) ??
		(await fromAutoconfig(
			`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
			"well-known",
			fetcher,
		)) ??
		(await fromAutoconfig(`${ISPDB}/${domain}`, "ispdb", fetcher));
	if (fromXml?.incoming !== undefined) {
		return named(fromXml, usernameFor(domain, address));
	}

	const fromSrv = await fromRecords(domain);
	if (fromSrv.incoming !== undefined) return named(fromSrv, usernameFor(domain, address));

	// Both guessed together. The conventional names travel in pairs — a domain with `imap.` almost
	// always has `smtp.` — and a guess that reached the mailbox and then refused to send would be one
	// bad guess reported as two different kinds of trouble.
	return {
		incoming: { host: `imap.${domain}`, port: 993, username: address, found: "guess" },
		outgoing: { host: `smtp.${domain}`, port: 465 },
	};
}

/** The username belongs to the account rather than to either server, so it is put on at the end. */
function named(found: Found, username: string): Servers {
	const incoming = found.incoming as Omit<Incoming, "username">;
	return {
		incoming: { ...incoming, username },
		...(found.outgoing !== undefined ? { outgoing: found.outgoing } : {}),
	};
}

function usernameFor(domain: string, address: string): string {
	// iCloud takes the local part alone and refuses the whole address, which reads as a wrong password.
	return domain === "icloud.com" || domain === "me.com"
		? address.slice(0, address.lastIndexOf("@"))
		: address;
}

async function fromAutoconfig(
	url: string,
	found: Incoming["found"],
	fetcher: typeof globalThis.fetch,
): Promise<Found | undefined> {
	try {
		const response = await fetcher(url, { signal: AbortSignal.timeout(STEP_MS) });
		if (!response.ok) return undefined;
		const read = readClientConfig(await response.text(), found);
		return read.incoming === undefined ? undefined : read;
	} catch {
		// Every step of the chain is allowed to be absent, and most of them will be. A domain with no
		// autoconfig is the ordinary case rather than a failure worth carrying up.
		return undefined;
	}
}

/**
 * Reads the IMAP server out of a Thunderbird clientConfig document.
 *
 * Deliberately not a general XML parse. What is wanted is four values from one element in a
 * schema that has not moved in fifteen years, and a parser would be a dependency and an attack
 * surface for a document fetched from whatever domain somebody typed after an `@`.
 */
export function readClientConfig(xml: string, found: Incoming["found"] = "autoconfig"): Found {
	const incoming = server(xml, "incomingServer", "imap");
	const outgoing = server(xml, "outgoingServer", "smtp");
	return {
		...(incoming !== undefined ? { incoming: { ...incoming, found } } : {}),
		...(outgoing !== undefined ? { outgoing } : {}),
	};
}

/** One element of a clientConfig document, of the one type worth having out of the several offered. */
function server(xml: string, element: string, type: string): Outgoing | undefined {
	for (const block of xml.split(new RegExp(`<${element}\\b`, "i")).slice(1)) {
		const body = block.slice(0, block.search(new RegExp(`</${element}>`, "i")));
		const attributes = block.slice(0, block.indexOf(">") + 1);
		if (!new RegExp(`type\\s*=\\s*["']${type}["']`, "i").test(attributes)) continue;

		const host = body.match(/<hostname>\s*([^<\s]+)\s*<\/hostname>/i)?.[1];
		const port = Number(body.match(/<port>\s*(\d+)\s*<\/port>/i)?.[1]);
		if (host === undefined || !Number.isInteger(port)) continue;
		return { host, port };
	}
	return undefined;
}

/** RFC 6186: the domain says where its own mail lives, for the domains that bothered to say. */
async function fromRecords(domain: string): Promise<Found> {
	const resolver = new Resolver({ timeout: STEP_MS, tries: 1 });
	const [incoming, outgoing] = await Promise.all([
		srv(resolver, `_imaps._tcp.${domain}`),
		srv(resolver, `_submission._tcp.${domain}`),
	]);
	return {
		...(incoming !== undefined ? { incoming: { ...incoming, found: "srv" as const } } : {}),
		...(outgoing !== undefined ? { outgoing } : {}),
	};
}

async function srv(resolver: Resolver, name: string): Promise<Outgoing | undefined> {
	try {
		const records = await resolver.resolveSrv(name);
		// A priority of zero on a single record is how RFC 6186 says the service is not offered.
		const best = records
			.filter((one) => one.name !== "" && one.name !== ".")
			.sort((a, b) => a.priority - b.priority)[0];
		return best === undefined ? undefined : { host: best.name, port: best.port };
	} catch {
		return undefined;
	}
}
