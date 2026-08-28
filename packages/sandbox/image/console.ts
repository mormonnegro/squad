import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Asked, alreadyAsked, askFor } from "./commands.ts";

/**
 * The file the control plane reads once the turn is over, for the same reason the wakeup is a file:
 * the sandbox has no route off itself except the egress proxy, and opening one so an agent could
 * reach the plane would be a new way in for anything that ever takes the agent over. A turn that has
 * already ended cannot be talked out of what it left behind.
 *
 * Named by the plane, with the literal repeated here because a container that predates the variable
 * is still running the agent that needs this.
 */
const CONSOLE_FILE = process.env.SQUAD_CONSOLE_FILE ?? "/home/agent/.run/console.json";

/** The queue as the plane will find it, since the file is the whole of what passes between them. */
function ask(line: string): Asked {
	let held: string | undefined;
	try {
		held = readFileSync(CONSOLE_FILE, "utf8");
	} catch {
		// No file yet: this turn has asked for nothing so far, which is what askFor is about to be told.
	}

	const asked = askFor(line, alreadyAsked(held));
	mkdirSync(dirname(CONSOLE_FILE), { recursive: true });
	writeFileSync(CONSOLE_FILE, `${JSON.stringify(asked.asked)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return asked;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "console_command",
		label: "Console command",
		description: [
			"Ask for one of the commands your operator types at your console, so that a thing you need",
			"set up gets set up instead of being described to somebody who has to go and type it.",
			"",
			"What you can ask for:",
			"",
			"  /mcp add <name> <url>     connect yourself to an MCP server",
			"  /mcp add <name> <cmd>     one you run yourself, instead of a URL",
			"  /mcp login <name>         send your operator to that server's consent screen",
			"  /mcp                      the servers you have, and the ones on the shelf",
			"  /mcp drop <name>          give one up",
			"  /model [<name>]           what you think with, and what else you could",
			"  /limit <amount>           lower what you may spend in a day",
			"  /serve <port>             put a port of yours on your operator's own machine",
			"  /serve stop <port>        take it back down",
			"  /serve                    what of yours is open, and at which addresses",
			"",
			"Nothing you run is reachable from outside this sandbox unless you ask for /serve. Bind your",
			"server to 127.0.0.1 and then ask, and your operator gets a link they can open in a browser.",
			"",
			"What you cannot: anything that widens what you may reach or spend, and anything that",
			"destroys. Those stay with your operator, and asking for one prints the exact line they",
			"would type — which is more use to them than a paragraph explaining what you wanted.",
			"",
			"The command runs when this turn ends, and its answer goes to your operator's console, not",
			"to you. If you need to see what it said, ask for a turn afterwards with wake_me.",
		].join("\n"),
		promptSnippet: "Ask for a console command: connect an MCP server, log into one, change model",
		promptGuidelines: [
			"Use console_command instead of telling the operator to go and configure something you could ask for yourself.",
			"To connect to a server that needs an account, ask for /mcp add and /mcp login in the same turn: the second is what puts a consent screen in front of the operator.",
			"The answer arrives at the operator's console rather than in your turn, so pair it with wake_me when you need to act on what it said.",
			"A command that widens your reach or your spending will be refused, and the refusal tells the operator what to type. That is the end of it: do not ask again.",
			"When you build something with a page — a server, a frontend, a dashboard — bind it to 127.0.0.1, start it with keep so it outlives this turn, and ask for /serve on its port. A link is worth more than a description of what the operator would see.",
		],
		parameters: Type.Object({
			line: Type.String({
				description: 'The command, written exactly as it would be typed, e.g. "/mcp login ahrefs".',
			}),
		}),
		async execute(_toolCallId, params) {
			const { line } = params as { line: string };
			return { content: [{ type: "text", text: ask(line).text }], details: {} };
		},
	});
}
