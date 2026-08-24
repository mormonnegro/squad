import { randomBytes } from "node:crypto";
import { hostOf, type McpServer, type NamedServer, readName, readServer, written } from "./mcp.ts";

/**
 * What a command may do, which is deliberately less than what the plane can.
 *
 * A command arrives on the control socket and so carries operator trust, but it is still typed into
 * the same box as a message and read by the same eyes. Handing it the whole plane would make every
 * slip of the keyboard reach as far as the plane does.
 */
export interface CommandContext {
	/** What the agent may spend, with the config and the keyboard already reconciled. */
	account(): Promise<{ readonly spentUsd: number; readonly limitUsd: number | undefined }>;
	/** `null` takes the ceiling off, which is not the same as leaving it to the config. */
	setLimit(usd: number | null): Promise<void>;
	/** Every server the plane knows of, and which of them this agent has been given. */
	mcp(): Promise<{ readonly shelf: readonly NamedServer[]; readonly held: readonly NamedServer[] }>;
	/**
	 * Whether this agent may reach a host at all. Asked, never set.
	 *
	 * A grant comes from the operator's file and from nowhere else, so the most a command can do
	 * about a server nothing can reach is to notice and say so. Adding the grant here would put the
	 * whole of an agent's reach one typo away from the box its messages are typed into.
	 */
	granted(host: string): Promise<boolean>;
	addServer(name: string, server: McpServer): Promise<void>;
	attachServer(name: string): Promise<void>;
	detachServer(name: string): Promise<void>;
	forgetServer(name: string): Promise<void>;
}

/**
 * Every command there is, in one list rather than in a paragraph.
 *
 * Written down as data because two things read it: the help, which is prose, and the menu the
 * console opens under a `/`, which needs the name apart from the sentence about it. A command
 * documented in only one of those two places is a command half of its users never find.
 */
export const COMMANDS = [
	{
		name: "/limit",
		takes: "[<amount>|off]",
		does: "what it has spent today, and the ceiling for it",
	},
	{
		name: "/mcp",
		takes: "[<name>|add …]",
		does: "the MCP servers it has, and the shelf to add from",
	},
	{ name: "/help", takes: "", does: "every command there is" },
] as const;

/** Names and the sentences about them, laid out so the sentences line up whatever the names are. */
function laidOut(rows: readonly (readonly [string, string])[]): string {
	const widest = Math.max(...rows.map(([name]) => name.length));
	return rows.map(([name, does]) => `${name.padEnd(widest + 2)}${does}`).join("\n");
}

const HELP = laidOut([
	...COMMANDS.map(
		(command) => [`${command.name} ${command.takes}`.trimEnd(), command.does] as const,
	),
	["!<command>", "run it in this agent's sandbox, and show what it printed"],
]);

/**
 * Whether a line is a command rather than something to say to the agent.
 *
 * A leading slash and nothing else, so a message that happens to start with a path — `/etc/hosts is
 * wrong` — is still a message. The way to say something starting with a slash is to say it, since
 * `/etc` is not a command and is answered as one that does not exist rather than swallowed.
 */
export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

export type Command = (typeof COMMANDS)[number];

/**
 * The commands a half-typed line could still turn out to be.
 *
 * Empty the moment the line has a space in it, which is what says the command has been chosen and
 * what is being typed now is its argument. Without that, a menu offering `/limit` would still be
 * sitting over `/limit 5` and stealing the return that was meant to send it.
 */
export function completions(draft: string): readonly Command[] {
	if (!isCommand(draft) || /\s/.test(draft)) return [];
	return COMMANDS.filter((command) => command.name.startsWith(draft));
}

/**
 * Whether a line is a command to run inside the agent's sandbox rather than anything to do with the
 * agent at all.
 *
 * The same `!` a shell uses, and for the same reason: the question it answers — what does it
 * actually look like in there — is one an operator asks constantly while an agent is working, and
 * the alternative is leaving the console to type `docker exec` at a container whose name you have
 * to remember.
 */
export function isShell(line: string): boolean {
	return line.startsWith("!");
}

/** How long a command typed at a keyboard may run before it is given up on and killed. */
export const SHELL_TIMEOUT_MS = 2 * 60_000;

/**
 * How much of what a command printed is kept.
 *
 * The transcript is rewritten whole on every line, so one `find /` left in it would be paid for by
 * every line said afterwards for the rest of the conversation. What is cut is the middle, because
 * a command's first lines say what it did and its last say how it ended, and the run of identical
 * progress between them is the part nobody reads.
 */
const KEPT_LINES = 200;

/**
 * What a command printed, as text safe to put in a pane.
 *
 * The escape sequences go. Most of what a command prints them for is colour, which is no loss in a
 * conversation, and the rest is cursor movement — and this is the one place where a file the agent
 * wrote gets drawn on the operator's terminal, so a `!cat` of something it authored must not be
 * able to move the cursor around the console reading it.
 */
export function shellOutput(
	result: {
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number;
	},
	/** What to say instead of "(no output)" for a command whose only effect was somewhere else. */
	whenSilent?: string,
): string {
	const printed = clip(plain(`${result.stdout}${result.stderr}`).replace(/\s+$/, ""));
	if (result.exitCode === 0) return printed.length > 0 ? printed : (whenSilent ?? "(no output)");
	// Always said, even under output that explains itself: "exit 1" is the difference between a test
	// run that reported failures and one that crashed before it could.
	const status = `exit ${result.exitCode}`;
	return printed.length > 0 ? `${printed}\n${status}` : status;
}

/**
 * A CSI sequence, a two-character escape, and every control character but the tab and the newline,
 * which are the two a pane can draw. The carriage return goes with them: a pane has no cursor to
 * send back to the margin, so a progress bar that redrew itself arrives as its frames run together
 * rather than as a line that writes over the one beside it.
 */
const CONTROL =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the whole function.
	/\u001b\[[0-9;?]*[\u0020-\u002f]*[\u0040-\u007e]|\u001b[\u0030-\u007e]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

function plain(text: string): string {
	return text.replace(CONTROL, "");
}

function clip(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= KEPT_LINES) return text;
	const head = lines.slice(0, KEPT_LINES / 2);
	const tail = lines.slice(-KEPT_LINES / 2);
	return [...head, `… ${lines.length - KEPT_LINES} more lines`, ...tail].join("\n");
}

/**
 * The line, wrapped so that the next one starts where this one left off.
 *
 * Every `!` is a new `sh`, which is the whole difficulty: a `cd` would move a shell that exits a
 * moment later, and the operator would be back where they started with nothing to show for it. So
 * the shell is told where the last one ended and asked where this one did, and the answer comes back
 * printed after a mark drawn at random, which is what makes it a mark the command cannot print by
 * accident. `$?` is caught first, because asking is a command too and would otherwise be the answer.
 */
export function shellScript(line: string, cwd: string): { script: string; mark: string } {
	const mark = `cwd-${randomBytes(8).toString("hex")}`;
	return {
		mark,
		// Not the exec's working directory, which is refused outright when it no longer exists — a
		// directory the agent deleted under the operator should put them back at its door, not stop
		// them from running anything at all.
		script: [
			`cd ${quoted(cwd)} 2>/dev/null`,
			line,
			"__status=$?",
			`printf '%s\\n%s' ${quoted(mark)} "$PWD"`,
			"exit $__status",
		].join("\n"),
	};
}

/** Splits the directory a shell ended in off what it printed, leaving the mark in neither. */
export function endedIn(printed: string, mark: string): { text: string; cwd: string | undefined } {
	const at = printed.lastIndexOf(mark);
	if (at === -1) return { text: printed, cwd: undefined };
	const cwd = printed.slice(at + mark.length).trim();
	return { text: printed.slice(0, at), cwd: cwd.length > 0 ? cwd : undefined };
}

/** A string `sh` reads as one word, whatever is in it. */
function quoted(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function money(usd: number): string {
	return `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function spentAgainst(account: { spentUsd: number; limitUsd: number | undefined }): string {
	const spent = `${money(account.spentUsd)} spent today`;
	return account.limitUsd === undefined
		? `${spent}, against no limit.`
		: `${spent}, of ${money(account.limitUsd)} a day.`;
}

/** The words `/mcp` reads as instructions, and therefore not names a server may be given. */
const VERBS = ["add", "drop", "forget"];

/** How to add one, which is the answer to "and what do I type", asked in three different ways. */
const ADDING = [
	"/mcp add <name> <url>              a remote server",
	"/mcp add <name> sse <url>          one speaking the older transport",
	"/mcp add <name> <command> [args]   one the agent starts for itself",
].join("\n");

/**
 * Says a server cannot be reached, and what the operator would have to do about it.
 *
 * Not something this can fix. A grant comes from the config file and from nowhere else, and the
 * value of saying it here is that the alternative is finding out from the agent, mid-turn, in the
 * shape of a tool that answers with the proxy's refusal instead of with an answer.
 */
async function unreachable(
	name: string,
	server: McpServer,
	context: CommandContext,
): Promise<string> {
	const host = hostOf(server);
	if (host === undefined || (await context.granted(host))) return "";
	return [
		"",
		"",
		`It cannot be reached yet: nothing grants this agent ${host}. Grants are`,
		"yours to make, not mine — put this under the agent and reload:",
		"",
		`  - id: ${name}`,
		`    host: ${host}`,
		`    injection: { kind: bearer, token: { ref: ${name.toUpperCase().replaceAll("-", "_")}_TOKEN } }`,
		"",
		"or `injection: { kind: none }` if it wants no key of its own.",
	].join("\n");
}

/** Each server as a row: what it is called, what it is, and whether it is reachable at all. */
async function rows(
	servers: readonly NamedServer[],
	context: CommandContext,
): Promise<readonly (readonly [string, string])[]> {
	return Promise.all(
		servers.map(async ({ name, server }) => {
			const host = hostOf(server);
			const reach = host === undefined || (await context.granted(host));
			return [
				`  ${name}`,
				`${written(server)}${reach ? "" : `   (no grant for ${host})`}`,
			] as const;
		}),
	);
}

async function listing(context: CommandContext): Promise<string> {
	const { shelf, held } = await context.mcp();
	if (shelf.length === 0) return `No MCP servers yet.\n\n${ADDING}`;

	const spare = shelf.filter((one) => !held.some((has) => has.name === one.name));
	const said = [
		held.length === 0
			? "This agent has none of them."
			: `This agent has:\n${laidOut(await rows(held, context))}`,
	];
	if (spare.length > 0) {
		said.push(`On the shelf:\n${laidOut(await rows(spare, context))}`);
		said.push(`/mcp ${spare[0]?.name} gives this agent that one.`);
	}
	return said.join("\n\n");
}

/**
 * The servers this agent has, and the ones it could be given.
 *
 * Adding is separate from attaching because finding a server is the expensive part and it only has
 * to happen once: from the second agent on, the whole of it is a name off a list.
 */
async function mcp(words: readonly string[], context: CommandContext): Promise<string> {
	const [verb = "", ...rest] = words;
	const [named = "", ...target] = rest;

	if (verb === "") return listing(context);

	if (verb === "add") {
		if (named === "") return `A server needs a name to be called by.\n\n${ADDING}`;
		// Checked before the name is read, so the answer to `/mcp add add …` is the real problem with
		// it rather than a complaint about characters that were all perfectly fine.
		if (VERBS.includes(named)) return `"${named}" is a word /mcp uses. Call it something else.`;
		const complaint = readName(named);
		if (complaint !== undefined) return complaint;
		const read = readServer(target);
		if ("refused" in read) return read.refused;

		await context.addServer(named, read.server);
		await context.attachServer(named);
		return [
			`"${named}" is on the shelf, and this agent has it.`,
			await unreachable(named, read.server, context),
			`\n\nAny other agent can have it too, with /mcp ${named}.`,
		].join("");
	}

	const { shelf, held } = await context.mcp();

	if (verb === "drop" || verb === "forget") {
		if (named === "")
			return `Which one? ${shelf.map((one) => `/mcp ${verb} ${one.name}`).join(", ")}`;
		if (verb === "drop") {
			if (!held.some((one) => one.name === named)) return `This agent does not have "${named}".`;
			await context.detachServer(named);
			// Said, because the two words do different things and which one was wanted is not obvious
			// from either. Nobody should have to find out by typing the wrong one.
			return `This agent no longer has "${named}". It is still on the shelf: /mcp ${named} gives it back.`;
		}
		if (!shelf.some((one) => one.name === named)) return `There is no server called "${named}".`;
		await context.forgetServer(named);
		return `"${named}" is off the shelf, and off every agent that had it.`;
	}

	// Anything else is a name, which is the short way and the one the second agent uses.
	const found = shelf.find((one) => one.name === verb);
	if (found === undefined) {
		if (shelf.length === 0) return `There is no server called "${verb}".\n\n${ADDING}`;
		return `There is no server called "${verb}". There is: ${shelf.map((one) => one.name).join(", ")}.`;
	}
	if (held.some((one) => one.name === verb)) {
		return `This agent already has "${verb}": ${written(found.server)}`;
	}
	await context.attachServer(verb);
	return `This agent has "${verb}": ${written(found.server)}${await unreachable(verb, found.server, context)}`;
}

/**
 * Runs a command and says what happened, in a sentence meant to be read in the conversation.
 *
 * Every answer is a full sentence rather than an acknowledgement, because this goes where the
 * agent's answers go: "ok" under a line nobody can see any more says nothing at all.
 */
export async function runCommand(line: string, context: CommandContext): Promise<string> {
	const [name = "", ...rest] = line.trim().slice(1).split(/\s+/);
	const argument = rest.join(" ");

	if (name === "help" || name === "") return HELP;

	// The words rather than the argument: a server is a name and then a whole command line, and
	// joining those back into one string only to split them again would lose where each of them ended.
	if (name === "mcp") return mcp(rest, context);

	if (name === "limit") {
		if (argument === "") return spentAgainst(await context.account());
		if (argument === "off" || argument === "none") {
			await context.setLimit(null);
			return `No spending limit. ${spentAgainst(await context.account())}`;
		}
		// A leading dollar sign is what a person types when asked for an amount in dollars, and
		// refusing it would be pedantry about a number that was perfectly clear.
		const amount = Number(argument.replace(/^\$/, ""));
		if (!Number.isFinite(amount) || amount <= 0) {
			return `"${argument}" is not an amount. Try /limit 5, or /limit off.`;
		}
		await context.setLimit(amount);
		return `Spending limit set to ${money(amount)} a day. ${spentAgainst(await context.account())}`;
	}

	return `No command "/${name}". There is:\n${HELP}`;
}
