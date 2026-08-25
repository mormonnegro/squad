import type { NewAgentEvent } from "@agent-dive/events";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
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

	#running = false;
	#session: Session | undefined;
	/** Reading is serialized: two `exists` a moment apart would otherwise read the same mail twice. */
	#tail: Promise<unknown> = Promise.resolve();
	#dropped = new Map<string, number>();

	constructor(options: EmailChannelOptions) {
		this.#account = options.account;
		this.#publisher = options.publisher;
		this.#agents = options.agents;
		this.#onChange = options.onChange;
		this.#onError = options.onError;
		this.#onDropped = options.onDropped;
		this.#open = options.open ?? openImap;
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
	 */
	async verify(account: Account): Promise<void> {
		const session = this.#open(account);
		try {
			await session.connect();
			await session.mailboxOpen("INBOX");
			await session.logout();
		} finally {
			session.close();
		}
	}

	// Nothing goes out yet. Said plainly rather than left to fail somewhere further in, because a turn
	// that answered into the dark would look, to the person who wrote in, like an agent ignoring them.
	async send(reply: Reply): Promise<void> {
		throw new ChannelError(
			`Cannot write to ${reply.channel}: this plane reads mail and does not yet send it.`,
		);
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
		const body = withoutTrail(parsed.text ?? readableText(String(parsed.html ?? "")));
		if (body.trim() === "") return this.#drop("nothing in it");

		if (account.pairing !== undefined) {
			return this.#pair(account, sender.address, proven, body);
		}

		// Only the operator, for now. Every message that gets past here spends a turn, and a mailbox is
		// an address strangers already have: publishing what arrives from anyone would put the plane's
		// bill in the hands of whoever finds it. Nothing is lost by waiting — an agent cannot write back
		// yet, so a stranger heard would be a stranger heard and never answered.
		if (!account.operators.includes(sender.address)) return this.#drop("not the operator");
		if (!proven) return this.#drop(`${sender.address} unsigned: DKIM did not vouch for the domain`);

		const tag = agentFor(recipients, account.address);
		const known = this.#agents();
		const agentId = tag !== undefined && known.includes(tag) ? tag : account.fallback;
		if (!known.includes(agentId)) return this.#drop(`no agent "${agentId}"`);

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
	 */
	#pair(account: Account, from: string, proven: boolean, body: string): void {
		const phrase = account.pairing?.toLowerCase() ?? "";
		if (!body.toLowerCase().includes(phrase)) {
			this.#drop("not the phrase");
			return;
		}
		if (!proven) {
			this.#drop(`${from} sent the phrase unsigned, and was not let in`);
			return;
		}

		// Gone rather than emptied. A phrase left lying about is a second key to the same door, and this
		// door is every agent here.
		const { pairing: _spent, ...rest } = account;
		this.#account = { ...rest, operators: [from] };
		this.#onChange?.(this.#account);
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
