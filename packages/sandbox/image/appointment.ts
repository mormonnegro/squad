/**
 * The one appointment an agent has, and the rules about asking for it.
 *
 * Apart from the extension that registers the tools because that extension cannot be run outside the
 * image: pi loads it and typebox describes its parameters, and neither of those is installed here. So
 * nothing about it was ever typechecked or tested, and what went uncovered was not the wiring but the
 * deciding — which is where the bug was. An agent asked for a joke a minute told two hundred of them
 * inside a single turn, at one every three seconds, because it read "you will be woken at 09:41" as
 * the waiting being over and got on with what it meant to do then: ask again.
 *
 * Nothing here touches a disk or a clock it was not handed. That is the point: the file is written by
 * whoever calls this, so what is left for the plane and what the agent is told cannot come apart.
 */

/** A second, because "right after this turn" is a real thing to want and the plane can honour it. */
export const MIN_SECONDS = 1;

/** Past a month it is not scheduling work, it is leaving a note for a stranger. */
export const MAX_SECONDS = 30 * 24 * 60 * 60;

/** What the plane is to find once the turn is over, and what the agent is told before it ends. */
export interface Asked {
	readonly request: Record<string, unknown>;
	readonly text: string;
}

export class Appointment {
	/**
	 * When this turn already booked, if it did. One pi process is one turn, so this lives for a turn.
	 */
	#at: Date | undefined;

	/**
	 * Asks for the next turn, or says why it cannot be had.
	 *
	 * The request is left before the appointment is kept, and the order is load-bearing: a write that
	 * fails must leave the agent free to ask again, rather than told it is booked for a turn nothing
	 * will ever come for.
	 */
	book(
		afterSeconds: number,
		note: string,
		leave: (request: Record<string, unknown>) => void,
		now = Date.now(),
	): Asked {
		if (!Number.isInteger(afterSeconds) || afterSeconds < MIN_SECONDS) {
			throw new Error(`The soonest you can be woken is ${MIN_SECONDS} seconds from now.`);
		}
		if (afterSeconds > MAX_SECONDS) {
			throw new Error(`The furthest you can be woken is ${MAX_SECONDS} seconds from now.`);
		}
		if (note.trim().length === 0) {
			throw new Error("A wakeup with no note wakes you knowing nothing. Say what to continue.");
		}
		// Refused rather than moved, because an agent asking twice in one turn is not changing its mind
		// about when — it is waiting, here, for a turn that cannot start until it stops waiting.
		if (this.#at !== undefined) {
			throw new Error(
				`You have already asked, and you are being woken at ${this.#at.toISOString()}. There is` +
					" one wakeup and it is booked. No time passes while this turn runs, so asking again" +
					" cannot bring it closer: end the turn, and it will come.",
			);
		}

		const request = { afterSeconds, note };
		leave(request);
		this.#at = new Date(now + afterSeconds * 1000);

		// Said as a time rather than as a count of seconds, because what the agent has to judge is
		// whether that is soon enough, and it is about to go and not be able to reconsider.
		return {
			request,
			text:
				`You will be woken at ${this.#at.toISOString()} with: ${note}\n` +
				"The wait starts when this turn ends. Finish what you are saying and stop.",
		};
	}

	/**
	 * Drops it, which leaves the turn free to ask again.
	 *
	 * That is also the way to change one's mind about when: dropping the appointment is what makes
	 * asking a second time mean something other than asking the same thing twice.
	 */
	cancel(leave: (request: Record<string, unknown>) => void): Asked {
		const request = { cancel: true };
		leave(request);
		this.#at = undefined;
		return { request, text: "Your wakeup is cancelled. Nothing will wake you." };
	}
}
