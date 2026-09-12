/**
 * The slash menu, copied rather than imported.
 *
 * `commands.ts` in the plane is the source of truth and stays the source of truth — but it reaches
 * for `node:crypto` on its first line and pulls the whole plane in behind it, so importing the one
 * table out of it would put Docker in a browser bundle. What keeps the copy honest is a test that
 * fails the day the two lists differ, which is the only thing a comment saying "keep these in sync"
 * has never done.
 *
 * Nothing here decides what a command means. The line is typed, sent whole to the plane, and
 * `runCommand` answers it. This is a menu.
 */

export interface Command {
	readonly name: string;
	readonly takes: string;
	readonly does: string;
}

export const COMMANDS: readonly Command[] = [
	{
		name: "/limit",
		takes: "[<amount>|off]",
		does: "what it has spent today, and the ceiling for it",
	},
	{ name: "/model", takes: "[<name>]", does: "what it thinks with, and what else there is" },
	{
		name: "/plugins",
		takes: "[<name>|add …|login …]",
		does: "the plugins it has, and the ones on the shelf to give it",
	},
	{
		name: "/serve",
		takes: "[<port>|stop <port>]",
		does: "open a port inside it on the machine you are sitting at",
	},
	{
		name: "/reach",
		takes: "<host>",
		does: "ask to open a host on the way out, answered here with one key",
	},
	{
		name: "/repo",
		takes: "[<owner/name> [<branch>…]|drop …]",
		does: "the GitHub repositories it holds, and which branches it may push",
	},
	{
		name: "/team",
		takes: "[<name>|drop <name>]",
		does: "the agents it may write to, and what it has asked to write to",
	},
	{
		name: "/telegram",
		takes: "[<token>|off]",
		does: "the Telegram bot it answers on, and how to pair one",
	},
	{
		name: "/email",
		takes: "[<address>|<password>|allow …|deny …|off]",
		does: "the address it is reached at, and whose mail is read as instructions",
	},
	{ name: "/clear", takes: "", does: "forget the conversation, and start it again on nothing" },
	{ name: "/delete", takes: "", does: "delete this agent, after asking whether you meant it" },
	{
		name: "/config",
		takes: "[models|search|grants|plugins|email]",
		does: "the whole plane's screen: its keys, models, reach and mailbox",
	},
	{ name: "/help", takes: "", does: "every command there is" },
];

export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

export function isShell(line: string): boolean {
	return line.startsWith("!");
}

/**
 * The rows worth offering for what has been typed so far.
 *
 * Nothing once there is a space, because past the command's own name the argument is the agent's
 * business — a port number, a hostname, a repository — and this menu knows none of those.
 */
export function completions(draft: string): readonly Command[] {
	if (!isCommand(draft) || /\s/.test(draft)) return [];
	return COMMANDS.filter((command) => command.name.startsWith(draft));
}
