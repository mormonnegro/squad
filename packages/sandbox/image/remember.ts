import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { heldLessons, lessonsFile, MOST_LESSONS, record } from "./lessons.ts";

/**
 * The agent's own file, unlike every other file these extensions touch.
 *
 * The wakeup and the console queue are messages to the plane, kept outside the repository because
 * the plane consumes them within the minute. This is the opposite: it lives in the repository beside
 * the soul, it is the agent's to commit and to rewrite, and the plane only ever reads it. An operator
 * looking at what an agent has become can read this file and see what it learned the hard way.
 *
 * Named by the plane, with the literal repeated here because a container that predates the variable
 * is still running the agent that needs this.
 */
const LESSONS_FILE = process.env.SQUAD_LESSONS_FILE ?? "/home/agent/.self/memory/lessons.md";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "remember",
		label: "Remember",
		description: [
			"Write down something you got wrong, so that the next you does not get it wrong the same way.",
			"",
			"This is for your own mistakes and what they taught you, not for notes about a project: a",
			"command that failed until you found the flag it wanted, an assumption about this machine",
			"that turned out to be false, an approach that does not work here. Write it as a rule aimed",
			"at yourself on a turn you will not remember having.",
			"",
			`You carry ${MOST_LESSONS} lessons and no more, and they are read back to you at the start of`,
			"every turn you ever take. That is what makes one worth writing and also what makes it cost",
			"something. When the list is full nothing is dropped for you: you go and merge or delete one",
			`yourself, in ${LESSONS_FILE}, which is your file and is yours to edit.`,
		].join("\n"),
		promptSnippet: "Write down a mistake you made, so a later turn does not repeat it",
		promptGuidelines: [
			"Use remember the moment something failed and you worked out why, before moving on. That moment is the only one where you have all of the detail; a turn later you have the fix and not the reason.",
			'Write the rule rather than the incident: "apt-get needs an update before an install here" rather than "I tried to install ripgrep and it failed".',
			"Do not record what you could look up — what a file says, what a command's help says, anything you would find by going and looking. Record what you would not have thought to go and look for.",
			"Nothing about a project belongs here. That goes in the project, or under memory/projects.",
			"A failure you caused and then fixed inside the same turn is still worth a lesson. Nobody else saw it, and that is exactly why the next you will walk into it.",
		],
		parameters: Type.Object({
			lesson: Type.String({
				description:
					'One line, in your own words, about what to do differently. E.g. "The proxy refuses any host nobody granted, so a fetch that hangs is a grant to ask for and not a network to retry."',
			}),
		}),
		async execute(_toolCallId, params) {
			const { lesson } = params as { lesson: string };

			let raw: string | undefined;
			try {
				raw = readFileSync(LESSONS_FILE, "utf8");
			} catch {
				// No file yet, which is an agent that has not been wrong yet rather than a failure.
			}

			const recorded = record(lesson, heldLessons(raw), LESSONS_FILE);
			// Not rewritten when nothing changed, so that a lesson written twice does not show up in the
			// repository as a commit that says something happened.
			if (recorded.changed) {
				mkdirSync(dirname(LESSONS_FILE), { recursive: true });
				writeFileSync(LESSONS_FILE, lessonsFile(recorded.lessons), "utf8");
			}
			return { content: [{ type: "text", text: recorded.text }], details: {} };
		},
	});
}
