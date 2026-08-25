import type { NewAgentEvent } from "@agent-dive/events";
import { afterEach, describe, expect, it } from "vitest";
import { type Account, addressFor, EmailChannel, type Session } from "../src/email.ts";
import { pairingPhrase } from "../src/phrase.ts";

class RecordingPublisher {
	readonly published: NewAgentEvent[] = [];

	async publish(event: NewAgentEvent): Promise<void> {
		this.published.push(event);
	}
}

interface Letter {
	readonly uid: number;
	readonly from: string;
	readonly to?: string;
	readonly subject?: string;
	readonly body: string;
	/** What the receiving provider wrote down about the signature, which is what trust rests on. */
	readonly results?: string;
	readonly extra?: Readonly<Record<string, string>>;
}

function raw(letter: Letter): Buffer {
	const lines = [
		...(letter.results === undefined ? [] : [`Authentication-Results: ${letter.results}`]),
		`From: ${letter.from}`,
		`To: ${letter.to ?? "agents@example.com"}`,
		`Subject: ${letter.subject ?? "hello"}`,
		...Object.entries(letter.extra ?? {}).map(([name, value]) => `${name}: ${value}`),
		"Content-Type: text/plain; charset=utf-8",
		"",
		letter.body,
	];
	return Buffer.from(lines.join("\r\n"), "utf8");
}

/** Stands in for a provider's IMAP server, holding the connection open the way one does. */
class FakeMailbox {
	readonly connections: number[] = [];
	/** How many times the box has been read through, which is when a connection is settled enough. */
	reads = 0;
	uidValidity = 100n;
	#letters: Letter[] = [];
	#listeners = new Map<string, Array<(...args: never[]) => void>>();

	/** Mail that was in the box before anybody connected, which nobody is told about. */
	hold(...letters: readonly Letter[]): void {
		this.#letters.push(...letters);
	}

	/** Puts mail in and tells whoever is connected, the way a server announces one arriving. */
	deliver(...letters: readonly Letter[]): void {
		this.#letters.push(...letters);
		for (const listener of this.#listeners.get("exists") ?? []) listener();
	}

	drop(): void {
		for (const listener of this.#listeners.get("close") ?? []) listener();
	}

	get uidNext(): number {
		return Math.max(0, ...this.#letters.map((one) => one.uid)) + 1;
	}

	open = (): Session => {
		this.#listeners = new Map();
		const session: Session = {
			connect: async () => {
				this.connections.push(Date.now());
			},
			mailboxOpen: async () => ({ uidValidity: this.uidValidity, uidNext: this.uidNext }),
			fetch: (range: string) => this.#fetch(range),
			on: (event: string, listener: (...args: never[]) => void) => {
				const held = this.#listeners.get(event) ?? [];
				held.push(listener);
				this.#listeners.set(event, held);
				return session;
			},
			logout: async () => {},
			close: () => {},
		};
		return session;
	};

	async *#fetch(range: string): AsyncIterable<{ uid: number; source?: Buffer }> {
		const from = Number(range.split(":")[0]);
		const wanted = this.#letters.filter((one) => one.uid >= from);
		// A `n:*` range never comes back empty: with nothing that new, a server answers with the newest
		// message there is, even though it is one already read.
		const answering = wanted.length > 0 ? wanted : this.#letters.slice(-1);
		for (const letter of answering) yield { uid: letter.uid, source: raw(letter) };
		this.reads += 1;
	}
}

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let waited = 0; waited < 400; waited += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

const SIGNED = "mx.example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

const ACCOUNT: Account = {
	address: "agents@example.com",
	host: "imap.example.com",
	port: 993,
	username: "agents@example.com",
	password: "secret",
	fallback: "scout",
	operators: ["nico@example.com"],
};

const stoppers: Array<() => void> = [];

afterEach(() => {
	for (const stop of stoppers.splice(0)) stop();
});

interface Running {
	readonly channel: EmailChannel;
	readonly mailbox: FakeMailbox;
	readonly publisher: RecordingPublisher;
	readonly changes: Account[];
	readonly dropped: Array<{ why: string; count: number }>;
}

interface Setup {
	readonly account?: Partial<Account>;
	readonly agents?: readonly string[];
	/** Mail already sitting in the box when the plane first connects to it. */
	readonly holding?: readonly Letter[];
}

/**
 * A channel reading a mailbox, returned once it has been through the box a first time.
 *
 * Waited for rather than handed back straight away, because everything a connection settles — where
 * to resume from, that anyone is listening for an arrival at all — happens on the way in. Mail
 * delivered before that is mail that was already there, which is a different thing entirely.
 */
async function running(setup: Setup = {}): Promise<Running> {
	const mailbox = new FakeMailbox();
	mailbox.hold(...(setup.holding ?? []));
	const publisher = new RecordingPublisher();
	const changes: Account[] = [];
	const dropped: Array<{ why: string; count: number }> = [];
	const agents = setup.agents ?? ["scout", "clerk"];
	const channel = new EmailChannel({
		account: { ...ACCOUNT, ...setup.account },
		publisher,
		agents: () => agents,
		open: mailbox.open,
		onChange: (changed) => changes.push(changed),
		onDropped: (why, count) => dropped.push({ why, count }),
	});
	stoppers.push(() => channel.stop());
	channel.start();
	await until(() => mailbox.reads > 0, "the first read");
	return { channel, mailbox, publisher, changes, dropped };
}

describe("addressFor and pairingPhrase", () => {
	it("tags an agent's name onto the mailbox", () => {
		expect(addressFor("agents@example.com", "scout")).toBe("agents+scout@example.com");
		// A mailbox typed in with a tag already on it is still the same account underneath.
		expect(addressFor("agents+old@example.com", "scout")).toBe("agents+scout@example.com");
	});

	it("offers a phrase with no vowels in it to read wrong", () => {
		expect(pairingPhrase()).toMatch(/^[a-z0-9]{10}$/);
	});
});

describe("EmailChannel", () => {
	it("publishes an operator's mail as something the agent may act on", async () => {
		const { mailbox, publisher } = await running();

		mailbox.deliver({
			uid: 1,
			from: "Nico <nico@example.com>",
			to: "agents+clerk@example.com",
			subject: "deploy",
			body: "ship it",
			results: SIGNED,
		});
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published[0]).toMatchObject({
			agentId: "clerk",
			source: "channel",
			trust: "operator",
			channel: "email:nico@example.com",
			actor: { id: "nico@example.com", displayName: "Nico" },
			subject: "deploy",
			body: "ship it",
			replyTo: "nico@example.com",
		});
	});

	// Not every provider does plus-addressing, and on one that does not the bare address would reach
	// nobody at all — a mailbox connected, read, and quietly dropping everything in it.
	it("gives mail with no tag on it to the agent the mailbox was connected at", async () => {
		const { mailbox, publisher } = await running();

		mailbox.deliver({ uid: 1, from: "nico@example.com", body: "hello", results: SIGNED });
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published[0]).toMatchObject({ agentId: "scout" });
	});

	it("gives mail tagged for an agent that does not exist to the one that does", async () => {
		const { mailbox, publisher } = await running();

		mailbox.deliver({
			uid: 1,
			from: "nico@example.com",
			to: "agents+nobody@example.com",
			body: "hello",
			results: SIGNED,
		});
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published[0]).toMatchObject({ agentId: "scout" });
	});

	it("takes the quoted thread off before spending a turn on it", async () => {
		const { mailbox, publisher } = await running();

		mailbox.deliver({
			uid: 1,
			from: "nico@example.com",
			body: "yes, go ahead\n\nOn Tue, 25 Aug 2026, agents wrote:\n> should I deploy?",
			results: SIGNED,
		});
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published[0]?.body).toBe("yes, go ahead");
	});

	/**
	 * The whole of operator trust by mail. `From:` is a line the sender chose, so without the
	 * provider's word on the signature an agent would take instructions from whoever typed the
	 * operator's address into a header — which is anybody.
	 */
	it("refuses the operator's own address when nothing signed it", async () => {
		const { mailbox, publisher, dropped } = await running();

		mailbox.deliver(
			{ uid: 1, from: "nico@example.com", body: "delete everything" },
			{ uid: 2, from: "nico@example.com", body: "the real one", results: SIGNED },
		);
		await until(() => publisher.published.length > 0, "the signed one");

		expect(publisher.published).toHaveLength(1);
		expect(publisher.published[0]).toMatchObject({ body: "the real one" });
		expect(dropped.some((one) => one.why.includes("unsigned"))).toBe(true);
	});

	// A mailbox is an address strangers already have, and every message that got through would spend a
	// turn. Nothing is lost by waiting: an agent cannot write back yet.
	it("drops a stranger, and counts them rather than listing them", async () => {
		const { mailbox, publisher, dropped } = await running();

		mailbox.deliver(
			{ uid: 1, from: "stranger@elsewhere.test", body: "buy this", results: SIGNED },
			{ uid: 2, from: "another@elsewhere.test", body: "and this", results: SIGNED },
			{ uid: 3, from: "nico@example.com", body: "mine", results: SIGNED },
		);
		await until(() => publisher.published.length > 0, "the operator's mail");

		expect(publisher.published).toHaveLength(1);
		expect(dropped).toContainEqual({ why: "not the operator", count: 2 });
	});

	it("says nothing back to a machine", async () => {
		const { mailbox, publisher, dropped } = await running();

		mailbox.deliver(
			{
				uid: 1,
				from: "nico@example.com",
				body: "I am on holiday",
				results: SIGNED,
				extra: { "Auto-Submitted": "auto-replied" },
			},
			{ uid: 2, from: "nico@example.com", body: "back now", results: SIGNED },
		);
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published).toHaveLength(1);
		expect(dropped.some((one) => one.why.includes("auto-replied"))).toBe(true);
	});

	it("does not answer itself", async () => {
		const { mailbox, publisher, dropped } = await running();

		mailbox.deliver(
			{ uid: 1, from: "agents+scout@example.com", body: "my own words", results: SIGNED },
			{ uid: 2, from: "nico@example.com", body: "theirs", results: SIGNED },
		);
		await until(() => publisher.published.length > 0, "the event");

		expect(publisher.published).toHaveLength(1);
		expect(dropped.some((one) => one.why.includes("own address"))).toBe(true);
	});

	it("moves the read mark past what it has queued, and says so", async () => {
		const { mailbox, changes, publisher } = await running();

		mailbox.deliver(
			{ uid: 7, from: "nico@example.com", body: "one", results: SIGNED },
			{ uid: 8, from: "nico@example.com", body: "two", results: SIGNED },
		);
		await until(() => publisher.published.length === 2, "both events");

		expect(changes.at(-1)?.seen).toEqual({ uidValidity: "100", lastUid: 8 });
	});

	/**
	 * A `n:*` range never comes back empty: with nothing that new, a server answers with the newest
	 * message there is. Taking it would answer the same mail again on every reconnection, for as long
	 * as nobody wrote in.
	 */
	it("does not read again the message a server answered with for want of a newer one", async () => {
		const { mailbox, publisher } = await running();

		mailbox.deliver({ uid: 5, from: "nico@example.com", body: "only this", results: SIGNED });
		await until(() => publisher.published.length > 0, "the event");

		mailbox.drop();
		await until(() => mailbox.connections.length > 1, "the reconnection");
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(publisher.published).toHaveLength(1);
	});

	// Reading a mailbox's whole history would wake an agent once per message in it, which for an
	// account somebody has had for years is a bill rather than a backlog.
	it("starts a mailbox it has never read at the end of it", async () => {
		const { publisher, changes } = await running({
			holding: [{ uid: 40, from: "nico@example.com", body: "old", results: SIGNED }],
		});

		expect(changes[0]?.seen).toEqual({ uidValidity: "100", lastUid: 40 });
		expect(publisher.published).toHaveLength(0);
	});

	// When the numbering resets, every uid before it means something else. Resuming from the old mark
	// would read a stranger's mail or silently skip a week of your own.
	it("starts again when the server renumbers the mailbox", async () => {
		const { changes } = await running({
			account: { seen: { uidValidity: "99", lastUid: 3 } },
			holding: [{ uid: 1, from: "nico@example.com", body: "renumbered", results: SIGNED }],
		});

		expect(changes[0]?.seen).toEqual({ uidValidity: "100", lastUid: 1 });
	});

	it("comes back after the connection drops in the night", async () => {
		const { mailbox, publisher } = await running({
			account: { seen: { uidValidity: "100", lastUid: 0 } },
		});

		mailbox.drop();
		await until(() => mailbox.connections.length > 1, "the reconnection");

		mailbox.deliver({ uid: 1, from: "nico@example.com", body: "still here", results: SIGNED });
		await until(() => publisher.published.length > 0, "the event after it");

		expect(publisher.published[0]).toMatchObject({ body: "still here" });
	});

	it("refuses to write, rather than answering into the dark", async () => {
		const { channel } = await running();

		await expect(
			channel.send({ agentId: "scout", channel: "email:nico@example.com", body: "done" }),
		).rejects.toThrow(/does not yet send/);
	});
});

describe("pairing", () => {
	const unpaired = { operators: [], pairing: "openthedoor" };

	it("binds whoever mails the phrase in from a domain that was signed", async () => {
		const { channel, mailbox, publisher } = await running({ account: unpaired });

		mailbox.deliver({
			uid: 1,
			from: "nico@example.com",
			body: "openthedoor",
			results: SIGNED,
		});
		await until(() => channel.account?.pairing === undefined, "the pairing");

		expect(channel.account).toMatchObject({ operators: ["nico@example.com"] });
		// Gone rather than emptied: a phrase left lying about is a second key to the same door.
		expect(channel.account).not.toHaveProperty("pairing");
		// The phrase is plumbing, not something anybody said to an agent.
		expect(publisher.published).toHaveLength(0);
	});

	it("takes the phrase however the keyboard cased it", async () => {
		const { channel, mailbox } = await running({ account: unpaired });

		mailbox.deliver({ uid: 1, from: "nico@example.com", body: "Openthedoor", results: SIGNED });
		await until(() => channel.account?.pairing === undefined, "the pairing");

		expect(channel.account).toMatchObject({ operators: ["nico@example.com"] });
	});

	// What is being handed over is every agent on the plane, so a phrase from an address nothing
	// vouched for opens nothing at all.
	it("will not be paired by an unsigned address", async () => {
		const { channel, mailbox, dropped } = await running({ account: unpaired });

		mailbox.deliver({ uid: 1, from: "nico@example.com", body: "openthedoor" });
		await until(() => dropped.length > 0, "the refusal");

		expect(channel.account).toMatchObject({ operators: [], pairing: "openthedoor" });
		expect(dropped.some((one) => one.why.includes("unsigned"))).toBe(true);
	});

	it("ignores mail that does not carry the phrase", async () => {
		const { channel, mailbox, dropped } = await running({ account: unpaired });

		mailbox.deliver({ uid: 1, from: "nico@example.com", body: "hello?", results: SIGNED });
		await until(() => dropped.length > 0, "the drop");

		expect(channel.account).toMatchObject({ pairing: "openthedoor" });
	});
});
