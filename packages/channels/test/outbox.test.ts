import { afterEach, describe, expect, it, vi } from "vitest";
import type { Letter } from "../src/email.ts";
import { CARRIERS, carry, resolveCarrier } from "../src/outbox.ts";

const LETTER: Letter = {
	from: "scout <you+scout@example.com>",
	to: "boss@work.com",
	replyTo: "you+scout@example.com",
	subject: "Re: the numbers",
	text: "**done**",
	html: "<p><strong>done</strong></p>",
	inReplyTo: "<abc@work.com>",
	references: "<abc@work.com>",
};

const CARRYING = { key: "k-123", domain: "example.com" };

/** What the carrier's own writer produced, parsed back into whatever shape it chose. */
function sent(name: string): { url: string; headers: Record<string, string>; body: string } {
	const carrier = CARRIERS[name];
	if (carrier === undefined) throw new Error(`no carrier called ${name}`);
	const call = carrier.send(LETTER, CARRYING);
	return { url: call.url, headers: { ...call.headers }, body: call.body ?? "" };
}

describe("what each carrier makes of one message", () => {
	it("gives Mailgun a form at the domain's own endpoint, with the threading headers prefixed", () => {
		const { url, headers, body } = sent("mailgun");
		expect(url).toBe("https://api.mailgun.net/v3/example.com/messages");
		expect(headers.authorization).toBe(`Basic ${Buffer.from("api:k-123").toString("base64")}`);

		const form = new URLSearchParams(body);
		expect(form.get("from")).toBe("scout <you+scout@example.com>");
		expect(form.get("to")).toBe("boss@work.com");
		expect(form.get("h:Reply-To")).toBe("you+scout@example.com");
		expect(form.get("h:In-Reply-To")).toBe("<abc@work.com>");
		expect(form.get("h:References")).toBe("<abc@work.com>");
		expect(form.get("html")).toContain("<strong>done</strong>");
	});

	it("gives Resend one JSON body with the recipient in a list", () => {
		const { url, headers, body } = sent("resend");
		expect(url).toBe("https://api.resend.com/emails");
		expect(headers.authorization).toBe("Bearer k-123");

		const wrote = JSON.parse(body) as Record<string, unknown>;
		expect(wrote.to).toEqual(["boss@work.com"]);
		expect(wrote.reply_to).toBe("you+scout@example.com");
		expect(wrote.headers).toEqual({ "In-Reply-To": "<abc@work.com>", References: "<abc@work.com>" });
	});

	it("gives Postmark its capitalised keys and its list of header pairs", () => {
		const { url, headers, body } = sent("postmark");
		expect(url).toBe("https://api.postmarkapp.com/email");
		expect(headers["x-postmark-server-token"]).toBe("k-123");

		const wrote = JSON.parse(body) as Record<string, unknown>;
		expect(wrote.From).toBe("scout <you+scout@example.com>");
		expect(wrote.TextBody).toBe("**done**");
		expect(wrote.Headers).toEqual([
			{ Name: "In-Reply-To", Value: "<abc@work.com>" },
			{ Name: "References", Value: "<abc@work.com>" },
		]);
	});

	// SendGrid is the only one that will not read a "Name <address>" string, so the from line has to be
	// taken apart here or the agent's name is lost off every message it sends.
	it("takes SendGrid's sender apart into a name and an address", () => {
		const { url, body } = sent("sendgrid");
		expect(url).toBe("https://api.sendgrid.com/v3/mail/send");

		const wrote = JSON.parse(body) as Record<string, unknown>;
		expect(wrote.from).toEqual({ email: "you+scout@example.com", name: "scout" });
		expect(wrote.reply_to).toEqual({ email: "you+scout@example.com" });
		expect(wrote.content).toEqual([
			{ type: "text/plain", value: "**done**" },
			{ type: "text/html", value: "<p><strong>done</strong></p>" },
		]);
	});

	it("leaves the threading out of a message that is not answering anything", () => {
		const { inReplyTo: _a, references: _b, ...first } = LETTER;
		expect(new URLSearchParams(CARRIERS.mailgun?.send(first, CARRYING).body).has("h:In-Reply-To")).toBe(
			false,
		);
		expect(JSON.parse(CARRIERS.resend?.send(first, CARRYING).body ?? "{}").headers).toBeUndefined();
	});
});

describe("resolving which carrier takes the mail", () => {
	it("refuses a name off nobody's list, and says whose names it does know", () => {
		const refused = resolveCarrier({ carrier: "pigeon" });
		expect(refused).toBe(
			'nothing here knows how to send with "pigeon". Known: mailgun, resend, postmark, sendgrid',
		);
	});

	// The domain is not a detail Mailgun fills in from the address: an account with none set up sends
	// nothing at all, and the 404 that comes back says only that a domain was not found.
	it("refuses Mailgun with no domain, because Mailgun cannot work one out", () => {
		expect(resolveCarrier({ carrier: "mailgun" })).toBe(
			"Mailgun will not send until it is told which domain to send from",
		);
		expect(resolveCarrier({ carrier: "resend" })).toMatchObject({ title: "Resend" });
	});

	it("carries the choice through with the table's half filled in", () => {
		expect(resolveCarrier({ carrier: "mailgun", domain: " example.com " })).toMatchObject({
			carrier: "mailgun",
			domain: "example.com",
			keyEnv: "MAILGUN_API_KEY",
			host: "api.mailgun.net",
		});
	});
});

describe("handing a message over", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("says what the carrier said, because the status alone is never the problem", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"message":"Domain not found: example.com"}', { status: 404 })),
		);
		const carrier = CARRIERS.mailgun;
		if (carrier === undefined) throw new Error("no mailgun");
		await expect(carry(carrier, CARRYING).sendMail(LETTER)).rejects.toThrow(
			"Mailgun refused with 404: {\"message\":\"Domain not found: example.com\"}",
		);
	});

	it("checks the key without sending anything to anybody", async () => {
		const fetched = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetched);
		const carrier = CARRIERS.postmark;
		if (carrier === undefined) throw new Error("no postmark");
		await carry(carrier, CARRYING).verify();

		expect(fetched).toHaveBeenCalledTimes(1);
		const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.postmarkapp.com/server");
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
	});

	it("turns a network that is not there into a sentence rather than a TypeError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND api.resend.com");
			}),
		);
		const carrier = CARRIERS.resend;
		if (carrier === undefined) throw new Error("no resend");
		await expect(carry(carrier, CARRYING).verify()).rejects.toThrow(
			"Resend could not be reached: getaddrinfo ENOTFOUND api.resend.com",
		);
	});
});
