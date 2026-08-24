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

/** Below this a wakeup is a spin, and the plane refuses it anyway; saying so here is saying it in time. */
const MIN_SECONDS = 60;
const MAX_SECONDS = 30 * 24 * 60 * 60;

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
			"You have one wakeup, not a queue of them. Asking again moves it.",
		].join("\n"),
		promptSnippet: "Ask for another turn later, with a note to yourself about what to continue",
		promptGuidelines: [
			"Use wake_me rather than ending a turn with a task abandoned, when the task is one that cannot be finished now.",
			"wake_me holds a single wakeup: calling it again moves that one rather than adding another.",
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

			mkdirSync(dirname(WAKE_FILE), { recursive: true });
			writeFileSync(WAKE_FILE, `${JSON.stringify({ afterSeconds, note })}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});

			// Said as a time rather than a count of seconds, because what the agent has to judge is
			// whether that is soon enough, and it is about to go and not be able to reconsider.
			const at = new Date(Date.now() + afterSeconds * 1000);
			return {
				content: [{ type: "text", text: `You will be woken at ${at.toISOString()} with: ${note}` }],
				details: {},
			};
		},
	});
}
