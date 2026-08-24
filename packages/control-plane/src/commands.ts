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
	"!<command>         run it in this agent's sandbox, and show what it printed",
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
export function shellOutput(result: {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}): string {
	const printed = clip(plain(`${result.stdout}${result.stderr}`).replace(/\s+$/, ""));
	if (result.exitCode === 0) return printed.length > 0 ? printed : "(no output)";
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
