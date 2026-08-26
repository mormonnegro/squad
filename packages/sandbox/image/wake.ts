import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The file the control plane reads once the turn is over, and the reason this is a file rather than
 * a call: the sandbox has no route off itself except the egress proxy, and opening one so an agent
 * could reach the plane would be a new way in for anything that ever takes the agent over. A turn
 * that has already ended cannot be talked out of what it left behind.
 *
 * Named by the plane, with the literal repeated here because a container that predates the variable
 * is still running the agent that needs this.
 */
const WAKE_FILE = process.env.AGENT_DIVE_WAKE_FILE ?? "/home/agent/.run/wake.json";

/** A second, because "right after this turn" is a real thing to want and the plane can honour it. */
const MIN_SECONDS = 1;
const MAX_SECONDS = 30 * 24 * 60 * 60;

/** Both tools write the same file, because the plane reads one file and acts on what it says. */
function request(asked: Record<string, unknown>): void {
	mkdirSync(dirname(WAKE_FILE), { recursive: true });
	writeFileSync(WAKE_FILE, `${JSON.stringify(asked)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * When the turn already booked its wakeup, if it did. One pi process is one turn, so this is per-turn.
 *
 * The bug it exists to stop is an agent that reads "you will be woken at 09:41" as the waiting being
 * over, and gets on with what it meant to do then — asks again, is told 09:42, gets on with that one
 * too. An agent asked for a joke a minute told two hundred of them in a single turn that way, at a
 * joke every three seconds, and the operator's only way to end it was to press stop.
 */
let booked: Date | undefined;

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "wake_me",
		label: "Wake me",
		description: [
			"Ask to be given another turn later, when the work you were asked for is not work that",
			"finishes in one sitting: something to check on, something to wait for, something to",
			"continue.",
			"",
			"The note is the whole of what you will be told when you wake, so write it to yourself and",
			"not about yourself: what you were doing, and what to do next. Anything that will not fit",
			"belongs in a file in your memory, with the note saying which one.",
			"",
			"The wait does not begin until this turn is over, and nothing is waited out inside a turn.",
			"What you are asking for the time to do is work for the turn you are asking for, and not",
			"for the rest of this one.",
			"",
			"You have one wakeup, not a queue of them, and a turn books it once. cancel_wake drops it.",
		].join("\n"),
		promptSnippet: "Ask for another turn later, with a note to yourself about what to continue",
		promptGuidelines: [
			"Use wake_me rather than ending a turn with a task abandoned, when the task is one that cannot be finished now.",
			"Book the wakeup once and then finish the turn. The wait starts when the turn ends, so asking again cannot bring the next turn any closer.",
			"To stop being woken at all, use cancel_wake. Moving the wakeup far away only postpones it.",
		],
		parameters: Type.Object({
			afterSeconds: Type.Integer({
				description: `How long from now, in seconds. Between ${MIN_SECONDS} and ${MAX_SECONDS}.`,
			}),
			note: Type.String({
				description: "What you will be told when you wake. Written to yourself, in your own words.",
			}),
		}),
		async execute(_toolCallId, params) {
			const { afterSeconds, note } = params as { afterSeconds: number; note: string };

			if (!Number.isInteger(afterSeconds) || afterSeconds < MIN_SECONDS) {
				throw new Error(`The soonest you can be woken is ${MIN_SECONDS} seconds from now.`);
			}
			if (afterSeconds > MAX_SECONDS) {
				throw new Error(`The furthest you can be woken is ${MAX_SECONDS} seconds from now.`);
			}
			if (note.trim().length === 0) {
				throw new Error("A wakeup with no note wakes you knowing nothing. Say what to continue.");
			}
			// Refused rather than moved, because an agent asking twice in one turn is not changing its
			// mind about when — it is waiting, here, for a turn that cannot start until it stops.
			if (booked !== undefined) {
				throw new Error(
					`You have already asked, and you are being woken at ${booked.toISOString()}. There is` +
						" one wakeup and it is booked. No time passes while this turn runs, so asking again" +
						" cannot bring it closer: end the turn, and it will come.",
				);
			}

			request({ afterSeconds, note });

			// Said as a time rather than a count of seconds, because what the agent has to judge is
			// whether that is soon enough, and it is about to go and not be able to reconsider.
			booked = new Date(Date.now() + afterSeconds * 1000);
			return {
				content: [
					{
						type: "text",
						text:
							`You will be woken at ${booked.toISOString()} with: ${note}\n` +
							"The wait starts when this turn ends. Finish what you are saying and stop.",
					},
				],
				details: {},
			};
		},
	});

	/**
	 * Its own tool rather than a time that means never, because there is no such time: the plane
	 * clamps what it is given into a range it can honour, so an agent trying to call the wakeup off by
	 * pushing it a year away has only moved it a month — and gone, believing otherwise.
	 */
	pi.registerTool({
		name: "cancel_wake",
		label: "Cancel my wakeup",
		description: [
			"Drop the wakeup you asked for, when what it was for is done, or was dealt with some other",
			"way, or is no longer wanted.",
			"",
			"Nothing will wake you afterwards until somebody says something to you, or you ask again.",
		].join("\n"),
		promptSnippet: "Call off the turn you had asked for later",
		promptGuidelines: [
			"Use cancel_wake when the reason you asked to be woken has gone away, rather than leaving a turn booked that will find nothing to do.",
		],
		parameters: Type.Object({}),
		async execute() {
			request({ cancel: true });
			// Which leaves the turn free to book one again, and is the way to change one's mind about
			// when: dropping the appointment is what makes asking a second time mean something.
			booked = undefined;
			return {
				content: [{ type: "text", text: "Your wakeup is cancelled. Nothing will wake you." }],
				details: {},
			};
		},
	});
}
