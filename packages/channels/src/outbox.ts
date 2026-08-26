import type { Letter, Post } from "./email.ts";

/**
 * What a carrier needs to know beyond the message: whose key, and which domain it was bought for.
 *
 * The domain is separate from the address the mail says it is from because a carrier is set up per
 * domain and an agent is reached at a tag: `you+scout@example.com` is one of thousands of addresses
 * that the one `example.com` at Mailgun is allowed to send as.
 */
export interface Carrying {
	readonly key: string;
	readonly domain: string;
}

/** One HTTP call, written out rather than made, so the four shapes below can be read side by side. */
export interface Call {
	readonly url: string;
	readonly method: "GET" | "POST";
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
}

/**
 * A company that will take a message and deliver it, over its own API rather than over SMTP.
 *
 * The same table idea as the model and search providers: naming one is most of configuring it. What
 * differs here is that no two of them take a message the same way — one wants a form, one wants JSON
 * with capitalised keys, one wants the recipients nested two deep — so the request is a function
 * instead of a path. Four small functions is the honest shape of four incompatible APIs, and it beats
 * an adapter layer that would have to invent a common message only to take it apart again.
 *
 * Why any of this, when the mailbox already has a submission server: an app password sends as the
 * account, from the provider's domain, at whatever rate a human mailbox is rate-limited to. These
 * send as a domain of your own, and they say whether the message arrived.
 */
export interface Carrier {
	/** What it calls itself, for a screen that lists these. */
	readonly title: string;
	readonly host: string;
	readonly keyEnv: string;
	/** Where the key is issued, so a console asking for one can say where to go and get it. */
	readonly issued: string;
	/** Whether it refuses to send at all until it is told which domain, which most of them do. */
	readonly needsDomain: boolean;
	/** The call that hands one message over. */
	readonly send: (letter: Letter, carrying: Carrying) => Call;
	/** The call that asks whether the key works, without sending anything to anybody. */
	readonly check: (carrying: Carrying) => Call;
}

function basic(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

const JSON_TYPE = { "content-type": "application/json", accept: "application/json" } as const;

export const CARRIERS: Readonly<Record<string, Carrier>> = {
	mailgun: {
		title: "Mailgun",
		host: "api.mailgun.net",
		keyEnv: "MAILGUN_API_KEY",
		issued: "https://app.mailgun.com/settings/api_security",
		needsDomain: true,
		send: (letter, { key, domain }) => {
			const form = new URLSearchParams({
				from: letter.from,
				to: letter.to,
				"h:Reply-To": letter.replyTo,
				subject: letter.subject,
				text: letter.text,
				html: letter.html,
			});
			// Any header Mailgun has no field of its own for goes on prefixed, which is how the two that
			// decide where a reply lands in a mail client get through.
			if (letter.inReplyTo !== undefined) form.set("h:In-Reply-To", letter.inReplyTo);
			if (letter.references !== undefined) form.set("h:References", letter.references);
			return {
				url: `https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`,
				method: "POST",
				headers: {
					authorization: basic("api", key),
					"content-type": "application/x-www-form-urlencoded",
				},
				body: form.toString(),
			};
		},
		check: ({ key, domain }) => ({
			url: `https://api.mailgun.net/v3/domains/${encodeURIComponent(domain)}`,
			method: "GET",
			headers: { authorization: basic("api", key) },
		}),
	},
	resend: {
		title: "Resend",
		host: "api.resend.com",
		keyEnv: "RESEND_API_KEY",
		issued: "https://resend.com/api-keys",
		needsDomain: false,
		send: (letter, { key }) => ({
			url: "https://api.resend.com/emails",
			method: "POST",
			headers: { authorization: `Bearer ${key}`, ...JSON_TYPE },
			body: JSON.stringify({
				from: letter.from,
				to: [letter.to],
				reply_to: letter.replyTo,
				subject: letter.subject,
				text: letter.text,
				html: letter.html,
				...(letter.inReplyTo !== undefined
					? { headers: { "In-Reply-To": letter.inReplyTo, References: letter.references } }
					: {}),
			}),
		}),
		check: ({ key }) => ({
			url: "https://api.resend.com/domains",
			method: "GET",
			headers: { authorization: `Bearer ${key}` },
		}),
	},
	postmark: {
		title: "Postmark",
		host: "api.postmarkapp.com",
		keyEnv: "POSTMARK_SERVER_TOKEN",
		issued: "https://account.postmarkapp.com/servers",
		needsDomain: false,
		send: (letter, { key }) => ({
			url: "https://api.postmarkapp.com/email",
			method: "POST",
			headers: { "x-postmark-server-token": key, ...JSON_TYPE },
			body: JSON.stringify({
				From: letter.from,
				To: letter.to,
				ReplyTo: letter.replyTo,
				Subject: letter.subject,
				TextBody: letter.text,
				HtmlBody: letter.html,
				...(letter.inReplyTo !== undefined
					? {
							Headers: [
								{ Name: "In-Reply-To", Value: letter.inReplyTo },
								{ Name: "References", Value: letter.references ?? letter.inReplyTo },
							],
						}
					: {}),
			}),
		}),
		check: ({ key }) => ({
			url: "https://api.postmarkapp.com/server",
			method: "GET",
			headers: { "x-postmark-server-token": key, accept: "application/json" },
		}),
	},
	sendgrid: {
		title: "SendGrid",
		host: "api.sendgrid.com",
		keyEnv: "SENDGRID_API_KEY",
		issued: "https://app.sendgrid.com/settings/api_keys",
		needsDomain: false,
		send: (letter, { key }) => {
			const at = letter.from.lastIndexOf("<");
			const address = at === -1 ? letter.from : letter.from.slice(at + 1, -1);
			const name = at === -1 ? undefined : letter.from.slice(0, at).trim();
			return {
				url: "https://api.sendgrid.com/v3/mail/send",
				method: "POST",
				headers: { authorization: `Bearer ${key}`, ...JSON_TYPE },
				body: JSON.stringify({
					personalizations: [
						{
							to: [{ email: letter.to }],
							...(letter.inReplyTo !== undefined
								? {
										headers: {
											"In-Reply-To": letter.inReplyTo,
											References: letter.references ?? letter.inReplyTo,
										},
									}
								: {}),
						},
					],
					from: name !== undefined && name.length > 0 ? { email: address, name } : { email: address },
					reply_to: { email: letter.replyTo },
					subject: letter.subject,
					content: [
						{ type: "text/plain", value: letter.text },
						{ type: "text/html", value: letter.html },
					],
				}),
			};
		},
		check: ({ key }) => ({
			url: "https://api.sendgrid.com/v3/scopes",
			method: "GET",
			headers: { authorization: `Bearer ${key}` },
		}),
	},
};

/** Which carrier takes the mail out, and the domain it was set up for. Empty means the mailbox's own. */
export interface CarrierSpec {
	readonly carrier: string;
	readonly domain?: string;
}

/**
 * The way out as everything downstream needs it, with the table's half filled in.
 *
 * A string rather than a throw when it is wrong, because the two callers are a console drawing an
 * answer and a channel about to send: neither wants a stack, and both want the sentence.
 */
export function resolveCarrier(spec: CarrierSpec): (Carrier & CarrierSpec) | string {
	const name = spec.carrier.trim();
	const known = CARRIERS[name];
	if (known === undefined) {
		return `nothing here knows how to send with "${name}". Known: ${Object.keys(CARRIERS).join(", ")}`;
	}
	const domain = spec.domain?.trim() ?? "";
	if (known.needsDomain && domain.length === 0) {
		return `${known.title} will not send until it is told which domain to send from`;
	}
	return { ...known, carrier: name, domain };
}

/** Everything a request through fetch can be, said the way a person reads it. */
async function ask(call: Call, carrier: Carrier): Promise<void> {
	let answer: Response;
	try {
		answer = await fetch(call.url, {
			method: call.method,
			headers: { ...call.headers },
			...(call.body !== undefined ? { body: call.body } : {}),
		});
	} catch (error) {
		throw new Error(`${carrier.title} could not be reached: ${(error as Error).message}`);
	}
	if (answer.ok) return;
	// The body, because every one of these says what is actually wrong in it — an unverified domain, a
	// key with no send scope — and the status alone turns all of those into "403".
	const said = (await answer.text().catch(() => "")).trim().slice(0, 400);
	throw new Error(
		`${carrier.title} refused with ${answer.status}${said.length > 0 ? `: ${said}` : ""}`,
	);
}

/**
 * A carrier as the mail channel wants it, which is the same two calls a submission server offers.
 *
 * The point of wearing {@link Post} is that nothing above here changes: `send` still builds one
 * letter and hands it over, and whether that went out over SMTP or as a form post to Mailgun is not
 * a thing the threading, the tagging or the reply-to has to know about.
 */
export function carry(carrier: Carrier, carrying: Carrying): Post {
	return {
		async verify(): Promise<void> {
			await ask(carrier.check(carrying), carrier);
		},
		async sendMail(letter: Letter): Promise<void> {
			await ask(carrier.send(letter, carrying), carrier);
		},
		close(): void {},
	};
}
