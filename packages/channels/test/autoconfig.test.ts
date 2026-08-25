import { describe, expect, it } from "vitest";
import {
	appPasswordPage,
	baseAddress,
	closedTo,
	discover,
	domainOf,
	needsBridge,
	readClientConfig,
} from "../src/autoconfig.ts";

/** What Thunderbird's database actually serves, trimmed to the elements that are read. */
const CLIENT_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <domain>example.com</domain>
    <incomingServer type="pop3">
      <hostname>pop.example.com</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>OAuth2</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>465</port>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

const answering = (body: string, status = 200): typeof globalThis.fetch =>
	(async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

describe("domainOf and baseAddress", () => {
	it("takes the domain off an address, folded", () => {
		expect(domainOf("Nico@FastMail.com")).toBe("fastmail.com");
	});

	// One mailbox serves every agent this way, so the address an agent is reached at and the account
	// it lives in are routinely different strings.
	it("takes a plus tag off, leaving the account the tag labelled", () => {
		expect(baseAddress("nico+scout@fastmail.com")).toBe("nico@fastmail.com");
		expect(baseAddress("nico@fastmail.com")).toBe("nico@fastmail.com");
		// A plus in the domain is not a tag, and the last @ is the one that separates.
		expect(baseAddress("not-an-address")).toBe("not-an-address");
	});
});

describe("readClientConfig", () => {
	// The document lists every protocol the provider speaks, and POP comes first often enough that
	// taking the first `incomingServer` would connect a mailbox that deletes as it reads.
	it("takes the IMAP server and not whichever one came first", () => {
		expect(readClientConfig(CLIENT_CONFIG).incoming).toEqual({
			host: "imap.example.com",
			port: 993,
			found: "autoconfig",
		});
	});

	// The same document says where the account's mail is handed in, and it is the same credential
	// that submits it. Reading both out of one fetch is what makes sending cost nothing to set up.
	it("takes the submission server out of the same document", () => {
		expect(readClientConfig(CLIENT_CONFIG).outgoing).toEqual({
			host: "smtp.example.com",
			port: 465,
		});
	});

	it("finds nothing in a document that offers no IMAP", () => {
		const popOnly = CLIENT_CONFIG.replace(/type="imap"/, 'type="pop3"');
		expect(readClientConfig(popOnly).incoming).toBeUndefined();
		expect(readClientConfig("<html>404 not found</html>").incoming).toBeUndefined();
		expect(readClientConfig("")).toEqual({});
	});

	// Reading is the channel and sending is the improvement on it, so a provider that publishes only
	// half of itself is one whose mail is still worth reading.
	it("takes an incoming server from a document with no outgoing one", () => {
		const noSmtp = CLIENT_CONFIG.replace(/type="smtp"/, 'type="ews"');
		expect(readClientConfig(noSmtp).incoming).toMatchObject({ host: "imap.example.com" });
		expect(readClientConfig(noSmtp).outgoing).toBeUndefined();
	});
});

describe("discover", () => {
	it("answers for a provider it knows without asking anything", async () => {
		const refuses = (() => {
			throw new Error("should not have been asked");
		}) as unknown as typeof globalThis.fetch;

		expect(await discover("nico+scout@fastmail.com", refuses)).toEqual({
			incoming: {
				host: "imap.fastmail.com",
				port: 993,
				username: "nico+scout@fastmail.com",
				found: "known",
			},
			outgoing: { host: "smtp.fastmail.com", port: 465 },
		});
	});

	// iCloud refuses the whole address, and the refusal reads exactly like a wrong password.
	it("logs in to iCloud with the local part alone", async () => {
		expect((await discover("nico@icloud.com")).incoming).toMatchObject({ username: "nico" });
	});

	it("reads a domain that publishes its own autoconfig", async () => {
		const found = await discover("someone@example.com", answering(CLIENT_CONFIG));

		expect(found).toEqual({
			incoming: {
				host: "imap.example.com",
				port: 993,
				username: "someone@example.com",
				found: "autoconfig",
			},
			outgoing: { host: "smtp.example.com", port: 465 },
		});
	});

	// Right often enough to be worth making, and marked as a guess so an answer can say so. Both are
	// guessed together: the conventional names travel in pairs, and one bad guess reported as two
	// kinds of trouble is two things to debug where there was one.
	it("falls back to the conventional names, and admits it is a guess", async () => {
		const found = await discover("someone@nothing-here.invalid", answering("", 404));

		expect(found).toEqual({
			incoming: {
				host: "imap.nothing-here.invalid",
				port: 993,
				username: "someone@nothing-here.invalid",
				found: "guess",
			},
			outgoing: { host: "smtp.nothing-here.invalid", port: 465 },
		});
	});
});

describe("closedTo", () => {
	it("names the providers that stopped taking passwords at all", async () => {
		expect((await closedTo("someone@outlook.com"))?.why).toContain("OAuth");
		expect((await closedTo("someone@hotmail.com"))?.why).toContain("OAuth");
	});

	it("lets through the ones that still take an app password", async () => {
		expect(await closedTo("nico@fastmail.com")).toBeUndefined();
		expect(await closedTo("nico@gmail.com")).toBeUndefined();
		expect(await closedTo("nico@icloud.com")).toBeUndefined();
	});
});

describe("needsBridge", () => {
	// Proton advertises 127.0.0.1:1143 truthfully — the mail is only reachable through a bridge the
	// user runs on their own desktop. A plane on a VPS dialling that fails talking to itself.
	it("knows a bridge on somebody's desktop from a server", () => {
		const proton = {
			host: "127.0.0.1",
			port: 1143,
			username: "nico",
			found: "autoconfig",
		} as const;

		expect(needsBridge(proton)).toBe(true);
		expect(needsBridge({ ...proton, host: "localhost" })).toBe(true);
		expect(needsBridge({ ...proton, host: "imap.fastmail.com" })).toBe(false);
	});
});

describe("appPasswordPage", () => {
	// The longest step of connecting a mailbox is finding this screen, and every provider hides it
	// somewhere different under a different name.
	it("hands over the page instead of the instruction to look for it", () => {
		expect(appPasswordPage("nico@fastmail.com")).toContain("fastmail.com/settings");
		expect(appPasswordPage("nico@gmail.com")).toContain("myaccount.google.com");
		expect(appPasswordPage("someone@example.com")).toBeUndefined();
	});
});
