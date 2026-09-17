import { randomBytes } from "node:crypto";
import { isSigner, SIGNER_SAID, SIGNERS, type Signer } from "@squad/channels";
import type { LoginStatus, Reachability } from "@squad/proxy";
import { GATES, type Gate, gateSaid, isGate } from "./gates.ts";
import { readHost } from "./grants.ts";
import { hostOf, type McpServer, type NamedServer, readName, readServer, written } from "./mcp.ts";
import type { Model, ModelStanding } from "./models.ts";
import type { PointingOffer, PointingStanding } from "./pointing.ts";
import { type Served, servedPath, unservable } from "./ports.ts";
import {
	looksLikeGithubToken,
	type RepoHold,
	type RepoSpec,
	type RepoStanding,
	readPush,
	readRepo,
} from "./repos.ts";
import type { ScreenStanding } from "./screens.ts";
import type { Skill } from "./skills.ts";
import type { Teammate } from "./team.ts";
import type { Trigger } from "./triggers.ts";
import { perLookUsd, type VisionOffer, type VisionSpec, type VisionStanding } from "./vision.ts";

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
	/**
	 * The phrase the link carries, while it is unpaired.
	 *
	 * Given on its own as well as inside the link because the link is not always enough: Telegram Web
	 * does not reliably hand the `?start=` payload to the bot, and a person there presses the link,
	 * lands in an empty chat and has nothing to type. The phrase in any message does the same work.
	 */
	readonly phrase: string | undefined;
}

/**
 * The plane's mailbox as one agent sees it, which is one mailbox seen from one of its addresses.
 *
 * Connected once for the whole plane rather than once per agent: plus-addressing already separates
 * them, so `you+scout@` and `you+clerk@` are one account to the provider and two agents here. An
 * operator does this once and every agent it ever has, including the ones made tomorrow, has an
 * address without anybody going back to a settings page.
 */
export interface EmailStanding {
	/** The account being read. Every agent's address is a tag on this one. */
	readonly mailbox: string;
	/** Where this particular agent is reached. */
	readonly address: string;
	readonly host: string;
	readonly port: number;
	/** Whether the host was told to us or guessed at, so an answer can admit which. */
	readonly guessed: boolean;
	/** Whether the agent can answer, or whether this is a mailbox it can only be written to at. */
	readonly writes: boolean;
	/** What the submission server said when it refused, on a mailbox that cannot be written from. */
	readonly mute: string | undefined;
	/** The agent that mail arriving with no tag on it goes to. */
	readonly fallback: string;
	/** Addresses whose mail is read as instructions. Empty until somebody pairs. */
	readonly operators: readonly string[];
	/** The phrase that binds the first of them, while there are none. */
	readonly phrase: string | undefined;
	/** What went wrong the last time the plane tried to read, if something did. */
	readonly trouble: string | undefined;
}

/** What was found out about an address before a password for it has been asked for. */
export interface EmailOffer {
	readonly address: string;
	readonly host: string;
	readonly port: number;
	/** How the host was worked out, so an answer can admit to a guess rather than state it. */
	readonly found: string;
	/** The exact page where this provider makes app passwords, when it is one we know. */
	readonly appPasswords: string | undefined;
	/** Why this provider will refuse any password at all, when it will. */
	readonly closed: string | undefined;
	/** Whether what was discovered points at a bridge on somebody's desktop rather than a server. */
	readonly bridge: boolean;
	/** Where this account hands mail in to be sent, when the provider says. Absent means read-only. */
	readonly outgoing?: { readonly host: string; readonly port: number };
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
	/** Where this agent's browser stands: whether it is meant to have one, and whether it has. */
	screen(): Promise<ScreenStanding>;
	/**
	 * Gives this agent a browser, or takes it away. `null` hands the decision back to the file.
	 *
	 * Allowed here for the reason serving a port is, and with the same direction: it opens nothing
	 * outwards. The browser reaches exactly the hosts the agent already reaches, under the agent's own
	 * egress credential, because it is handed the agent's own — so a screen widens what an agent can
	 * do with its grants and not what its grants are.
	 */
	setScreen(on: boolean | null): Promise<ScreenStanding>;
	/**
	 * Opens a site this agent's browser may sign into out of the operator's vault.
	 *
	 * The one thing guarded in this file that hands an agent a credential, and it is a command
	 * because of when it is wanted: in front of an agent that has just stopped at a login. What it
	 * opens is narrow on purpose — one host, for one agent, out of a vault the operator chose what
	 * to put in — and the agent never sees what is filled in, so this is the use of an account
	 * rather than the account. An agent asking for it is turned away one file over.
	 */
	openSignIn(host: string): Promise<string>;
	/** Closes one. Answers whether there was one to close. */
	closeSignIn(host: string): Promise<boolean>;
	/**
	 * Which model looks at pictures for this plane, and every model that could.
	 *
	 * Plane-wide rather than per-agent, on the search provider's terms: which model does a job, what
	 * it drives and what it costs are the operator's to decide once, and a per-agent version of this
	 * would be four screens to keep in step for one question nobody asks twice.
	 */
	vision(): Promise<{
		readonly using: VisionStanding | undefined;
		readonly offers: readonly VisionOffer[];
	}>;
	/** Chooses one, or `null` to leave looking to whatever the agent itself thinks with. */
	chooseVision(spec: VisionSpec | null): Promise<void>;
	/**
	 * Which model points at things on a page for this plane, and every model that could.
	 *
	 * Beside the other two because it is the same kind of decision: a job an agent's own model does
	 * badly or dearly, done somewhere else by one the operator picks once.
	 */
	pointing(): Promise<{
		readonly using: PointingStanding | undefined;
		readonly offers: readonly PointingOffer[];
	}>;

	/** The hosts this plane pipes rather than reads, which is the plane's list and not an agent's. */
	piped(): Promise<readonly string[]>;
	/** Opens a host and pipes it, or stops piping one. Answers whether anything changed. */
	pipe(host: string, on: boolean): Promise<boolean>;
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
	 * Puts a host in front of the operator as a question, and opens nothing.
	 *
	 * The way out of the rule above without breaking it. An agent that hits a host it may not reach
	 * has no move except describing the problem to somebody who then has to go and find the screen
	 * that fixes it, and a request answered a day later is a request that may as well have been
	 * refused. What this writes down is a question, which widens nothing on its own: the reach is
	 * opened by a key pressed on a modal with the host name in it, and by nothing else.
	 */
	askReach(host: string): Promise<void>;
	/** The repositories this agent holds, from the operator's file and from here. */
	repos(): Promise<readonly RepoStanding[]>;
	/** The other agents on this plane, and which of them this one may write to. */
	team(): Promise<readonly Teammate[]>;
	/** What outside this plane gives this agent a turn. */
	triggers(): Promise<readonly Trigger[]>;
	/** Makes one, and answers with it — including the secret, which is shown this once. */
	addTrigger(name: string, from: Signer, only: readonly string[], says?: string): Promise<Trigger>;
	/** Says what arrives at one. False when there is no trigger of that name. */
	describeTrigger(name: string, says: string): Promise<boolean>;
	/** Takes one down. False when there was none of that name. */
	dropTrigger(name: string): Promise<boolean>;
	/** What this agent has written down that it knows how to do. */
	skills(): Promise<readonly Skill[]>;
	/** Asks it to write what it has just been doing down as a skill, under this name. */
	keepSkill(name: string, about: string): Promise<void>;
	/** Copies one of its skills into another agent on this plane. */
	giveSkill(name: string, to: string): Promise<void>;
	/** What this agent must be shown for before it goes out in the operator's name. */
	gates(): Promise<readonly Gate[]>;
	/** Holds one of those, or lets it go again. Answers whether anything changed. */
	setGate(gate: Gate, hold: boolean): Promise<boolean>;
	/**
	 * Lets this agent write to another one. One-way: what is typed at planner is planner's to send.
	 *
	 * Refused to the agent itself for the reason a grant is. A message wakes another agent and spends
	 * that agent's ceiling, so an agent that could name its own correspondents could spend a whole
	 * plane's day without anyone deciding it should.
	 */
	holdTeam(to: string): Promise<void>;
	/** Closes one opened here. Answers whether there was one to close. */
	dropTeam(to: string): Promise<boolean>;
	/**
	 * Gives this agent a repository, after asking GitHub whether the plane's token can see it.
	 *
	 * The one command here that spends a credential, and it is allowed to because of what it cannot
	 * do: the token is the plane's, pasted once by the operator, and what this decides is only what it
	 * is spent on — which repository, and which branches. Answers that the token is missing rather
	 * than throwing, because a missing token is the ordinary first time and the next line is where it
	 * gets pasted.
	 */
	holdRepo(spec: RepoSpec): Promise<RepoHold>;
	/** Keeps a GitHub token typed here, and finishes the repository that was waiting on one, if one was. */
	keepGithubToken(token: string): Promise<RepoHold | undefined>;
	/** Takes a repository back. Answers whether this agent held it here rather than in the file. */
	dropRepo(repo: string): Promise<boolean>;
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
	/**
	 * Throws away the conversation without touching the agent, and says what that came to.
	 *
	 * The other half of `remove`, and the reason both are here: an agent that has talked itself into a
	 * corner is usually not an agent worth deleting, and before this the only way out of the corner
	 * was taking the repository with it.
	 */
	clear(): Promise<{ stopped: boolean; remembered: boolean }>;
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
	/** The plane's mailbox, seen from this agent's address in it. */
	email(): Promise<EmailStanding | undefined>;
	/**
	 * Works out where an address's mail lives and what it will take, without connecting anything.
	 *
	 * Its own step because the answer decides what to say next, and two of the three answers are
	 * reasons not to go on: a provider that stopped taking passwords, or one whose mail is only
	 * reachable through a bridge on a desktop this plane is not sitting at.
	 */
	offerEmail(address: string): Promise<EmailOffer>;
	/**
	 * Finishes it with the password, against the address already offered.
	 *
	 * The address is not passed back. It was typed one line ago and asking for it again is asking
	 * somebody to retype something the console is already holding.
	 */
	connectEmail(password: string): Promise<EmailStanding>;
	/** Puts the mailbox down, for the whole plane. Answers whether there was one. */
	disconnectEmail(): Promise<boolean>;
	/**
	 * Lets somebody else instruct the agents by mail. Answers with the entry as it was written down.
	 *
	 * What was typed is not what is kept: a bare domain is a whole domain, and the plane says so by
	 * handing back `*@company.com`. It refuses a line that is neither, and a wildcard over a provider
	 * anybody can sign up with, by throwing — because both are said to whoever typed them.
	 */
	allowSender(typed: string): Promise<string>;
	/** Stops reading one entry's mail. Answers whether it was on the list. */
	denySender(entry: string): Promise<boolean>;
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
 * The parts of this plane the config screen is divided into, in the order it walks them.
 *
 * Here rather than only on the screen because the command that opens it has to say what it takes,
 * and a menu row offering an argument the screen has since renamed is worse than offering none.
 */
export const CONFIG_SECTIONS = ["models", "search", "grants", "plugins", "email"] as const;

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
		name: "/screen",
		takes: "[on|off|auto|login <host>]",
		does: "give it a browser of its own, and open the live view of it here",
	},
	{
		name: "/pipe",
		takes: "[<host>|off <host>]",
		does: "sites read end to end by the browser, rather than opened and read here",
	},
	{
		name: "/vision",
		takes: "[<provider> [<model>]|off]",
		does: "which model looks at a screenshot for the agents, and what a look costs",
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
		name: "/trigger",
		takes: "[new|<name> says …|drop <name>]",
		does: "what outside this plane gives it a turn, and the address each one is posted to",
	},
	{
		name: "/skills",
		takes: "[save <name> [<what for>]|give <name> <agent>]",
		does: "what it has learned how to do, and how to keep or pass one on",
	},
	{
		name: "/ask",
		takes: "[mail|telegram [off]]",
		does: "what it has to show you before it sends it in your name",
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
	// The one row here that is not about the agent whose prompt it was typed at, which is why the
	// sentence says whose it is before it says what is on it.
	{
		name: "/config",
		takes: `[${CONFIG_SECTIONS.join("|")}]`,
		does: "the whole plane's screen: its keys, models, reach and mailbox",
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

/**
 * What a half-typed path inside a sandbox could still become, listed from inside it.
 *
 * Node rather than a shell, and the word handed over as an argument rather than written into a
 * line, because the names being completed are names the agent chose: a directory called
 * `; rm -rf ~` has to stay a directory. Reading a listing is the whole of what this does, which is
 * the other half of the same rule — a tab is not a thing anybody expects to have effects.
 */
export const COMPLETE_SCRIPT = [
	'const { readdirSync } = require("node:fs");',
	'const { resolve } = require("node:path");',
	'const [, cwd = "/", typed = ""] = process.argv;',
	// `~` belongs to the shell rather than to the filesystem, so it is spelled out here or the path
	// resolves to a directory with that literal name, which is nobody's.
	'const home = process.env.HOME ?? "/home/agent";',
	'const word = typed === "~" ? home : typed.startsWith("~/") ? home + typed.slice(1) : typed;',
	// Up to the last slash is the directory to list; what follows is how much of a name in it is typed.
	'const cut = word.lastIndexOf("/") + 1;',
	"const dir = word.slice(0, cut);",
	"const partial = word.slice(cut);",
	"let entries = [];",
	"try {",
	'\tentries = readdirSync(resolve(cwd, dir === "" ? "." : dir), { withFileTypes: true });',
	"} catch {",
	// A directory that is not there is not an error worth a row in anything: it is a word that
	// completes to nothing, which is what an empty answer already says.
	"\tprocess.exit(0);",
	"}",
	"const found = entries",
	"\t.filter((entry) => entry.name.startsWith(partial))",
	// A dotfile once a dot has been typed and not before, which is what every shell does.
	'\t.filter((entry) => partial.startsWith(".") || !entry.name.startsWith("."))',
	'\t.map((entry) => dir + entry.name + (entry.isDirectory() ? "/" : ""))',
	"\t.sort()",
	// Enough to choose from and never enough to be a wall: no list this long was going to be read,
	// and the way out of one is to type another letter.
	"\t.slice(0, 200);",
	'process.stdout.write(found.join("\\n"));',
].join("\n");

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

/**
 * Where a served port is reachable from, said once wherever the link is.
 *
 * One link, because the answer is read in two places and only one sentence is true in both. The
 * path hangs off whatever address the console is being read at, which is an address that can be
 * reached by definition — you are reading it through that address — and whichever console reads it
 * draws the link it means: the browser's turns it into a name of that port's own, and a console in
 * a terminal names the port it bound itself, in its own feed, at the moment it binds it.
 *
 * What used to be here was both addresses every time, and the second of them — a port on the
 * machine a terminal console happens to be running on — is a real link while one is running and
 * nothing at all the rest of the time. Printed into a conversation, it is a link that is wrong more
 * often than it is right, sitting under one that is always right.
 *
 * Nothing is published off the server either way. The sandbox network is as unrouted as it was and
 * every road runs through the plane, which is the thing that was already let in.
 */
const ONLY_HERE = [
	"The link hangs off whatever address the console is being read at, so it works from wherever",
	"the console does, and it opens at a name of that port's own. Pass it on as it is written, from",
	"the slash: which address the console is read at cannot be known from in here, and a link",
	"completed with a guess works only where the guess was right. Nothing is published off the",
	"server.",
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
		// On its own line and against the margin. It used to be indented, which set two addresses off
		// from the prose around them; one link drawn as the address it opens needs no setting off, and
		// what the indent looks like on a screen is a gap in front of the link.
		servedPath(id, port),
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
			`${id} is serving nothing. /serve 3000 opens a port inside it — on this console's own`,
			"address, whether or not anything is listening on it in there yet.",
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
						`${servedPath(id, one.port)}${one.at === one.port ? "" : `   (${one.port} is ${theirs.get(one.port) ?? "another agent"}'s on the machine a terminal console is on, so this one is opened there on ${one.at})`}`,
					] as const,
			),
		),
		"",
		ONLY_HERE,
		"",
		`/serve stop ${mine[0]?.port} closes one.`,
	].join("\n");
}

/**
 * What a screen is, said once, wherever the answer needs it said.
 *
 * Every sentence in here is one somebody would otherwise find out the hard way: that the browser is
 * not in the sandbox, that it stays signed in, that the operator can take it, and that it costs
 * something to leave running. An operator deciding whether to turn this on is deciding about a
 * container and a session of their own, and both of those are things to say out loud.
 */
const WHAT_A_SCREEN_IS = [
	"A screen is a browser in a container of its own, beside the sandbox and not inside it. The",
	"agent drives it through a short list of verbs — open a page, read it, click a numbered thing,",
	"type, look — and has no other way in: the profile, with every cookie in it, is mounted where",
	"the agent has no filesystem at all.",
	"",
	"It stays signed in. Anything you log it into, it is still logged into next week, through",
	"restarts and rebuilds, until you sign it out or delete the agent with its profile.",
	"",
	"It reaches what the agent reaches. The browser carries the agent's own egress credential, so",
	"the proxy holds it to the same grants and the same bill.",
].join("\n");

/**
 * What to say when the browser is there and the agent cannot drive it.
 *
 * The two halves of a screen ship in two images, and on most installs one of them is pulled: a
 * plane built from today's sources can make the browser before the sandbox image that knows what to
 * do with it exists. Nothing about this is visible from either end — the live view works and the
 * agent simply never mentions a browser — so it is said here, with the thing to do about it.
 */
const NO_TOOLS = [
	"The agent cannot drive it yet. The browser is this plane's to build, but the tools that drive it",
	"ship in the sandbox image, and this agent is running one from before they existed. You can use",
	"the screen yourself in the meantime — the live view is a whole browser.",
	"",
	"It fixes itself on the next update that brings a newer sandbox image: the plane replaces a",
	"container whose image has moved, and the agent has the tools on its next turn.",
].join("\n");

/**
 * What signing in out of a vault is, for the operator about to allow one.
 *
 * Three facts, and each is one somebody would otherwise find out the wrong way round: the password
 * is never in the sandbox, the agent never learns it, and what it may sign into is this list and
 * nothing else. The vault is the operator's own and what is in it is their decision — this only
 * says which of it an agent may ask to have typed for it.
 */
const WHAT_SIGNING_IN_IS = [
	"The password is read inside the browser's own container, by the 1Password CLI, using a token",
	"this plane holds and the sandbox has no path to — and what crosses into the page is keystrokes.",
	"The agent names a site and gets back a sentence about the boxes on the page: it never sees the",
	"password, not in the answer and not in a reading of the page afterwards.",
	"",
	"It can only ask for sites on this list. Everything else is refused at the browser's door, and",
	"the list is not something the agent can read or add to.",
].join("\n");

/** Said wherever the link is, because the keyboard is the half of this that is not obvious. */
const THE_KEYBOARD = [
	"On that page there is a button that takes the keyboard. While you hold it the agent cannot",
	"touch the page — it can still read it, so it sees whatever you leave on the screen — and it",
	"comes back to the agent when you give it back, or a minute and a half after you walk away.",
	"That is how you sign it in: take the keyboard, log in as yourself, give it back.",
].join("\n");

/**
 * The browser an agent has, and the window onto it.
 *
 * The one command here that makes a container. It is allowed for the same reason `/serve` is — it
 * opens nothing outwards, and the thing it creates can reach only what the agent could already
 * reach — and it is spelled out at more length than the others because it is the only one whose
 * consequence is a place an operator's own logged-in session lives.
 */
async function screen(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [said = ""] = words;

	if (said === "on" || said === "yes") {
		const standing = await context.setScreen(true);
		return [
			standing.running
				? `${id} has a screen.`
				: standing.building === true
					? `${id} has a screen, and this machine is building the browser image for it. That is Chromium, so it takes a few minutes the first time and happens once — the screen comes up on its own when it lands, with nothing to type here.`
					: `${id} has a screen. It is starting — a browser takes a few seconds to come up, longer the first time.`,
			"",
			...(standing.at === undefined ? [] : [servedPath(id, standing.at.port), ""]),
			...(standing.toolless === true ? [NO_TOOLS, ""] : []),
			THE_KEYBOARD,
			"",
			WHAT_A_SCREEN_IS,
			"",
			ONLY_HERE,
		].join("\n");
	}

	if (said === "off" || said === "no" || said === "stop") {
		const standing = await context.setScreen(false);
		return [
			`${id} has no screen. The container is gone and the link with it${standing.on ? ", though the operator's file says it should have one, so this holds only until somebody types /screen auto" : ""}.`,
			"",
			"What it was signed into is kept. The profile is a volume and outlives the browser, so",
			`/screen on gives ${id} back the same browser, still logged into everything it was. To`,
			`throw the logins away as well, delete ${id} with its state.`,
		].join("\n");
	}

	if (said === "auto" || said === "default") {
		const standing = await context.setScreen(null);
		return standing.on
			? `${id} is back to what the operator's file says, which is that it has a screen.`
			: `${id} is back to what the operator's file says, which is that it has no screen.`;
	}

	if (said === "login" || said === "signin" || said === "sign-in") {
		const [first = "", ...after] = words.slice(1);
		if (first === "off" || first === "drop" || first === "close") {
			const host = after.join(" ").trim();
			if (host === "") return "Which site? /screen login off <host>.";
			const closed = await context.closeSignIn(host);
			if (!closed) return `${id} was not signing into ${host}, so nothing changed.`;
			return [
				`${id} can no longer sign into ${host}. Its browser has been told.`,
				"",
				"What it is already signed into, it stays signed into: the session is a cookie in the",
				`profile rather than a password, and ${id} keeps it until somebody signs that browser out.`,
			].join("\n");
		}
		if (first === "") {
			const standing = await context.screen();
			return standing.sites.length === 0
				? [
						`${id} signs into nothing out of your vault. /screen login <host> opens one.`,
						"",
						WHAT_SIGNING_IN_IS,
					].join("\n")
				: [`${id} signs into: ${standing.sites.join(", ")}.`, "", WHAT_SIGNING_IN_IS].join("\n");
		}
		let host: string;
		try {
			host = await context.openSignIn([first, ...after].join(" ").trim());
		} catch (error) {
			// Answered rather than thrown, as a login that would not start is: what this refuses is a
			// host somebody mistyped, and the place to say so is under the line they typed it on.
			return (error as Error).message;
		}
		const standing = await context.screen();
		return [
			`${id} can sign into ${host} out of your vault, and its browser has the list now.`,
			"",
			// Said here rather than left for the browser to say later: a permission granted against a
			// vault this plane has not been given is a permission that does nothing, and the operator
			// is standing right here at the moment it would be cheapest to fix.
			...(standing.vault
				? []
				: [
						"No vault is connected to this plane yet, so nothing will be filled in: the 1Password",
						"service account token goes on the keys screen, under /config keys. This list is kept",
						"either way, and starts working the moment a vault is connected.",
						"",
					]),
			...(standing.on
				? []
				: [`${id} has no browser to sign in with either. /screen on gives it one.`, ""]),
			WHAT_SIGNING_IN_IS,
		].join("\n");
	}

	if (said !== "") {
		return `"${said}" is not something to do to a screen. /screen on gives it one, /screen off takes it away, /screen auto leaves it to the operator's file, /screen login <host> lets it sign into one out of your vault, and /screen on its own says where it stands.`;
	}

	const standing = await context.screen();
	if (!standing.on) {
		return [`${id} has no screen. /screen on gives it one.`, "", WHAT_A_SCREEN_IS].join("\n");
	}

	return [
		standing.running
			? `${id} has a screen, and it is up.`
			: standing.building === true
				? `${id} has a screen, and the browser image is still being built here. It comes up on its own when that finishes.`
				: `${id} has a screen, and nothing is running it. It comes up on its own — if it does not, look for what the plane said when it tried.`,
		standing.keyboard === "operator"
			? "Somebody has the keyboard on it right now, so the agent cannot touch the page."
			: "",
		standing.sites.length === 0
			? "It signs into nothing out of your vault. /screen login <host> opens one."
			: `It signs into: ${standing.sites.join(", ")}.`,
		"",
		...(standing.at === undefined ? [] : [servedPath(id, standing.at.port), ""]),
		...(standing.toolless === true ? [NO_TOOLS, ""] : []),
		THE_KEYBOARD,
		"",
		ONLY_HERE,
	]
		.filter((line, index, all) => !(line === "" && all[index - 1] === ""))
		.join("\n");
}

/**
 * What piping a host gives up, said where somebody is about to give it up.
 *
 * The one thing on this console that trades a security property for a working feature, so the trade
 * is written out rather than implied: what is lost is the path on the audit line and the ability to
 * put a credential on that host, and what is bought is a browser that works on the part of the web
 * that measures TLS handshakes.
 */
const PIPING = [
	"Everything an agent reaches goes through a certificate this plane issues for the host: the proxy",
	"reads the request, can write a credential onto it, and writes down where it went. That is what",
	"the audit line is made of, and it is why a sandbox never has a raw connection to anywhere.",
	"",
	"It is also why some sites refuse the browser. What they see is this plane's handshake under a",
	"browser's name, and comparing those two is how they decide a connection is not a person. A piped",
	"host is read end to end by the browser itself, so what arrives is Chrome's own handshake.",
	"",
	"What it costs: the audit line for that host says the host and no path, nothing can be injected on",
	"it, and what goes down it is whatever the agent puts there rather than HTTPS this plane has read.",
	"Worth it for a site an agent only browses. Never for one it has a key to — a host carrying a",
	"credential is refused this whatever else is said about it.",
].join("\n");

/**
 * The sites read end to end by the browser rather than opened and read here.
 *
 * Its own command rather than a flag on `/reach`, because it is a different decision: opening a host
 * says an agent may go there, and this says nobody here will look at what it did when it did. One of
 * those is answered with a key press while somebody is mid-turn; the other is worth typing out.
 */
async function pipe(words: readonly string[], context: CommandContext): Promise<string> {
	const [said = "", named = ""] = words;

	if (said === "off" || said === "stop") {
		const read = readHost(named);
		if ("refused" in read) return `/pipe off takes ${read.refused}.`;
		if (!(await context.pipe(read.host, false))) return `${read.host} was not being piped.`;
		return `${read.host} is read here again, from the next turn: the path is back on the audit line, and a browser on that site is back to presenting this plane's handshake under its own name.`;
	}

	if (said !== "") {
		const read = readHost(said);
		if ("refused" in read) return `/pipe takes ${read.refused}.`;
		await context.pipe(read.host, true);
		return [
			`${read.host} is open and piped, from the next turn.`,
			"",
			// The thing somebody gets wrong once: a site is not one host, and the script that decides
			// whether you are a person is usually not on the name in the address bar.
			read.host === "*"
				? "That is the whole web. Every host an agent reaches is now a pipe, except the ones carrying a credential — a model, a search, a repository — which are read here as they always were, because a key cannot be written onto bytes nobody reads. What is given up is the path on every other audit line, and the guarantee that what leaves a sandbox is HTTPS this plane has read rather than whatever the agent put on the wire."
				: read.host.startsWith("*.")
					? ""
					: `If it still refuses, try *.${read.host.replace(/^www\./, "")} — a site is not one host, and the script that decides whether you are a person is usually on another name under the same domain.`,
			"",
			PIPING,
		]
			.filter((line, at, all) => !(line === "" && all[at - 1] === ""))
			.join("\n");
	}

	const hosts = await context.piped();
	if (hosts.length === 0) {
		return [
			"Nothing is piped: every host is opened and read here.",
			"",
			"/pipe www.example.com opens one and pipes it, for a site that refuses the browser.",
			"",
			PIPING,
		].join("\n");
	}
	return [
		"Read end to end by the browser, not by this plane:",
		"",
		...hosts.map((host) => `  ${host}`),
		"",
		`/pipe off ${hosts[0]} puts one back.`,
		"",
		PIPING,
	].join("\n");
}

/**
 * What looking is, said once, above the table of who could do it.
 *
 * Worth saying at all because this is the one tool whose model is not the agent's, and the reason
 * is not obvious: an agent thinks with something cheap, and there is no sense in choosing that
 * model for the one turn a week where something has to be looked at.
 */
const LOOKING = [
	"An agent reads a page as text and numbers, which is exact and costs almost nothing. Looking is",
	"for what text cannot say — a chart, a map, a captcha, a page that reads as empty and is not.",
	"",
	"The picture goes to a model that can see, with the agent's question, and what comes back is",
	"prose. The agent never holds an image, which is what makes this work with an agent thinking in",
	"a model that cannot see at all — and is most of them. Left off, a screenshot is handed to the",
	"agent's own model, which reads it or silently does not.",
	"",
	"Choosing here is the whole of setting it up: the host, the key and the price come with the",
	"provider, and the proxy is told to pay for that one endpoint and nothing else on it.",
].join("\n");

/** A price as somebody deciding whether to turn this on needs to read it, which is not four decimals. */
function aLook(usd: number): string {
	if (usd >= 0.01) return `~$${usd.toFixed(2)} a look`;
	if (usd >= 0.001) return `~$${usd.toFixed(3)} a look`;
	return "under a tenth of a cent a look";
}

/**
 * Which model looks at a screenshot, and what the alternatives would cost.
 *
 * A table rather than a sentence, because the question here has three halves at once: what is on,
 * what else there is, and which of those this plane already holds a key for. A screen that answered
 * only the first would send somebody to the keys screen to find out whether the second is even
 * available to them.
 */
async function vision(words: readonly string[], context: CommandContext): Promise<string> {
	const [said = "", named = ""] = words;

	if (said === "off" || said === "none") {
		await context.chooseVision(null);
		return [
			"Nothing looks at a screenshot for these agents now.",
			"",
			"screen_look still works: it hands the picture to whatever the agent itself thinks with,",
			"which reads it or silently does not, depending on the model. /vision <provider> turns a",
			"model back on.",
		].join("\n");
	}

	if (said !== "") {
		const offers = await context.vision();
		const wanted = offers.offers.filter((one) => one.provider === said);
		if (wanted.length === 0) {
			const known = [...new Set(offers.offers.map((one) => one.provider))];
			return `"${said}" is not a provider that looks here. There is ${known.join(", ")}.`;
		}
		if (named !== "" && !wanted.some((one) => one.model === named)) {
			return `${said} looks with ${wanted.map((one) => one.model).join(", ")}, and not with "${named}".`;
		}
		await context.chooseVision(
			named === "" ? { provider: said } : { provider: said, model: named },
		);
		const now = await context.vision();
		const using = now.using;
		if (using === undefined) return "That was not something this plane can look with.";
		const cost = aLook(perLookUsd(using.rate));
		const missing = using.held
			? ""
			: `\n\nNothing here holds ${using.keyEnv} yet, so a look will be refused at the proxy until this plane has it. /config models is where a key goes.`;
		return `Looking goes to ${using.model} at ${using.provider}, from the next turn. ${cost}.${missing}`;
	}

	const { using, offers } = await context.vision();
	const rows = offers.map(
		(one) =>
			[
				`  ${one.using ? "▸ " : "  "}${one.provider} ${one.model}`,
				`${one.held ? "key ✓" : `key ✗ (${one.keyEnv})`}   ${aLook(perLookUsd(one.rate))}`,
			] as const,
	);

	return [
		using === undefined
			? "Nothing looks at a screenshot for these agents: screen_look hands the picture to whatever the agent itself thinks with."
			: `Looking goes to ${using.model} at ${using.provider}${using.held ? "" : ` — though nothing here holds ${using.keyEnv}, so it will be refused at the proxy`}.`,
		"",
		laidOut(rows),
		"",
		"/vision openai turns one on, /vision openai gpt-5 names the model, /vision off leaves it to",
		"the agent's own model.",
		"",
		LOOKING,
	].join("\n");
}

/** The words `/plugins` reads as instructions, and therefore not names a plugin may be given. */
const VERBS = ["add", "drop", "forget", "login", "logout"];

/** How to add one, which is the answer to "and what do I type", asked in three different ways. */
const ADDING = [
	"/plugins add <name> <url>              a remote server",
	"/plugins add <name> sse <url>          one speaking the older transport",
	"/plugins add <name> <command> [args]   one the agent starts for itself",
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
		return `\n\nIt wants an account first: /plugins login ${name}`;
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
			`the address it lands on back as: /plugins login ${name} <address>`,
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
	if (shelf.length === 0) return `No plugins here yet.\n\n${ADDING}`;

	const spare = shelf.filter((one) => !held.some((has) => has.name === one.name));
	const said = [
		held.length === 0
			? "This agent has none of them."
			: `This agent has:\n${laidOut(await rows(held, context))}`,
	];
	if (spare.length > 0) {
		said.push(`On the shelf:\n${laidOut(await rows(spare, context))}`);
		said.push(`/plugins ${spare[0]?.name} gives this agent that one.`);
	}
	return said.join("\n\n");
}

/**
 * The servers this agent has, and the ones it could be given.
 *
 * Adding is separate from attaching because finding a server is the expensive part and it only has
 * to happen once: from the second agent on, the whole of it is a name off a list.
 */
async function plugins(words: readonly string[], context: CommandContext): Promise<string> {
	const [verb = "", ...rest] = words;
	const [named = "", ...target] = rest;

	if (verb === "") return listing(context);

	if (verb === "add") {
		if (named === "") return `A server needs a name to be called by.\n\n${ADDING}`;
		// Checked before the name is read, so the answer to `/plugins add add …` is the real problem with
		// it rather than a complaint about characters that were all perfectly fine.
		if (VERBS.includes(named)) return `"${named}" is a word /plugins uses. Call it something else.`;
		const complaint = readName(named);
		if (complaint !== undefined) return complaint;
		const read = readServer(target);
		if ("refused" in read) return read.refused;

		await context.addServer(named, read.server);
		await context.attachServer(named);
		return [
			`"${named}" is on the shelf, and this agent has it.`,
			await whatNext(named, read.server, context),
			`\n\nAny other agent can have it too, with /plugins ${named}.`,
		].join("");
	}

	const { shelf, held } = await context.mcp();

	if (verb === "login" || verb === "logout") {
		if (named === "") {
			const names = shelf.map((one) => one.name);
			return names.length === 0
				? `There is nothing to log ${verb === "login" ? "in" : "out"} of yet.\n\n${ADDING}`
				: `Which one? ${names.map((one) => `/plugins ${verb} ${one}`).join(", ")}`;
		}
		const found = shelf.find((one) => one.name === named);
		if (found === undefined) return `There is no plugin called "${named}".`;
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
			return `Which one? ${shelf.map((one) => `/plugins ${verb} ${one.name}`).join(", ")}`;
		if (verb === "drop") {
			if (!held.some((one) => one.name === named)) return `This agent does not have "${named}".`;
			await context.detachServer(named);
			// Said, because the two words do different things and which one was wanted is not obvious
			// from either. Nobody should have to find out by typing the wrong one.
			return `This agent no longer has "${named}". It is still on the shelf: /plugins ${named} gives it back.`;
		}
		if (!shelf.some((one) => one.name === named)) return `There is no plugin called "${named}".`;
		await context.forgetServer(named);
		return `"${named}" is off the shelf, and off every agent that had it.`;
	}

	// Anything else is a name, which is the short way and the one the second agent uses.
	const found = shelf.find((one) => one.name === verb);
	if (found === undefined) {
		if (shelf.length === 0) return `There is no plugin called "${verb}".\n\n${ADDING}`;
		return `There is no plugin called "${verb}". There is: ${shelf.map((one) => one.name).join(", ")}.`;
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
	const email = /^(\s*\/email\s+)(.+)$/i.exec(line);
	// By the command rather than by the shape of it. An app password is sixteen ordinary letters, often
	// in four groups of four, and no pattern that catches one leaves a sentence alone. What is known
	// here is the thing a pattern cannot know: everything after `/email` that is not an address is one.
	if (email !== null) {
		const rest = email[2] ?? "";
		// Except after the two verbs that take a list, where there is no password to be had and the line
		// is the record of who was let in. Struck out to dots it would be a record nobody can read back.
		if (/^(allow|deny)\b/i.test(rest)) return line;
		return `${email[1] ?? ""}${spent(rest)}`;
	}
	return line.replace(BOT_TOKEN, (_whole, id: string) => `${id}:…`).replace(GITHUB_TOKEN, "…");
}

/** GitHub's shapes, which say what they are from the first four letters and so can be struck out anywhere. */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

function spent(rest: string): string {
	return rest
		.split(/\s+/)
		.filter((word) => word !== "")
		.map((word) => (word.includes("@") || word === "off" || word === "stop" ? word : "…"))
		.join(" ");
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
		// Telegram Web opens the chat without handing the bot the payload behind `?start=`, so the
		// Start button there pairs nothing and the person is left in an empty chat with no way on.
		// The phrase does the same work in any message, which is the way through that always exists.
		`If pressing Start does nothing — which happens on Telegram Web — write to @${standing.username}`,
		"and send it this phrase instead:",
		"",
		`    ${standing.phrase}`,
		"",
		`Whoever does either is the one ${id} takes instructions from. Anyone else who writes to it is`,
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

const NEW_MAILBOX = [
	"Type the address of a mailbox you already read. Nothing to buy, no domain to own, no DNS to",
	"wait on — the plane logs in and reads it the way a mail client does:",
	"",
	"    /email you@fastmail.com",
].join("\n");

/**
 * The password step, once it is known where the mailbox is and that it will take one.
 *
 * The link is the point. Every provider buries the app-password screen somewhere different and none
 * of them call it the same thing, so "make an app password" is an instruction that ends in a search
 * box — which is the longest part of connecting a mailbox and the part people give up in.
 */
function askForPassword(offer: EmailOffer): string {
	const guessed =
		offer.found === "guess"
			? [
					"",
					`Nothing published where ${offer.address.split("@")[1] ?? "that domain"}'s mail lives, so that host is the conventional guess. If it is`,
					"wrong, the login will be the thing that says so.",
				]
			: [];

	const where =
		offer.appPasswords === undefined
			? [
					"Make an app password in that provider's security settings. Your ordinary password will",
					"not work on most of them, and is not the kind of thing to paste into a console.",
				]
			: [
					"Now make an app password. Your ordinary password will not work, and is not the kind of",
					"thing to paste into a console:",
					"",
					`    ${offer.appPasswords}`,
				];

	// Both servers named in one line, because the question the password step raises is how many
	// credentials this is going to take. A provider issues an app password for the account rather than
	// for a protocol, so the answer is one, and saying it here is cheaper than being asked.
	const found =
		offer.outgoing === undefined
			? [
					`${offer.host}:${offer.port} reads ${offer.address}. Nothing there says where its mail is handed`,
					"in to be sent, so an agent on it can be written to and cannot write back.",
				]
			: [
					`${offer.host}:${offer.port} reads ${offer.address} and ${offer.outgoing.host}:${offer.outgoing.port} sends from it.`,
					"One app password does both.",
				];

	return [
		...found,
		...guessed,
		"",
		...where,
		"",
		"Then paste it back:",
		"",
		"    /email <the app password>",
	].join("\n");
}

/** The two answers that are reasons to stop rather than steps on the way. */
function refusal(offer: EmailOffer): string | undefined {
	if (offer.closed !== undefined) {
		return `${offer.address} cannot be connected with a password.\n\n${offer.closed}`;
	}
	if (!offer.bridge) return undefined;

	// Proton is the one that does this, and its autoconfig is telling the truth: the mail really is at
	// 127.0.0.1, on a desktop somewhere running the bridge. Said plainly here, because dialling it
	// would fail with a connection refused from an address that looked perfectly ordinary.
	return [
		`${offer.address} is only reachable through a bridge running on your own computer — its own`,
		`settings say the mail is at ${offer.host}:${offer.port}, and that is this machine, not that one.`,
		"There is nothing here for the plane to connect to.",
	].join("\n");
}

function pairingByMail(id: string, said: EmailStanding): string {
	return [
		`Nobody may instruct ${id} by mail yet. Write to that address from wherever you read your own`,
		"mail, with this phrase anywhere in the message:",
		"",
		`    ${said.phrase}`,
		"",
		`Ask for something in that same mail if you like. ${id} reads whatever the phrase was written`,
		"around, so the first mail takes a turn like any other.",
		"",
		`Whoever sends it is the one ${id} takes instructions from: an address strangers already have is`,
		"one where every message read would spend a turn, so everyone else's mail is left unread.",
		"",
		"/email allow <address> is the other way onto that list, for anyone you would rather not wait",
		"on — and /email allow *@company.com lets a whole domain in at once.",
	].join("\n");
}

/**
 * Whether an answer goes anywhere, which is the difference between a channel and a suggestion box.
 *
 * Worth saying in both directions. An operator who does not know the agent writes back watches an
 * inbox for nothing; one who assumes it does, on a provider that refused the same password at its
 * submission server, is waiting on answers that were thrown away at the far end of every turn.
 */
function writing(id: string, said: EmailStanding): readonly string[] {
	if (said.writes) {
		return [
			`${id} answers from that same address and under the same subject, so what it writes back`,
			"arrives in the thread you started and a reply to that comes back to the same agent.",
		];
	}

	// Two different situations wearing the same face. Nothing published is a provider that never
	// offered, and there is nothing to retry; a refusal is a password that got half way in, and typing
	// the two lines again is the whole of what there is to do about it.
	if (said.mute === undefined) {
		return [
			`${id} can be written to and cannot write back: ${said.mailbox} publishes nowhere to hand`,
			"mail in to be sent.",
		];
	}
	return [
		`${id} can be written to and cannot write back. Its submission server refused the same password:`,
		"",
		`    ${said.mute}`,
		"",
		`Connecting the mailbox again with /email ${said.mailbox} tries that half once more.`,
	];
}

function reachedAt(id: string, said: EmailStanding): string {
	const trouble =
		said.trouble === undefined ? [] : [`The plane cannot read it: ${said.trouble}`, ""];

	if (said.phrase !== undefined) {
		return [...trouble, `${id} is reached at ${said.address}.`, "", pairingByMail(id, said)].join(
			"\n",
		);
	}

	const untagged =
		said.fallback === id
			? `and mail arriving with no tag on it comes here, to ${id}.`
			: `and mail arriving with no tag on it goes to ${said.fallback}.`;

	return [
		...trouble,
		`${id} is reached at ${said.address}. Write to it and ${id} takes a turn.`,
		"",
		`That is ${said.mailbox} on ${said.host}:${said.port}, and it serves every agent on this plane:`,
		`each one is reached at its own name tagged onto the address, ${untagged}`,
		"",
		...writing(id, said),
		"",
		`Mail from ${said.operators.join(", ")} is read as instructions and nobody else's is read at all: an`,
		"address strangers already have is one where every message read would spend a turn.",
		"",
		"/email allow <address> adds somebody to that list, /email allow *@company.com adds everyone at",
		"a domain, and /email deny takes them off. /email off puts the mailbox down, for every agent.",
	].join("\n");
}

/**
 * Google shows an app password in four groups of four and people paste it that way.
 *
 * Every provider that formats one like that ignores the spaces, so joining them is what was meant.
 * A password that is not that shape is left exactly as it was typed, spaces and all, because on a
 * mailbox somebody runs themselves it may well have one in it.
 */
function password(words: readonly string[]): string {
	return words.every((word) => /^[a-z0-9]+$/i.test(word)) ? words.join("") : words.join(" ");
}

/**
 * The mailbox this plane reads, and this agent's address in it.
 *
 * Connected once for every agent rather than once per agent, which is the whole design: an operator
 * who has done this has done it for the agents they have and the ones they have not made yet.
 *
 * Two lines because the address has to be looked up before there is anything useful to say about a
 * password — where to make one, and whether making one is even possible. The address is not asked
 * for twice; the second line is only the password, against the address the first line held on to.
 */
async function email(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", ...rest] = words;

	if (first === "") {
		const said = await context.email();
		return said === undefined
			? `No mailbox is connected, so ${id} has no address.\n\n${NEW_MAILBOX}`
			: reachedAt(id, said);
	}

	if (first === "off" || first === "stop") {
		const had = await context.disconnectEmail();
		return had
			? "The mailbox is down, for every agent on this plane. The app password is still yours to revoke\nwherever you made it, and /email takes a mailbox back."
			: "No mailbox was connected.";
	}

	// Before the address path, because `allow nico@company.com` has an address in it and is not one
	// being connected. Two words where the second is the address, so the verb is what tells them apart.
	if (first === "allow" || first === "deny") return whoMayWrite(id, first, rest, context);

	if (first.includes("@")) {
		const offer = await context.offerEmail(first);
		const stop = refusal(offer);
		if (stop !== undefined) return stop;
		if (rest.length === 0) return askForPassword(offer);
	}

	const said = await connect(password(first.includes("@") ? rest : words), context);
	return typeof said === "string" ? said : reachedAt(id, said);
}

/** The list as a sentence, which is the half of every answer here that says where things stand. */
function reading(said: EmailStanding): string {
	return said.operators.length === 0
		? "Nobody's mail is read as instructions."
		: `Mail from ${said.operators.join(", ")} is read as instructions, and nobody else's is read at all.`;
}

/**
 * Adds somebody to the list whose mail is read as instructions, or takes them off it.
 *
 * There is one rung and this is it: everybody on the list spends turns and instructs agents, the
 * same as whoever connected the mailbox. So the answer says what it costs rather than only that it
 * happened, and a domain admitted is spelled out as the number of people nobody counted that it is.
 *
 * A whole domain is safe to offer because it is not a promise anybody can make about themselves.
 * The mail is checked against the domain that signed it before this list is read at all, so
 * `*@company.com` means whoever that company's mail server signed for, not whoever typed it.
 */
async function whoMayWrite(
	id: string,
	verb: "allow" | "deny",
	words: readonly string[],
	context: CommandContext,
): Promise<string> {
	const said = await context.email();
	if (said === undefined) {
		return `No mailbox is connected, so there is nobody to let write to one.\n\n${NEW_MAILBOX}`;
	}

	const typed = words.join(" ").trim();
	if (typed === "") {
		return verb === "allow"
			? [
					`/email allow <address> lets somebody instruct ${id} and every other agent here by mail.`,
					"/email allow *@company.com lets everyone at a domain, which is checked against the domain",
					"that signed the mail rather than the one it claims to be from.",
					"",
					reading(said),
				].join("\n")
			: ["/email deny <address> stops their mail being read.", "", reading(said)].join("\n");
	}

	if (verb === "deny") {
		const had = await context.denySender(typed);
		const now = await context.email();
		return had
			? [
					`${typed} no longer instructs anything here, and nothing they write is answered.`,
					...(now === undefined ? [] : ["", reading(now)]),
				].join("\n")
			: [`${typed} was not on the list.`, "", reading(said)].join("\n");
	}

	let entry: string;
	try {
		entry = await context.allowSender(typed);
	} catch (error) {
		// The plane's own words. A line that is neither an address nor a domain and a domain that means
		// the whole internet are refused for different reasons, and which it was is what to do about it.
		return (error as Error).message;
	}

	const everyone = entry.startsWith("*@")
		? `Everyone at ${entry.slice(2)} — anyone whose mail that domain signs for — can now instruct`
		: `${entry} can now instruct`;
	return [
		`${everyone} ${id} and every other agent on this plane, spending a turn for`,
		"each message, the same as whoever connected the mailbox.",
		"",
		`/email deny ${entry} stops it.`,
	].join("\n");
}

async function connect(secret: string, context: CommandContext): Promise<EmailStanding | string> {
	try {
		return await context.connectEmail(secret);
	} catch (error) {
		// The provider's own words, because which refusal it is decides what to do about it: a password
		// that was mistyped is retyped, and one refused for a reason of the provider's own is not.
		return `That did not get in: ${(error as Error).message}`;
	}
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
 * Forgetting the conversation, which is the cheap way out of one that has gone somewhere useless.
 *
 * Not confirmed, unlike the other command here that throws something away. What `/delete` takes
 * cannot be got back and this can be lived without: the agent keeps everything it chose to write
 * down, and what goes is the part that was only ever a means to it. A conversation is also the thing
 * most often worth ending — one talked into a corner, one grown long enough that every turn now pays
 * to re-read it — and a key to press every time would put the price on the ordinary case.
 */
async function clear(words: readonly string[], context: CommandContext): Promise<string> {
	const unknown = words[0];
	if (unknown !== undefined) return `"${unknown}" is not something /clear takes. It takes nothing.`;

	const { id } = context.agent;
	const { stopped, remembered } = await context.clear();
	const what = stopped
		? `Stopped the turn ${id} was taking, and forgot the conversation.`
		: remembered
			? `${id} has forgotten the conversation.`
			: `${id} had no conversation to forget.`;

	return [
		what,
		"",
		`The repository is untouched: ${id}'s soul, its skills and whatever it wrote down to remember`,
		"are what outlive a conversation, and are why throwing one away costs little. So is everything",
		"/model, /plugins, /limit and /serve have set. The next thing said starts it again on nothing.",
	].join("\n");
}

/**
 * Runs a command and says what happened, in a sentence meant to be read in the conversation.
 *
 * Every answer is a full sentence rather than an acknowledgement, because this goes where the
 * agent's answers go: "ok" under a line nobody can see any more says nothing at all.
 */
/** Where a fine-grained token is made, said once wherever one is asked for. */
const NEW_TOKEN_AT = "https://github.com/settings/personal-access-tokens/new";

function askForToken(repo: string): string {
	return [
		`This plane holds no GitHub token. Make a fine-grained one at ${NEW_TOKEN_AT} with`,
		`Contents: read and write on ${repo} — and Pull requests: read and write, if it should open`,
		"them — then paste it here:",
		"/repo github_pat_…",
		"",
		"It is kept here, spent by the proxy, and never given to an agent.",
	].join("\n");
}

/** What holding a repository comes to, in the words the operator reads under the line they typed. */
function heldSaid(id: string, hold: RepoHold): string {
	if (hold.kind === "token-needed") return askForToken(hold.spec.repo);
	if (hold.kind === "refused") return `Nothing was held: ${hold.why}.`;
	const { standing } = hold;
	return [
		`${id} holds ${standing.url}. It can clone it and push to ${standing.push.join(", ")};`,
		"a push to any other branch is refused before it leaves, and it can open pull requests.",
		"The token stays here, never in the sandbox.",
		...(hold.warning !== undefined ? ["", hold.warning] : []),
	].join("\n");
}

const NEW_REPO = [
	"Give it one, and it pushes to its own branches there and nowhere else:",
	"/repo acme/website",
	"/repo acme/website fix/* docs        to name the branches instead",
].join("\n");

function holdingSaid(id: string, repos: readonly RepoStanding[]): string {
	if (repos.length === 0) return `${id} holds no repository.\n\n${NEW_REPO}`;
	const widest = Math.max(...repos.map((held) => held.url.length));
	return [
		`${id} holds:`,
		...repos.map(
			(held) =>
				`  ${held.url.padEnd(widest + 2)}push ${held.push.join(" ")}  ${held.origin === "file" ? "from the file" : "from here"}`,
		),
		"",
		"/repo drop <owner/name> takes one back; /repo <owner/name> <branch>… changes what it may push.",
	].join("\n");
}

/**
 * The repositories an agent holds, and the line that gives it one.
 *
 * Two forms share the command because they are two halves of one act: the first time a repository is
 * given there is no token yet, and the token is pasted on the next line the way an app password is
 * after `/email <address>`. A token is unmistakable by shape, so the two are told apart without a
 * verb, and the line the token was on is written down without it.
 */
async function repo(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", ...rest] = words;

	if (first === "") return holdingSaid(id, await context.repos());

	if (first === "drop" || first === "off") {
		const read = readRepo(rest.join(" "));
		if ("refused" in read) return `/repo drop takes ${read.refused}.`;
		try {
			const had = await context.dropRepo(read.repo);
			return had
				? `${id} no longer holds ${read.repo}. Whatever it cloned is still in its workspace; the credential to push it is not.`
				: `${id} does not hold ${read.repo}.`;
		} catch (error) {
			return (error as Error).message;
		}
	}

	if (looksLikeGithubToken(first)) {
		const finished = await context.keepGithubToken(first);
		if (finished === undefined) {
			return "Kept, as GITHUB_TOKEN, for every repository given here. Now say which: /repo <owner/name>";
		}
		return heldSaid(id, finished);
	}

	const read = readRepo(first);
	if ("refused" in read) return `/repo takes ${read.refused}.`;
	// `push` may be said or left out: `/repo acme/website push fix/*` reads the same as without it.
	const push = readPush(rest[0] === "push" ? rest.slice(1) : rest);
	if ("refused" in push)
		return `After the repository come the branches it may push: ${push.refused}.`;
	const spec: RepoSpec = { repo: read.repo, ...(push.push.length > 0 ? { push: push.push } : {}) };
	return heldSaid(id, await context.holdRepo(spec));
}

/**
 * What outside this plane gives this agent a turn.
 *
 * A wakeup answers "when", and this answers "when something happens" — which is the half an agent
 * cannot arrange for itself, because the thing that happened happened somewhere else. Underneath it
 * is a webhook and deliberately nothing cleverer: the senders worth reacting to all speak it, sign
 * it and retry it, and what is added on top is knowing who signed, which events are worth a turn,
 * and not taking the same delivery twice.
 */
async function trigger(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", ...rest] = words;

	if (first === "") {
		const held = (await context.triggers()).filter((one) => one.agentId === id);
		if (held.length === 0) {
			return [
				`Nothing outside this plane wakes ${id}.`,
				"",
				`  /trigger new       an address that wakes ${id}, and nothing else to decide`,
				"  /trigger <name> from stripe on customer.subscription.deleted",
				"",
				"The first is a URL you paste into whatever should wake it. The second is for a sender",
				"that signs — it checks the signature, and takes a turn only on the events you name.",
			].join("\n");
		}
		return [
			`${held.length === 1 ? "One thing wakes" : `${held.length} things wake`} ${id}:`,
			"",
			...held.flatMap((one) => [
				`  ${one.name} — ${one.from}, at /hooks/${one.name}`,
				`    ${one.only.length === 0 ? "every event it sends" : one.only.join(", ")}`,
				`    ${one.fired === 0 ? "never fired yet" : `${one.fired} so far, last ${one.firedAt ?? "—"}`}`,
				...(one.says === undefined ? [] : [`    “${one.says}”`]),
			]),
			"",
			`/trigger <name> says <what arrives> tells ${id} what it is looking at when one fires.`,
			"/trigger drop <name> takes one down.",
		].join("\n");
	}

	if (first === "drop" || first === "off") {
		const name = rest.join(" ").trim();
		if (name === "") return "/trigger drop takes the name of one.";
		return (await context.dropTrigger(name))
			? `${name} is gone. Anything posted to it from now on is refused, so take the address out of wherever it is written down.`
			: `There is no trigger called "${name}".`;
	}

	/*
	 * An address that wakes this agent, and nothing else to decide.
	 *
	 * The whole of what most people want from a webhook, and what every product that offers one in a
	 * click gives them: a URL nobody can guess. Everything else here — who signs, which events — is
	 * a refinement of this, and refinements belong after the thing works rather than in front of it.
	 */
	if (first === "new") {
		try {
			const made = await context.addTrigger("", "url", []);
			return [
				`Anything that posts to this wakes ${id}:`,
				"",
				`  /hooks/${made.name}`,
				"",
				"on whatever address this plane is reachable at. The address is the secret — anybody who",
				"has it can wake this agent — so paste it where it is going and nowhere else.",
				"",
				"If the sender signs what it posts, /trigger <name> from stripe on <event> checks the",
				"signature as well, and takes a turn only on the events you name.",
			].join("\n");
		} catch (error) {
			return (error as Error).message;
		}
	}

	/*
	 * What arrives here, in the operator's own words.
	 *
	 * The half of a trigger a payload cannot supply: `customer.subscription.deleted` says a
	 * subscription was cancelled and nothing about whether anybody wants a report, who it is for, or
	 * where to look first. It reaches the turn as an instruction and apart from the body, because it
	 * is the operator's sentence and the body is a stranger's.
	 */
	const says = rest.indexOf("says");
	if (says !== -1) {
		const about = rest
			.slice(says + 1)
			.join(" ")
			.trim();
		if (!(await context.describeTrigger(first, about))) {
			return `There is no trigger called "${first}".`;
		}
		return about === ""
			? `${first} says nothing now. What arrives there reaches ${id} as a payload and nothing else.`
			: `Noted. Every time ${first} fires, ${id} is told: “${about}”`;
	}

	// `<name> from <signer> on <event> <event>` — read as words rather than as flags, because this
	// is a sentence somebody says out loud and every flag in it would be a thing to look up.
	const name = first;
	const at = rest.findIndex((word) => word === "from");
	const on = rest.findIndex((word) => word === "on");
	const signer = at === -1 ? "" : (rest[at + 1] ?? "");
	if (!isSigner(signer)) {
		return [
			`/trigger ${name} from <${SIGNERS.filter((one) => one !== "url").join("|")}> — who is at`,
			"the other end, which is how the signature on what arrives gets read.",
			"",
			...SIGNERS.map((one) => `  ${one.padEnd(7)} ${SIGNER_SAID[one]}`),
			"",
			"Or /trigger new, for an address that wakes it with nothing else to set up.",
		].join("\n");
	}
	const only = on === -1 ? [] : rest.slice(on + 1).filter((word) => word !== "");

	try {
		const made = await context.addTrigger(name, signer, only);
		return [
			`${id} takes a turn whenever ${signer} posts to:`,
			"",
			`  /hooks/${made.name}`,
			"",
			"on whatever address this plane is reachable at — the console's own, if you have published",
			"it, or the hook port. The secret to sign with, which is not shown again:",
			"",
			`  ${made.secret}`,
			"",
			only.length === 0
				? "Every event it sends is a turn. Say `on <event>` to narrow that, or it will be a lot."
				: `Only ${only.join(", ")}. Everything else is taken, answered and dropped without a turn.`,
			"",
			`Then /trigger ${name} says <what arrives> tells ${id} what it is looking at when it fires.`,
		].join("\n");
	} catch (error) {
		return (error as Error).message;
	}
}

/**
 * What an agent has learned how to do, and the two lines that change it.
 *
 * A skill is the agent's own file in the agent's own repository, which is why nothing here writes
 * one: `save` asks the agent to write down what it just did, because the only thing that knows what
 * that was is the thing that did it. What this command owns is the list and the copying.
 */
async function skills(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", second = "", ...rest] = words;

	if (first === "") {
		const held = await context.skills();
		if (held.length === 0) {
			return [
				`${id} has not written down how to do anything yet.`,
				"",
				"After it does something worth doing the same way twice, /skills save <name> asks it to",
				"write the procedure into its own repository, where it reads it back the next time.",
			].join("\n");
		}
		return [
			`${id} knows how to do ${held.length === 1 ? "one thing" : `${held.length} things`}:`,
			"",
			...held.map(
				(skill) =>
					`  ${skill.name}${skill.does === "" ? "" : ` — ${skill.does}`} (${skill.lines} lines)`,
			),
			"",
			"/skills give <name> <agent> copies one to another agent.",
		].join("\n");
	}

	if (first === "save" || first === "keep") {
		const name = second.trim();
		if (name === "") return "/skills save takes a name for it: /skills save weekly-report";
		try {
			await context.keepSkill(name, rest.join(" "));
		} catch (error) {
			return (error as Error).message;
		}
		return `Asked ${id} to write down how it did this, as "${name}". It takes a turn on it and commits the file; /skills lists it once it has.`;
	}

	if (first === "give" || first === "copy") {
		const name = second.trim();
		const to = rest.join(" ").trim().replace(/^@/, "");
		if (name === "" || to === "") {
			return "/skills give takes the skill and who gets it: /skills give weekly-report scribe";
		}
		try {
			await context.giveSkill(name, to);
		} catch (error) {
			return (error as Error).message;
		}
		return `${to} has a copy of "${name}" now. It is a copy: ${to} may edit it into something else, and ${id} keeps its own.`;
	}

	return `/skills takes nothing at all, "save <name>", or "give <name> <agent>".`;
}

/**
 * What this agent has to show you before it sends it.
 *
 * Only the things that leave in the operator's name and cannot be taken back by deciding afterwards
 * that they should not have gone. What an agent may reach is a different question with a different
 * answer — `/reach` and the grants — and what it does to its own files is bounded by the box it
 * lives in. This is about the two doors that open onto somebody else's inbox.
 */
async function ask(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", second = ""] = words;

	if (first === "") {
		const held = await context.gates();
		return [
			held.length === 0
				? `${id} sends what it writes, without asking.`
				: `${id} shows you what it would send ${held.map(gateSaid).join(" and ")}, and waits.`,
			"",
			...GATES.map(
				(gate) =>
					`  ${gate.padEnd(9)} ${held.includes(gate) ? "held — you answer each one" : "goes out as written"}`,
			),
			"",
			`/ask mail holds one. /ask mail off lets it go again.`,
		].join("\n");
	}

	if (!isGate(first)) {
		return `/ask takes ${GATES.join(" or ")}, and "off" after it to let one go again.`;
	}
	const hold = second !== "off";
	try {
		const changed = await context.setGate(first, hold);
		if (!changed) {
			return hold
				? `${id} already shows you what it sends ${gateSaid(first)}.`
				: `${id} was not being held on that.`;
		}
	} catch (error) {
		return (error as Error).message;
	}
	return hold
		? `${id} will show you every answer it would send ${gateSaid(first)} before it goes. The message is held whole, and a yes sends exactly what is on the screen.`
		: `${id} sends ${gateSaid(first)} without asking again.`;
}

/**
 * Who this agent may write to, and the two lines that change it.
 *
 * Written from the agent the line was typed at, in both directions of the sentence: `/team scout`
 * typed at planner is planner writing to scout and not the other way round. Said out loud in every
 * answer, because a list of names on a pane is otherwise a list that could be read either way — and
 * the two are different grants.
 */
async function team(words: readonly string[], context: CommandContext): Promise<string> {
	const { id } = context.agent;
	const [first = "", ...rest] = words;

	if (first === "") return teamSaid(id, await context.team());

	if (first === "drop" || first === "off") {
		const name = rest.join(" ").trim();
		if (name === "") return "/team drop takes the name of an agent.";
		try {
			return (await context.dropTeam(name))
				? `${id} can no longer write to ${name}. Nothing else changed: ${name} may still answer whatever it was already asked.`
				: `${id} was not given ${name} here.`;
		} catch (error) {
			return (error as Error).message;
		}
	}

	const name = first.replace(/^@/, "");
	try {
		await context.holdTeam(name);
	} catch (error) {
		return (error as Error).message;
	}
	return [
		`${id} may write to ${name} from now on, that way round.`,
		"",
		`What ${id} sends arrives there as data and not as an instruction — ${id} is not ${name}'s`,
		`operator — and ${name}'s answer comes back as a turn of ${id}'s.`,
	].join("\n");
}

/** The others as rows: who they are, what they are for, and which way a message may go. */
function teamSaid(id: string, mates: readonly Teammate[]): string {
	if (mates.length === 0) {
		return `${id} is the only agent in this plane, so there is nobody to write to.`;
	}
	const open = mates.filter((mate) => mate.open);
	const rows = laidOut(
		mates.map(
			(mate) =>
				[`${mate.open ? "→" : " "} ${mate.id}`, mate.description ?? "no description"] as const,
		),
	);
	return [
		open.length === 0
			? `${id} may write to none of them. A name after /team opens one:`
			: `${id} may write to ${open.map((mate) => mate.id).join(", ")}. The whole plane:`,
		"",
		rows,
		"",
		"An agent may also be given one for a single turn, by naming it with an @ in what you write.",
	].join("\n");
}

export async function runCommand(line: string, context: CommandContext): Promise<string> {
	const [name = "", ...rest] = line.trim().slice(1).split(/\s+/);
	const argument = rest.join(" ");

	if (name === "help" || name === "") return HELP;

	// The words rather than the argument: a server is a name and then a whole command line, and
	// joining those back into one string only to split them again would lose where each of them ended.
	// `/mcp` is what this was called, and is kept: it is in everybody's history and in every note
	// anybody wrote down about this plane, and a command that stops existing to be renamed is a
	// rename that costs its users an error message.
	if (name === "plugins" || name === "mcp") return plugins(rest, context);
	if (name === "model") return models(rest, context);
	if (name === "serve") return serve(rest, context);
	if (name === "screen") return screen(rest, context);
	if (name === "vision") return vision(rest, context);
	if (name === "pipe") return pipe(rest, context);
	if (name === "telegram") return telegram(rest, context);
	if (name === "email") return email(rest, context);
	if (name === "repo") return repo(rest, context);
	if (name === "team") return team(rest, context);
	if (name === "ask") return ask(rest, context);
	if (name === "skills" || name === "skill") return skills(rest, context);
	if (name === "trigger" || name === "triggers") return trigger(rest, context);
	if (name === "delete") return remove(rest, context);
	if (name === "clear") return clear(rest, context);

	// The console opens the screen itself and sends nothing down, so the only `/config` that gets this
	// far is one naming a part of the plane that is not one — which is a typo, answered with the words
	// that would have worked rather than with the whole help.
	if (name === "config") {
		return `"${argument}" is not a part of this plane. /config takes ${CONFIG_SECTIONS.join(", ")}, or nothing at all for the list of them.`;
	}

	if (name === "reach") {
		const read = readHost(argument);
		if ("refused" in read) return `/reach takes ${read.refused}.`;
		// Answered rather than asked again. A host already open is the answer to what the asker
		// actually wanted to know, and putting a question in front of an operator to have them open
		// something that is open is spending the one thing this whole path is careful with.
		if (await context.granted(read.host)) {
			return `${read.host} is already open to this agent. Whatever failed was not the proxy refusing it.`;
		}
		await context.askReach(read.host);
		// The prompt below this has room for the host and the two keys and not for what a yes costs, so
		// it is said here, on the line the question is asked directly under.
		return `Asked to open ${read.host}. Nothing is open yet: it is a question at the console until somebody answers it there, and a yes opens the host to every agent on this plane.`;
	}

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
 * `/reach` is the same test again and the clearest case of it: asking to reach a host widens nothing,
 * because all it writes down is a question. What opens the host is a key pressed on a modal with the
 * host name on it — the consent screen again, drawn on the operator's own terminal.
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

	// The conversation is where an injection would be sitting, so an agent that could clear its own is
	// one that can be talked into erasing the record of being talked into things. Cheap for an
	// operator to do and worth nothing to an attacker, which is exactly the line this list draws.
	if (name === "clear") {
		return "This agent asked to forget the conversation. That one stays with you, because the conversation is the record of how it got here — including whatever put it up to asking: /clear, if you meant it.";
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

	// Listing widens nothing and is worth answering: an agent that knows who it may write to writes to
	// them instead of describing the message it would have sent. Opening a door is the other half, and
	// it is the whole grant — a message wakes another agent and spends that agent's ceiling, so an
	// agent that could open one could put the plane to work on its own say-so. The line the operator
	// would type is printed instead, which is what puts the two names in front of them.
	if (name === "team" && rest.length > 0) {
		const [first = "", ...after] = rest;
		if (first === "drop" || first === "off") {
			return `This agent asked to stop being able to write to ${after.join(" ") || "another agent"}. That one stays with you: /team drop ${after.join(" ")}, if you meant it.`;
		}
		return `This agent asked to be able to write to "${first}", which would wake ${first} and spend what ${first} may spend. That one stays with you: /team ${first}, if you meant it. Writing to ${first} is the thing it can do about this by itself: that puts the same question on your screen and opens nothing until you answer it.`;
	}

	/*
	 * A site an agent may sign into is the one thing a command can hand it that is somebody's account.
	 *
	 * The agent never sees the password and still: what the browser types on its behalf is the
	 * operator's own login, and an agent that could add to this list is an agent that can be talked
	 * into signing into anything the vault holds. The line is printed, because an agent asking is
	 * usually an agent stopped at exactly the login its operator meant it to have.
	 *
	 * Closing one is not on this list. Narrowing what it may do is the same kind of thing as asking
	 * to be held to a tighter ceiling, and an agent that wants less of somebody's account may have it.
	 */
	if (name === "screen" && rest[0] !== undefined && /^(login|signin|sign-in)$/.test(rest[0])) {
		const [, first = "", ...after] = rest;
		if (first !== "off" && first !== "drop" && first !== "close") {
			const host = [first, ...after].join(" ").trim();
			return `This agent asked to be able to sign into ${host === "" ? "a site" : host} out of your vault. That one stays with you: /screen login ${host}, if you meant it.`;
		}
	}

	if (name === "repo") {
		const [first = ""] = rest;
		// Asking what it holds widens nothing; it is told the same list at the start of every turn.
		if (first === "") return undefined;
		// A token an agent is holding is a token it got from something it read, and the one thing it
		// should not be able to do with it is put it into this plane. Not printed, for the reason a bot
		// token is not.
		if (looksLikeGithubToken(first)) {
			return "This agent asked to keep a GitHub token, and nothing an agent can ask for may put a credential into this plane. If it needs a repository, that one is yours to give: /repo <owner/name>.";
		}
		return `This agent asked for a repository. That one stays with you, because holding one spends your GitHub token on it: /repo ${rest.join(" ")}, if you meant it.`;
	}

	if (name === "telegram") {
		// Deliberately without the line it asked for, unlike every other refusal here. This is the one
		// where printing it would be the attack: a token the agent was handed by something it read,
		// pasted by an operator who was only being helpful, is a stranger's bot wired to somebody else's
		// agent — and the first person to tap the pairing link is the one it takes instructions from.
		return "This agent asked about its Telegram bot. That one stays with you: /telegram decides who may instruct it, and nothing an agent can ask for may move that.";
	}

	if (name === "email") {
		// Withheld for the same reason, and it reaches further than a bot does. One mailbox serves every
		// agent on the plane, so an address the agent was handed by something it read is not a mistake
		// about this agent — it is a stranger reading and answering the mail of all of them.
		return "This agent asked about email. That one stays with you: /email connects the mailbox every agent here is reached at, and decides whose mail is read as instructions.";
	}

	// Not a widening and not destructive, and still not the agent's to ask for: the screen is drawn on
	// the operator's terminal and nothing said in a conversation can put a key into it. An agent that
	// asked is an agent missing something, so the line it wanted is printed under the reason.
	if (name === "config") {
		return "This agent asked for the config screen. It is a screen rather than a command, and it is the whole plane's rather than this agent's — the keys every agent is paid for with, and the mailbox all of them are reached at: /config, to see what it was after.";
	}

	if (name === "mcp" || name === "plugins") {
		const [verb = "", named = "", ...target] = rest;
		if (verb === "forget") {
			return `This agent asked to take "${named}" off the shelf, which takes it off every agent that has it and not only this one: /plugins forget ${named}, if you meant it.`;
		}
		if (verb === "logout") {
			return `This agent asked to log out of "${named}". The account is one you opened in a browser and it is yours to close: /plugins logout ${named}.`;
		}
		// The half of a login that carries an address is the operator walking back from a consent
		// screen. An agent holding one has not been to a consent screen; it has an address it got
		// somewhere, and finishing a login with it is the one way this could end in a token.
		if (verb === "login" && /^https?:\/\//i.test(target[0] ?? "")) {
			return `This agent asked to finish a login with an address of its own. The trip back from a consent screen is yours to make: /plugins login ${named} <address>.`;
		}
	}

	return undefined;
}
