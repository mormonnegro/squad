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
const KNOWN: Record<string, Incoming & { readonly appPasswords: string }> = {
	"fastmail.com": {
		host: "imap.fastmail.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://app.fastmail.com/settings/security/apppasswords",
	},
	"gmail.com": {
		host: "imap.gmail.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://myaccount.google.com/apppasswords",
	},
	"zoho.com": {
		host: "imappro.zoho.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://accounts.zoho.com/home#security",
	},
	"icloud.com": {
		host: "imap.mail.me.com",
		port: 993,
		username: "",
		found: "known",
		appPasswords: "https://account.apple.com/account/manage",
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
export async function discover(address: string, fetcher = globalThis.fetch): Promise<Incoming> {
	const domain = domainOf(address);
	const known = KNOWN[domain];
	// Named rather than spread: the table carries the app-password page too, and that is something to
	// tell a person rather than something to connect with.
	if (known !== undefined) {
		return {
			host: known.host,
			port: known.port,
			username: usernameFor(domain, address),
			found: known.found,
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
	if (fromXml !== undefined) return { ...fromXml, username: usernameFor(domain, address) };

	const fromSrv = await fromRecords(domain);
	if (fromSrv !== undefined) return { ...fromSrv, username: usernameFor(domain, address) };

	return { host: `imap.${domain}`, port: 993, username: address, found: "guess" };
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
): Promise<Omit<Incoming, "username"> | undefined> {
	try {
		const response = await fetcher(url, { signal: AbortSignal.timeout(STEP_MS) });
		if (!response.ok) return undefined;
		return readClientConfig(await response.text(), found);
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
export function readClientConfig(
	xml: string,
	found: Incoming["found"] = "autoconfig",
): Omit<Incoming, "username"> | undefined {
	for (const block of xml.split(/<incomingServer\b/i).slice(1)) {
		const body = block.slice(0, block.search(/<\/incomingServer>/i));
		if (!/type\s*=\s*["']imap["']/i.test(block.slice(0, block.indexOf(">") + 1))) continue;

		const host = body.match(/<hostname>\s*([^<\s]+)\s*<\/hostname>/i)?.[1];
		const port = Number(body.match(/<port>\s*(\d+)\s*<\/port>/i)?.[1]);
		if (host === undefined || !Number.isInteger(port)) continue;
		return { host, port, found };
	}
	return undefined;
}

/** RFC 6186: the domain says where its own mail lives, for the domains that bothered to say. */
async function fromRecords(domain: string): Promise<Omit<Incoming, "username"> | undefined> {
	try {
		const resolver = new Resolver({ timeout: STEP_MS, tries: 1 });
		const records = await resolver.resolveSrv(`_imaps._tcp.${domain}`);
		// A priority of zero on a single record is how RFC 6186 says the service is not offered.
		const best = records
			.filter((one) => one.name !== "" && one.name !== ".")
			.sort((a, b) => a.priority - b.priority)[0];
		return best === undefined ? undefined : { host: best.name, port: best.port, found: "srv" };
	} catch {
		return undefined;
	}
}
