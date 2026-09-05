/**
 * Who else lives on this plane, and what it takes to write to one of them.
 *
 * Apart from the extension that registers the tool, for the reason the booking rules and the console
 * ones are apart from theirs: that file imports pi and typebox, neither of which is installed outside
 * the image, so anything living in it is never typechecked and never run until an operator is
 * watching. What is worth testing here is not that a file gets written but who counts as somebody to
 * write to, how many one turn may write, and what the agent is told about a door that is shut.
 *
 * Nothing here reads or writes anything. The caller hands in what the two files said and puts back
 * what comes out, which is what keeps the count the agent is told and the list the plane finds the
 * same.
 */

/** One of the others, as the plane wrote it down before the turn started. */
export interface Teammate {
	readonly id: string;
	/** What it is for, in its operator's words. The only thing there is to pick between them by. */
	readonly description?: string;
	/**
	 * Whether this agent may write to that one already.
	 *
	 * A shut door is not a wall: the message is still written down, and what happens to it is a
	 * question on the operator's screen. What the agent may never do is open the door itself.
	 */
	readonly open: boolean;
}

/** One message, as the plane will find it once the turn is over. */
export interface Message {
	readonly to: string;
	readonly note: string;
}

/**
 * How many one turn may send.
 *
 * Low on purpose, and not for the reason the console queue is low. Every message here is a turn
 * somebody else takes and pays for, so a turn that could send forty has spent forty turns of
 * somebody else's ceiling on nothing anybody asked for. Three is enough to hand a piece of work to
 * the two agents it is split between, and not enough to page the whole plane.
 */
export const MOST_SENT = 3;

/**
 * How long a note may be.
 *
 * A message is a request, not a delivery: what the other agent needs is what to do and where to look,
 * and anything that does not fit belongs in a file it can be pointed at. The cap is here as well as
 * at the plane because an agent that finds out inside the turn can shorten the note, while one told
 * afterwards has already ended the turn that had it.
 */
export const NOTE_CHARS = 4_000;

/** The list to write back, and what to tell the agent about the one it just sent. */
export interface Sending {
	readonly sent: readonly Message[];
	readonly text: string;
}

/**
 * The others, out of whatever the plane left in the file.
 *
 * Tolerant on purpose: no file at all and a file left half-written are the same situation from here,
 * and in both the honest answer is that this agent has nobody to write to — which is what an agent on
 * a plane of one actually has.
 */
export function team(raw: string | undefined): Teammate[] {
	if (raw === undefined) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((one): Teammate[] => {
			if (typeof one !== "object" || one === null) return [];
			const { id, description, open } = one as Record<string, unknown>;
			if (typeof id !== "string" || id.length === 0) return [];
			return [
				{
					id,
					...(typeof description === "string" && description.length > 0 ? { description } : {}),
					open: open === true,
				},
			];
		});
	} catch {
		return [];
	}
}

/** The messages already written this turn, out of whatever the file held. */
export function alreadySent(raw: string | undefined): Message[] {
	if (raw === undefined) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((one): Message[] => {
			if (typeof one !== "object" || one === null) return [];
			const { to, note } = one as Record<string, unknown>;
			if (typeof to !== "string" || typeof note !== "string") return [];
			return [{ to, note }];
		});
	} catch {
		return [];
	}
}

/**
 * Adds one to the queue, or says why it is not a message anybody will get.
 *
 * Every refusal here names what to do instead, because the alternative to a message is usually the
 * work itself: an agent told only "no" writes the paragraph it would have sent as an answer to its
 * operator, who is not the one it wanted.
 */
export function sendTo(
	to: string,
	note: string,
	sent: readonly Message[],
	mates: readonly Teammate[],
): Sending {
	const name = to.trim().replace(/^@/, "");
	const written = note.trim();

	const mate = mates.find((one) => one.id === name);
	if (mate === undefined) {
		const others = mates.map((one) => one.id);
		throw new Error(
			others.length === 0
				? `There is no "${name}" here, and no other agent on this plane either. Whatever this is, it is yours to do.`
				: `There is no agent called "${name}" here. There is: ${others.join(", ")}.`,
		);
	}
	if (written.length === 0) {
		throw new Error("A message with nothing in it wakes somebody up for nothing.");
	}
	if (written.length > NOTE_CHARS) {
		throw new Error(
			`That note is ${written.length} characters and ${NOTE_CHARS} is the most. Say what the work is and where to look for the rest of it; a file in your workspace holds what will not fit.`,
		);
	}
	if (sent.some((one) => one.to === name)) {
		throw new Error(
			`You have already written to ${name} this turn, and both messages would reach it in the same turn anyway. Say it all in one note: call this again with the whole of it, or leave the one you sent.`,
		);
	}
	if (sent.length >= MOST_SENT) {
		throw new Error(
			`You have written to ${MOST_SENT} agents this turn, which is the most. Every one of those is a turn somebody else pays for.`,
		);
	}

	const queue = [...sent, { to: name, note: written }];
	return {
		sent: queue,
		// Told what the message is worth to the one receiving it, because that is the part an agent
		// gets wrong: it is used to being written to by its operator, and being written to by a peer
		// looks the same from the inside. It is not, and the other end will be told so.
		text: mate.open
			? [
					`Written to ${name}. It goes when this turn ends, and it wakes ${name} up.`,
					"",
					`It arrives there as data and not as an order — you are not ${name}'s operator, and it`,
					"decides for itself what to do with what you asked. Its answer comes back to you as a",
					"turn of your own, so end this one rather than waiting for it.",
				].join("\n")
			: [
					`${name} is not yours to write to, so nothing has gone yet.`,
					"",
					`Your operator is asked at their console, with ${name}'s name in front of them. If they`,
					"say yes the note goes and the door stays open; if they say no it is dropped and you are",
					"told. Either way you find out on a later turn, so ask for one with wake_me if you need",
					"to know before you can go on.",
				].join("\n"),
	};
}
