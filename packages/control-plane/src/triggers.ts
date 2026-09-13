import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { type Hook, isSigner, type Signer } from "@squad/channels";

/**
 * Something outside this plane that gives an agent a turn.
 *
 * A wakeup the agent asks itself for answers "when"; this answers "when something happens". Stripe
 * cancels a subscription, GitHub merges a branch, something you wrote posts a line — and an agent
 * that would otherwise be polling every five minutes to find out, at a turn a time, is woken once,
 * with the thing that happened in its hands.
 *
 * It is a webhook underneath, and deliberately nothing cleverer: the senders worth reacting to all
 * speak it, they all sign it, and they all retry it. What this adds on top is the three things that
 * make one usable — knowing who signed, saying which events are worth a turn, and not taking the
 * same delivery twice.
 */
export interface Trigger {
	/** What it is called here, and the last segment of the URL the sender posts to. */
	readonly name: string;
	readonly agentId: string;
	/** Who is at the other end, which decides how the signature is read. */
	readonly from: Signer;
	/** The secret the sender signs with. Shown once, when it is made, and never again. */
	readonly secret: string;
	/** Which kinds of event are worth a turn. Empty is all of them. */
	readonly only: readonly string[];
	/** Turns a minute this may cause, so a backlog cannot spend a day's ceiling in one. */
	readonly atMostPerMinute?: number;
	readonly madeAt: string;
	/** When it last woke somebody, so a trigger that has never fired is visibly one. */
	readonly firedAt?: string;
	readonly fired: number;
}

/** Named like everything else a person types and puts in a URL. */
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function nameRefused(name: string): string | undefined {
	if (name.length === 0) return "A trigger needs a name.";
	if (!NAME.test(name)) {
		return `"${name}" will not do as a trigger name: lowercase letters, digits and dashes, starting with a letter or a digit.`;
	}
	return undefined;
}

/**
 * The secret the sender will sign with.
 *
 * Made here rather than asked for, because a secret somebody chooses is a secret somebody can
 * remember, and this one is pasted into a form on another company's website exactly once.
 */
export function newSecret(): string {
	return `whsec_${randomBytes(24).toString("base64url")}`;
}

/** What the hook looks like to the channel that answers it. */
export function hookOf(trigger: Trigger): Hook {
	return {
		id: trigger.name,
		agentId: trigger.agentId,
		secret: trigger.secret,
		from: trigger.from,
		only: trigger.only,
		// Never operator, whoever signed it. A signature proves which system sent the request, not
		// that a person meant what is inside it: a genuine Stripe delivery carries a customer's own
		// words in half its fields.
		trust: "public",
		...(trigger.atMostPerMinute === undefined ? {} : { atMostPerMinute: trigger.atMostPerMinute }),
	};
}

/** How many delivery ids are remembered per trigger. Enough to outlast a sender's retry window. */
const REMEMBERED = 500;

interface Written {
	readonly triggers: Record<string, Trigger>;
	/** Delivery ids already handled, newest last, per trigger. */
	readonly handled: Record<string, string[]>;
}

/**
 * The triggers this plane has, and which deliveries they have already taken.
 *
 * Both in one file because they are written together on the hot path: a delivery arrives, it is
 * recognised as new, and the fact that it was taken has to survive the restart that happens while
 * the agent is still thinking about it. Everything a console decides lives beside this, on the same
 * terms — the operator's configuration file is theirs, and no plane writes to it.
 */
export class Triggers {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async all(): Promise<readonly Trigger[]> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			return Object.values(held.triggers).sort((one, other) => one.name.localeCompare(other.name));
		});
	}

	async of(name: string): Promise<Trigger | undefined> {
		return await this.#serialize(async () => (await this.#read()).triggers[name]);
	}

	async add(trigger: Trigger): Promise<void> {
		await this.#serialize(async () => {
			const held = await this.#read();
			if (held.triggers[trigger.name] !== undefined) {
				throw new Error(`There is already a trigger called "${trigger.name}".`);
			}
			await this.#write({
				...held,
				triggers: { ...held.triggers, [trigger.name]: trigger },
			});
		});
	}

	async drop(name: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			if (held.triggers[name] === undefined) return false;
			const { [name]: _gone, ...left } = held.triggers;
			const { [name]: _forgotten, ...rest } = held.handled;
			await this.#write({ triggers: left, handled: rest });
			return true;
		});
	}

	/** An agent that is gone takes its triggers with it: a name is reused, and a door is not. */
	async forget(agentId: string): Promise<readonly string[]> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			const gone = Object.values(held.triggers)
				.filter((one) => one.agentId === agentId)
				.map((one) => one.name);
			if (gone.length === 0) return [];
			const triggers: Record<string, Trigger> = {};
			const handled: Record<string, string[]> = {};
			for (const [name, trigger] of Object.entries(held.triggers)) {
				if (gone.includes(name)) continue;
				triggers[name] = trigger;
				const seen = held.handled[name];
				if (seen !== undefined) handled[name] = seen;
			}
			await this.#write({ triggers, handled });
			return gone;
		});
	}

	/**
	 * Whether this delivery has been handled, and writes it down when it has not.
	 *
	 * The two halves in one step because they cannot be two: a sender that retries while the first
	 * delivery is still being written down would otherwise be told twice that it is new.
	 */
	async handled(name: string, deliveryId: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const held = await this.#read();
			const seen = held.handled[name] ?? [];
			if (seen.includes(deliveryId)) return true;
			await this.#write({
				...held,
				handled: { ...held.handled, [name]: [...seen, deliveryId].slice(-REMEMBERED) },
			});
			return false;
		});
	}

	/** Counts one that woke somebody, so a trigger that has never fired is visibly one. */
	async fired(name: string, at: string): Promise<void> {
		await this.#serialize(async () => {
			const held = await this.#read();
			const trigger = held.triggers[name];
			if (trigger === undefined) return;
			await this.#write({
				...held,
				triggers: {
					...held.triggers,
					[name]: { ...trigger, firedAt: at, fired: trigger.fired + 1 },
				},
			});
		});
	}

	async #read(): Promise<Written> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return { triggers: {}, handled: {} };
			}
			const { triggers, handled } = parsed as Record<string, unknown>;
			return { triggers: readTriggers(triggers), handled: readHandled(handled) };
		} catch {
			return { triggers: {}, handled: {} };
		}
	}

	async #write(held: Written): Promise<void> {
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(held, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, this.#path);
	}

	async #serialize<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(work, work);
		this.#tail = next.then(
			() => undefined,
			() => undefined,
		);
		return await next;
	}
}

/** Read tolerantly: a trigger the file cannot describe is one this plane would answer wrongly. */
function readTriggers(raw: unknown): Record<string, Trigger> {
	if (typeof raw !== "object" || raw === null) return {};
	const held: Record<string, Trigger> = {};
	for (const [name, one] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof one !== "object" || one === null) continue;
		const { agentId, from, secret, only, atMostPerMinute, madeAt, firedAt, fired } = one as Record<
			string,
			unknown
		>;
		if (typeof agentId !== "string" || typeof secret !== "string") continue;
		if (typeof from !== "string" || !isSigner(from)) continue;
		held[name] = {
			name,
			agentId,
			from,
			secret,
			only: Array.isArray(only) ? only.filter((it): it is string => typeof it === "string") : [],
			...(typeof atMostPerMinute === "number" ? { atMostPerMinute } : {}),
			madeAt: typeof madeAt === "string" ? madeAt : new Date(0).toISOString(),
			...(typeof firedAt === "string" ? { firedAt } : {}),
			fired: typeof fired === "number" ? fired : 0,
		};
	}
	return held;
}

function readHandled(raw: unknown): Record<string, string[]> {
	if (typeof raw !== "object" || raw === null) return {};
	const held: Record<string, string[]> = {};
	for (const [name, ids] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(ids)) continue;
		held[name] = ids.filter((one): one is string => typeof one === "string").slice(-REMEMBERED);
	}
	return held;
}
