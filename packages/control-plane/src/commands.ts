import { randomBytes } from "node:crypto";
import type { LoginStatus, Reachability } from "@agent-dive/proxy";
import { hostOf, type McpServer, type NamedServer, readName, readServer, written } from "./mcp.ts";
import type { Model, ModelStanding } from "./models.ts";
import { type Served, servedAt, unservable } from "./ports.ts";

/** Where to send the operator, and where the answer is expected back. */
export interface LoginPage {
	readonly url: string;
	readonly redirectUri: string;
}

/** What an agent's Telegram bot is, in the terms a console has to say it in. */
export interface TelegramStanding {
	readonly username: string | undefined;
	/** Whether an account has been bound. Until one is, the bot listens to nobody. */
	readonly paired: boolean;
	/** How many chats it answers in. */
	readonly chats: number;
	/** The link that would pair it, while it is unpaired. */
	readonly link: string | undefined;
}

/**
 * What a command may do, which is deliberately less than what the plane can.
 *
 * A command arrives on the control socket and so carries operator trust, but it is still typed into
 * the same box as a message and read by the same eyes. Handing it the whole plane would make every
 * slip of the keyboard reach as far as the plane does.
 */
export interface CommandContext {
	/** Which agent this was typed at. Every command here is about that one and can be about no other. */
	readonly agent: {
		readonly id: string;
		/** Made at a keyboard rather than declared, which is the only kind a plane may forget. */
		readonly created: boolean;
	};
	/** What the agent may spend, with the config and the keyboard already reconciled. */
	account(): Promise<{ readonly spentUsd: number; readonly limitUsd: number | undefined }>;
	/** `null` takes the ceiling off, which is not the same as leaving it to the config. */
	setLimit(usd: number | null): Promise<void>;
	/**
	 * Every model the operator configured, and the name of the one this agent is on — which may be a
	 * name off no list at all, on a plane whose config names its model the older way.
	 */
	models(): Promise<{
		readonly all: readonly Model[];
		readonly using: string | undefined;
		/** The ones with no key behind them, which are configured and still cannot be thought with. */
		readonly keyless: readonly string[];
	}>;
	/**
	 * Moves this agent onto one of them. A choice among the configured, never a way to add one.
	 *
	 * Allowed for the same reason a ceiling is: every model on that list is one the operator wrote
	 * into their file, keys and all, so the agent could already reach every one of them and this
	 * changes nothing about its reach. What it changes is what the next turn costs and how good it
	 * is, which is a thing to decide while watching the agent answer rather than in a text editor.
	 */
	setModel(id: string): Promise<void>;
	/** Every server the plane knows of, and which of them this agent has been given. */
	mcp(): Promise<{ readonly shelf: readonly NamedServer[]; readonly held: readonly NamedServer[] }>;
	/** The ports this agent has open, and the ones another agent's port had to make way for. */
	served(): Promise<{
		readonly mine: readonly Served[];
		readonly theirs: ReadonlyMap<number, string>;
	}>;
	/**
	 * Opens one of its ports where the operator is, and answers with where that turned out to be.
	 *
	 * Allowed for the reason a model is: it widens nothing. Every other command guarded here is about
	 * what the agent can reach outwards, and this is the opposite direction — a door from the
	 * operator's own machine into the sandbox, opened by the console they are sitting at, reaching
	 * only loopback inside the box. Whoever can ask for this could already run `!` in there.
	 */
	serve(port: number): Promise<Served>;
	/** Closes one. Answers whether there was one to close. */
	unserve(port: number): Promise<boolean>;
	/** Whether anything is listening on that port inside the sandbox, asked of the sandbox. */
	listening(port: number): Promise<boolean>;
	/**
	 * Whether this agent may reach a host at all. Asked, never set.
	 *
	 * A grant comes from the operator's file, or from a login the operator completed in a browser,
	 * and from nowhere else. What a command may not do is write one: that would put the whole of an
	 * agent's reach one typo away from the box its messages are typed into.
	 */
	granted(host: string): Promise<boolean>;
	/**
	 * Takes this agent away: the container, the repository inside it, and the conversation.
	 *
	 * The one destructive thing in here, and the exception that says what the rest of this interface
	 * is for. A grant is refused because a slip of the keyboard would widen an agent's reach without
	 * anyone meaning to; this cannot be reached by a slip, because it does nothing until the agent's
	 * own name has been typed after it. It also reaches no further than the agent it was typed at,
	 * which is what keeps a command from being a way to delete something you were not even looking at.
	 */
	remove(): Promise<void>;
	addServer(name: string, server: McpServer): Promise<void>;
	attachServer(name: string): Promise<void>;
	detachServer(name: string): Promise<void>;
	forgetServer(name: string): Promise<void>;
	/** What the server itself says about being reached, which is the only authority on it. */
	reach(server: McpServer): Promise<Reachability>;
	/** The login the plane holds for a server, if it holds one. Never the token. */
	loginStatus(name: string): Promise<LoginStatus | undefined>;
	/** Starts a login and answers with the page to open. */
	login(name: string, clientId?: string): Promise<LoginPage>;
	/** Finishes one from the address the browser was sent to, pasted back by hand. */
	returned(name: string, redirected: string): Promise<void>;
	logout(name: string): Promise<boolean>;
	/** The bot this agent answers on, if it has one. */
	telegram(): Promise<TelegramStanding | undefined>;
	/** Gives it a bot, checking the token against Telegram before writing it down. */
	connectTelegram(token: string): Promise<TelegramStanding>;
	/** Takes the bot away. Answers whether there was one. */
	disconnectTelegram(): Promise<boolean>;
}

/**
 * A row of the menu the console opens under a `/`: the line it would type, and what that would do.
 *
 * Not only the commands. What a command takes is as unguessable as the command was — a model is a
 * name off a list nobody memorises — so an argument that comes from a list the plane can read is
 * offered here in the same shape, and the menu does not have to know which kind of row it is drawing.
 */
export interface Command {
	/** The whole line, because that is what picking the row puts in the prompt. */
	readonly name: string;
	/** What still has to be typed after it, when anything does. */
	readonly takes: string;
	readonly does: string;
}

/**
 * Every command there is, in one list rather than in a paragraph.
 *
 * Written down as data because two things read it: the help, which is prose, and the menu the
 * console opens under a `/`, which needs the name apart from the sentence about it. A command
 * documented in only one of those two places is a command half of its users never find.
 */
export const COMMANDS: readonly Command[] = [
	{
		name: "/limit",
		takes: "[<amount>|off]",
		does: "what it has spent today, and the ceiling for it",
	},
	{
		name: "/model",
		takes: "[<name>]",
		does: "what it thinks with, and what else there is",
	},
	{
		name: "/mcp",
		takes: "[<name>|add …|login …]",
		does: "the MCP servers it has, and the shelf to add from",
	},
	{
		name: "/serve",
		takes: "[<port>|stop <port>]",
		does: "open a port inside it on the machine you are sitting at",
	},
	{
		name: "/telegram",
		takes: "[<token>|off]",
		does: "the Telegram bot it answers on, and how to pair one",
	},
	{ name: "/delete", takes: "", does: "delete this agent, after asking whether you meant it" },
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

/**
 * The commands a half-typed line could still turn out to be, or the models it could move an agent
 * onto once it has turned out to be `/model`.
 *
 * Otherwise empty the moment the line has a space in it, which is what says the command has been
 * chosen and what is being typed now is its argument. Without that, a menu offering `/limit` would
 * still be sitting over `/limit 5` and stealing the return that was meant to send it.
 */
export function completions(
	draft: string,
	models: readonly ModelStanding[] = [],
	using?: string,
): readonly Command[] {
	if (!isCommand(draft)) return [];
	// The space is the boundary, which also makes it the gesture: taking `/model` off the menu leaves
	// a trailing space behind it, so the same return that chose the command opens the list of models.
	const moving = /^\/model\s+([\s\S]*)$/.exec(draft);
	if (moving !== null) return moves(moving[1] ?? "", models, using);
	if (/\s/.test(draft)) return [];
	return COMMANDS.filter((command) => command.name.startsWith(draft));
}

/**
 * The models a `/model ` could still be about.
 *
 * Every one of these is on the operator's list already, so this offers nothing that could not be
 * typed — which is the point: a name is only unguessable until something shows it to you, and the
 * one place it was shown was two panes away on a screen about keys.
 */
function moves(
	typed: string,
	models: readonly ModelStanding[],
	using: string | undefined,
): readonly Command[] {
	const wanted = typed.trim().toLowerCase();
	// The provider's own name matches too, because half of remembering a model is remembering whose
	// it is: `anthropic` finds the one called `sonnet` without knowing that is what it was called.
	const found = models.filter((model) =>
		`${model.id} ${model.provider} ${model.model}`.toLowerCase().includes(wanted),
	);
	// A name typed in full is the menu agreeing rather than offering, and a menu that agrees is a menu
	// holding on to the return that would have sent the line.
	if (found.some((model) => model.id.toLowerCase() === wanted)) return [];
	return found.map((model) => ({
		name: `/model ${model.id}`,
		takes: "",
		does: `${named(model)}${model.id === using ? "   (this one)" : ""}${
			model.held ? "" : `   (no ${model.keyEnv})`
		}`,
	}));
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

/** A model as the two facts about it that are not its name: whose it is, and what they call it. */
function named(model: Model): string {
	return `${model.provider}/${model.model}`;
}

/** How to configure one, which is the answer to "and what do I type" for the third time. */
const CONFIGURING = [
	"  models:",
	"    - id: sonnet",
	"      provider: anthropic",
	"      model: claude-sonnet-4-6",
	"",
	"The key is read from ANTHROPIC_API_KEY in this plane's own environment. The agent",
	"never holds it: the proxy writes it onto the request on the way out.",
].join("\n");

/**
 * What this agent thinks with, and what else there is to think with.
 *
 * The list is the operator's file read back, never added to. Every model on it is already reachable
 * by every agent — that is what configuring one does — so moving between them changes what a turn
 * costs and how good it is, and changes nothing about what the agent can get to. That is the whole
 * reason this is a command rather than an edit and a restart.
 */
async function models(words: readonly string[], context: CommandContext): Promise<string> {
	const { all, using, keyless } = await context.models();
	const wanted = words.join(" ").trim();
	// Said wherever the model is said, because it is the difference between a model that works and
	// one that reads exactly like it works right up to the turn that dies against it.
	const missing = (model: Model) =>
		keyless.includes(model.id) ? `   (no ${model.keyEnv} in this plane's environment)` : "";

	if (all.length === 0) {
		return [
			using === undefined
				? "This plane configures no models, so its agents think with whatever pi is set up for."
				: `This agent thinks with ${using}, which this plane's config names and grants by hand.`,
			"",
			"There is nothing to move it onto until the models are a list. One is three lines:",
			"",
			CONFIGURING,
		].join("\n");
	}

	if (wanted === "") {
		const other = all.find((model) => model.id !== using);
		return [
			using === undefined
				? "This agent is on none of the configured models. There are:"
				: `This agent thinks with ${using}. There are:`,
			"",
			laidOut(
				all.map(
					(model) =>
						[
							`  ${model.id}`,
							`${named(model)}${model.id === using ? "   (this one)" : ""}${missing(model)}`,
						] as const,
				),
			),
			...(other === undefined
				? []
				: ["", `/model ${other.id} moves it onto that one, from its next turn.`]),
		].join("\n");
	}

	const found = all.find((model) => model.id === wanted);
	if (found === undefined) {
		return `There is no model called "${wanted}". There is: ${all.map((model) => model.id).join(", ")}.`;
	}
	if (found.id === using) {
		return `This agent already thinks with ${found.id}: ${named(found)}.${missing(found)}`;
	}

	await context.setModel(found.id);
	// The turn in flight is said out loud because the change looks instant and is not: a turn already
	// running was handed its model when it started, and the answer arriving afterwards is the old
	// one's — which reads, to whoever just switched, like the switch having done nothing.
	const moved = `This agent thinks with ${found.id} from its next turn: ${named(found)}. A turn already running finishes on the one it started with.`;
	if (!keyless.includes(found.id)) return moved;
	// Done rather than refused: the operator asked for it, and the key can be exported without
	// touching this choice. Saying nothing would leave them watching every turn fail instead.
	return `${moved}\n\nNothing here holds ${found.keyEnv} yet, so turns on it will be refused at the proxy until this plane has it.`;
}

/** Where a served port is reachable from, said once wherever the links are. */
const ONLY_HERE = [
	"A console is what opens these, on the machine it is running on. They are reachable from",
	"there and from nowhere else: nothing is published off the server, and the sandbox network",
	"is still as unrouted as it was.",
].join("\n");

/**
 * What an agent is serving, and where each of it comes out on the operator's own machine.
 *
 * The one command here that opens something rather than describing it, and the direction is what
 * makes it safe to be one: everything else guarded in this file is about what an agent can reach
 * outwards, and this reaches inwards, from the keyboard to the box, over a socket whoever typed it
 * was already holding. What it saves is the alternative — publishing a port off the sandbox, which
 * would need a routable network and would hand the agent back the internet route it exists without.
 */
async function serve(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", ...rest] = words;

	if (first === "" || first === "list") return serving(context);

	if (first === "stop" || first === "close") {
		// Zero rather than a complaint is what `Number("")` answers, and a bare `/serve stop` that read
		// as port 0 would be told it was not serving one, which is true and not what was asked.
		const port = Number((rest[0] ?? "").replace(/^:/, ""));
		if (!Number.isInteger(port) || port <= 0)
			return "Which port? /serve stop 3000 closes that one.";
		if (!(await context.unserve(port))) return `${id} was not serving ${port}.`;
		// Said because the two halves are in different places and only one of them just changed: the
		// server inside the box is the agent's and is still running, and an operator who read this as
		// "stopped" would go looking for a process that is exactly where they left it.
		return `${id} is not serving ${port} any more, so nothing opens it here. Whatever is listening on ${port} inside the sandbox is still listening — this was only the way in to it.`;
	}

	const port = Number(first.replace(/^:/, ""));
	const complaint = unservable(port);
	if (complaint !== undefined) return complaint;

	const { theirs } = await context.served();
	const opened = await context.serve(port);
	const moved =
		opened.at === port
			? ""
			: ` — ${port} is ${theirs.get(port) ?? "another agent"}'s here, so this one is on ${opened.at}.`;

	return [
		`${id} is serving ${port}${moved}`,
		"",
		`  ${servedAt(id, opened)}`,
		"",
		(await context.listening(port))
			? `Something is listening on ${port} in there, so that link has something behind it.`
			: `Nothing is listening on ${port} inside the sandbox yet. The link waits: it starts working the moment something binds that port in there, with nothing to type here.`,
		"",
		ONLY_HERE,
	].join("\n");
}

async function serving(context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const { mine, theirs } = await context.served();
	if (mine.length === 0) {
		return [
			`${id} is serving nothing. /serve 3000 opens a port inside it on the machine you are`,
			"sitting at, whether or not anything is listening on it in there yet.",
			"",
			ONLY_HERE,
		].join("\n");
	}
	return [
		`${id} is serving:`,
		"",
		laidOut(
			mine.map(
				(one) =>
					[
						`  ${one.port}`,
						`${servedAt(id, one)}${one.at === one.port ? "" : `   (${one.port} is ${theirs.get(one.port) ?? "another agent"}'s here)`}`,
					] as const,
			),
		),
		"",
		ONLY_HERE,
		"",
		`/serve stop ${mine[0]?.port} closes one.`,
	].join("\n");
}

/** The words `/mcp` reads as instructions, and therefore not names a server may be given. */
const VERBS = ["add", "drop", "forget", "login", "logout"];

/** How to add one, which is the answer to "and what do I type", asked in three different ways. */
const ADDING = [
	"/mcp add <name> <url>              a remote server",
	"/mcp add <name> sse <url>          one speaking the older transport",
	"/mcp add <name> <command> [args]   one the agent starts for itself",
].join("\n");

/**
 * Says what stands between a server and the agent, in the words of whatever is standing there.
 *
 * Three different problems used to be one message. A server that wants an account is not a server
 * missing a line of YAML, and telling an operator to invent a bearer token for something that was
 * about to offer them a consent screen is how they end up in a developer portal for an hour. So the
 * server is asked, and its own refusal decides which sentence this is.
 */
async function whatNext(name: string, server: McpServer, context: CommandContext): Promise<string> {
	const host = hostOf(server);
	if (host === undefined) return "";
	if ((await context.loginStatus(name)) !== undefined) return "";
	if (await context.granted(host)) return "";

	const said = await context.reach(server);
	if (said.kind === "authorize") {
		return `\n\nIt wants an account first: /mcp login ${name}`;
	}
	if (said.kind === "unreachable") {
		return `\n\nThe plane cannot reach ${host} either: ${said.why}`;
	}
	return [
		"",
		"",
		`It cannot be reached yet: nothing grants this agent ${host}, and it asks`,
		"for no account. A grant is yours to make — put this under the agent and reload:",
		"",
		`  - id: ${name}`,
		`    host: ${host}`,
		"    injection: { kind: none }",
	].join("\n");
}

/** Each server as a row: what it is called, what it is, and whether it is reachable at all. */
async function rows(
	servers: readonly NamedServer[],
	context: CommandContext,
): Promise<readonly (readonly [string, string])[]> {
	return Promise.all(
		servers.map(async ({ name, server }) => {
			return [`  ${name}`, `${written(server)}${await note(name, server, context)}`] as const;
		}),
	);
}

/**
 * The one thing worth saying about a server in a list of them.
 *
 * A login is said before a grant because it is the stronger fact: it implies the grant, it is the
 * thing that expires, and it is the only one of the two that the operator can do something about
 * from here.
 */
async function note(name: string, server: McpServer, context: CommandContext): Promise<string> {
	const host = hostOf(server);
	if (host === undefined) return "";
	if ((await context.loginStatus(name)) !== undefined) return "   (logged in)";
	return (await context.granted(host)) ? "" : "   (no grant)";
}

/**
 * Sends the operator to a consent screen, or finishes the trip back from one.
 *
 * One word for both halves because it is one thing to the person doing it. The second argument is
 * whatever they have in hand: nothing, an address bar they had to carry across machines, or the id
 * of a client they registered themselves at a server that would not do it for them — and which of
 * those it is is legible from the thing itself.
 */
async function logIn(
	name: string,
	host: string,
	held: string,
	context: CommandContext,
): Promise<string> {
	try {
		if (/^https?:\/\//i.test(held)) {
			await context.returned(name, held);
			return `Logged in to ${host}. This agent can reach "${name}" now.`;
		}
		const page = await context.login(name, held === "" ? undefined : held);
		return [
			`Log in to ${host} here — opened already, if this console is somewhere with a browser:`,
			"",
			`  ${page.url}`,
			"",
			`Waiting at ${page.redirectUri}. If that page cannot reach the plane, paste`,
			`the address it lands on back as: /mcp login ${name} <address>`,
		].join("\n");
	} catch (error) {
		// Answered rather than thrown: a login that could not start is news about the server, and it
		// belongs in the conversation next to the command that asked for it.
		return (error as Error).message;
	}
}

async function logOut(name: string, host: string, context: CommandContext): Promise<string> {
	if (!(await context.logout(name))) return `"${name}" was not logged in to ${host}.`;
	return `Logged out of ${host}. The token is gone, and so is the reach it carried.`;
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
			await whatNext(named, read.server, context),
			`\n\nAny other agent can have it too, with /mcp ${named}.`,
		].join("");
	}

	const { shelf, held } = await context.mcp();

	if (verb === "login" || verb === "logout") {
		if (named === "") {
			const names = shelf.map((one) => one.name);
			return names.length === 0
				? `There is nothing to log ${verb === "login" ? "in" : "out"} of yet.\n\n${ADDING}`
				: `Which one? ${names.map((one) => `/mcp ${verb} ${one}`).join(", ")}`;
		}
		const found = shelf.find((one) => one.name === named);
		if (found === undefined) return `There is no server called "${named}".`;
		const host = hostOf(found.server);
		if (host === undefined) {
			return `"${named}" is a command this agent runs, not a place with an account.`;
		}
		return verb === "login"
			? logIn(named, host, target[0] ?? "", context)
			: logOut(named, host, context);
	}

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
	return `This agent has "${verb}": ${written(found.server)}${await whatNext(verb, found.server, context)}`;
}

/** BotFather's shape: the bot's own id, a colon, and the half that is the secret. */
const BOT_TOKEN = /\b(\d{6,})(:[\w-]{20,})\b/;

const NEW_BOT = [
	"Talk to @BotFather on Telegram, send it /newbot, and paste back what it gives you:",
	"/telegram 8123456:AAH…",
].join("\n");

/**
 * A command line as it should be written down, with the secret in it spent rather than kept.
 *
 * The conversation is where a command and its answer are read, which means it is also a pane on a
 * screen and a file that outlives the moment. A bot token is the whole account — anyone holding it
 * can read every message the agent is sent and answer as it — and there is no reason for it to be
 * legible in either place. The bot's own id is public, so what is left still says which bot it was.
 */
export function withoutSecrets(line: string): string {
	return line.replace(BOT_TOKEN, (_whole, id: string) => `${id}:…`);
}

function pairing(id: string, standing: TelegramStanding): string {
	if (standing.link === undefined) {
		// getMe answered without a username, which a bot can be left in by BotFather. Nothing can build
		// a link without one, and saying so beats a link that goes nowhere.
		return `Nobody is paired to it yet, and it has no @name for a link to use. Give it one in @BotFather, then reconnect it.`;
	}
	return [
		"Nobody is paired to it yet. Open this and press Start, and it is yours:",
		standing.link,
		"",
		`Whoever does that is the one ${id} takes instructions from. Anyone else who writes to it is`,
		"heard, and what they write arrives as something to consider rather than something to do.",
	].join("\n");
}

function standing(id: string, said: TelegramStanding): string {
	const name = said.username === undefined ? "The bot" : `@${said.username}`;
	if (!said.paired) return `${name} is ${id}'s bot.\n\n${pairing(id, said)}`;

	const where =
		said.chats === 1 ? "the chat you paired in" : `${said.chats} chats it has been spoken to in`;
	return [
		`${name} is ${id}'s bot, paired to you, answering in ${where}.`,
		`Write to it and ${id} takes a turn.`,
		"",
		"/telegram off puts it down.",
	].join("\n");
}

/**
 * The bot an agent answers on, and the two things there are to do about it.
 *
 * Pairing is deliberately not something typed here. Binding the operator to an account has to happen
 * on the side that can prove which account it is, so the console's half is a link and Telegram's half
 * is whoever taps it — and nobody has to find out their own numeric user id to be recognised.
 */
async function telegram(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", ...rest] = words;

	if (first === "") {
		const said = await context.telegram();
		return said === undefined ? `${id} has no Telegram bot.\n\n${NEW_BOT}` : standing(id, said);
	}

	if (first === "off" || first === "stop") {
		const had = await context.disconnectTelegram();
		return had
			? `${id} no longer has a bot. The token is still yours at @BotFather, and /telegram takes it back.`
			: `${id} had no bot to put down.`;
	}

	if (rest.length > 0) return "A token is one word. Paste only the line @BotFather gave you.";
	if (!BOT_TOKEN.test(first)) return `That is not a bot token.\n\n${NEW_BOT}`;

	const before = await context.telegram();
	let said: TelegramStanding;
	try {
		said = await context.connectTelegram(first);
	} catch (error) {
		// Telegram's own words. "Unauthorized" is a token that was revoked or mistyped and "Not Found" is
		// one that never existed, and which of the two it is decides whether to go back to @BotFather.
		return `Telegram would not take that token: ${(error as Error).message}`;
	}

	const replaced =
		before === undefined
			? []
			: [
					"",
					`That replaces ${before.username === undefined ? "the bot it had" : `@${before.username}`}, which ${id} no longer answers on. Pairing starts again: the`,
					"account paired to the old one has no hold on this one.",
				];
	return [`@${said.username} is ${id}'s bot.`, ...replaced, "", pairing(id, said)].join("\n");
}

/**
 * Deletes the agent, once its own name has come back with the command.
 *
 * There is one kind of delete here and it is the whole one: the container and the repository
 * inside it, everything the agent wrote, remembered and made for itself. A delete that leaves the
 * agent in the list is not what the word means at a console, and an operator who typed it and saw
 * the name still sitting there has been told the thing failed.
 *
 * `/delete` alone is the question and destroys nothing. What answers it is the agent's own name,
 * which can only ever be this agent's, because a command reaches no further than the conversation
 * it was typed in. That is the plane's half. Whoever is driving decides how the question gets put
 * to a person — at the console it is a key — and this says only what the delete would cost, so
 * that the two halves cannot contradict each other about which key to press.
 */
async function remove(words: readonly string[], context: CommandContext): Promise<string> {
	const { id, created } = context.agent;
	const [typed = "", ...rest] = words;
	// Said before the name is checked, because the whole of the answer to a bare `/delete` is what
	// the delete would do — and that is also the answer to a `/delete` typed to find out.
	if (typed === "") {
		return [
			`Deleting ${id} stops its container and throws it away, along with the repository inside`,
			"it: everything it wrote, remembered and made for itself. There is no copy of that anywhere",
			"and nothing here can put it back.",
			"",
			"Nothing has been deleted yet.",
		].join("\n");
	}
	if (typed !== id) {
		return `"${typed}" is not this agent. /delete takes ${id}'s own name back as the confirmation: /delete ${id}`;
	}
	const unknown = rest[0];
	if (unknown !== undefined)
		return `"${unknown}" is not something /delete takes. Only the name is.`;

	await context.remove();
	// Both are gone and stay gone. The difference is only where the name was written down, and it is
	// worth a line because it is the one thing left to do about this agent: a declared name is still
	// in the operator's file, so the delete is remembered against it until that line comes out.
	return created
		? `Deleted ${id}, and its repository with it. Nothing anywhere knew that name but this plane, so that was the last of it.`
		: `Deleted ${id}, and its repository with it. The config still declares it and this cannot write that file, so the deletion is what got written down: ${id} stays gone across restarts. Take it out of the config when you get the chance.`;
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
	if (name === "model") return models(rest, context);
	if (name === "serve") return serve(rest, context);
	if (name === "telegram") return telegram(rest, context);
	if (name === "delete") return remove(rest, context);

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

/** What an agent is asking about itself, so the answer can be about the ceiling it actually has. */
export interface AgentAsking {
	readonly agentId: string;
	readonly limitUsd: number | undefined;
}

/**
 * Why an agent may not ask for a command itself, when it may not.
 *
 * An agent can ask for these because the alternative is worse than it looks: an agent that needs one
 * MCP server writes a paragraph asking for it, and then sits there until somebody reads the
 * paragraph and types the line — which is a day, or a week, or never. So the ones that change
 * nothing about its reach it may ask for, and they run.
 *
 * The line between the two is not "destructive": it is whether an agent that has been talked into
 * this by something in its own context could get anywhere by it. A webhook body arrives fenced as
 * data and is never operator trust, but an agent reading it is still an agent that can be argued
 * with — so nothing here may widen what it can reach or what it can spend. Connecting a server
 * widens nothing, which is the whole point of a shelf that grants nothing; a login widens exactly as
 * much as a person at a consent screen decides it does, with the host name in front of them. Serving
 * a port is the same test read the other way round: it opens a way in rather than a way out, from a
 * console whose operator could already have run anything they liked inside that sandbox.
 *
 * A refusal is not a dead end, which is the other half of why this is a list and not a ban. It
 * prints the line the operator would type, in their console, under the reason the agent wanted it —
 * so the operator does the one thing only they can do, without having to know the command existed.
 */
export function agentMayNot(line: string, asking: AgentAsking): string | undefined {
	const [name = "", ...rest] = line.trim().slice(1).split(/\s+/);

	if (name === "delete") {
		return `This agent asked to delete itself, and that one stays with you: /delete ${asking.agentId} takes it and its repository, and nothing else does.`;
	}

	if (name === "limit") {
		const argument = rest.join(" ");
		if (argument === "off" || argument === "none") {
			return "This agent asked to have its spending ceiling taken off. Nothing it can ask for leaves it able to spend without one: /limit off, if you meant it.";
		}
		const amount = Number(argument.replace(/^\$/, ""));
		if (argument === "" || !Number.isFinite(amount) || amount <= 0) return undefined;
		// Setting one where there is none is not a raise, it is the first ceiling there has been, and
		// an agent that wants to be held to something tighter than nothing is asking for less.
		if (asking.limitUsd === undefined || amount <= asking.limitUsd) return undefined;
		return `This agent asked for a ceiling of ${money(amount)} a day, which is above the ${money(asking.limitUsd)} it has. It can ask to be held to less, never to more: /limit ${money(amount)}, if you meant it.`;
	}

	if (name === "telegram") {
		// Deliberately without the line it asked for, unlike every other refusal here. This is the one
		// where printing it would be the attack: a token the agent was handed by something it read,
		// pasted by an operator who was only being helpful, is a stranger's bot wired to somebody else's
		// agent — and the first person to tap the pairing link is the one it takes instructions from.
		return "This agent asked about its Telegram bot. That one stays with you: /telegram decides who may instruct it, and nothing an agent can ask for may move that.";
	}

	if (name === "mcp") {
		const [verb = "", named = "", ...target] = rest;
		if (verb === "forget") {
			return `This agent asked to take "${named}" off the shelf, which takes it off every agent that has it and not only this one: /mcp forget ${named}, if you meant it.`;
		}
		if (verb === "logout") {
			return `This agent asked to log out of "${named}". The account is one you opened in a browser and it is yours to close: /mcp logout ${named}.`;
		}
		// The half of a login that carries an address is the operator walking back from a consent
		// screen. An agent holding one has not been to a consent screen; it has an address it got
		// somewhere, and finishing a login with it is the one way this could end in a token.
		if (verb === "login" && /^https?:\/\//i.test(target[0] ?? "")) {
			return `This agent asked to finish a login with an address of its own. The trip back from a consent screen is yours to make: /mcp login ${named} <address>.`;
		}
	}

	return undefined;
}
