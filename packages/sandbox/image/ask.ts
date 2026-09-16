import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { alreadyAsked, askFor, holding, keep, MOST_OPTIONS } from "./question.ts";

/**
 * The file the control plane reads once the turn is over, for the reason the wakeup is a file: the
 * sandbox has no route off itself except the egress proxy, and opening one so an agent could reach
 * the plane would be a new way in for anything that ever takes the agent over.
 *
 * Named by the plane, with the literal repeated here because a container that predates the variable
 * is still running the agent that needs this.
 */
const ASK_FILE = process.env.SQUAD_ASK_FILE ?? "/home/agent/.run/ask.json";

/** The queue as the plane will find it, since the file is the whole of what passes between them. */
function ask(question: string, options: readonly string[], hands: boolean): string {
	const asked = askFor(question, options, hands, alreadyAsked(holding(ASK_FILE)));
	keep(ASK_FILE, asked.asked);
	return asked.text;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_operator",
		label: "Ask your operator",
		description: [
			"Put a question on your operator's console with the answers already written, so that what",
			"they have to do about it is press one.",
			"",
			"Each option is the message they send by pressing it. There is no translation step at either",
			'end: press "Comfort $793" and that is the line that arrives in your next turn, word for word.',
			"So write the options as replies, in the language they are talking to you in, and never as",
			'labels — "option 1" is a button that tells you nothing when it comes back.',
			"",
			"What this is for is the moment where you are one decision away from carrying on: which of",
			"these flights, which branch, which of the two readings of what they asked for. The old way",
			"round was to write the three fares out as a paragraph and end it with a question — read",
			`twenty minutes later by somebody who then types an answer you have to match up. ${MOST_OPTIONS} options`,
			"is the most, because a column of buttons is read at a glance and a menu is not.",
			"",
			"Set hands when what you need is not an answer but the person: a click you cannot reach, a",
			"password, a code out of their phone. The card then also carries a button that takes the",
			"keyboard off you and puts your browser in front of them — and your options are what they",
			"press afterwards, so write them for that: one that says they did it, one that says they",
			"could not.",
			"",
			"Nothing waits. They may be asleep. The answer is a message in a turn of its own, so ask and",
			"then finish this turn — say in your answer what you are stopping for.",
		].join("\n"),
		promptSnippet: "Ask your operator something they can answer by pressing one of your options",
		promptGuidelines: [
			"When you are one decision away from carrying on, use ask_operator instead of writing the choice out as a paragraph and ending with a question mark.",
			"Write each option as the message it sends, in the operator's own language, so that the reply reads as an answer rather than as a label.",
			"Put your reasoning in your answer and keep the options short: the card is where the decision is taken, not where it is explained.",
			"When what you need is their hands — a click you cannot make, a password, a one-time code — set hands, and write the options as what they will press when they are done.",
			"Ask, then end the turn. Do not book a wakeup to come back and look at your own unanswered question, and do not ask the same thing twice.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "What you are asking, in one or two sentences, in their language.",
			}),
			options: Type.Array(Type.String(), {
				description:
					"The answers, each one written as the message it sends. Between one and six, best first.",
			}),
			hands: Type.Optional(
				Type.Boolean({
					description:
						"True when you need them to do something on your screen rather than answer you.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { question, options, hands } = params as {
				question: string;
				options?: readonly string[];
				hands?: boolean;
			};
			return {
				content: [{ type: "text", text: ask(question, options ?? [], hands === true) }],
				details: {},
			};
		},
	});
}
