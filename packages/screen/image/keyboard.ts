/**
 * Who is driving the browser: the agent, or the person watching it.
 *
 * The whole reason this exists is that both of them are real. An agent that keeps clicking while
 * somebody types a password into the same page is not a race to be smoothed over — it is the agent
 * navigating away mid-login, and, if it takes a screenshot at the wrong moment, the password in its
 * own transcript. So there is one keyboard and it is held by one of them at a time, and the other
 * is refused in words that say who has it and how it comes back.
 *
 * Held by the agent unless somebody says otherwise, because that is the state a screen spends
 * almost all of its life in, and because the alternative — a screen that starts locked — is a
 * feature that does nothing until an operator finds the button.
 */

/**
 * How long the operator keeps it without saying anything.
 *
 * A lease rather than a latch, because the way this ends is almost never the button: it is a closed
 * tab, a laptop shut, a browser that went to sleep on the train. Without an expiry, the agent is
 * locked out of its own screen until somebody remembers a page they closed yesterday — and what
 * that looks like from the console is an agent that has quietly stopped being able to work.
 */
export const LEASE_MS = 90_000;

export type Holder = "agent" | "operator";

export interface Keyboard {
	readonly holder: Holder;
	/** What the agent asked the operator to come and do, while it is still waiting for it. */
	readonly note: string | undefined;
}

/**
 * The keyboard, and the clock it expires against.
 *
 * The clock is injected because the interesting behaviour here is entirely about time passing, and
 * a test that has to wait ninety seconds to check a lease is a test nobody runs.
 */
export class TheKeyboard {
	readonly #now: () => number;
	readonly #leaseMs: number;
	#heldUntil = 0;
	#note: string | undefined;

	constructor(now: () => number = Date.now, leaseMs = LEASE_MS) {
		this.#now = now;
		this.#leaseMs = leaseMs;
	}

	get holder(): Holder {
		return this.#now() < this.#heldUntil ? "operator" : "agent";
	}

	state(): Keyboard {
		return { holder: this.holder, note: this.#note };
	}

	/**
	 * The operator takes it, and takes it again with every frame they are sent.
	 *
	 * Renewing on the view rather than on their clicks is deliberate: somebody reading a page they
	 * are about to type into is not idle, and a lease that only counted keystrokes would expire in
	 * the middle of them reading the two-factor mail.
	 */
	take(): Keyboard {
		this.#heldUntil = this.#now() + this.#leaseMs;
		return this.state();
	}

	/**
	 * Handed back, which also drops whatever the agent was waiting to be helped with.
	 *
	 * The note goes because the note is a question, and giving the keyboard back is the answer to it
	 * — whether or not the thing was done. An agent that asked to be signed in and was not will find
	 * out in the way it was always going to: by looking at the page.
	 */
	release(): Keyboard {
		this.#heldUntil = 0;
		this.#note = undefined;
		return this.state();
	}

	/**
	 * The agent asks for a person, and says what for.
	 *
	 * It does not take the keyboard by asking, and it cannot: this leaves a sentence on the operator's
	 * screen and nothing else. An agent that could put itself on hold could put itself on hold at the
	 * end of every turn it found hard.
	 */
	ask(note: string): Keyboard {
		this.#note = note.trim().slice(0, 300) || undefined;
		return this.state();
	}
}

/**
 * What the agent is told when it asks for something while somebody else is holding the keyboard.
 *
 * Long for a refusal, because the agent's next move is the whole point of it: a tool that says only
 * "denied" is a tool an agent retries in a loop until the turn dies, and the honest answer is that
 * there is nothing to do here for a minute or two and it has a way of coming back then.
 */
export function refusedToAgent(note: string | undefined): string {
	return [
		"The operator has the keyboard on this screen, so nothing was done.",
		note === undefined
			? ""
			: `They are there because you asked: "${note}". That question is on their screen.`,
		"Do not retry this in a loop. Either get on with something else, or end the turn and book",
		"one a few minutes out with wake_me — the keyboard comes back on its own when they are done",
		"or when they walk away from it.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

/** What the page tells the operator when the agent is the one driving. */
export function refusedToOperator(): string {
	return "The agent is driving this screen. Take the keyboard first.";
}
