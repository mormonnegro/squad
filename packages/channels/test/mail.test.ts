import { describe, expect, it } from "vitest";
import {
	addressesIn,
	admits,
	agentFor,
	asOperator,
	authenticated,
	automated,
	isOwnAddress,
	parseAddress,
	readableText,
	tooWide,
	withoutTrail,
} from "../src/mail.ts";

describe("parseAddress and addressesIn", () => {
	it("takes the address out from behind the name it was written under", () => {
		expect(parseAddress("Nico <Nico@Example.com>")).toEqual({
			address: "nico@example.com",
			name: "Nico",
		});
		expect(parseAddress("  bare@example.com ")).toEqual({ address: "bare@example.com" });
		expect(parseAddress('"Quoted Name" <q@example.com>')).toMatchObject({ name: "Quoted Name" });
		expect(parseAddress("not an address")).toBeUndefined();
	});

	// A display name is allowed a comma, and this one is common enough that splitting on commas turns
	// one recipient into two halves, neither of which is an address.
	it("splits a recipient list where it splits, not on every comma", () => {
		expect(addressesIn('"Doe, John" <j@d.com>, Ana <ana@e.com>')).toEqual(["j@d.com", "ana@e.com"]);
	});
});

describe("agentFor", () => {
	const mailbox = "agents@example.com";

	// One mailbox, every agent: this is what lets an operator connect a mailbox once instead of once
	// per agent, so it decides whether the whole feature is one setup or twenty.
	it("reads the agent off the tag on the address it arrived at", () => {
		expect(agentFor(["agents+scout@example.com"], mailbox)).toBe("scout");
		expect(agentFor(["Agents+Scout@Example.com"], mailbox)).toBe("scout");
	});

	it("finds the tagged recipient among the ones that are not", () => {
		const recipients = ["someone@elsewhere.com", "agents@example.com", "agents+clerk@example.com"];
		expect(agentFor(recipients, mailbox)).toBe("clerk");
	});

	it("names nobody when nothing was tagged, rather than guessing an agent", () => {
		expect(agentFor(["agents@example.com"], mailbox)).toBeUndefined();
		expect(agentFor(["agents+@example.com"], mailbox)).toBeUndefined();
		expect(agentFor(["other+scout@example.com"], mailbox)).toBeUndefined();
	});

	it("knows the mailbox writing to itself, under any tag", () => {
		expect(isOwnAddress("agents+scout@example.com", mailbox)).toBe(true);
		expect(isOwnAddress("someone@example.com", mailbox)).toBe(false);
	});
});

describe("authenticated", () => {
	const google = [
		"mx.google.com;",
		"       dkim=pass header.i=@example.com header.s=s1 header.b=Ab3;",
		"       spf=pass (google.com: domain of nico@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=nico@example.com;",
		"       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
	].join("\n");

	// The whole of operator trust by mail rests here. `From:` is a line the sender chose, so an agent
	// that trusted it would take instructions from whoever typed the right address into it.
	it("takes the provider's word that the domain was signed", () => {
		expect(authenticated([google], "nico@example.com")).toBe(true);
		expect(authenticated(["mx.test; dkim=pass header.d=example.com"], "nico@example.com")).toBe(
			true,
		);
	});

	it("counts a subdomain signed by its parent as the same domain", () => {
		const signed = ["mx.test; dkim=pass header.d=example.com"];
		expect(authenticated(signed, "nico@mail.example.com")).toBe(true);
		// The other way round is not alignment: a signature from a subdomain says nothing about the root.
		expect(authenticated(["mx.test; dkim=pass header.d=mail.example.com"], "s@example.com")).toBe(
			false,
		);
	});

	it("refuses a pass that was for somebody else's domain", () => {
		const elsewhere = [
			"mx.test; dkim=pass header.i=@attacker.test; dmarc=pass header.from=attacker.test",
		];
		expect(authenticated(elsewhere, "nico@example.com")).toBe(false);
	});

	it("refuses what did not pass, and what was never checked", () => {
		expect(authenticated(["mx.test; dkim=fail header.d=example.com"], "s@example.com")).toBe(false);
		expect(authenticated(["mx.test; dkim=none"], "s@example.com")).toBe(false);
		expect(authenticated([], "s@example.com")).toBe(false);
	});

	// A sender may put an Authentication-Results of their own in the message. The provider prepends its
	// own on the way in, so the first is the one that was written by the machine that did the checking.
	it("reads only the one the provider put there", () => {
		const forged = "mx.test; dkim=pass header.d=example.com";
		expect(authenticated(["mx.google.com; dkim=fail", forged], "nico@example.com")).toBe(false);
	});
});

describe("automated", () => {
	// Two machines that both answer everything write to each other until somebody notices, and every
	// message in that exchange is a paid turn.
	it("names the machines that must not be answered", () => {
		expect(automated({ "auto-submitted": "auto-replied" })).toContain("auto-replied");
		expect(automated({ "list-id": "<dev.example.com>" })).toContain("mailing list");
		expect(automated({ "list-unsubscribe": "<mailto:x@y.com>" })).toContain("mailing list");
		expect(automated({ precedence: "bulk" })).toContain("bulk");
		expect(automated({ "x-autoreply": "yes" })).toContain("autoresponder");
		expect(automated({ "return-path": "<>" })).toContain("bounce");
		expect(
			automated({ "content-type": "multipart/report; report-type=delivery-status" }),
		).toContain("delivery report");
	});

	it("lets a person through, including one whose client says so", () => {
		expect(automated({})).toBeUndefined();
		expect(automated({ "auto-submitted": "no" })).toBeUndefined();
		expect(automated({ precedence: "normal", "content-type": "text/plain" })).toBeUndefined();
	});
});

describe("withoutTrail", () => {
	it("leaves a message that is only a message", () => {
		expect(withoutTrail("ship it\n\nthanks")).toBe("ship it\n\nthanks");
	});

	it("cuts the quote a top-posted reply sits above", () => {
		const reply = [
			"yes, go ahead",
			"",
			"On Tue, Aug 25, 2026 at 3:14 PM Nico <nico@example.com> wrote:",
			"> should I deploy?",
			"> let me know",
		].join("\n");

		expect(withoutTrail(reply)).toBe("yes, go ahead");
	});

	// Gmail leaves `wrote:` alone on a line of its own often enough that cutting at that line would
	// keep the half above it — a stray date and a stranger's address at the bottom of every message.
	it("cuts the whole attribution when the client wrapped it", () => {
		const reply = [
			"yes",
			"",
			"On Tue, Aug 25, 2026 at 3:14 PM Nico <nico@example.com>",
			"wrote:",
			"> should I deploy?",
		].join("\n");

		expect(withoutTrail(reply)).toBe("yes");
	});

	it("cuts a Spanish attribution too", () => {
		const reply = [
			"dale",
			"",
			"El mar, 25 ago 2026 a las 15:14, Nico escribió:",
			"> lo hago?",
		].join("\n");

		expect(withoutTrail(reply)).toBe("dale");
	});

	it("cuts the header block Outlook pastes with nothing to introduce it", () => {
		const reply = [
			"looks fine",
			"",
			"From: Nico <nico@example.com>",
			"Sent: Tuesday, August 25, 2026 3:14 PM",
			"To: agents@example.com",
			"Subject: deploy?",
			"",
			"should I deploy?",
		].join("\n");

		expect(withoutTrail(reply)).toBe("looks fine");
	});

	it("cuts a signature and a phone's footer", () => {
		expect(withoutTrail("done\n\n-- \nNico\nCTO")).toBe("done");
		expect(withoutTrail("done\n\nSent from my iPhone")).toBe("done");
	});

	it("cuts a trailing quote that nothing introduced", () => {
		expect(withoutTrail("ok\n\n> the question\n>\n> more")).toBe("ok");
	});

	/**
	 * The one that cutting naively gets wrong. Answers written in among the quoted questions are the
	 * whole message, and a cut at the attribution throws away every one of them — leaving an agent that
	 * received a reply and read it as empty.
	 */
	it("keeps an inline reply, quotes and all", () => {
		const reply = [
			"On Tue, Aug 25, 2026 at 3:14 PM Nico wrote:",
			"> which region?",
			"eu-west-1",
			"> and the database?",
			"leave it",
		].join("\n");

		expect(withoutTrail(reply)).toBe(reply);
	});

	// A forward is a message whose content is the thing being forwarded. Cutting it leaves nothing,
	// and nothing is worse than too much.
	it("hands over a bare forward whole rather than emptying it", () => {
		const forwarded = "---------- Forwarded message ---------\nFrom: a@b.com\n\nthe actual thing";
		expect(withoutTrail(forwarded)).toBe(forwarded);
	});

	it("does not take a horizontal rule for a signature", () => {
		expect(withoutTrail("above\n\n---\n\nbelow")).toBe("above\n\n---\n\nbelow");
	});
});

describe("readableText", () => {
	it("takes the words out of a part that arrived with no plain text", () => {
		const html = "<div><p>Hello&nbsp;there</p><p>Ship it &amp; tell me</p></div>";
		expect(readableText(html)).toBe("Hello there\nShip it & tell me");
	});

	it("drops what is not text at all", () => {
		expect(
			readableText("<style>p{color:red}</style><script>alert(1)</script><p>only this</p>"),
		).toBe("only this");
	});

	it("reads a numbered entity, and leaves alone what is not one", () => {
		expect(readableText("<p>caf&#233; &#x26; m&aacute;s</p>")).toBe("café & m&aacute;s");
	});

	it("breaks lines where the markup broke them", () => {
		expect(readableText("one<br>two<br/>three")).toBe("one\ntwo\nthree");
	});
});

/**
 * Who is read as an operator, which is the whole of what an agent's mailbox is protected by.
 *
 * Two shapes and no more. A regular expression here would be a security decision made in a language
 * nobody proofreads, on a list where being wrong means a stranger spends turns and instructs agents.
 */
describe("admits", () => {
	it("takes an address exactly, and nobody who merely looks like it", () => {
		const list = ["nico@company.com"];

		expect(admits(list, "nico@company.com")).toBe(true);
		expect(admits(list, "NICO@Company.com")).toBe(true);
		expect(admits(list, " nico@company.com ")).toBe(true);
		expect(admits(list, "nico@company.com.evil.test")).toBe(false);
		expect(admits(list, "notnico@company.com")).toBe(false);
	});

	it("takes everyone at a domain, and only at that domain", () => {
		const list = ["*@company.com"];

		expect(admits(list, "anyone@company.com")).toBe(true);
		expect(admits(list, "anyone@sub.company.com")).toBe(false);
		expect(admits(list, "anyone@company.com.evil.test")).toBe(false);
		expect(admits(list, "company.com@evil.test")).toBe(false);
	});

	it("admits nobody off an empty list", () => {
		expect(admits([], "nico@company.com")).toBe(false);
	});
});

describe("asOperator", () => {
	it("keeps an address as the address it is", () => {
		expect(asOperator("Nico@Company.com")).toBe("nico@company.com");
		expect(asOperator("  nico@company.com  ")).toBe("nico@company.com");
		// Pasted out of a mail client, which brackets what it copies.
		expect(asOperator("<nico@company.com>")).toBe("nico@company.com");
	});

	// A domain typed bare is somebody meaning the company. Reading it as anything else would be
	// reading it as an address that cannot exist.
	it("reads a bare domain as everyone at it", () => {
		expect(asOperator("company.com")).toBe("*@company.com");
		expect(asOperator("*@company.com")).toBe("*@company.com");
		expect(asOperator("@company.com")).toBe("*@company.com");
	});

	it("refuses what is neither", () => {
		expect(asOperator("")).toBeUndefined();
		expect(asOperator("everyone")).toBeUndefined();
		expect(asOperator("two words")).toBeUndefined();
		expect(asOperator("nico@")).toBeUndefined();
		// A star in the local part is a pattern, and patterns are the thing this grammar exists to
		// keep off the list: `*@*.com` and `seb*@company.com` are unreadable at a glance.
		expect(asOperator("seb*@company.com")).toBeUndefined();
		expect(asOperator("*@*.com")).toBeUndefined();
	});
});

describe("tooWide", () => {
	it("refuses a domain a stranger can hold an address at by this afternoon", () => {
		expect(tooWide("*@gmail.com")).toContain("gmail.com");
		expect(tooWide("*@icloud.com")).toBeDefined();
		expect(tooWide("*@proton.me")).toBeDefined();
	});

	it("leaves a company's own domain alone, and an address always", () => {
		expect(tooWide("*@company.com")).toBeUndefined();
		// One person at a public provider is one person, which is the ordinary case.
		expect(tooWide("nico@gmail.com")).toBeUndefined();
	});
});
