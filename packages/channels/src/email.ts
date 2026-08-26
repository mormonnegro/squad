import type { NewAgentEvent } from "@agent-dive/events";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { Outgoing } from "./autoconfig.ts";
import { type Channel, ChannelError, type Reply } from "./channel.ts";
import {
	addressesIn,
	agentFor,
	authenticated,
	automated,
	isOwnAddress,
	parseAddress,
	readableText,
	withoutTrail,
} from "./mail.ts";

/** How far the mailbox has been read, which is two numbers that only mean anything together. */
export interface ReadMark {
	/**
	 * The server's name for the current numbering, kept as a string because it is a 32-bit unsigned
	 * value the protocol allows to be larger than a safe integer.
	 *
	 * When it changes every uid before it means something else, so resuming from the old one would
	 * read a stranger's mail or silently skip a week of your own.
	 */
	readonly uidValidity: string;
	readonly lastUid: number;
}

/**
 * The one mailbox a plane reads, and everything it has learned about who writes to it.
 *
 * One rather than one per agent, because plus-addressing already separates them: `you+scout@` and
 * `you+clerk@` are the same account to the provider and two different agents here. Connecting email
 * is then a thing done once, ever — including for the agents that do not exist yet.
 */
export interface Account {
	/** The address mail arrives at, with no tag on it. Agents are reached at tags on this. */
	readonly address: string;
	readonly host: string;
	readonly port: number;
	readonly username: string;
	/** An app password. Whoever holds it can read every message in the account. */
	readonly password: string;
	/** How the host was worked out, kept only so an answer can say whether it was told or guessed. */
	readonly found?: string;
	/**
	 * Where this account hands mail in to be sent, when there is somewhere that took the same login.
	 *
	 * The credential is the one already asked for — a provider issues an app password for the account,
	 * not for a protocol — so writing back costs nothing to set up beyond finding this. Absent means a
	 * mailbox that can be read and not written from, which is a channel that works and cannot answer.
	 */
	readonly outgoing?: Outgoing;
	/**
	 * Where mail arriving with no tag on it goes.
	 *
	 * Because not every provider does plus-addressing, and on one that does not the bare address would
	 * otherwise reach nobody — a mailbox connected, read, and quietly dropping everything in it.
	 */
	readonly fallback: string;
	/** Addresses whose mail is read as instructions rather than as something to consider. */
	readonly operators: readonly string[];
	/** The phrase that binds the first operator, until one is bound. */
	readonly pairing?: string;
	readonly seen?: ReadMark;
}

export interface EmailPublisher {
	publish(event: NewAgentEvent): Promise<unknown>;
}

export interface EmailChannelOptions {
	readonly account?: Account;
	readonly publisher: EmailPublisher;
	/**
	 * Which agents exist, asked at the moment a message arrives.
	 *
	 * A tag is whatever somebody typed after a `+`, and mail is addressed by strangers and by mistake.
	 * A tag naming no agent has to fall to the one that does rather than invent an agent id from a
	 * line of somebody else's header.
	 */
	readonly agents: () => readonly string[];
	/** The account after something about it changed: an operator paired, the read mark moved on. */
	readonly onChange?: (account: Account) => void;
	readonly onError?: (error: Error) => void;
	/** What was dropped and why, counted rather than listed. Most of a mailbox is not for the agent. */
	readonly onDropped?: (why: string, count: number) => void;
	/** Opens a session. Given only so a test can hand over a mailbox that is not on the internet. */
	readonly open?: (account: Account) => Session;
	/** Opens the way out. Given for the same reason, so nothing under test posts a real message. */
	readonly post?: (account: Account, outgoing: Outgoing) => Post;
}

/**
 * The part of an IMAP connection this channel uses, which is a small part of one.
 *
 * Named as an interface so a test can supply a mailbox rather than reach a real provider. What is
 * tested through it is not the protocol — that is imapflow's — but the things above it that go wrong
 * in the field: a numbering that reset, a range that returns a message older than what was asked for,
 * a connection that dropped in the night.
 */
export interface Session {
	connect(): Promise<void>;
	mailboxOpen(path: string): Promise<{ readonly uidValidity: bigint; readonly uidNext: number }>;
	fetch(
		range: string,
		query: { readonly uid: true; readonly source: true },
		options: { readonly uid: true },
	): AsyncIterable<{ readonly uid: number; readonly source?: Buffer | undefined }>;
	on(event: "exists", listener: () => void): unknown;
	on(event: "close", listener: () => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	logout(): Promise<void>;
	close(): void;
}

/** One message on its way out, filled in as far as this channel ever fills one in. */
export interface Letter {
	readonly from: string;
	readonly to: string;
	readonly replyTo: string;
	readonly subject: string;
	readonly text: string;
	readonly inReplyTo?: string;
	readonly references?: string;
}

/**
 * The part of a submission server this channel uses, which is a login and one call.
 *
 * An interface for the reason `Session` is one. What is worth testing here is not SMTP — that is
 * nodemailer's — but what goes on the envelope: which agent the mail comes from, which address a
 * reply to it lands back on, and which thread it appears under in a mail client.
 */
export interface Post {
	/** Logs in without sending anything, which is how a password is checked before it is relied on. */
	verify(): Promise<unknown>;
	sendMail(letter: Letter): Promise<unknown>;
	close(): void;
}

const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 60_000;

/** The address an agent is reached at: the account's, with the agent's name tagged onto it. */
export function addressFor(mailbox: string, agentId: string): string {
	const at = mailbox.lastIndexOf("@");
	if (at === -1) return mailbox;
	const local = mailbox.slice(0, at);
	const plus = local.indexOf("+");
	return `${plus === -1 ? local : local.slice(0, plus)}+${agentId}${mailbox.slice(at)}`;
}

/** Every header a message may have arrived at this mailbox by, including the ones nobody can see. */
const RECIPIENT_HEADERS = ["delivered-to", "x-original-to", "envelope-to", "to", "cc"] as const;

/**
 * An agent's mail, read out of a mailbox the operator already has.
 *
 * IMAP rather than anything that receives: a mailbox is reached by connecting outwards to it, which
 * needs no domain, no MX, no certificate and no port open on this machine. It is the same property
 * that made a Telegram bot the right first channel — the whole of the setup is a credential pasted
 * into a console — and it is the only shape of email that has it.
 */
export class EmailChannel implements Channel {
	readonly name = "email";

	#account: Account | undefined;
	readonly #publisher: EmailPublisher;
	readonly #agents: () => readonly string[];
	readonly #onChange: ((account: Account) => void) | undefined;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #onDropped: ((why: string, count: number) => void) | undefined;
	readonly #open: (account: Account) => Session;
	readonly #post: (account: Account, outgoing: Outgoing) => Post;

	#running = false;
	#session: Session | undefined;
	/** Reading is serialized: two `exists` a moment apart would otherwise read the same mail twice. */
	#tail: Promise<unknown> = Promise.resolve();
	#dropped = new Map<string, number>();
	/**
	 * The message each conversation last arrived on, so that an answer can land underneath it.
	 *
	 * A `Reply` carries a body and who it is for and nothing else, because most channels have nothing
	 * else. Mail has a subject and a message id, and an answer sent without them arrives as a new
	 * message somewhere down an inbox rather than under the question it is answering.
	 *
	 * Only operators get this far, so this holds one entry per agent per person who writes to it.
	 */
	readonly #threads = new Map<string, { readonly subject: string; readonly messageId?: string }>();

	constructor(options: EmailChannelOptions) {
		this.#account = options.account;
		this.#publisher = options.publisher;
		this.#agents = options.agents;
		this.#onChange = options.onChange;
		this.#onError = options.onError;
		this.#onDropped = options.onDropped;
		this.#open = options.open ?? openImap;
		this.#post = options.post ?? openSmtp;
	}

	get account(): Account | undefined {
		return this.#account;
	}

	/** Puts a mailbox in place, replacing whatever was there, and starts reading it. */
	set(account: Account): void {
		this.#account = account;
		this.#session?.close();
		this.#session = undefined;
		if (this.#running) void this.#read();
	}

	remove(): void {
		this.#account = undefined;
		this.#session?.close();
		this.#session = undefined;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		void this.#read();
	}

	stop(): void {
		this.#running = false;
		this.#session?.close();
		this.#session = undefined;
	}

	/**
	 * Checks that an account can actually be logged into, before it is written down anywhere.
	 *
	 * Its own step because the alternative is finding out later: a password with a space missing off
	 * the end becomes a mailbox that is connected, listed as connected, and never delivers anything —
	 * and nothing about that silence points back at the line where it was pasted.
	 *
	 * Reading has to work and sending does not. A mailbox that can only be read is a channel — it was
	 * the whole channel until recently — so a submission server that refuses the same password throws
	 * nothing away here. It is answered with, and the caller writes the account down without anywhere
	 * to hand mail in, which is a thing `/email` can then say plainly. The alternative is an agent
	 * that claims it will write back and whose answers go nowhere at the far end of a turn.
	 */
	async verify(account: Account): Promise<string | undefined> {
		const session = this.#open(account);
		try {
			await session.connect();
			await session.mailboxOpen("INBOX");
			await session.logout();
		} finally {
			session.close();
		}

		if (account.outgoing === undefined) return undefined;
		const post = this.#post(account, account.outgoing);
		try {
			await post.verify();
			return undefined;
		} catch (error) {
			return (error as Error).message;
		} finally {
			post.close();
		}
	}

	/**
	 * Writes back, from the agent's own address and into the thread the question came in on.
	 *
	 * The `From` is `you+scout@`, not the account, because that is what makes a reply to this answer
	 * come back to the same agent rather than to whichever one the untagged address falls to. Some
	 * providers rewrite a `From` that is not the account they know, which is the whole reason the
	 * `Reply-To` says the same thing again: between them, one survives.
	 */
	async send(reply: Reply): Promise<void> {
		const account = this.#account;
		if (account === undefined) {
			throw new ChannelError(`Cannot write to ${reply.channel}: no mailbox is connected.`);
		}
		if (account.outgoing === undefined) {
			throw new ChannelError(
				`Cannot write to ${reply.channel}: ${account.address} is connected for reading only.`,
			);
		}

		const to = reply.replyTo ?? reply.channel.slice(reply.channel.indexOf(":") + 1);
		if (!to.includes("@")) {
			throw new ChannelError(`Cannot write to ${reply.channel}: there is no address in it.`);
		}

		const from = addressFor(account.address, reply.agentId);
		const thread = this.#threads.get(threadOf(reply.agentId, to));
		const post = this.#post(account, account.outgoing);
		try {
			await post.sendMail({
				from: `${reply.agentId} <${from}>`,
				to,
				replyTo: from,
				subject: answering(thread?.subject),
				text: reply.body,
				// Both, because clients disagree about which one threads: `In-Reply-To` is the answer to
				// what, and `References` is the conversation it belongs to. With one message known they
				// are the same id, and a thread of two is where a mail client stops calling it a thread.
				...(thread?.messageId !== undefined
					? { inReplyTo: thread.messageId, references: thread.messageId }
					: {}),
			});
		} finally {
			post.close();
		}
	}

	async #read(): Promise<void> {
		let wait = FIRST_RETRY_MS;

		while (this.#running) {
			const account = this.#account;
			if (account === undefined) return;

			try {
				await this.#session0(account);
				wait = FIRST_RETRY_MS;
			} catch (error) {
				if (!this.#running || this.#account !== account) return;
				this.#onError?.(error as Error);
				await new Promise((resolve) => setTimeout(resolve, wait));
				wait = Math.min(wait * 2, LONGEST_RETRY_MS);
			}
		}
	}

	/** One connection, from opening it to whatever ends it. Returns when the connection is gone. */
	async #session0(account: Account): Promise<void> {
		const session = this.#open(account);
		this.#session = session;

		const ended = new Promise<void>((resolve) => {
			session.on("close", resolve);
			// Bound because imapflow emits `error` on a socket that died, and an EventEmitter with no
			// listener for it throws out of whatever was running instead.
			session.on("error", () => resolve());
		});

		try {
			await session.connect();
			const box = await session.mailboxOpen("INBOX");
			this.#reconcile(account, box);

			session.on("exists", () => void this.#serialize(() => this.#drain(session)));
			await this.#serialize(() => this.#drain(session));
			await ended;
		} finally {
			if (this.#session === session) this.#session = undefined;
			session.close();
		}
	}

	/**
	 * Settles where to resume from, against what the server says the numbering now is.
	 *
	 * A mailbox that was never read starts at the end rather than the beginning. Reading a mailbox's
	 * whole history on connection would wake every agent once per message in it, which for an account
	 * somebody has had for years is a bill rather than a backlog.
	 */
	#reconcile(account: Account, box: { uidValidity: bigint; uidNext: number }): void {
		const uidValidity = String(box.uidValidity);
		if (account.seen?.uidValidity === uidValidity) return;
		this.#change({ seen: { uidValidity, lastUid: Math.max(box.uidNext - 1, 0) } });
	}

	async #drain(session: Session): Promise<void> {
		const account = this.#account;
		const seen = account?.seen;
		if (account === undefined || seen === undefined || this.#session !== session) return;

		const from = seen.lastUid + 1;
		let last = seen.lastUid;

		for await (const message of session.fetch(
			`${from}:*`,
			{ uid: true, source: true },
			{ uid: true },
		)) {
			// A `n:*` range never comes back empty: when nothing is that new the server answers with the
			// newest message there is, which is one already read. Taking it would answer the same mail on
			// every reconnection for as long as nobody wrote in.
			if (message.uid < from || message.source === undefined) continue;

			await this.#receive(account, message.source);
			last = Math.max(last, message.uid);
			// Moved after the event is queued rather than before, so a plane that dies mid-batch is told
			// the same message again instead of losing it. A repeat is a wasted turn; a loss is somebody
			// whose mail was never answered and who has no way of knowing that.
			this.#change({ seen: { uidValidity: seen.uidValidity, lastUid: last } });
		}

		this.#report();
	}

	async #receive(account: Account, raw: Buffer): Promise<void> {
		const parsed = await simpleParser(raw);
		const headers: Record<string, string | undefined> = {};
		const results: string[] = [];
		for (const { key, line } of parsed.headerLines) {
			const value = line.slice(line.indexOf(":") + 1).trim();
			if (key === "authentication-results") results.push(value);
			else headers[key] = value;
		}

		const sender = parseAddress(parsed.from?.text ?? "");
		if (sender === undefined) return this.#drop("no sender");

		// The mailbox writing to itself, under any tag. Without this an agent Cc'd on its own answer
		// would wake itself, read its own words as somebody's, and do it again.
		if (isOwnAddress(sender.address, account.address)) return this.#drop("its own address");

		const machine = automated(headers);
		if (machine !== undefined) return this.#drop(machine);

		const proven = authenticated(results, sender.address);
		const recipients = RECIPIENT_HEADERS.flatMap((name) => addressesIn(headers[name] ?? ""));
		let body = withoutTrail(parsed.text ?? readableText(String(parsed.html ?? "")));
		if (body.trim() === "") return this.#drop("nothing in it");

		let mailbox = account;
		if (account.pairing !== undefined) {
			const bound = this.#pair(account, sender.address, proven, body);
			if (bound === undefined) return;
			mailbox = bound;
			// The phrase is spent, and whatever was around it is a first request from somebody who has
			// just proved they are the operator. Dropping it would make the first mail the one that never
			// works, and the first mail is the one anybody sends on finishing the instructions.
			body = withoutPhrase(body, account.pairing);
			if (body === "") return;
		}

		// Only the operator. Every message that gets past here spends a turn, and a mailbox is an address
		// strangers already have — publishing whatever arrives from anyone would put the plane's bill in
		// the hands of whoever finds it, and now that agents answer, its outgoing mail too.
		if (!mailbox.operators.includes(sender.address)) return this.#drop("not the operator");
		if (!proven) return this.#drop(`${sender.address} unsigned: DKIM did not vouch for the domain`);

		const tag = agentFor(recipients, mailbox.address);
		const known = this.#agents();
		const agentId = tag !== undefined && known.includes(tag) ? tag : mailbox.fallback;
		if (!known.includes(agentId)) return this.#drop(`no agent "${agentId}"`);

		const messageId = headers["message-id"];
		this.#threads.set(threadOf(agentId, sender.address), {
			subject: parsed.subject ?? "",
			...(messageId !== undefined ? { messageId } : {}),
		});

		await this.#publisher.publish({
			agentId,
			source: "channel",
			trust: "operator",
			channel: `${this.name}:${sender.address}`,
			actor: {
				id: sender.address,
				...(sender.name !== undefined ? { displayName: sender.name } : {}),
			},
			...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
			body,
			replyTo: sender.address,
		});
	}

	/**
	 * Binds the first operator, to whoever mails the phrase in from a domain that was signed.
	 *
	 * The signature is the whole of it. `From:` is a line of text the sender chose, so a phrase that
	 * bound whoever put the right address in it would bind whoever could guess it — and what is being
	 * handed over is every agent on the plane.
	 *
	 * Answers with the account it bound, so that the rest of the same mail can go on being read as a
	 * message from the operator it just made.
	 */
	#pair(account: Account, from: string, proven: boolean, body: string): Account | undefined {
		const phrase = account.pairing?.toLowerCase() ?? "";
		if (!body.toLowerCase().includes(phrase)) {
			this.#drop("not the phrase");
			return undefined;
		}
		if (!proven) {
			this.#drop(`${from} sent the phrase unsigned, and was not let in`);
			return undefined;
		}

		// Gone rather than emptied. A phrase left lying about is a second key to the same door, and this
		// door is every agent here.
		const { pairing: _spent, ...rest } = account;
		this.#account = { ...rest, operators: [from] };
		this.#onChange?.(this.#account);
		return this.#account;
	}

	#change(part: Partial<Account>): void {
		if (this.#account === undefined) return;
		this.#account = { ...this.#account, ...part };
		this.#onChange?.(this.#account);
	}

	#drop(why: string): void {
		this.#dropped.set(why, (this.#dropped.get(why) ?? 0) + 1);
	}

	/** Counted rather than listed: most of what is in a mailbox is not for the agent, every day. */
	#report(): void {
		for (const [why, count] of this.#dropped) this.#onDropped?.(why, count);
		this.#dropped = new Map();
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}

/**
 * The pairing mail with the phrase struck out of it, which leaves whatever else was being said.
 *
 * Struck out rather than cut off at, because people write the phrase wherever they read it — on its
 * own first line, at the end as a signature, in the middle of a sentence about it.
 */
function withoutPhrase(body: string, phrase: string): string {
	const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return body
		.replace(new RegExp(escaped, "gi"), "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** One agent talking to one person, folded, because a client cases an address however it likes. */
function threadOf(agentId: string, address: string): string {
	return `${agentId}\u0000${address.toLowerCase()}`;
}

/** An answer belongs under the question. A thread nobody here remembers starting needs a line. */
function answering(subject: string | undefined): string {
	const asked = subject?.trim() ?? "";
	if (asked === "") return "Re: your message";
	return /^re\s*:/i.test(asked) ? asked : `Re: ${asked}`;
}

function openSmtp(account: Account, outgoing: Outgoing): Post {
	return nodemailer.createTransport({
		host: outgoing.host,
		port: outgoing.port,
		// 465 is encrypted from the first byte and 587 starts in the clear and upgrades. That is the
		// whole of the convention, and it holds on servers somebody runs themselves as well.
		secure: outgoing.port === 465,
		auth: { user: account.username, pass: account.password },
	}) as unknown as Post;
}

function openImap(account: Account): Session {
	return new ImapFlow({
		host: account.host,
		port: account.port,
		secure: account.port !== 143,
		auth: { user: account.username, pass: account.password },
		// Its log is one line per protocol command, which is the mailbox's whole traffic on the console.
		logger: false,
	}) as unknown as Session;
}
