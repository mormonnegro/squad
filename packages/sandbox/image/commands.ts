/**
 * What an agent may ask its console for, and what it is told back.
 *
 * Apart from the extension that registers the tool, for the same reason the booking rules are apart
 * from wake.ts: that file imports pi and typebox, neither of which is installed outside the image, so
 * anything living in it is never typechecked and never run until an operator is watching. What is
 * worth testing here is not that a file gets written but what counts as a command, what happens to
 * the ones already asked for this turn, and where the agent is told the answer will arrive.
 *
 * Nothing here reads or writes anything. The caller hands in what the file said and puts back what
 * comes out, which is what keeps the count the agent is told and the list the plane finds the same.
 */

/**
 * How many one turn may ask for. The plane caps this too, since the agent has a shell and could write
 * the file itself; here it is so that an agent looping on a refusal finds out inside the turn rather
 * than filling a console with the same line forty times.
 */
export const MOST = 10;

/** The list to write back, and what to tell the agent about the one it just asked for. */
export interface Asked {
	readonly asked: readonly string[];
	readonly text: string;
}

/**
 * The commands this turn has asked for already, out of whatever the file held.
 *
 * Tolerant on purpose: no file yet and a file left half-written are the same situation from here, and
 * in both the right thing is to treat this line as the turn's first rather than to fail on it.
 */
export function alreadyAsked(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((one) => typeof one === "string") : [];
	} catch {
		return [];
	}
}

/** Adds one to the queue, or says why it is not a command. Appended, never replaced: adding a server
 * and logging into it is two lines and one intent. */
export function askFor(line: string, asked: readonly string[]): Asked {
	const wanted = line.trim();

	if (!wanted.startsWith("/")) {
		throw new Error(`A command starts with a slash. "${wanted}" is not one.`);
	}
	// Refused here as well as at the plane, because a newline would put a second command into the
	// conversation under the first one's answer, where nobody is looking for it.
	if (/[\n\r]/.test(wanted)) {
		throw new Error("One command to a call. Call this again for the next one.");
	}
	if (asked.length >= MOST) {
		throw new Error(`You have already asked for ${MOST} commands this turn, which is the most.`);
	}

	const queue = [...asked, wanted];
	return {
		asked: queue,
		// Told the count, because the agent cannot see the console it is asking of: the only way it
		// knows a second call landed on top of the first rather than instead of it is being told so.
		text:
			`Asked for: ${wanted}\n\nIt runs when this turn ends, and the answer goes to your operator. ` +
			(queue.length === 1
				? "It is the only command you have asked for this turn."
				: `It is ${queue.length} of the commands you have asked for this turn, and they run in order.`),
	};
}
