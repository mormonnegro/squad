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
}

const HELP = [
	"/limit             what this agent has spent today, and against what",
	"/limit <amount>    a ceiling, in US dollars a day",
	"/limit off         no ceiling",
].join("\n");

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

export function money(usd: number): string {
	return `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function spentAgainst(account: { spentUsd: number; limitUsd: number | undefined }): string {
	const spent = `${money(account.spentUsd)} spent today`;
	return account.limitUsd === undefined
		? `${spent}, against no limit.`
		: `${spent}, of ${money(account.limitUsd)} a day.`;
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
