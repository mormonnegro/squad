import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { AGENT_NAME_PATTERN, SANDBOX_REPO_PATH } from "@squad/agent-repo";
import {
	type Account,
	addressFor,
	appPasswordPage,
	asOperator,
	type Bot,
	baseAddress,
	CARRIERS,
	type CarrierSpec,
	type Channel,
	ChannelRouter,
	closedTo,
	discover,
	EmailChannel,
	type Hook,
	needsBridge,
	pairingPhrase,
	type Reply,
	resolveCarrier,
	type Signer,
	startLink,
	TelegramChannel,
	tooWide,
	WebhookChannel,
} from "@squad/channels";
import { type AgentEvent, EventBus, FileEventStore, isOwnNote } from "@squad/events";
import {
	type AuditEntry,
	EgressBroker,
	EnvSecretStore,
	type Grant,
	GrantSet,
	loadOrCreateCertificateAuthority,
	OAuthLogins,
	OAuthSecretStore,
	oauthRef,
	type Reachability,
	reachability,
	type SecretStore,
	StaticAgentDirectory,
} from "@squad/proxy";
import {
	DEFAULT_DEPLOYMENT,
	DockerEngine,
	DockerSandboxManager,
	SANDBOX_SCREEN_EXTENSION,
} from "@squad/sandbox";
import {
	FileScheduleStore,
	type NewSchedule,
	readWhen,
	type Schedule,
	Scheduler,
} from "@squad/scheduler";
import { buildScreenImage, DockerScreens, SCREEN_VIEW_PORT } from "@squad/screen";
import { AgentNameStore } from "./agent-names.ts";
import {
	agentMayNot,
	COMPLETE_SCRIPT,
	type CommandContext,
	type EmailOffer,
	type EmailStanding,
	endedIn,
	type LoginPage,
	money,
	runCommand,
	SHELL_TIMEOUT_MS,
	shellOutput,
	shellScript,
	type TelegramStanding,
	withoutSecrets,
} from "./commands.ts";
import { ExecStream } from "./exec-stream.ts";
import {
	FILE_CHUNK,
	folderOf,
	insideBox,
	LIST_SCRIPT,
	type Listing,
	MOST_ENTRIES,
	nameOfPath,
	READ_SCRIPT,
	readAnswer,
	refused,
	type Slice,
	tilde,
	WRITE_SCRIPT,
	type Wrote,
} from "./files.ts";
import { type Gate, Gates, gateOf, gateSaid } from "./gates.ts";
import {
	AddedGrants,
	carriedBy,
	type GrantStanding,
	originOf,
	PipedHosts,
	reachId,
	readHost,
} from "./grants.ts";
import { ProviderKeys } from "./keys.ts";
import { LOG_CHUNK, LOGS_SCRIPT, type Printed } from "./logs.ts";
import { MailboxStore, type MailStanding } from "./mailbox.ts";
import {
	hostOf,
	type McpServer,
	McpShelf,
	type NamedServer,
	readName,
	readServer,
	type ServerStanding,
} from "./mcp.ts";
import {
	AddedModels,
	type Catalog,
	type Model,
	type ModelChoice,
	ModelChoices,
	type ModelOffer,
	type ModelSpec,
	type ModelStanding,
	modelGrants,
	offersOf,
	PROVIDERS,
	type ProviderStanding,
	providersOf,
	resolveModel,
} from "./models.ts";
import { LoginDesk, loginRedirect } from "./oauth-login.ts";
import type { AgentStep } from "./pi-output.ts";
import { RELAY_PATH } from "./pi-session.ts";
import { nameFor, PLUGINS, type Plugin, pluginAt, pluginOf, serverOf } from "./plugins.ts";
import { type Served, ServedPorts } from "./ports.ts";
import { type Question, StandingQuestions } from "./questions.ts";
import {
	checkRepo,
	GITHUB_TOKEN_ENV,
	HeldRepos,
	listRepos,
	type RepoHold,
	type RepoOffer,
	type RepoOrigin,
	type RepoSpec,
	type RepoStanding,
	repoGrants,
	standingOf as repoStanding,
} from "./repos.ts";
import { nameRefused, type Room, RoomChannel, Rooms, roomChannel } from "./rooms.ts";
import { hasScreen, ScreenChoices, type ScreenStanding } from "./screens.ts";
import {
	DEFAULT_SEARCH_PROVIDER,
	resolveSearch,
	SEARCH_PROVIDERS,
	type Search,
	SearchChoice,
	type SearchSpec,
	type SearchStanding,
	searchGrant,
} from "./search.ts";
import { ensureSelfRepo } from "./self.ts";
import {
	copySkill,
	type Skill,
	skillPath,
	nameRefused as skillRefused,
	skillsOf,
} from "./skills.ts";
import { SpendLedger } from "./spend.ts";
import {
	AgentChannel,
	agentChannel,
	agentIn,
	hopsIn,
	MOST_HOPS,
	mentioned,
	type Sent,
	TeamEdges,
	type Teammate,
} from "./team.ts";
import { TelegramBots } from "./telegram.ts";
import { overheard, sentTo, Transcript, type Utterance } from "./transcript.ts";
import {
	hookOf,
	newName,
	newSecret,
	type Trigger,
	Triggers,
	nameRefused as triggerRefused,
} from "./triggers.ts";
import {
	createTurnHandler,
	PiTurnRunner,
	type TurnResult,
	type TurnRunner,
	type WakeChange,
} from "./turn.ts";
import {
	resolveVision,
	VISION_PROVIDERS,
	VisionChoice,
	type VisionOffer,
	type VisionSpec,
	type VisionStanding,
	visionGrant,
} from "./vision.ts";

export interface AgentConfig {
	readonly id: string;
	/** Written into the agent's repository when it is first created, and its to edit afterwards. */
	readonly description?: string;
	/**
	 * What the agent is allowed to reach. Approved by an operator, never read from the agent's own
	 * manifest: the manifest lives in a repository the agent can commit to, so a grant taken from it
	 * would be a grant the agent wrote itself.
	 */
	readonly grants?: readonly Grant[];
	/**
	 * GitHub repositories it holds, each with the branches it may push. Four words that become three
	 * grants, derived where the model grants are — see repos.ts for which three and why.
	 */
	readonly repos?: readonly RepoSpec[];
	readonly provider?: string;
	readonly model?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly memoryBytes?: number;
	readonly nanoCpus?: number;
	readonly schedules?: readonly Omit<NewSchedule, "agentId">[];
	/**
	 * The other agents on this plane it may write to, without anybody being asked first.
	 *
	 * The operator's, like every other capability here, and for a reason of its own: a message wakes
	 * another agent and spends its ceiling, so an agent that could name its own correspondents could
	 * spend a plane's whole day by asking everybody for something. What an agent may do about a name
	 * that is not on this list is ask, which puts the name on a screen with a key to press.
	 */
	readonly talksTo?: readonly string[];
	/**
	 * The most this agent may spend in a day, in US dollars.
	 *
	 * An agent that books its own next turn can spend all night without anybody deciding that it
	 * should, which is the one failure here that arrives as a bill rather than as a bug. A ceiling
	 * set at the keyboard overrides this one, and neither is written back to the operator's file.
	 */
	readonly limitUsd?: number;
	/**
	 * Whether this agent gets a browser of its own, in a container beside its sandbox.
	 *
	 * Declared here and switched at the console, because it is both: an agent whose whole job is the
	 * web should come up with a screen every time this plane starts, and an agent that needs one for
	 * the next twenty minutes should not need an edit to this file and a redeploy. The console wins
	 * while it disagrees, and never writes back here.
	 */
	readonly screen?: boolean;
}

/** What every agent starts from: the same shape as an agent, minus the one thing that names it. */
export type AgentDefaults = Omit<AgentConfig, "id">;

/**
 * Fills in what an agent did not say for itself.
 *
 * Lists are joined rather than replaced, so an agent that asks for one host of its own keeps the
 * grant that lets it reach the model. An id declared twice is the agent's, which is the only way to
 * narrow a default rather than add to it.
 */
export function withDefaults(agent: AgentConfig, defaults?: AgentDefaults): AgentConfig {
	if (defaults === undefined) return agent;
	const grants = [
		...(agent.grants ?? []),
		...(defaults.grants ?? []).filter(
			(grant) => !(agent.grants ?? []).some((own) => own.id === grant.id),
		),
	];
	const env = { ...defaults.env, ...agent.env };
	const schedules = [...(defaults.schedules ?? []), ...(agent.schedules ?? [])];

	return {
		...defaults,
		...agent,
		...(grants.length > 0 ? { grants } : {}),
		...(Object.keys(env).length > 0 ? { env } : {}),
		...(schedules.length > 0 ? { schedules } : {}),
	};
}

export interface ControlPlaneOptions {
	readonly agents: readonly AgentConfig[];
	/** Applied to every agent, and the whole of what an agent created at runtime is. */
	readonly defaults?: AgentDefaults;
	/**
	 * Every model this plane may think with, which is the whole of what `/model` can choose from.
	 *
	 * What each of them costs to reach is already in the defaults by the time this arrives: the
	 * grants and the placeholder keys are folded in when the configuration is read, so this is the
	 * list itself rather than a second source of capability.
	 */
	readonly models?: readonly Model[];
	/** Host directory for durable state: event queues, schedules and the proxy CA. */
	readonly stateDir: string;
	readonly image?: string;
	/**
	 * The image a screen runs, when it is not the one built on this machine.
	 *
	 * Beside the sandbox's and for its reason: which images this install runs is a fact about how it
	 * was installed rather than a decision about any agent, so it comes from the environment and the
	 * operator's file stays the same either way.
	 */
	readonly screenImage?: string;
	readonly hooks?: readonly Hook[];
	readonly secrets?: SecretStore;
	readonly networkName?: string;
	/**
	 * What this deployment is called, and the first word of every container and volume it makes.
	 *
	 * Two on one machine is the whole reason it exists: without it they share `squad-scout` and the
	 * volume behind it, and one agent's soul lands on top of another's. Left out it is `squad`, so
	 * a plane that never heard of this keeps the names it already gave things.
	 */
	readonly deployment?: string;
	readonly proxyPort?: number;
	/**
	 * How a sandbox addresses the proxy, as host:port.
	 *
	 * The sandbox network is internal, which really does mean unrouted: a container on it cannot
	 * reach the host at all, not by gateway address and not by host.docker.internal. So this names
	 * the proxy's alias on that same network, and the proxy has to be on it.
	 */
	readonly proxyOrigin?: string;
	readonly webhookPort?: number;
	/** How long a turn may go without a word before it is given up on. Not how long it may take. */
	readonly turnIdleMs?: number;
	readonly onAudit?: (entry: AuditEntry) => void;
	readonly onError?: (context: string, error: Error) => void;
	/** Called with whatever the agent said. Without it a running control plane is silent. */
	readonly onTurn?: (agentId: string, result: TurnResult) => void;
}

/**
 * How much of a running turn is kept for whoever opens a console in the middle of it.
 *
 * The same eight rows the pane draws, because that is the whole purpose: what is kept is what a
 * reader arriving late can be shown, and keeping more would be keeping it for nobody.
 */
const KEPT_STEPS = 8;

/** Everything worth watching from outside, in one shape so a subscriber can render a single feed. */
export type PlaneEvent =
	| { readonly kind: "audit"; readonly entry: AuditEntry }
	| { readonly kind: "turn"; readonly agentId: string; readonly result: TurnResult }
	| { readonly kind: "error"; readonly context: string; readonly message: string }
	/** A piece of an answer being written. The whole of it arrives again as a turn. */
	| { readonly kind: "say"; readonly agentId: string; readonly text: string }
	/**
	 * A line of the conversation, as it goes into the transcript that outlives the console.
	 *
	 * `queued` says it arrived at an agent that was already mid-turn, so nobody has heard it yet. It is
	 * not part of the transcript and is deliberately not written down: it is true for a few minutes and
	 * false forever after, and a console opened tomorrow would be reading it as news. Said out loud
	 * because only the plane knows — the words are the same either way, and a console left to guess
	 * from them would guess.
	 */
	| {
			readonly kind: "said";
			readonly agentId: string;
			readonly said: Utterance;
			readonly queued?: boolean;
	  }
	/**
	 * The conversation thrown away, so that whoever is showing it stops showing it.
	 *
	 * Said rather than left to the console that asked, because the console is not the only thing
	 * holding this and need not be the thing that cleared it: a second console open on the same plane
	 * would otherwise go on displaying a conversation that no longer exists anywhere else, and start
	 * appending to it.
	 */
	| { readonly kind: "cleared"; readonly agentId: string }
	/**
	 * The rooms have changed: one made, one gone, somebody in or out of one.
	 *
	 * Said without saying what changed, because a roster is four names and asking for it again is
	 * cheaper than describing an edit — and every console watching wants the same answer anyway.
	 */
	| { readonly kind: "rooms" }
	/** A trigger made or taken down. Asked for again rather than described, like the rosters. */
	| { readonly kind: "triggers" }
	/**
	 * A turn starting, which is a different moment from the message that caused it: a burst is one
	 * turn, and a message arriving at a busy agent waits for the one in front of it to finish.
	 *
	 * The console needs this said outright. A turn nobody in the room asked for — a schedule, a
	 * webhook, an agent waking itself — looks exactly like one that never happened otherwise.
	 */
	| {
			readonly kind: "thinking";
			readonly agentId: string;
			/**
			 * When it began, which is not always now.
			 *
			 * A console that opens mid-turn is caught up with this event, and a clock started at the
			 * moment it arrived would tell that console the turn is four seconds old when it is four
			 * minutes old — which, for a reader deciding whether to wait or to stop it, is the one
			 * number that matters said wrong.
			 */
			readonly at?: string;
	  }
	/** Something an agent did inside its sandbox, reported while the turn is still running. */
	| { readonly kind: "step"; readonly agentId: string; readonly step: AgentStep }
	/**
	 * A page the operator has to look at, which is only ever a consent screen.
	 *
	 * Asked of whoever is watching rather than opened here, because the plane is usually not where
	 * the person is: in the deployment it is a container with no desktop, and the console is on the
	 * machine with the browser. The URL is in the conversation either way — this only saves copying
	 * a hundred characters out of a pane that had to wrap them.
	 */
	| { readonly kind: "open"; readonly url: string }
	/**
	 * Something the plane did that is not a turn, in the columns a turn is already reported in.
	 *
	 * Shaped like the feed's own rows on purpose. A mailbox declining two hundred newsletters is worth
	 * a line and is not worth two hundred, and a line that had nowhere to sit would either be dropped
	 * or printed in a gutter of its own.
	 */
	| {
			readonly kind: "note";
			readonly who: string;
			readonly action: string;
			readonly detail: string;
	  };

export interface AgentSummary {
	readonly id: string;
	readonly running: boolean;
	readonly startedAt: string | undefined;
	readonly grants: number;
	readonly schedules: number;
	/** When this agent next wakes, whoever booked it — its own, yours, or the file's. ISO instant. */
	readonly wakeAt: string | undefined;
	/** Made here rather than declared in the config, which is the only kind the plane may forget. */
	readonly created: boolean;
	/** What it has spent today, and the ceiling it is spending against, in US dollars. */
	readonly spentUsd: number;
	readonly limitUsd: number | undefined;
	/**
	 * What it thinks with: the model it was moved onto at the console, or the config's if it has not
	 * been moved.
	 *
	 * The one fact about an agent that changes what every answer costs and how good it is, and the
	 * one nothing on screen used to say: the way to find it out was to go and read the operator's
	 * file, which is the wrong place to learn it from while an agent is answering badly — and now
	 * also the wrong answer, since a console can move an agent onto another one.
	 */
	readonly model: string | undefined;
	/**
	 * The ports inside its sandbox that are open where the operator is, and where each comes out.
	 *
	 * On the summary rather than asked for separately because the console is what makes them true: it
	 * reads this list, binds what is on it and lets go of what is not, so a port opened at another
	 * console — or by the agent itself, at the end of a turn — is open here within the same two
	 * seconds as everything else on this row.
	 */
	readonly served: readonly Served[];
	/**
	 * The hosts it has asked to reach and nobody has answered, oldest first.
	 *
	 * On the summary rather than sent as an event for the reason the ports are: this row is read
	 * every two seconds anyway, and a question that only ever arrived as an event would be a question
	 * missed by every console that was not running when it was asked.
	 */
	readonly asking: readonly string[];
	/**
	 * The other agents it has written to and may not, oldest first, waiting on a yes or a no.
	 *
	 * Beside the hosts and for their reason: the console draws this row every two seconds anyway, and
	 * a question that arrived only as an event is one that every console not running at that moment
	 * never hears. The message itself is held by the plane until somebody answers.
	 */
	readonly wants: readonly string[];
	/**
	 * What it has asked its operator, with the answers it wrote for them, newest last.
	 *
	 * Beside the hosts and the peers because it is the same kind of fact — a thing waiting on a
	 * person — and drawn in the same place, which is the conversation. What is different about it is
	 * that the plane has no opinion at all about the answer: pressing one of these sends the agent's
	 * own sentence back as the operator's message, and that is the whole of it.
	 */
	readonly questions: readonly Question[];
	/**
	 * The answers it has written that are waiting to be let out, oldest first.
	 *
	 * The words themselves, because that is what is being decided: the other two questions are "may
	 * it", asked before anything exists, and this one is about a message already written. Whoever
	 * says yes is saying yes to what is on the screen.
	 */
	readonly sending: readonly { readonly channel: string; readonly body: string }[];
	/** What it must be asked about before it goes out in the operator's name. */
	readonly gates: readonly Gate[];
	/**
	 * The Telegram bot it answers on, if one is connected, and whether anybody has paired with it.
	 *
	 * Here rather than asked for per agent because the column draws the whole fleet at once, and a
	 * fact that costs a request each is a fact a list of six agents cannot afford to have. Both of
	 * these are read off the record the plane already holds, so the summary costs what it did.
	 *
	 * The pairing matters as much as the bot: a token pasted and never paired is a bot that looks
	 * connected from every screen there is and listens to nobody.
	 */
	readonly bot: { readonly username: string | undefined; readonly paired: boolean } | undefined;
	/**
	 * Where mail reaches it, when the plane has a mailbox, and whether it can answer from there.
	 *
	 * Every agent has an address the moment the plane has an account — it is a tag on that one — so
	 * this is absent for all of them or present for all of them, which is why it is drawn dim: the
	 * fact worth a colour is the mailbox that can only be written to, where an agent reads its mail
	 * and has no way to reply.
	 */
	readonly mail: { readonly address: string; readonly writes: boolean } | undefined;
}

/**
 * The channel a wakeup arrives on when it belongs to no conversation, and answers back to.
 *
 * It is registered rather than left unrouted so that a turn nobody else asked for does not also
 * report a failure to deliver its answer. Nothing is lost by absorbing it: every turn reaches the
 * console as it is written, and there is nobody else at the other end of a note to oneself.
 */
export const WAKE_CHANNEL = "wake";

/** The soonest an agent may ask to be woken: the next turn, near enough. */
export const MIN_WAKE_SECONDS = 1;

/** The furthest. Past a month it is not scheduling work, it is leaving a note for a stranger. */
export const MAX_WAKE_SECONDS = 30 * 24 * 60 * 60;

class SelfChannel implements Channel {
	readonly name = WAKE_CHANNEL;

	async send(): Promise<void> {}
}

function standingOf(bot: Bot): TelegramStanding {
	return {
		username: bot.username,
		paired: bot.operators.length > 0,
		chats: bot.chats.length,
		link:
			bot.pairing !== undefined && bot.username !== undefined
				? startLink(bot.username, bot.pairing)
				: undefined,
		phrase: bot.pairing,
	};
}

/**
 * How long a forwarded connection waits for something to be listening on the port it was opened for.
 *
 * Long enough to ride out a dev server restarting under a page being reloaded, short enough that a
 * link to a port with nothing behind it fails while the person who clicked it is still looking.
 */
const FORWARD_CONNECT_MS = 3000;

const DEFAULT_IMAGE = "squad/sandbox:dev";
const DEFAULT_NETWORK = "squad-egress";
const DEFAULT_PROXY_PORT = 8080;
const DEFAULT_WEBHOOK_PORT = 8787;

/**
 * Wires the pieces into something that can be started.
 *
 * Everything an agent can be told to do arrives as an event and leaves as a reply, so a webhook, a
 * cron tick and a human message are the same shape by the time the agent sees them, and the trust
 * label they carry is the only thing that decides whether the agent may act on the contents.
 */
export class ControlPlane {
	readonly bus: EventBus;
	readonly scheduler: Scheduler;
	readonly router = new ChannelRouter();
	readonly sandboxes: DockerSandboxManager;
	/**
	 * The browsers, which are containers of their own rather than anything inside a sandbox.
	 *
	 * Public beside the sandboxes because the same things are true of it: the plane makes them, the
	 * console asks about them, and neither of those is a secret the plane needs to keep from itself.
	 */
	readonly screens: DockerScreens;
	/** The daemon itself, for the one thing neither manager does: building an image. */
	readonly #docker: DockerEngine;
	readonly directory = new StaticAgentDirectory();
	readonly broker: EgressBroker;
	readonly webhooks: WebhookChannel;
	readonly telegram: TelegramChannel;
	readonly email: EmailChannel;

	readonly #agents: AgentConfig[];
	/**
	 * Every agent the config declared, whether or not it is still in the list above.
	 *
	 * Kept because a declared agent can be deleted here and made again later, and what should come
	 * back then is the agent the operator wrote — its grants, its model, its description — rather
	 * than a bare one with the defaults' reach and the same name.
	 */
	readonly #declared: readonly AgentConfig[];
	readonly #defaults: AgentDefaults | undefined;
	readonly #created: AgentNameStore;
	/**
	 * The declared agents somebody deleted, which is the only way a delete can outlive the process.
	 *
	 * The config file is the operator's and no plane may write it, so there is nowhere to take a
	 * declared name out of. The deletion is written down instead: a name in here is skipped at every
	 * start, so an agent that was thrown away stays thrown away rather than being back in the column
	 * after a restart, which is a delete that did not delete.
	 */
	readonly #deleted: AgentNameStore;
	readonly #transcript: Transcript;
	readonly #runners = new Map<string, TurnRunner>();
	/**
	 * Agents whose conversation was thrown away while they were mid-turn.
	 *
	 * A stopped turn still comes back with as far as it got, and that half-paragraph belongs to a
	 * conversation that no longer exists: written down it would be the whole of what a cleared agent
	 * remembers, and shown it would be the one thing left in an emptied pane. Held only for the moment
	 * between the stop and the turn handing in its remains.
	 */
	readonly #clearedMidTurn = new Set<string>();
	readonly #spend: SpendLedger;
	/**
	 * Which ports each agent has open on whatever machine a console is running on.
	 *
	 * Kept by the plane rather than by the console because the console is not the only thing that asks
	 * for one — an agent that has just started a dev server asks too, at the end of a turn nobody was
	 * watching — and because two consoles looking into the same plane should find the same links.
	 */
	readonly #served: ServedPorts;
	/** Which agents an operator has turned a screen on for, which outranks what the file declares. */
	readonly #screenChoices: ScreenChoices;
	/**
	 * The browser image being built, while it is being built.
	 *
	 * One build at a time and never two, because the first `/screen on` on a fresh install is the one
	 * that pays for Chromium and it takes minutes: an operator who typed it twice, or two agents given
	 * screens in the same minute, would otherwise have the machine building the same image twice.
	 */
	#buildingScreens: Promise<void> | undefined;
	/**
	 * Which sandboxes carry the screen tools, by the container that was asked.
	 *
	 * Asked at all because pi refuses to start when it is handed an extension that is not there — not
	 * warns, refuses — so passing the flag to a sandbox built before these tools existed would not cost
	 * the agent a browser: it would cost it every turn, with the reason in a message about a file path.
	 * A published sandbox image lags the plane's own by however long it is between releases, and that
	 * gap is exactly where somebody would first type `/screen on`.
	 *
	 * By container id rather than by agent, because the answer cannot change under a container — a file
	 * appears in there by the container being replaced, and a replaced container has a new id.
	 */
	readonly #screenToolsIn = new Map<string, boolean>();
	/**
	 * The file each served port was last seen printing into, so that a server which has stopped can
	 * still be read.
	 *
	 * The whole value of a log is at the end of it, and the end of it is written on the way down: a
	 * screen that could only find the file by asking which process holds the port would go blank at
	 * the exact moment somebody opened it. Read out of `/proc` by the plane itself and never from
	 * anything the agent said, and forgotten when the plane restarts — it is a shortcut back to a
	 * file, not a record of anything.
	 */
	readonly #printing = new Map<string, string>();
	/** The ones the operator's file declared. The console adds to these; it never rewrites them. */
	readonly #declaredModels: readonly Model[];
	readonly #addedModels: AddedModels;
	/** The hosts opened at the console, on top of the ones the file grants every agent. */
	readonly #addedGrants: AddedGrants;
	/** The hosts this plane pipes rather than reads, for the browsers that cannot survive being read. */
	readonly #piped: PipedHosts;
	readonly #addedTeam: TeamEdges;
	/** What an agent must be asked about before it goes out, and the messages waiting on an answer. */
	readonly #gates: Gates;
	/** What outside this plane may give an agent a turn, and which deliveries were already taken. */
	readonly #triggers: Triggers;
	readonly #sending = new Map<string, Reply[]>();
	/** The rooms made at a console, and what each one has said, which is a conversation of its own. */
	readonly #rooms: Rooms;
	readonly #roomTalk: Transcript;
	/** The repositories given to agents at the console, on top of the ones their file declares. */
	readonly #repos: HeldRepos;
	/**
	 * The repository `/repo` last asked for and could not hold for want of a token, waiting for one.
	 *
	 * Held for the reason the email offer is: it was typed one line ago and the console is still
	 * showing it. Not on disk, and cleared the moment it is held.
	 */
	#offeredRepo: { readonly agentId: string; readonly spec: RepoSpec } | undefined;
	readonly #choices: ModelChoices;
	/**
	 * The same store the broker resolves grants against, kept so the plane can ask whether a key is
	 * there at all — never for the value, which belongs on the wire and nowhere else.
	 */
	readonly #secrets: SecretStore;
	/** The half of that store this plane may write: the provider keys given at the console. */
	readonly #keys: ProviderKeys;
	readonly #mcp: McpShelf;
	/** Which provider the web_search tool goes through, when somebody has chosen one at the console. */
	readonly #search: SearchChoice;
	/** Which model looks at pictures, when an operator has decided that looking is worth paying for. */
	readonly #vision: VisionChoice;
	readonly #bots: TelegramBots;
	readonly #mailbox: MailboxStore;
	/**
	 * The address `/email` last looked up, waiting for the password that finishes it.
	 *
	 * Held rather than asked for again, because it was typed one line ago and the console is still
	 * showing it. Not on disk: an offer nobody completed is a question left hanging, and a plane that
	 * restarted should ask it again rather than resume it.
	 */
	#offered: EmailOffer | undefined;
	/** What went wrong the last time the mailbox was read, so `/email` can say so without a request. */
	#mailTrouble: string | undefined;
	/**
	 * What the submission server said when it refused the password the mailbox was connected with.
	 *
	 * Kept because the account itself only records the outcome — nowhere to hand mail in — and that on
	 * its own reads like a provider that never offered. Whether it was refused or never offered decides
	 * what to do about it, so the words the provider used are worth the field.
	 */
	#mailMute: string | undefined;
	readonly #logins: OAuthLogins;
	readonly #desk: LoginDesk;
	/**
	 * Where each agent's last `!` left the operator standing.
	 *
	 * Kept here rather than in the console, because it is a fact about the box: two consoles looking
	 * into the same one are looking at the same directory, and it survives either of them closing.
	 * Not written to disk — a plane that restarted put a new sandbox under it, and the door is the
	 * honest place to be standing then.
	 */
	readonly #cwd = new Map<string, string>();
	readonly #createdIds = new Set<string>();
	readonly #stateDir: string;
	readonly #image: string;
	readonly #proxyPort: number;
	readonly #proxyOrigin: string;
	readonly #webhookPort: number;
	readonly #turnIdleMs: number | undefined;
	readonly #tokens = new Map<string, string>();
	/**
	 * The hosts each agent has asked to reach and nobody has answered yet, oldest first.
	 *
	 * Held for as long as this plane runs and no longer. A question is worth keeping while there is
	 * somebody who might answer it, and a plane that has just restarted has told every console it had
	 * that it went away — while the agent, which is the thing that actually knows whether it still
	 * needs the host, finds out the moment it is refused again and can ask again then. What survives
	 * either way is the asking itself, which is written into the conversation like everything else.
	 */
	readonly #asking = new Map<string, string[]>();
	/**
	 * The messages each agent has written to an agent it may not write to, held until somebody says.
	 *
	 * Held here rather than delivered-and-undone because there is no undoing a turn: the message is
	 * what wakes the other agent, so holding it is the only place a question can be asked from. Kept
	 * for as long as this plane runs, on the asking's terms — a plane that restarted told every
	 * console it went away, and an agent still needing this writes again on a later turn.
	 */
	readonly #wanting = new Map<string, Sent[]>();
	/**
	 * The questions each agent has put to its operator and nobody has pressed anything on.
	 *
	 * Held for as long as this plane runs, on the asking's terms — and the rules for when one goes
	 * away are the other half of the feature, because a card that outlives its moment is worse than
	 * no card at all. It goes when the operator says anything to that agent at all, pressing an
	 * option being one way of saying something: a question is addressed to them, and them answering
	 * it in any form is the end of it. It is replaced when a later turn asks something new. And it is
	 * left exactly where it is by a turn that asked nothing, which is not a detail — the commonest
	 * turn after a question is the agent waking itself up to look at the same page again, and a card
	 * that vanished then would vanish while the person it was for was still asleep.
	 */
	readonly #questions = new Map<string, readonly Question[]>();
	/**
	 * The same, on disk, because this is the one of the four that a restart must not drop.
	 *
	 * A host an agent could not reach is asked about again the moment it is refused again: the agent
	 * is the thing that knows whether it still needs it, and it finds out by trying. A question has no
	 * such second chance — nothing makes an agent ask twice — so a card lost to a restart is an agent
	 * waiting forever for an answer nobody can give it, and an operator who watched the thing they
	 * were about to press disappear.
	 */
	readonly #standing: StandingQuestions;
	/**
	 * The turn each agent is taking right now, as the console would have drawn it.
	 *
	 * Kept because a turn's progress only ever existed as events, and events are only ever seen by
	 * whoever was watching when they happened. Reload the page mid-turn and the console came back
	 * with no idea that anything was running: an idle-looking agent, a box saying "Say something",
	 * and no stop button — while the agent went on working and the next line typed silently queued
	 * behind it. What is true of an agent has to be answerable to somebody who has just arrived,
	 * not only to somebody who never left.
	 *
	 * Bounded the way the pane that draws it is bounded: the last few steps and the answer as far as
	 * it has been written, which is exactly what a console holds for itself and no more.
	 */
	readonly #inFlight = new Map<string, { readonly at: string; steps: AgentStep[]; text: string }>();
	/**
	 * What is true for the turn each agent is taking right now: who its operator named in it, and how
	 * far the message that woke it had already travelled.
	 *
	 * Turn-scoped on purpose. A mention is consent for the turn it was typed into and not a standing
	 * arrangement, and the hop count is what stops two agents answering each other all night — both
	 * are facts about this turn, and both are gone when it ends.
	 */
	readonly #turn = new Map<string, { readonly opened: readonly string[]; readonly hops: number }>();
	readonly #onError: ((context: string, error: Error) => void) | undefined;
	readonly #onTurn: ((agentId: string, result: TurnResult) => void) | undefined;
	readonly #watchers = new Set<(event: PlaneEvent) => void>();
	#started = false;

	constructor(options: ControlPlaneOptions) {
		this.#defaults = options.defaults;
		this.#agents = options.agents.map((agent) => withDefaults(agent, options.defaults));
		this.#declared = [...this.#agents];
		this.#stateDir = options.stateDir;
		this.#image = options.image ?? DEFAULT_IMAGE;
		this.#proxyPort = options.proxyPort ?? DEFAULT_PROXY_PORT;
		this.#proxyOrigin = options.proxyOrigin ?? `egress:${this.#proxyPort}`;
		this.#webhookPort = options.webhookPort ?? DEFAULT_WEBHOOK_PORT;
		this.#turnIdleMs = options.turnIdleMs;
		this.#onError = options.onError;
		this.#onTurn = options.onTurn;
		this.#created = new AgentNameStore(join(this.#stateDir, "agents.json"), "createdAt");
		this.#deleted = new AgentNameStore(join(this.#stateDir, "deleted.json"), "deletedAt");
		this.#transcript = new Transcript(join(this.#stateDir, "transcript"));
		this.#spend = new SpendLedger(join(this.#stateDir, "spend.json"));
		this.#served = new ServedPorts(join(this.#stateDir, "served.json"));
		this.#screenChoices = new ScreenChoices(join(this.#stateDir, "screens.json"));
		this.#declaredModels = options.models ?? [];
		this.#addedModels = new AddedModels(join(this.#stateDir, "added-models.json"));
		this.#addedGrants = new AddedGrants(join(this.#stateDir, "added-grants.json"));
		this.#piped = new PipedHosts(join(this.#stateDir, "piped-hosts.json"));
		this.#standing = new StandingQuestions(join(this.#stateDir, "questions.json"));
		this.#addedTeam = new TeamEdges(join(this.#stateDir, "added-team.json"));
		this.#gates = new Gates(join(this.#stateDir, "gates.json"));
		this.#triggers = new Triggers(join(this.#stateDir, "triggers.json"));
		this.#rooms = new Rooms(join(this.#stateDir, "rooms.json"));
		// Its own, beside the agents': a room's thread is not any one agent's conversation, and the
		// agent that answered in it has the same line in its own pane for its own reasons.
		this.#roomTalk = new Transcript(join(this.#stateDir, "rooms"));
		this.#repos = new HeldRepos(join(this.#stateDir, "repos.json"));
		this.#choices = new ModelChoices(join(this.#stateDir, "models.json"));
		this.#keys = new ProviderKeys(
			join(this.#stateDir, "keys.json"),
			options.secrets ?? new EnvSecretStore(),
		);
		this.#secrets = this.#keys;
		this.#mcp = new McpShelf(join(this.#stateDir, "mcp.json"));
		this.#search = new SearchChoice(join(this.#stateDir, "search.json"));
		this.#vision = new VisionChoice(join(this.#stateDir, "vision.json"));
		this.#bots = new TelegramBots(join(this.#stateDir, "telegram.json"));
		this.#mailbox = new MailboxStore(join(this.#stateDir, "mailbox.json"));
		this.#logins = new OAuthLogins(join(this.#stateDir, "oauth.json"));
		this.#desk = new LoginDesk(this.#logins, (url) => this.#emit({ kind: "open", url }));

		// One client for both, because they are the same daemon and a second connection would only be
		// a second thing to get wrong when DOCKER_HOST is unusual.
		const engine = new DockerEngine();
		this.#docker = engine;
		this.sandboxes = new DockerSandboxManager(
			engine,
			options.networkName ?? DEFAULT_NETWORK,
			options.deployment ?? DEFAULT_DEPLOYMENT,
		);
		this.screens = new DockerScreens(
			engine,
			options.networkName ?? DEFAULT_NETWORK,
			options.deployment ?? DEFAULT_DEPLOYMENT,
			...(options.screenImage === undefined ? [] : [options.screenImage]),
		);
		this.bus = new EventBus({
			store: new FileEventStore(join(this.#stateDir, "events")),
			onError: (agentId, error) => this.#reportError(agentId, error),
			// Written down where it was said rather than where it was answered. An agent mid-turn may
			// not hear this for minutes, and a message that appeared only then would look, to the person
			// who typed it, like one the console had dropped. It is also the only recording that happens
			// once: a turn that fails is retried, and one that recorded what it was asked would write
			// the same question into the conversation again on every attempt.
			onAccepted: (event) => {
				// Asked here rather than worked out later, because this is the only moment the question has
				// an answer: a turn in flight now is the one this message is going to wait behind.
				void this.#record(event.agentId, overheard(event), this.bus.busy(event.agentId));
				// And here is where a card comes down. Whatever the agent was asking, the operator has
				// now said something to it — pressing one of the options is one way of saying something,
				// typing past the card is another, and both of them end the question. Nothing else does:
				// a webhook, a schedule or the agent waking itself leaves the card standing, because the
				// person it was addressed to has still not seen it.
				if (event.trust === "operator" && !isOwnNote(event)) this.#forgetQuestions(event.agentId);
			},
		});
		this.scheduler = new Scheduler({
			publisher: this.bus,
			store: new FileScheduleStore(join(this.#stateDir, "schedules.json")),
			onError: (schedule, error) => this.#reportError(`schedule ${schedule.id}`, error),
		});
		this.broker = new EgressBroker({
			ca: loadOrCreateCertificateAuthority(join(this.#stateDir, "pki")),
			// Layered over whatever was given, so a grant may name an environment variable or a login
			// and the broker cannot tell the difference at the moment it writes the header.
			secrets: new OAuthSecretStore(this.#logins, this.#secrets),
			directory: this.directory,
			onAudit: (entry) => {
				options.onAudit?.(entry);
				this.#emit({ kind: "audit", entry });
			},
		});
		this.webhooks = new WebhookChannel({
			hooks: options.hooks ?? [],
			// Counted where a delivery becomes a turn rather than where it arrives, so a trigger that
			// says it fired twice woke somebody twice: the ones filtered out, repeated or refused are
			// not firings, and a number that counted them could not answer "is this thing working".
			publisher: {
				publish: async (event) => {
					void this.#triggers
						.fired(event.channel.slice("webhook:".length), new Date().toISOString())
						.catch(() => undefined);
					return await this.bus.publish(event);
				},
			},
			// A retry is not a second event. Every sender worth reacting to keeps re-delivering until
			// it is told 2xx — Stripe for days — and without this an agent writes the same report
			// three times and the operator learns about the duplicate before the plane does.
			seen: (name, delivery) => this.#triggers.handled(name, delivery),
			onDropped: (name, why) =>
				this.#emit({ kind: "note", who: `#${name}`, action: "dropped", detail: why }),
		});
		this.telegram = new TelegramChannel({
			publisher: this.bus,
			// The channel learns things a message at a time — who the operator is, which chats to answer
			// in, how far it has read — and none of that may be lost to a restart. A pairing that did not
			// survive one is an operator who has to pair again without being told why.
			onChange: (bot) => {
				void this.#bots.save(bot).catch((error: Error) => {
					this.#reportError(`${bot.agentId} telegram`, error);
				});
			},
			onError: (agentId, error) => this.#reportError(`${agentId} telegram`, error),
		});
		this.email = new EmailChannel({
			publisher: this.bus,
			// Asked at the moment a message arrives rather than held, because a tag is whatever somebody
			// typed after a `+` and the agent it names may have been made since the mailbox was connected.
			agents: () => this.#agents.map((agent) => agent.id),
			// The same file every provider key is typed into. A carrier is paid for out of it rather than
			// out of the mailbox, so a key retyped at the console is in force on the next message sent.
			key: (env) => this.#keys.resolve({ ref: env }),
			onChange: (account) => {
				void this.#mailbox.save(account).catch((error: Error) => {
					this.#reportError("email", error);
				});
			},
			onError: (error) => {
				this.#mailTrouble = error.message;
				this.#reportError("email", error);
			},
			// Counted rather than listed. A mailbox is mostly not for the agent, every day, and a console
			// that printed every newsletter it declined would be a console nobody reads.
			onDropped: (why, count) =>
				this.#emit({ kind: "note", who: "email", action: "dropped", detail: `${why} ×${count}` }),
			onWatching: (where, fromUid) =>
				this.#emit({
					kind: "note",
					who: "email",
					action: "watching",
					detail: `${where}, from message ${fromUid}`,
				}),
		});
		this.router.register(this.webhooks);
		this.router.register(this.telegram);
		this.router.register(this.email);
		this.router.register(new SelfChannel());
		// The agents themselves, so that an answer to a peer goes back the way its message came. It is
		// registered beside the others because from a turn's side that is all it is: somebody wrote,
		// and the answer goes to whoever wrote.
		this.router.register(
			new AgentChannel({
				publish: (event) => this.bus.publish(event),
				has: (agentId) => this.#agents.some((agent) => agent.id === agentId),
				hops: (agentId) => this.#turn.get(agentId)?.hops ?? 0,
			}),
		);
		// The rooms, on the same terms: an agent spoken to in one answers in it, and the answer goes
		// where the question was asked rather than to whoever happened to write.
		this.router.register(
			new RoomChannel({
				members: async (name) => (await this.#rooms.of(name))?.members ?? [],
				post: (name, from, body) => this.#inRoom(name, { from: "other", via: from, text: body }),
				publish: (event) => this.bus.publish(event),
				hops: (agentId) => this.#turn.get(agentId)?.hops ?? 0,
			}),
		);
	}

	/** Host path of the CA certificate mounted into every sandbox. */
	get caCertPath(): string {
		return join(this.#stateDir, "pki", "ca.crt");
	}

	get stateDir(): string {
		return this.#stateDir;
	}

	/**
	 * Subscribes to everything the plane does. Returns the unsubscribe.
	 *
	 * The new subscriber is caught up first, on the turns that are running as it arrives: the moment
	 * each began, the steps it has taken and the answer as far as it is written. Replayed rather than
	 * offered as a separate question, because then nothing downstream has to know this happened — a
	 * console draws a turn it joined late exactly as it draws one it watched from the start, and the
	 * three ways a turn ends still end it.
	 */
	observe(listener: (event: PlaneEvent) => void): () => void {
		this.#watchers.add(listener);
		for (const [agentId, turn] of this.#inFlight) {
			listener({ kind: "thinking", agentId, at: turn.at });
			for (const step of turn.steps) listener({ kind: "step", agentId, step });
			if (turn.text.length > 0) listener({ kind: "say", agentId, text: turn.text });
		}
		return () => this.#watchers.delete(listener);
	}

	/**
	 * Every conversation the plane is keeping, oldest line first.
	 *
	 * Read whole and at once rather than an agent at a time, because a console that fetched them as
	 * it needed them would be fetching against a feed already arriving: the lines that landed while
	 * the request was in flight are exactly the ones it would then show twice.
	 */
	async transcripts(): Promise<Record<string, readonly Utterance[]>> {
		const conversations = await Promise.all(
			this.#agents.map(async (agent) => [agent.id, await this.#transcript.read(agent.id)] as const),
		);
		// The rooms in the same answer, under the address their lines arrive at. A console holds one
		// map of conversations and an agent's name cannot be a room's: `room:` is not a name.
		const rooms = await Promise.all(
			(await this.#rooms.all()).map(
				async (room) => [roomChannel(room.name), await this.#roomTalk.read(room.name)] as const,
			),
		);
		return Object.fromEntries([...conversations, ...rooms]);
	}

	/** What each agent is and whether its sandbox is up. */
	async agents(): Promise<AgentSummary[]> {
		return Promise.all(this.#agents.map((agent) => this.#summarise(agent)));
	}

	async #summarise(agent: AgentConfig): Promise<AgentSummary> {
		const status = await this.sandboxes.status(agent.id).catch(() => undefined);
		// Asked of the scheduler rather than counted off the config, which only knows the wakeups an
		// operator wrote down and would never show the one the agent booked for itself.
		const schedules = await this.scheduler.list(agent.id).catch(() => []);
		const account = await this.#account(agent.id);
		const bot = this.telegramStanding(agent.id);
		const mail = this.emailStanding(agent.id);
		return {
			...account,
			id: agent.id,
			running: status?.running ?? false,
			startedAt: status?.startedAt,
			grants: (await this.#grantsFor(agent.id)).length,
			schedules: schedules.length,
			// The soonest of all of them, whoever booked it. A row asks when this agent next does
			// something, and a task typed at a console answers that as truly as one the agent set for
			// itself — and the store's order is the store's, not the clock's.
			wakeAt: schedules
				.map((schedule) => schedule.nextRunAt)
				.sort()
				.at(0),
			created: this.#createdIds.has(agent.id),
			model: (await this.#modelFor(agent.id))?.id ?? agent.model,
			served: await this.#served.of(agent.id),
			asking: this.asking(agent.id),
			wants: this.wants(agent.id),
			sending: this.sending(agent.id),
			questions: this.questions(agent.id),
			gates: await this.#gates.of(agent.id).catch(() => []),
			bot: bot === undefined ? undefined : { username: bot.username, paired: bot.paired },
			// Cut down to the two facts a row can draw. The rest of a standing is a pairing link and a
			// host and a port, which are answers to `/telegram` and `/email` and belong in a sentence.
			mail: mail === undefined ? undefined : { address: mail.address, writes: mail.writes },
		};
	}

	/**
	 * Brings a new agent into being: a sandbox, a repository, and whatever the defaults allow it to
	 * reach.
	 *
	 * It is everything the config would have done, decided at runtime, except for the part that
	 * cannot be: the capabilities are the operator's defaults and nothing else. Whoever types a name
	 * chooses a name, never what the agent behind it may spend.
	 *
	 * Written down before it is started. A create that dies halfway leaves an agent the next start
	 * finishes, which is recoverable; the reverse leaves a container nothing remembers.
	 */
	async create(agentId: string): Promise<AgentSummary> {
		if (!AGENT_NAME_PATTERN.test(agentId)) {
			throw new Error(
				`"${agentId}" is not a name: lowercase, digits and dashes, e.g. "support-emma"`,
			);
		}
		if (this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`"${agentId}" is already here`);
		}

		// A name the config still declares is not made from nothing, it is brought back: the deletion
		// that took it out of the list is forgotten and the operator's own agent returns. Writing it
		// into this plane's file instead would leave the same name in two places, and the next delete
		// would take it out of one of them and watch the config put it back.
		const declared = this.#declared.find((agent) => agent.id === agentId);
		await this.#deleted.forget(agentId);
		const agent = declared ?? withDefaults({ id: agentId }, this.#defaults);
		if (declared === undefined) {
			await this.#created.add(agentId);
			this.#createdIds.add(agentId);
		}
		this.#agents.push(agent);
		await this.#startAgent(agent);
		return this.#summarise(agent);
	}

	/**
	 * Takes an agent's sandbox away, and optionally the repository inside it.
	 *
	 * The volume is kept by default because it is the agent: its soul, what it chose to remember and
	 * the tools it wrote for itself. A container is replaceable and none of that is, so discarding it
	 * has to be asked for, and without the purge the agent is only stopped: it comes back on the next
	 * start with everything it knew.
	 *
	 * A purge is the other thing entirely, and it takes the name too. Where the name was written down
	 * decides how: an agent made here is taken out of this plane's file, and a declared one cannot be,
	 * because the config is the operator's. So the deletion itself is written down for that one. Both
	 * leave the same way — gone from the list now, and still gone after a restart.
	 */
	async remove(agentId: string, options: { purge?: boolean } = {}): Promise<void> {
		const index = this.#agents.findIndex((agent) => agent.id === agentId);
		if (index === -1) throw new Error(`No agent "${agentId}" in this plane`);

		this.bus.unregister(agentId);
		this.#runners.delete(agentId);
		await this.sandboxes.destroy(agentId, { discardState: options.purge === true });
		// The browser goes with the agent, and the profile goes only on a purge — for the reason the
		// repository volume does. A screen stopped and started again should not cost the operator
		// every login they signed it into; a name being given away should cost them all of them.
		await this.screens
			.destroy(agentId, { discardProfile: options.purge === true })
			.catch(() => undefined);
		this.#tokens.delete(agentId);
		// The directory was inside the container that just went. Whatever comes back is at its door.
		this.#cwd.delete(agentId);
		// A question about an agent that is no longer running is a question with no answer worth
		// having, and one left here would be asked again about whoever takes the name next.
		this.#asking.delete(agentId);
		// And the messages it wrote to agents it may not write to, for the same reason: they were held
		// waiting on an answer about an agent that is gone, and a yes now would wake nobody.
		this.#wanting.delete(agentId);
		this.#turn.delete(agentId);

		if (options.purge === true) {
			if (this.#createdIds.delete(agentId)) await this.#created.forget(agentId);
			else await this.#deleted.add(agentId);
			await this.#spend.forget(agentId);
			await this.#choices.forget(agentId);
			// Whether this name had a screen was a decision about this agent, and the next one to hold
			// the name is not it: a browser nobody asked for, already signed in, would be the worst kind
			// of inheritance.
			await this.#screenChoices.forget(agentId);
			// The ports go with the container they pointed into. Left behind, the next agent to take
			// this name would inherit links to servers it never started.
			await this.#served.forget(agentId);
			// The conversation goes with the name. What was said to this agent is about the repository
			// that just went, and keeping it would hand a conversation to whoever gets the name next.
			await this.#transcript.forget(agentId);
			// What it was given, not what was found: a server stays on the shelf for the agents that
			// are left, and for the one somebody makes next.
			await this.#mcp.forgetAgent(agentId);
			// Doors opened at the console, from both ends. A name is reused, and an agent made again
			// with this one would inherit correspondents nobody in this plane ever gave it.
			await this.#addedTeam.forget(agentId);
			// And out of every room, for the same reason and with the same care: the room stays, so
			// what was said in it is still there to read, and nobody is quietly re-admitted to it.
			await this.#rooms.forget(agentId);
			this.#emit({ kind: "rooms" });
			// What it had to be asked about goes with the name, like every other thing decided here.
			await this.#gates.forget(agentId);
			this.#sending.delete(agentId);
			this.#forgetQuestions(agentId);
			// The doors into it go with it. A trigger left standing would be an address on somebody
			// else's dashboard pointing at an agent this plane no longer has.
			for (const name of await this.#triggers.forget(agentId)) this.webhooks.drop(name);
			this.#emit({ kind: "triggers" });
			// The bot is this agent as far as anyone writing to it is concerned, so it goes with the name.
			// The token stays good at BotFather's end; what stops is this plane answering with it.
			await this.disconnectTelegram(agentId);
			this.#agents.splice(index, 1);
		}
	}

	/**
	 * Puts a runtime behind an agent id: from here on, events for it become turns.
	 *
	 * Separate from starting a sandbox so that what an agent runs in is one decision and what it
	 * answers with is another, and so a caller with its own runner still gets the plane's wiring.
	 */
	async attach(agentId: string, runner: TurnRunner): Promise<void> {
		this.#runners.set(agentId, runner);
		const handler = createTurnHandler({
			runner,
			// The router, with a door in front of it. An answer that would leave in the operator's name
			// stops here when they have said it should, and waits where they will see it.
			router: { send: (reply) => this.#sendOut(reply) },
			onStart: (id) => this.#began(id),
			onTurn: (id, result, to) => {
				// Before anything else: from here on there is no turn in flight, so a console opening in
				// the next millisecond is not caught up onto one that has finished.
				this.#inFlight.delete(id);
				this.#onTurn?.(id, result);
				this.#emit({ kind: "turn", agentId: id, result });
				void this.#spend.record(id, result.costUsd);
				// Not into a conversation that was thrown away while this turn was taking it: as far as
				// it got is the one thing that would be left in an emptied pane, and the whole of what a
				// cleared agent is written down as remembering. The feed above still has it.
				if (result.text.length > 0 && !this.#clearedMidTurn.has(id)) {
					// Marked with where it went, so an answer the operator asked for by mail is one they
					// can see leave. Without it the pane shows the agent answering and says nothing about
					// the mail, which reads exactly like the mail never went.
					const went = sentTo(to);
					void this.#record(id, {
						from: "agent",
						text: result.text,
						...(went !== undefined ? { to: went } : {}),
					});
				}
				// Under the agent's name and a word, so it lands in the log rather than in the
				// conversation: the agent is already told which servers failed and why, and a plane
				// saying the same thing beside it is the operator reading it twice.
				for (const trouble of troubledServers(result.stderr)) {
					this.#reportError(`${id} mcp`, new Error(trouble));
				}
				if (result.stopped) this.#reportStopped(id);
			},
			onSay: (id, text) => {
				const turn = this.#inFlight.get(id);
				if (turn !== undefined) turn.text += text;
				this.#emit({ kind: "say", agentId: id, text });
			},
			onWake: (id, wake, answering) => this.#applyWake(id, wake, answering),
			onAsked: (id, asked) => this.#applyAsked(id, asked),
			onSent: (id, sent) => this.#applySent(id, sent),
			onQuestions: (id, questions) => this.#applyQuestions(id, questions),
			// Named by destination, not by agent, so an operator waiting on their own reply is not
			// told that somebody else's channel is the reason.
			onUndelivered: (id, channel, error) => this.#reportError(`${id} -> ${channel}`, error),
		});

		// The ceiling is checked here rather than inside the turn, because the point is not to stop a
		// turn but not to start one. The events are answered for either way: they are already in the
		// conversation, written down when they arrived, so refusing costs the reader nothing — and
		// leaving them queued would only mean spending the moment the ceiling moved.
		await this.bus.register(agentId, async (wakeup) => {
			const refusal = await this.#overspent(agentId);
			if (refusal !== undefined) {
				this.#reportError(agentId, new Error(refusal));
				return;
			}
			// Read off the events before the turn starts, because both halves are about the turn rather
			// than about the agent: who the operator named in what they wrote is consent for this turn,
			// and how far the message that woke it had already come is what the next hop is counted from.
			// Only operator lines are read for mentions — an `@` in a webhook body is a stranger typing
			// one, which is the whole reason trust levels exist.
			this.#turn.set(agentId, {
				opened: this.#mentionedIn(wakeup.events),
				hops: Math.max(0, ...wakeup.events.map((event) => hopsIn(event.metadata))),
			});
			try {
				await handler(wakeup);
			} finally {
				// Gone the moment the turn is, so a door opened by a mention closes with the sentence that
				// opened it, and the next turn counts its hops from whatever wakes it.
				this.#turn.delete(agentId);
				// However it ended, and this is the one that has to be in a finally: a turn that threw
				// never reaches onTurn, and a record left behind would catch every console that opened
				// afterwards up onto a turn that died an hour ago.
				this.#inFlight.delete(agentId);
				// However the turn ended, it has nothing further to hand in, so the next line to arrive
				// belongs to the conversation starting here rather than to any that was thrown away.
				this.#clearedMidTurn.delete(agentId);
			}
		});
	}

	/** Why this agent may not take a turn right now, if it may not. */
	async #overspent(agentId: string): Promise<string | undefined> {
		const { spentUsd, limitUsd } = await this.#account(agentId);
		if (limitUsd === undefined || spentUsd < limitUsd) return undefined;
		return `spending limit reached: ${money(spentUsd)} of ${money(limitUsd)} today. No turns until it resets at midnight UTC, or until the limit does`;
	}

	/**
	 * What an agent has spent today and what it may spend.
	 *
	 * A ceiling set at the keyboard wins over the one in the config, and removing it is not the same
	 * as never having set one: `/limit off` means no ceiling, and falling back to the file would
	 * quietly reinstate the one the operator had just taken off.
	 */
	async #account(agentId: string): Promise<{ spentUsd: number; limitUsd: number | undefined }> {
		const account = await this.#spend.account(agentId);
		const declared = this.#agents.find((agent) => agent.id === agentId)?.limitUsd;
		return {
			spentUsd: account.spentUsd,
			limitUsd: account.limitUsd === undefined ? declared : (account.limitUsd ?? undefined),
		};
	}

	/**
	 * Every model there is to think with: the file's, and then the ones added at the console.
	 *
	 * The file's come first so that a console entry reusing one of its ids does not quietly take its
	 * place — the operator's own declaration is the one that wins, and the duplicate is dropped.
	 */
	async models(): Promise<readonly ModelStanding[]> {
		const all: ModelStanding[] = this.#declaredModels.map((model) => ({
			...model,
			added: false,
			held: false,
		}));
		for (const model of await this.#addedModels.all()) {
			if (!all.some((other) => other.id === model.id)) {
				all.push({ ...model, added: true, held: false });
			}
		}
		// One resolve per distinct variable rather than per model, because two models on one provider
		// are one question and the store is a file read.
		const held = new Map<string, boolean>();
		for (const model of all) {
			if (held.has(model.keyEnv)) continue;
			const key = await this.#secrets.resolve({ ref: model.keyEnv }).catch(() => undefined);
			held.set(model.keyEnv, key !== undefined && key.length > 0);
		}
		return all.map((model) => ({ ...model, held: held.get(model.keyEnv) ?? false }));
	}

	/**
	 * Adds a model to think with, without a file to edit or a container to restart.
	 *
	 * This is the one thing here that widens what an agent can reach, so it is worth being plain about
	 * why it is allowed: the socket carrying it is the operator's, a model is the capability every
	 * agent must have to do anything at all, and the alternative was that trying a second provider
	 * meant editing YAML on a box over SSH and redeploying. What still holds the line is that the
	 * spending ceiling is per agent and unchanged, and that this is written down in a file of its own
	 * — so what an agent may reach is still two files somebody can read, not a thing that happened.
	 */
	async addModel(spec: ModelSpec): Promise<Model> {
		const resolved = resolveModel(spec);
		if (typeof resolved === "string") throw new Error(resolved);
		if (this.#declaredModels.some((model) => model.id === resolved.id)) {
			throw new Error(
				`"${resolved.id}" is declared in the config file, so it is not ours to change`,
			);
		}
		await this.#addedModels.add(spec);
		// The grant for it is derived from the list, so every agent has to be told the list changed.
		await this.#reregisterAll();
		return resolved;
	}

	/** Takes back a model added here. One the file declares is refused, for the same reason. */
	async dropModel(id: string): Promise<void> {
		if (this.#declaredModels.some((model) => model.id === id)) {
			throw new Error(`"${id}" is declared in the config file, so it is not ours to change`);
		}
		if (!(await this.#addedModels.drop(id))) throw new Error(`No model "${id}" was added here`);
		await this.#reregisterAll();
	}

	/**
	 * Everywhere every agent may go, in the order the proxy tries them.
	 *
	 * The screen this answers is the one somebody arrives at after an agent said it could not reach a
	 * host: the list is the whole answer, and each row says which of the four places it came from, so
	 * the reach that comes with a model is not mistaken for something to add or drop here.
	 *
	 * A grant written under one agent in the file is that agent's alone and is not on this list. What
	 * an agent earned by logging into a server is not either — that is the shelf's screen, and it goes
	 * away when the server does.
	 */
	async grants(): Promise<readonly GrantStanding[]> {
		const declared = this.#defaults?.grants ?? [];
		const standing = [
			...declared.map((grant) => ({ grant, origin: originOf(grant.id) })),
			...(await this.#thinking(declared)).map((grant) => ({ grant, origin: "model" as const })),
			...(await this.#searching(declared)).map((grant) => ({ grant, origin: "search" as const })),
			...(await this.#looking(declared)).map((grant) => ({ grant, origin: "search" as const })),
			...(await this.#pipedThrough(declared)).map((grant) => ({ grant, origin: "here" as const })),
			...(await this.#reached(declared)).map((grant) => ({ grant, origin: "here" as const })),
		];
		return standing.map(({ grant, origin }) => {
			const carries = carriedBy(grant.injection);
			return {
				id: grant.id,
				host: grant.host,
				...(grant.pathPrefix !== undefined ? { pathPrefix: grant.pathPrefix } : {}),
				...(grant.methods !== undefined ? { methods: grant.methods } : {}),
				origin,
				...(carries !== undefined ? { carries } : {}),
			};
		});
	}

	/**
	 * Opens a host to every agent, with nothing to edit and nothing to restart.
	 *
	 * The widening this system is most careful about, and the one it could least do without: an agent
	 * denied a host it needs reads the refusal as the internet being down, and the way out of that was
	 * SSH, YAML and a redeploy. What keeps it safe is that a console may only grant *reach* — the
	 * grant this builds has no field to put a credential in, so the boundary that was ever
	 * load-bearing, the one around the secrets, is exactly where it was.
	 */
	async addGrant(said: string): Promise<string> {
		const read = readHost(said);
		if ("refused" in read) throw new Error(read.refused);
		// Said here rather than left to be a silent no-op: a row that appeared under a host already
		// open is a row somebody would later drop, expecting the reach to go with it.
		const already = (this.#defaults?.grants ?? []).find(
			(grant) =>
				grant.host === read.host && grant.pathPrefix === undefined && grant.methods === undefined,
		);
		if (already !== undefined) {
			throw new Error(`"${read.host}" is already open, from the config file`);
		}
		await this.#addedGrants.add(read.host);
		await this.#reregisterAll();
		return read.host;
	}

	/** Closes one opened here. One the file grants is refused, the way a declared model is. */
	async dropGrant(host: string): Promise<void> {
		if ((this.#defaults?.grants ?? []).some((grant) => grant.id === reachId(host))) {
			throw new Error(`"${host}" is granted in the config file, so it is not ours to change`);
		}
		if (!(await this.#addedGrants.drop(host))) throw new Error(`No host "${host}" was opened here`);
		await this.#reregisterAll();
	}

	/**
	 * Writes down that an agent wants a host, which is all an agent gets to do about its own reach.
	 *
	 * The refusal it met is a 403 with `no_matching_host` in it, and an agent reads that as the
	 * internet being broken. Before this the only thing it could do about it was write a paragraph
	 * telling its operator to go and find the grants screen — a paragraph that is read hours later,
	 * by which time the turn that needed the host is over.
	 */
	async #askReach(agentId: string, host: string): Promise<void> {
		const waiting = this.#asking.get(agentId) ?? [];
		// Asked twice is asked once. A turn that met the same refusal on four URLs asked for one
		// thing four times, and four identical questions is a console nobody reads to the end of.
		if (waiting.includes(host)) return;
		this.#asking.set(agentId, [...waiting, host]);
	}

	/** The hosts an agent has asked for that nobody has answered yet, oldest first. */
	asking(agentId: string): readonly string[] {
		return this.#asking.get(agentId) ?? [];
	}

	/**
	 * Answers one of those questions, which is the only thing that opens a host on an agent's asking.
	 *
	 * Both answers are written into the conversation, because a question that disappeared off the
	 * screen having done something is worse than one that disappeared having done nothing: the yes
	 * opened a host to every agent on this plane, and that belongs in the record next to the asking.
	 *
	 * A host nobody is waiting on is not answered at all. Two consoles watching the same agent both
	 * see the question, and the second `y` must not be a second grant.
	 */
	async answerReach(agentId: string, host: string, open: boolean): Promise<void> {
		const waiting = this.#asking.get(agentId) ?? [];
		if (!waiting.includes(host)) return;
		this.#asking.set(
			agentId,
			waiting.filter((one) => one !== host),
		);
		if (!open) {
			await this.#record(agentId, {
				from: "plane",
				tone: "bad",
				text: `${host} stays closed. Nothing was opened, and the agent is not told to try again.`,
			});
			return;
		}
		try {
			const opened = await this.addGrant(host);
			await this.#record(agentId, {
				from: "plane",
				text: `${opened} is open, to every agent on this plane. /config grants takes it back.`,
			});
		} catch (error) {
			await this.#record(agentId, {
				from: "plane",
				tone: "bad",
				text: `${host} was not opened: ${(error as Error).message}`,
			});
		}
	}

	/**
	 * The questions this agent has put to its operator, oldest first.
	 *
	 * On the summary rather than sent as an event, for the reason the hosts it is asking about are:
	 * the console draws this row every two seconds anyway, and a question that arrived only as an
	 * event is a question missed by every console that was not open at the moment it was asked —
	 * which, for a thing whose entire purpose is to be waiting when somebody comes back, is the one
	 * failure that matters.
	 */
	questions(agentId: string): readonly Question[] {
		return this.#questions.get(agentId) ?? [];
	}

	/** Takes a card down, here and on disk, which are one act however many places hold it. */
	#forgetQuestions(agentId: string): void {
		if (!this.#questions.has(agentId)) return;
		this.#questions.delete(agentId);
		void this.#standing.forget(agentId).catch(() => undefined);
	}

	/**
	 * Puts up what a turn asked, replacing whatever was there.
	 *
	 * Replacing rather than adding, because a card is about the state the agent was in when it wrote
	 * it: an agent that woke itself, looked at the page again and asked something new is not also
	 * still asking the old thing. A turn that asked nothing never reaches here at all, which is what
	 * leaves a card standing across the agent's own checking-back turns.
	 */
	async #applyQuestions(agentId: string, questions: readonly Question[]): Promise<void> {
		if (questions.length === 0) return;
		this.#questions.set(agentId, questions);
		await this.#standing.put(agentId, questions).catch(() => undefined);
		// Written into the conversation as well as held, and this is the half that lasts. What is held
		// is a thing to press, and it goes the moment somebody presses it; what is written is what was
		// asked, which is still worth having tomorrow — otherwise the record reads "Comfort $793" in
		// the operator's own voice with nothing above it saying what the question was.
		//
		// It also means a console that draws no cards at all still shows the question, which is the
		// difference between a terminal that cannot answer conveniently and one that never finds out.
		// Marked `‹asks›` for the reason a console command the agent asked for is marked: unmarked is
		// how this pane draws the agent answering, and a question sitting among replies is a line the
		// operator has to work out nobody typed.
		for (const question of questions) {
			await this.#record(agentId, { from: "agent", via: "asks", text: question.text });
		}
	}

	/**
	 * Every other agent on this plane, and whether this one may write to it as things stand.
	 *
	 * Three ways a door is open, and they are the same door: the operator's file said so, somebody
	 * opened it at the console, or the operator named that agent in the message this turn is answering.
	 * The third is why this is asked again every turn rather than read once — a mention is consent for
	 * one turn, and the turn it is consent for is the one being taken.
	 *
	 * What is never here is the agent itself. An agent that could write to itself would have found a
	 * way to give itself a turn on its own say-so, which is the one thing wake_me is careful about.
	 */
	async team(agentId: string): Promise<readonly Teammate[]> {
		const declared = this.#agents.find((agent) => agent.id === agentId)?.talksTo ?? [];
		const added = await this.#addedTeam.open(agentId).catch(() => []);
		// Being put in a room together is the operator saying these two work on this, and an agent
		// that may be asked something in front of everybody but may not answer the person who asked
		// would be a door opened halfway.
		const mates = await this.#rooms.mates(agentId).catch(() => []);
		const open = new Set([
			...declared,
			...added,
			...mates,
			...(this.#turn.get(agentId)?.opened ?? []),
		]);
		return this.#agents
			.filter((agent) => agent.id !== agentId)
			.map((agent) => ({
				id: agent.id,
				...(agent.description !== undefined ? { description: agent.description } : {}),
				open: open.has(agent.id),
			}));
	}

	/** Which agents the operator named in what they wrote, out of the ones this plane has. */
	#mentionedIn(events: readonly AgentEvent[]): readonly string[] {
		const written = events
			.filter((event) => event.trust === "operator")
			.map((event) => event.body)
			.join("\n");
		if (written.length === 0) return [];
		return mentioned(
			written,
			this.#agents.map((agent) => agent.id),
		);
	}

	/**
	 * Lets one agent write to another from the console, which is the standing half of the same grant.
	 *
	 * One-way, and that is the point rather than an omission: `/team scout` typed at planner says
	 * planner may write to scout, and scout writing back is scout answering rather than scout deciding
	 * to start something. A door that opened both ways would be two grants made by one keystroke, and
	 * only one of them would be on the screen it was typed at.
	 */
	async holdTeam(agentId: string, to: string): Promise<void> {
		if (to === agentId) throw new Error("An agent does not write to itself");
		if (!this.#agents.some((agent) => agent.id === to)) {
			throw new Error(`No agent "${to}" in this plane`);
		}
		const declared = this.#agents.find((agent) => agent.id === agentId)?.talksTo ?? [];
		if (declared.includes(to)) {
			throw new Error(`${agentId} may already write to ${to}, from the config file`);
		}
		await this.#addedTeam.add(agentId, to);
	}

	/** Closes one opened here. One the file granted is refused, the way a declared grant is. */
	async dropTeam(agentId: string, to: string): Promise<boolean> {
		const declared = this.#agents.find((agent) => agent.id === agentId)?.talksTo ?? [];
		if (declared.includes(to)) {
			throw new Error(`${to} is in the config file, so it is not ours to change`);
		}
		return await this.#addedTeam.drop(agentId, to);
	}

	// ── what outside this plane may give an agent a turn ───────────────

	/** Every trigger, and which agent each one wakes. */
	async triggers(): Promise<readonly Trigger[]> {
		return await this.#triggers.all();
	}

	/**
	 * Makes one, and puts it up.
	 *
	 * The secret comes back and is never shown again — it goes into a form on the sender's own site
	 * once. The plane keeps it because it has to check what arrives signed with it, and a console
	 * from which it could be read later would be a console from which it could be taken.
	 */
	async addTrigger(
		agentId: string,
		name: string,
		from: Signer,
		only: readonly string[],
		says?: string,
	): Promise<Trigger> {
		// No name, and the plane makes one: an unguessable address for a trigger whose address is
		// what guards it. This is the one-click path — pick an agent, get a URL — and the reason it
		// can be one click is that there is nothing else to decide before it works.
		const asked = name.trim() === "" || from === "url" ? newName(agentId) : name.trim();
		const refused = triggerRefused(asked);
		if (refused !== undefined) throw new Error(refused);
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}"`);
		}
		const trigger: Trigger = {
			name: asked,
			agentId,
			from,
			secret: newSecret(),
			only: only.map((one) => one.trim()).filter((one) => one.length > 0),
			...(says === undefined || says.trim() === "" ? {} : { says: says.trim() }),
			madeAt: new Date().toISOString(),
			fired: 0,
		};
		await this.#triggers.add(trigger);
		this.webhooks.hold(hookOf(trigger));
		this.#emit({ kind: "triggers" });
		this.#emit({
			kind: "note",
			who: agentId,
			action: "woken by",
			detail: `${from} at /hooks/${asked}`,
		});
		return trigger;
	}

	/**
	 * Says what arrives at one, and what is wanted done about it.
	 *
	 * Reaches the agent as an instruction rather than as part of the payload, because it is the
	 * operator's sentence and the payload is a stranger's. Kept on the trigger rather than asked for
	 * at the moment it fires, which is three in the morning.
	 */
	async describeTrigger(name: string, says: string): Promise<boolean> {
		const said = await this.#triggers.describe(name, says);
		if (!said) return false;
		const trigger = await this.#triggers.of(name);
		// Put up again, because what the channel holds is a copy made when it was raised.
		if (trigger !== undefined) this.webhooks.hold(hookOf(trigger));
		this.#emit({ kind: "triggers" });
		return true;
	}

	/** Takes one down. Anything arriving at it afterwards is answered the way an unknown one is. */
	async dropTrigger(name: string): Promise<boolean> {
		const gone = await this.#triggers.drop(name);
		if (!gone) return false;
		this.webhooks.drop(name);
		this.#emit({ kind: "triggers" });
		this.#emit({ kind: "note", who: `#${name}`, action: "gone", detail: "the trigger" });
		return true;
	}

	/** Puts up everything the store holds. Called once, as the plane comes up. */
	async #raiseTriggers(): Promise<void> {
		for (const trigger of await this.#triggers.all()) {
			try {
				this.webhooks.hold(hookOf(trigger));
			} catch (error) {
				this.#reportError(`trigger ${trigger.name}`, error as Error);
			}
		}
	}

	// ── what an agent knows how to do ──────────────────────────────────

	/**
	 * The skills in an agent's own repository.
	 *
	 * Read out of the box every time rather than kept here, because the agent writes them: a list
	 * this plane cached would be a list that is right until the next turn.
	 */
	async skills(agentId: string): Promise<readonly Skill[]> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}"`);
		}
		return await skillsOf(this.sandboxes, agentId);
	}

	/**
	 * Asks an agent to write down what it has just been doing, as a skill.
	 *
	 * A turn rather than a file the plane writes, because the only thing that knows what just
	 * happened is the agent that did it — and because a procedure written by whoever will read it
	 * next is the only kind that survives being read again.
	 */
	async keepSkill(agentId: string, name: string, about?: string): Promise<void> {
		const refused = skillRefused(name);
		if (refused !== undefined) throw new Error(refused);
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}"`);
		}
		await this.bus.publish({
			agentId,
			source: "channel",
			// Its own channel rather than the console's: a console channel names one request that is
			// answered and gone, and what this asks for is a commit rather than a reply.
			channel: WAKE_CHANNEL,
			// The operator asked for this, at the console, which is the one place that trust is minted.
			trust: "operator",
			body: [
				`Write down how you did this, as a skill called "${name}".`,
				"",
				about === undefined || about.trim().length === 0
					? "It is the work from this conversation that is worth keeping."
					: `What it is for: ${about.trim()}`,
				"",
				`Put it in ${skillPath(name)}/SKILL.md, with front matter naming it and one line of`,
				"`description:` saying when it applies — that line is what decides whether you find it",
				"again, so write it as the situation rather than as the title. Then the steps as you",
				"actually took them: what to check first, what the decisions were, what the output should",
				"look like, and what to do when it goes wrong. Scripts and reference files go in the same",
				"folder. Commit it.",
				"",
				"Keep it short enough to read. If it is only true of today, it is not a skill.",
			].join("\n"),
		});
	}

	/** Copies one skill from one agent to another. Both must be running to have a volume to read. */
	async giveSkill(from: string, to: string, name: string): Promise<void> {
		for (const id of [from, to]) {
			if (!this.#agents.some((agent) => agent.id === id)) {
				throw new Error(`There is no agent called "${id}"`);
			}
		}
		if (from === to) throw new Error("An agent already has its own skills.");
		await copySkill(this.sandboxes, from, to, name);
	}

	// ── rooms ──────────────────────────────────────────────────────────

	/** Every room, and who is in it. */
	async rooms(): Promise<readonly Room[]> {
		return await this.#rooms.all();
	}

	/**
	 * Makes one, with the agents that are to work in it.
	 *
	 * The members are checked against the agents this plane has, rather than kept as written: a room
	 * with a typo in it would be a room whose brief quietly reaches two of the three people it was
	 * addressed to, and the operator would find out by noticing the silence.
	 */
	async makeRoom(name: string, members: readonly string[]): Promise<Room> {
		const refused = nameRefused(name);
		if (refused !== undefined) throw new Error(refused);
		for (const id of members) {
			if (!this.#agents.some((agent) => agent.id === id)) {
				throw new Error(`There is no agent called "${id}", so nobody was put in #${name}.`);
			}
		}
		const made = await this.#rooms.make(name, members);
		this.#emit({ kind: "rooms" });
		this.#emit({
			kind: "note",
			who: `#${name}`,
			action: "made",
			detail: members.length === 0 ? "with nobody in it yet" : `with ${members.join(", ")}`,
		});
		return made;
	}

	async joinRoom(name: string, agentId: string): Promise<boolean> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}".`);
		}
		const joined = await this.#rooms.join(name, agentId);
		if (joined) {
			this.#emit({ kind: "rooms" });
			this.#emit({ kind: "note", who: `#${name}`, action: "joined", detail: agentId });
		}
		return joined;
	}

	async leaveRoom(name: string, agentId: string): Promise<boolean> {
		const left = await this.#rooms.leave(name, agentId);
		if (left) {
			this.#emit({ kind: "rooms" });
			this.#emit({ kind: "note", who: `#${name}`, action: "left", detail: agentId });
		}
		return left;
	}

	/** Takes the room away, and the thread with it: it was the room's and there is no room. */
	async dropRoom(name: string): Promise<boolean> {
		const gone = await this.#rooms.drop(name);
		if (!gone) return false;
		await this.#roomTalk.forget(name).catch(() => undefined);
		this.#emit({ kind: "rooms" });
		this.#emit({ kind: "cleared", agentId: roomChannel(name) });
		this.#emit({
			kind: "note",
			who: `#${name}`,
			action: "gone",
			detail: "the room and its thread",
		});
		return true;
	}

	/**
	 * Says something in a room, and wakes whoever it names.
	 *
	 * One rule for everybody who speaks in here, the operator included: a turn is taken by the agents
	 * that were named and by nobody else. Naming is what asking is — `@scout, ¿cómo va el deploy?` is
	 * a question put to scout in front of the others, and the others reading it later is the point of
	 * having said it here rather than in scout's own pane.
	 *
	 * A line that names nobody is still worth saying: it is written into the thread, where everyone
	 * in the room reads it the next time they are woken. It just does not cost three turns to say.
	 */
	async sayInRoom(name: string, text: string): Promise<void> {
		const room = await this.#rooms.of(name);
		if (room === undefined) throw new Error(`There is no room called #${name}.`);
		const said = text.trim();
		if (said.length === 0) return;
		if (room.members.length === 0) {
			throw new Error(`#${name} has nobody in it. Add an agent, and it will hear this.`);
		}

		await this.#inRoom(name, { from: "operator", text: withoutSecrets(said) });

		const named = mentioned(said, room.members);
		for (const member of named) {
			await this.bus.publish({
				agentId: member,
				source: "channel",
				channel: roomChannel(name),
				// The operator typed it, and a room is one more place they type. What the room changes
				// is who else heard it, which the renderer says and the trust level does not.
				trust: "operator",
				body: said,
				metadata: {
					hops: "1",
					with: room.members.filter((one) => one !== member).join(", "),
				},
			});
		}

		// Somebody was named who is not in here. Said in the room rather than thrown, because the
		// message itself went nowhere wrong — it is in the thread — and what went wrong is that the
		// agent it was addressed to is not going to see it.
		const elsewhere = mentioned(
			said,
			this.#agents.map((agent) => agent.id),
		).filter((id) => !room.members.includes(id));
		if (elsewhere.length > 0) {
			await this.#inRoom(name, {
				from: "plane",
				tone: "bad",
				text: `${elsewhere.join(" and ")} ${elsewhere.length === 1 ? "is" : "are"} not in #${name}, so ${elsewhere.length === 1 ? "it was" : "they were"} not woken. Add ${elsewhere.length === 1 ? "it" : "them"} to the room, or say this where ${elsewhere.length === 1 ? "it is" : "they are"}.`,
			});
		}
	}

	/** A line in a room's thread: said to whoever is watching, and written down under the room. */
	async #inRoom(name: string, said: Utterance): Promise<void> {
		const one: Utterance = { at: new Date().toISOString(), ...said };
		this.#emit({ kind: "said", agentId: roomChannel(name), said: one });
		await this.#roomTalk.append(name, one).catch((error: Error) => {
			this.#onError?.(`#${name} transcript`, error);
		});
	}

	/**
	 * Sends what a turn wrote to the agents it wrote to, or asks about the ones it may not write to.
	 *
	 * Both halves are written into the sender's conversation, because a message that left this agent
	 * is a thing it did and the operator reading that pane should find it there — and a message that
	 * did not leave is a question they are about to be asked.
	 */
	async #applySent(agentId: string, sent: readonly Sent[]): Promise<void> {
		const mates = await this.team(agentId);
		// One further than the message that woke this turn, and one at all when a person did: what
		// this counts is distance from somebody asking, not the number of agents involved.
		const hops = (this.#turn.get(agentId)?.hops ?? 0) + 1;

		for (const message of sent) {
			await this.#record(agentId, { from: "agent", to: message.to, text: message.note });

			const mate = mates.find((one) => one.id === message.to);
			if (mate === undefined) {
				await this.#record(agentId, {
					from: "plane",
					tone: "bad",
					text: `There is no agent "${message.to}" in this plane, so nothing was sent.`,
				});
				continue;
			}
			if (hops > MOST_HOPS) {
				await this.#record(agentId, {
					from: "plane",
					tone: "bad",
					text: `Nothing was sent to ${message.to}: this would be hop ${hops} of a conversation that started ${MOST_HOPS} turns ago, and past that the agents are talking rather than working. Write to ${message.to} yourself, and the count starts again.`,
				});
				continue;
			}
			if (!mate.open) {
				this.#want(agentId, message);
				await this.#record(agentId, {
					from: "plane",
					text: `${agentId} wants to write to ${message.to}, which it may not. Nothing has gone: the message is held, and a yes below sends it and leaves ${agentId} able to write to ${message.to} from now on.`,
				});
				continue;
			}
			await this.#deliver(agentId, message, hops);
		}
	}

	/** Puts one message in front of the agent it was written to, which is the whole of sending it. */
	async #deliver(from: string, message: Sent, hops: number): Promise<void> {
		try {
			await this.bus.publish({
				agentId: message.to,
				source: "channel",
				channel: agentChannel(from),
				// Never operator, however it was asked for and whoever the sender answers to. One
				// injection would otherwise be the whole plane: the agent that fell for it instructs
				// every agent it can reach, in the plane's own voice, with nobody in the room.
				trust: "participant",
				actor: { id: from },
				body: message.note,
				metadata: { hops: String(hops) },
			});
		} catch (error) {
			// Caught on the wakeup's terms: a throw here would leave the sender's events queued and its
			// turn taken again, and an agent whose message could not be delivered would pay for that turn
			// twice and send the message twice.
			this.#reportError(
				`${from} -> ${agentChannel(message.to)}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	// ── what leaves in the operator's name ─────────────────────────────

	/**
	 * Sends a turn's answer, or holds it in front of the person whose name it would go out under.
	 *
	 * The reach question and the one about writing to a peer are both "may it", asked before anything
	 * happens. This one is "should this": the words are already written, and what is being decided is
	 * whether they leave. So the message is held whole and shown — a yes sends exactly what is on the
	 * screen, which is the only version of this that is worth anything.
	 */
	async #sendOut(reply: Reply): Promise<void> {
		const gate = gateOf(reply.channel);
		if (gate === undefined || !(await this.#gates.of(reply.agentId)).includes(gate)) {
			await this.router.send(reply);
			return;
		}
		const waiting = this.#sending.get(reply.agentId) ?? [];
		this.#sending.set(reply.agentId, [...waiting, reply]);
		await this.#record(reply.agentId, {
			from: "plane",
			text: `Nothing was sent. ${reply.agentId} would answer ${gateSaid(gate)}, and you asked to be shown that first — a yes below sends exactly what it wrote.`,
		});
	}

	/** The answers this agent has written that are waiting to be let out. */
	sending(agentId: string): readonly { channel: string; body: string }[] {
		return (this.#sending.get(agentId) ?? []).map((one) => ({
			channel: one.channel,
			body: one.body,
		}));
	}

	/**
	 * Lets one of those out, or drops it.
	 *
	 * By its place in the list rather than by its words: two answers held on the same channel can be
	 * the same sentence, and a person answering the second of them means the second of them.
	 */
	async answerSend(agentId: string, at: number, send: boolean): Promise<void> {
		const waiting = this.#sending.get(agentId) ?? [];
		const held = waiting[at];
		if (held === undefined) return;
		this.#sending.set(
			agentId,
			waiting.filter((_one, index) => index !== at),
		);
		const gate = gateOf(held.channel);
		if (!send) {
			await this.#record(agentId, {
				from: "plane",
				tone: "bad",
				text: `Dropped. Nothing went out, and ${agentId} is not told to write it again.`,
			});
			return;
		}
		try {
			await this.router.send(held);
			await this.#record(agentId, {
				from: "plane",
				tone: "good",
				text: `Sent ${gate === undefined ? "" : `${gateSaid(gate)} `}as written.`,
			});
		} catch (error) {
			await this.#record(agentId, {
				from: "plane",
				tone: "bad",
				text: `It did not go: ${(error as Error).message}`,
			});
		}
	}

	/** What this agent must be asked about before it goes out. */
	async gates(agentId: string): Promise<readonly Gate[]> {
		return await this.#gates.of(agentId);
	}

	/** Holds one kind of outbound thing, or lets it go again. Says whether anything changed. */
	async setGate(agentId: string, gate: Gate, hold: boolean): Promise<boolean> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}"`);
		}
		const changed = hold
			? await this.#gates.hold(agentId, gate)
			: await this.#gates.free(agentId, gate);
		if (changed) {
			this.#emit({
				kind: "note",
				who: agentId,
				action: hold ? "holds" : "frees",
				detail: `what it sends ${gateSaid(gate)}`,
			});
		}
		return changed;
	}

	/** Holds a message for an agent this one may not write to, once, however often it is written. */
	#want(agentId: string, message: Sent): void {
		const waiting = this.#wanting.get(agentId) ?? [];
		// The last one written rather than the first: an agent that wrote twice while waiting has said
		// the second thing more recently, and the operator answering is answering about that.
		this.#wanting.set(agentId, [...waiting.filter((one) => one.to !== message.to), message]);
	}

	/** The agents this one has written to and may not, oldest question first. */
	wants(agentId: string): readonly string[] {
		return (this.#wanting.get(agentId) ?? []).map((one) => one.to);
	}

	/**
	 * Answers one of those, which is the only thing that opens a door on an agent's asking.
	 *
	 * A yes does two things at once and says so: it sends the message that was held, and it leaves
	 * this agent able to write to that one from now on. The alternative — opening the door and making
	 * the agent write again — spends a turn to say a thing it has already said, and the operator has
	 * already read what it wanted to send.
	 *
	 * Both answers go into the conversation. What a yes is worth is one agent writing to one other,
	 * in that direction, which is a narrower thing than a host and still belongs in the record.
	 */
	async answerTalk(agentId: string, to: string, open: boolean): Promise<void> {
		const waiting = this.#wanting.get(agentId) ?? [];
		const held = waiting.filter((one) => one.to === to);
		if (held.length === 0) return;
		this.#wanting.set(
			agentId,
			waiting.filter((one) => one.to !== to),
		);

		if (!open) {
			await this.#record(agentId, {
				from: "plane",
				tone: "bad",
				text: `${to} was not written to. The message is dropped, ${agentId} is not told to try again, and nothing about what it may reach has changed.`,
			});
			return;
		}
		try {
			await this.holdTeam(agentId, to);
		} catch (error) {
			await this.#record(agentId, {
				from: "plane",
				tone: "bad",
				text: `${to} was not opened: ${(error as Error).message}`,
			});
			return;
		}
		// A turn that has been over for as long as it took somebody to answer, so the count starts from
		// the person who just said yes rather than from wherever the sender had got to.
		for (const message of held) await this.#deliver(agentId, message, 1);
		await this.#record(agentId, {
			from: "plane",
			text: `Sent, and ${agentId} may write to ${to} from now on — that way round, and no other agent is affected. /team drop ${to} takes it back.`,
		});
	}

	/**
	 * Which of the configured models an agent is on.
	 *
	 * Chosen at the keyboard wins over the one in the config, on the same terms as a spending
	 * ceiling: both are a choice among things the operator has already approved, which is why the
	 * console is allowed to make them, and neither is written back to the operator's file.
	 */
	async #modelFor(agentId: string): Promise<Model | undefined> {
		const chosen = await this.#choices.chosen(agentId);
		const declared = this.#agents.find((agent) => agent.id === agentId)?.model;
		const named = chosen ?? declared;
		return (await this.models()).find((model) => model.id === named);
	}

	/**
	 * The configured models this plane holds no key for.
	 *
	 * A model is three lines of configuration and one exported variable, and the variable is the half
	 * that is not in the file — so it is the half that gets forgotten, and the failure it causes is a
	 * turn dying at the proxy over a host nobody typed. Asked of the same store the broker resolves
	 * against, and only ever whether there is something there.
	 */
	async #keyless(): Promise<readonly string[]> {
		return (await this.models()).filter((model) => !model.held).map((model) => model.id);
	}

	/**
	 * Every provider this plane could be given a key for, and whether it is holding one.
	 *
	 * What the screen behind this is for: a plane that is running and configured and still refused at
	 * the proxy, because the half of a model that is not in the file — the key — was never exported.
	 * Which models exist stays the operator's file. This says only which of them this plane can pay
	 * for, which is a fact about the machine rather than a decision about an agent.
	 */
	async providers(): Promise<readonly ProviderStanding[]> {
		const here = await this.#keys.here();
		const standing: ProviderStanding[] = [];
		for (const provider of providersOf(await this.models())) {
			const held = await this.#secrets.resolve({ ref: provider.keyEnv }).catch(() => undefined);
			standing.push({
				...provider,
				held: held !== undefined && held.length > 0,
				here: here.has(provider.keyEnv),
			});
		}
		return standing;
	}

	/**
	 * Everything this plane's keys could buy, asked of the providers themselves.
	 *
	 * Handing over a key and then being asked for a model name is being asked for the one fact the
	 * key just made this plane able to look up. So it looks it up: every provider it is holding a key
	 * for is asked what it answers to, and what comes back is a list to pick from instead of a name
	 * to remember. Nothing here is added — an offer is a name a screen may show, and it becomes a
	 * model only when somebody picks it.
	 *
	 * Asked of all of them at once, and what fails is reported rather than dropped: an empty list is
	 * the shape both "this key is wrong" and "this provider has nothing" arrive in, and only one of
	 * those is worth telling somebody about.
	 */
	async offers(): Promise<Catalog> {
		const configured = await this.models();
		const asking = providersOf(configured).filter(
			(provider) => PROVIDERS[provider.id]?.catalog !== undefined,
		);
		const asked = await Promise.all(
			asking.map(async (provider): Promise<Catalog> => {
				const key = await this.#secrets.resolve({ ref: provider.keyEnv }).catch(() => undefined);
				if (key === undefined || key.length === 0) return { offers: [], trouble: [] };
				try {
					return { offers: await offersOf(provider.id, key), trouble: [] };
				} catch (error) {
					const why = error instanceof Error ? error.message : String(error);
					return { offers: [], trouble: [`${provider.id} ${why}`] };
				}
			}),
		);

		// A model already configured is not on offer: picking it again would be an id collision, and
		// the point of the list is what is not on the screen behind it yet.
		const taken = new Set(configured.map((model) => `${model.provider}\u0000${model.model}`));
		const offers: ModelOffer[] = [];
		for (const answer of asked) {
			for (const offer of answer.offers) {
				if (!taken.has(`${offer.provider}\u0000${offer.id}`)) offers.push(offer);
			}
		}
		return { offers, trouble: asked.flatMap((answer) => answer.trouble) };
	}

	/**
	 * Takes a key for one provider, or forgets it when what was typed is empty.
	 *
	 * Refuses any other name, and that is the boundary rather than a formality: every other secret
	 * this plane resolves is one a grant in the operator's file named — a GitHub token, a hook secret
	 * — and a console that could fill those in would be a keyboard handing out the credentials that
	 * file was careful to only name. A provider key fills a grant every agent already holds.
	 */
	async setKey(keyEnv: string, value: string): Promise<void> {
		const thinking = providersOf(await this.models()).some(
			(provider) => provider.keyEnv === keyEnv,
		);
		// The searching providers as well as the thinking ones. Their key fills a grant this plane
		// derives for every agent, exactly as a model's does, so it is the same kind of thing to be
		// allowed to type — and a search screen that could show the key but not take it would be a
		// screen that sends you to the `.env` on the host.
		const searching = Object.values(SEARCH_PROVIDERS).some(
			(provider) => provider.keyEnv === keyEnv,
		);
		if (!thinking && !searching) throw new Error(`${keyEnv} is not a provider key`);
		await this.#keys.keep(keyEnv, value.trim());
	}

	/** Where searching goes, filled in from the table, and whether this plane can pay for it. */
	async search(): Promise<SearchStanding> {
		const chosen = await this.#search.chosen();
		const resolved = resolveSearch(chosen ?? { provider: DEFAULT_SEARCH_PROVIDER });
		// A stored choice can only be refused by a plane that has since forgotten the provider, which
		// leaves the search where it would have been anyway rather than leaving the screen with nothing.
		const search =
			typeof resolved === "string"
				? (resolveSearch({ provider: DEFAULT_SEARCH_PROVIDER }) as Search)
				: resolved;
		const key = await this.#secrets.resolve({ ref: search.keyEnv }).catch(() => undefined);
		const here = await this.#keys.here();
		return {
			...search,
			chosen: chosen !== undefined,
			held: key !== undefined && key.length > 0,
			here: here.has(search.keyEnv),
		};
	}

	/**
	 * Which model looks at pictures, filled in from the table, and whether this plane can pay for it.
	 *
	 * Nothing when nobody has chosen, which is the difference from searching: every plane searches,
	 * and a plane that looks is one whose operator decided what looking is worth. An agent on a plane
	 * with no vision model hands the picture to its own model, the way it always did.
	 */
	async vision(): Promise<VisionStanding | undefined> {
		const chosen = await this.#vision.chosen();
		if (chosen === undefined) return undefined;
		const resolved = resolveVision(chosen);
		// A stored choice this plane has since forgotten how to reach leaves looking off rather than
		// leaving the screen with a provider it cannot name.
		if (typeof resolved === "string") return undefined;
		const key = await this.#secrets.resolve({ ref: resolved.keyEnv }).catch(() => undefined);
		const here = await this.#keys.here();
		return {
			...resolved,
			chosen: true,
			held: key !== undefined && key.length > 0,
			here: here.has(resolved.keyEnv),
		};
	}

	/**
	 * Every model that could do the looking, and whether this plane can pay for it.
	 *
	 * The whole table rather than the ones that are paid for, because the question somebody has at
	 * this screen is not only "what can I turn on" but "what would I have to add" — and a provider
	 * that is missing from the list because its key is missing is a provider nobody knows to want.
	 */
	async visionOffers(): Promise<readonly VisionOffer[]> {
		const using = await this.vision();
		const offers: VisionOffer[] = [];
		for (const [provider, known] of Object.entries(VISION_PROVIDERS)) {
			const key = await this.#secrets.resolve({ ref: known.keyEnv }).catch(() => undefined);
			const held = key !== undefined && key.length > 0;
			for (const model of known.models) {
				offers.push({
					provider,
					model,
					keyEnv: known.keyEnv,
					held,
					rate: known.rates[model] ?? { input: 0, output: 0 },
					using: using?.provider === provider && using.model === model,
				});
			}
		}
		return offers;
	}

	/**
	 * Every provider that could do the searching, on the vision offers' terms.
	 *
	 * Written for the screen rather than for the socket: a console drawing both tools needs the same
	 * three facts about each of them — what is on, what else there is, and which of those this plane
	 * holds a key for — and working that out from a table the browser cannot import is the plane's
	 * job rather than the browser's.
	 */
	async searchOffers(): Promise<readonly VisionOffer[]> {
		const using = await this.search();
		const offers: VisionOffer[] = [];
		for (const [provider, known] of Object.entries(SEARCH_PROVIDERS)) {
			const key = await this.#secrets.resolve({ ref: known.keyEnv }).catch(() => undefined);
			const held = key !== undefined && key.length > 0;
			for (const model of known.models) {
				offers.push({
					provider,
					model,
					keyEnv: known.keyEnv,
					held,
					rate: known.rates[model] ?? { input: 0, output: 0 },
					using: using.provider === provider && using.model === model,
				});
			}
		}
		return offers;
	}

	/**
	 * Chooses the model that looks, or `null` to stop looking with anything but the agent's own.
	 *
	 * Every agent's grants are written again afterwards, on the search choice's terms: the grant that
	 * pays for looking is derived from this, and a choice that held in the sandbox while the proxy
	 * refused it is the worst of the two halves being out of step.
	 */
	async chooseVision(spec: VisionSpec | null): Promise<void> {
		if (spec !== null) {
			const resolved = resolveVision(spec);
			if (typeof resolved === "string") throw new Error(resolved);
		}
		await this.#vision.choose(spec);
		await this.#reregisterAll();
	}

	/**
	 * Points the search tool at another provider, or another of that provider's models.
	 *
	 * Every agent's grants are written again afterwards, because the grant that pays for searching is
	 * derived from this: without it the choice would hold in the sandbox on the next turn and be
	 * refused at the proxy, which is the worst of the two halves being out of step.
	 */
	async chooseSearch(spec: SearchSpec): Promise<void> {
		const resolved = resolveSearch(spec);
		if (typeof resolved === "string") throw new Error(resolved);
		await this.#search.choose(spec);
		await this.#reregisterAll();
	}

	/**
	 * What pi is actually told, which is the model when there is a list of them to choose from and
	 * the raw provider and model name when there is not.
	 *
	 * The second half is not a fallback so much as the older way of saying it: a configuration that
	 * names a provider and a model and writes the grant out by hand goes on working as it did, and
	 * has no `/model` to switch with because it has no list to switch among.
	 */
	async #thinksWith(agentId: string): Promise<ModelChoice | undefined> {
		const found = await this.#modelFor(agentId);
		if (found !== undefined) return found;
		const agent = this.#agents.find((one) => one.id === agentId);
		if (agent === undefined) return undefined;
		return {
			...(agent.provider !== undefined ? { provider: agent.provider } : {}),
			...(agent.model !== undefined ? { model: agent.model } : {}),
		};
	}

	/**
	 * Everything an agent may reach: what the operator wrote down, and what they logged into.
	 *
	 * The second half is the only capability in this system that does not come out of the config
	 * file, and it is allowed for one reason — a login is a person on a consent screen with the host
	 * name in front of them, which is a stronger act of approval than a line of YAML, not a weaker
	 * one. It is also the narrowest grant here: one host, one path, and only for the agents actually
	 * holding that server. Take the server off an agent and the reach goes with it.
	 */
	async #grantsFor(agentId: string): Promise<readonly Grant[]> {
		const declared = this.#agents.find((agent) => agent.id === agentId)?.grants ?? [];
		const earned: Grant[] = [];
		for (const { name, server, from } of await this.#serversFor(agentId)) {
			if ((await this.#logins.get(name)) === undefined) continue;

			/*
			 * A plugin of ours that runs in the sandbox reaches an API rather than a server, and the
			 * grant is that API: one host, the path its tools use, and the methods they use it with.
			 *
			 * This is the whole of why reading a mailbox this way is safe to hand over on a screen.
			 * What leaves the sandbox carries nothing, the token is written onto it at the proxy, and
			 * the grant exists only while this agent holds this plugin — take it off and the next
			 * request out is a bare one against a host nothing grants.
			 */
			const reaches = from === undefined ? undefined : pluginOf(from)?.reaches;
			if (reaches !== undefined) {
				earned.push({
					id: `mcp:${name}`,
					host: reaches.host,
					...(reaches.pathPrefix !== undefined ? { pathPrefix: reaches.pathPrefix } : {}),
					...(reaches.methods !== undefined ? { methods: [...reaches.methods] } : {}),
					injection: { kind: "bearer", token: oauthRef(name) },
				});
				continue;
			}

			const host = hostOf(server);
			if (host === undefined) continue;
			const at = endpointPath(server);
			earned.push({
				id: `mcp:${name}`,
				host,
				...(at !== undefined ? { pathPrefix: at } : {}),
				injection: { kind: "bearer", token: oauthRef(name) },
			});
		}

		// The hosts opened at the console go last, behind everything carrying a credential. They are the
		// only grants here with no key on them, so a tie they won would be a request going out bare to a
		// host something of the operator's was meant to be attached for.
		return [
			...declared,
			...(await this.#holding(agentId)),
			...(await this.#thinking(declared)),
			...(await this.#searching(declared)),
			...(await this.#looking(declared)),
			...(await this.#pipedThrough(declared)),
			...earned,
			...(await this.#reached(declared)),
		];
	}

	/** The three grants each repository the agent holds comes to. Behind the declared ones, like every derived grant. */
	async #holding(agentId: string): Promise<readonly Grant[]> {
		return (await this.repos(agentId)).flatMap((held) => repoGrants(agentId, held));
	}

	/**
	 * The repositories an agent holds, the file's first.
	 *
	 * A repository named in both places is the file's, so the console is told it is not theirs to
	 * change rather than shown two rows for one thing — the same rule the grants follow by id.
	 */
	async repos(agentId: string): Promise<readonly RepoStanding[]> {
		const declared = this.#agents.find((agent) => agent.id === agentId)?.repos ?? [];
		const here = (await this.#repos.of(agentId)).filter(
			(held) => !declared.some((own) => own.repo === held.repo),
		);
		return [
			...declared.map((spec) => repoStanding(agentId, spec, "file")),
			...here.map((spec) => repoStanding(agentId, spec, "here")),
		];
	}

	/**
	 * Every repository anybody here holds, and who holds it with what.
	 *
	 * The other way up from `repos(agentId)`, and the way a screen about repositories needs it: the
	 * question that screen answers is "who can touch this one", and asking it of the per-agent list
	 * means opening every agent in turn and holding the answer in your head.
	 *
	 * Whether there is a token comes with it, because it decides what the screen can do at all —
	 * without one there is nothing to list from GitHub and nothing to hand over.
	 */
	async heldRepos(): Promise<{
		readonly token: boolean;
		readonly repos: readonly {
			readonly repo: string;
			readonly url: string;
			readonly by: readonly {
				readonly agentId: string;
				readonly push: readonly string[];
				readonly origin: RepoOrigin;
			}[];
		}[];
	}> {
		const held = new Map<
			string,
			{
				repo: string;
				url: string;
				by: { agentId: string; push: readonly string[]; origin: RepoOrigin }[];
			}
		>();
		for (const agent of this.#agents) {
			for (const one of await this.repos(agent.id)) {
				const row = held.get(one.repo) ?? { repo: one.repo, url: one.url, by: [] };
				row.by.push({ agentId: agent.id, push: one.push, origin: one.origin });
				held.set(one.repo, row);
			}
		}
		const token = await this.#secrets.resolve({ ref: GITHUB_TOKEN_ENV });
		return {
			token: token !== undefined && token.length > 0,
			repos: [...held.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
		};
	}

	/**
	 * What this plane's token can see on GitHub.
	 *
	 * Asked of GitHub every time rather than written down: a token is given repositories and taken
	 * off them elsewhere, and a list of them kept here would be a list that is quietly wrong about
	 * what somebody can be given.
	 */
	async githubRepos(): Promise<readonly RepoOffer[]> {
		const token = await this.#secrets.resolve({ ref: GITHUB_TOKEN_ENV });
		if (token === undefined || token.length === 0) {
			throw new Error("This plane holds no GitHub token yet.");
		}
		return listRepos(token);
	}

	/** Keeps the token every repository here is reached with. Nothing is checked until one is given. */
	async setGithubToken(token: string): Promise<void> {
		const said = token.trim();
		if (said === "") throw new Error("That is not a token.");
		await this.#keys.keep(GITHUB_TOKEN_ENV, said);
	}

	/**
	 * Gives an agent a repository, once GitHub has said the plane's token can see it.
	 *
	 * Checked before it is written down, for the reason a bot token is: a token that was never given
	 * the repository becomes an agent told it holds one, meeting a 404 on its first clone, and nothing
	 * about that points back at the line it was pasted on. A token that can see it and not write to it
	 * is held with a sentence about it, because the fix for that is on GitHub's side and not here.
	 *
	 * With no token at all the repository is kept as an offer, the way an address is kept while the
	 * password is fetched: the next `/repo <token>` finishes it without the repository being retyped.
	 */
	async holdRepo(agentId: string, spec: RepoSpec): Promise<RepoHold> {
		const agent = this.#agents.find((one) => one.id === agentId);
		if (agent === undefined) throw new Error(`No agent "${agentId}" in this plane`);
		if ((agent.repos ?? []).some((own) => own.repo === spec.repo)) {
			return {
				kind: "refused",
				why: `${spec.repo} is in the config file for ${agentId}, so it is not ours to change`,
			};
		}
		const token = await this.#secrets.resolve({ ref: GITHUB_TOKEN_ENV });
		if (token === undefined || token.length === 0) {
			this.#offeredRepo = { agentId, spec };
			return { kind: "token-needed", spec };
		}
		const checked = await checkRepo(spec.repo, token);
		if (checked.kind === "refused") return { kind: "refused", why: checked.why };
		await this.#repos.hold(agentId, spec);
		await this.#reregister(agentId);
		this.#offeredRepo = undefined;
		return {
			kind: "held",
			standing: repoStanding(agentId, spec, "here"),
			...(checked.push
				? {}
				: {
						warning: `The token can see ${spec.repo} and cannot write to it, so GitHub will refuse every push there until the token has Contents: read and write on it.`,
					}),
		};
	}

	/**
	 * Keeps the GitHub token typed at a console, over the one the plane was started with if any, and
	 * finishes the repository that was waiting on it.
	 *
	 * Kept before it is checked, unlike a bot token, because there is nothing to check it against on
	 * its own: a fine-grained token answers for the repositories it was given and no others, so the
	 * check is the repository's, and a wrong token comes back as that repository being refused — with
	 * the offer still standing for the next paste.
	 */
	async keepGithubToken(agentId: string, token: string): Promise<RepoHold | undefined> {
		await this.#keys.keep(GITHUB_TOKEN_ENV, token);
		const offered = this.#offeredRepo;
		if (offered === undefined || offered.agentId !== agentId) return undefined;
		return this.holdRepo(agentId, offered.spec);
	}

	/** Takes a repository back from an agent, and its grants with it. */
	async dropRepo(agentId: string, repo: string): Promise<boolean> {
		const agent = this.#agents.find((one) => one.id === agentId);
		if ((agent?.repos ?? []).some((own) => own.repo === repo)) {
			throw new Error(`${repo} is in the config file for ${agentId}, so it is not ours to change`);
		}
		const had = await this.#repos.drop(agentId, repo);
		if (had) await this.#reregister(agentId);
		return had;
	}

	/**
	 * Derived here rather than folded in when the file was read, because the list can grow at the
	 * console now. Behind the declared ones, so a hand-written grant for the same host still wins.
	 */
	async #thinking(declared: readonly Grant[]): Promise<readonly Grant[]> {
		return modelGrants(await this.#addedModels.all()).filter(
			(grant) => !declared.some((own) => own.id === grant.id),
		);
	}

	/**
	 * The one grant the search tool needs, on the same terms as the model grants: derived rather than
	 * written down, so that choosing a search provider at the config screen is the whole of setting one
	 * up. Behind the declared ones, so the hand-written `search` grant older configurations still carry
	 * is the one that matches first and nothing changes under them.
	 */
	async #searching(declared: readonly Grant[]): Promise<readonly Grant[]> {
		return [searchGrant(await this.search())].filter(
			(grant) => !declared.some((own) => own.id === grant.id),
		);
	}

	/**
	 * The grant that pays for looking, when there is a model to look with. On the search grant's
	 * terms, and absent entirely on a plane where nobody turned looking on — which is most of them.
	 */
	async #looking(declared: readonly Grant[]): Promise<readonly Grant[]> {
		const vision = await this.vision();
		if (vision === undefined) return [];
		return [visionGrant(vision)].filter((grant) => !declared.some((own) => own.id === grant.id));
	}

	async #reached(declared: readonly Grant[]): Promise<readonly Grant[]> {
		return (await this.#addedGrants.all()).filter(
			(grant) => !declared.some((own) => own.id === grant.id),
		);
	}

	/**
	 * The hosts opened and piped, which is one row doing both.
	 *
	 * Ahead of the reached ones in the list, because a host on both lists is one somebody asked to be
	 * piped after opening it, and the piping is the later decision.
	 */
	async #pipedThrough(declared: readonly Grant[]): Promise<readonly Grant[]> {
		return (await this.#piped.all()).filter(
			(grant) => !declared.some((own) => own.id === grant.id),
		);
	}

	/** The hosts this plane pipes, and whether one was added or was already there. */
	async piped(): Promise<readonly string[]> {
		return this.#piped.hosts();
	}

	/**
	 * Opens a host and pipes it, or stops piping one.
	 *
	 * Every agent's grants are written again afterwards, on the search choice's terms: what the proxy
	 * holds and what the console says have to move together, and a host that was piped in one and read
	 * in the other is the worst of the two halves being out of step.
	 */
	async pipe(host: string, on: boolean): Promise<boolean> {
		const changed = on ? (await this.#piped.add(host), true) : await this.#piped.drop(host);
		if (changed) await this.#reregisterAll();
		return changed;
	}

	/**
	 * Tells the proxy what an agent may reach now, which is a different set from a minute ago
	 * whenever a server was attached, dropped, logged into or logged out of.
	 */
	async #reregister(agentId: string): Promise<void> {
		const proxyToken = this.#tokens.get(agentId);
		if (proxyToken === undefined) return;
		this.directory.register({ agentId, proxyToken, grants: await this.#grantsFor(agentId) });
	}

	/** For the changes that are not about one agent: a server forgotten, an account logged out of. */
	async #reregisterAll(): Promise<void> {
		for (const agent of this.#agents) await this.#reregister(agent.id);
	}

	/**
	 * Asks the server itself whether it wants an account, from the plane rather than the sandbox.
	 *
	 * Deliberately not through the proxy: the whole point of the question is that the agent is not
	 * granted this host yet, so a probe that went the agent's way would be denied by design and every
	 * server would look unreachable. Nothing of the agent's goes into it — an unauthenticated
	 * handshake, sent to a URL the operator typed a moment ago.
	 */
	async #reach(server: McpServer): Promise<Reachability> {
		if (server.transport === "stdio") return { kind: "open" };
		return reachability(server.url);
	}

	/**
	 * Every server on the shelf, with who holds it and whether it has an account here.
	 *
	 * The shelf is the plane's rather than an agent's, so there is a screen it belongs on: `/mcp` in a
	 * chat answers what this agent has, and the question left over — what has anybody got, and is any
	 * of it going unused — is one you would otherwise have to open every agent to ask.
	 */
	async servers(): Promise<readonly ServerStanding[]> {
		const standing: ServerStanding[] = [];
		for (const one of await this.#mcp.holding()) {
			standing.push({ ...one, loggedIn: (await this.#logins.status(one.name)) !== undefined });
		}
		return standing;
	}

	/**
	 * Puts a server on the shelf from the console, which attaches it to nobody.
	 *
	 * Adding widens nothing on its own: the grant for a remote one is derived from the agents holding
	 * it, so a shelf entry no agent was given is a URL written down and not a capability.
	 */
	async addServer(name: string, server: McpServer): Promise<void> {
		const refused = readName(name);
		if (refused !== undefined) throw new Error(refused);
		await this.#mcp.add(name, server);
	}

	/** Gives an agent one off the shelf, or takes it back. Its grant follows on the next turn. */
	async holdServer(agentId: string, name: string, held: boolean): Promise<void> {
		if (!(await this.#mcp.servers()).some((one) => one.name === name)) {
			throw new Error(`There is no server called "${name}"`);
		}
		if (!(await this.agents()).some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}"`);
		}
		if (held) await this.#mcp.attach(agentId, name);
		else await this.#mcp.detach(agentId, name);
		await this.#reregister(agentId);
	}

	/** Takes one off the shelf, and off every agent that had it — the two are one act. */
	async forgetServer(name: string): Promise<void> {
		if (!(await this.#mcp.servers()).some((one) => one.name === name)) {
			throw new Error(`There is no server called "${name}"`);
		}
		await this.#mcp.forget(name);
		await this.#reregisterAll();
	}

	/**
	 * What an agent holds, with anything the catalogue has since moved put right.
	 *
	 * A connection made from the catalogue is a copy of a catalogue entry, and the entry is where
	 * that plugin actually is. When one moves — a company publishes a server where there was none,
	 * an address changes — every connection made from it should follow, and the alternative is what
	 * happened here: a shelf pointing at a command that no longer exists in any image, an agent
	 * saying `spawn squad-gmail ENOENT` on every turn, and nothing on any screen admitting it.
	 *
	 * Only for the ones that came from the catalogue. An address somebody typed in is theirs, and
	 * this never touches it.
	 */
	async #serversFor(agentId: string): Promise<readonly NamedServer[]> {
		return (await this.#mcp.attached(agentId)).map((one) => {
			const plugin = one.from === undefined ? undefined : pluginOf(one.from);
			return plugin === undefined ? one : { ...one, server: serverOf(plugin) };
		});
	}

	/**
	 * The plugins screen's whole answer: what there is to connect, and what has been connected.
	 *
	 * Both halves in one reply because they are one question — "what can this plane reach, and
	 * through whose account" — and because the second is meaningless without the first: a row saying
	 * `stripe-2` means nothing until something says that Stripe is a thing one can have two of.
	 */
	async plugins(): Promise<{
		readonly catalog: readonly Plugin[];
		readonly instances: readonly ServerStanding[];
	}> {
		// A connection the shelf cannot name is named by its address, here rather than in whatever is
		// drawing it: the catalogue is on this side, and every screen asking this question wants the
		// same answer.
		const instances = (await this.servers()).map((one) => {
			if (one.from !== undefined) {
				// Drawn as it will be reached, which is the catalogue's address and not whatever was
				// written down the day this connection was made.
				const plugin = pluginOf(one.from);
				return plugin === undefined ? one : { ...one, server: serverOf(plugin) };
			}
			const from = pluginAt(one.server);
			return from === undefined ? one : { ...one, from };
		});
		return { catalog: PLUGINS, instances };
	}

	/**
	 * Connects a plugin, which is to say: makes one more copy of it under a name of its own.
	 *
	 * One plugin is not one connection. Connecting Stripe a second time is a legitimate, ordinary
	 * thing — the company's account and the side project's are two accounts — so this never refuses
	 * on the grounds that one is already here. It takes the next free name instead and says which it
	 * took, because that name is what the login will be opened against and what the model will spell.
	 *
	 * Nobody is given it. The shelf is the plane's, a grant is derived from the agents holding a
	 * server, and so an instance nobody was handed is an address written down and not a capability.
	 */
	async connectPlugin(
		pluginId: string,
		label?: string,
	): Promise<{ readonly name: string; readonly wants: "login" | "nothing" }> {
		const plugin = pluginOf(pluginId);
		if (plugin === undefined) throw new Error(`There is no plugin called "${pluginId}".`);
		const taken = (await this.#mcp.servers()).map((one) => one.name);
		const name = nameFor(plugin.id, taken);
		const server = serverOf(plugin);
		await this.#mcp.add(name, server, {
			from: plugin.id,
			...(label !== undefined && label !== "" ? { label } : {}),
		});
		// Read off the catalogue rather than asked of the server, which is the one place in this file
		// that is deliberately not the careful thing. Connecting has to be instant — it is a button
		// press with a screen waiting on it — and the answer only decides whether a consent tab opens
		// next. What actually settles it is the login itself, which asks the server on its way out.
		return { name, wants: plugin.account === "oauth" ? "login" : "nothing" };
	}

	/**
	 * Adds anything that is not on the shelf, from the line somebody typed.
	 *
	 * The line is read here rather than in the browser, because the reader is here: a URL is a URL
	 * wherever it appears and anything that is not one is a command, and a second implementation of
	 * that rule in a bundle would be a second thing that is nearly right.
	 */
	async addPlugin(name: string, line: string): Promise<void> {
		const refused = readName(name);
		if (refused !== undefined) throw new Error(refused);
		const read = readServer(
			line
				.trim()
				.split(/\s+/)
				.filter((word) => word !== ""),
		);
		if ("refused" in read) throw new Error(read.refused);
		await this.#mcp.add(name, read.server);
	}

	/** Says which copy a connection is, for the screens that have to tell two of them apart. */
	async labelPlugin(name: string, label: string): Promise<void> {
		if (!(await this.#mcp.servers()).some((one) => one.name === name)) {
			throw new Error(`There is no connection called "${name}".`);
		}
		await this.#mcp.relabel(name, label);
	}

	/**
	 * Opens the login for one connection, from the screen the connections are on.
	 *
	 * The same trip as `/plugins login` in a chat and deliberately not the same method: that one
	 * writes what happened into the conversation it was asked from, because the person who asked is
	 * reading a conversation. Here they are reading a list, and the list says so by the row going
	 * green on the next poll.
	 */
	async loginPlugin(name: string, clientId?: string, clientSecret?: string): Promise<LoginPage> {
		// Opened by whoever asked, which for this method is always a browser: it is the screen the
		// button is on, and it is holding this answer. Nothing else is told to open anything.
		const started = await this.#beginLogin(name, clientId, true, clientSecret);
		void started.done.then(
			() => this.#reregisterAll(),
			() => {},
		);
		return { url: started.url, redirectUri: started.redirectUri };
	}

	/** Closes the account a connection was opened with, and takes the reach it carried with it. */
	async logoutPlugin(name: string): Promise<boolean> {
		await this.#desk.cancel(name);
		const held = await this.#logins.forget(name);
		if (held) await this.#reregisterAll();
		return held;
	}

	/** The ceiling an agent is held to, in dollars a day, or nothing for no ceiling at all. */
	async setLimit(agentId: string, usd: number | null): Promise<void> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}"`);
		}
		if (usd !== null && (!Number.isFinite(usd) || usd <= 0)) {
			throw new Error(`"${usd}" is not an amount.`);
		}
		await this.#spend.setLimit(agentId, usd);
	}

	/**
	 * Starts the trip to a consent screen, whoever is going to be told how it ended.
	 *
	 * The two callers differ only in that: one writes the landing into a conversation and one lets a
	 * list redraw. Everything before the landing — finding the server, refusing a process that has no
	 * account, asking it where its metadata lives — is the same work and is done once, here.
	 */
	async #beginLogin(name: string, clientId?: string, opened?: boolean, clientSecret?: string) {
		const found = (await this.#mcp.servers()).find((one) => one.name === name);
		if (found === undefined) throw new Error(`There is no server called "${name}".`);

		/*
		 * A plugin of ours, whose account is at a provider that advertises nothing.
		 *
		 * Everything else here is an MCP server: it says where its authorization lives, a client is
		 * registered on the spot, and a person consents. Google is not one — it is an API, its two
		 * addresses have been the same for a decade, and the app is the operator's because the scope
		 * that reads a mailbox is one Google audits before an application may ask anybody for it.
		 */
		const plugin = found.from === undefined ? undefined : pluginOf(found.from);
		if (plugin?.oauth !== undefined) {
			const said = plugin.oauth;
			if (clientId === undefined) {
				throw new Error(
					`${plugin.title} does not register clients. Make an OAuth app of your own with ${loginRedirect()} as its redirect, and connect it with that app's client id.`,
				);
			}
			return {
				...(await this.#desk.begin({
					name,
					url: plugin.url,
					host: said.tokenUrl,
					clientId,
					...(clientSecret !== undefined ? { clientSecret } : {}),
					endpoints: {
						authorizationUrl: said.authorizationUrl,
						tokenUrl: said.tokenUrl,
						resource: plugin.url,
					},
					scopes: said.scopes,
					...(said.extra !== undefined ? { extra: said.extra } : {}),
					...(opened === true ? { opened } : {}),
				})),
				host: new URL(plugin.url).hostname,
			};
		}

		const host = hostOf(found.server);
		if (found.server.transport === "stdio" || host === undefined) {
			throw new Error(`"${name}" is a command this agent runs, not a place with an account.`);
		}
		// Asked first only for what the refusal names: a server that says where its metadata lives
		// saves a round of guessing, and one that says nothing costs a request nobody waits on twice.
		const said = await this.#reach(found.server);
		const where = said.kind === "authorize" ? said.resourceMetadataUrl : undefined;
		const started = await this.#desk.begin({
			name,
			url: found.server.url,
			host,
			...(clientId !== undefined ? { clientId } : {}),
			...(where !== undefined ? { resourceMetadataUrl: where } : {}),
			...(opened === true ? { opened } : {}),
		});
		return { ...started, host };
	}

	/**
	 * Opens a login for a server on the shelf, and arranges for its landing to be said out loud.
	 *
	 * The command answers long before the operator does, so what happens at the far end of the browser
	 * has to arrive in the conversation on its own: a login that succeeded silently would leave them
	 * looking at a tab saying it worked and a console saying nothing, with no way to tell whether the
	 * plane heard about it.
	 */
	async #login(agentId: string, name: string, clientId?: string): Promise<LoginPage> {
		const started = await this.#beginLogin(name, clientId);
		const host = started.host;
		void started.done
			.then(
				async () => {
					await this.#reregisterAll();
					await this.#record(agentId, {
						from: "plane",
						tone: "good",
						text: `Logged in to ${host}. This agent can reach "${name}" now.`,
					});
				},
				async (error: Error) => {
					await this.#record(agentId, {
						from: "plane",
						tone: "bad",
						text: `${name}: ${error.message}`,
					});
				},
			)
			.catch(() => {});
		return { url: started.url, redirectUri: started.redirectUri };
	}

	/** What this agent's bot is, if it has one. Read off the record, so it costs no request. */
	telegramStanding(agentId: string): TelegramStanding | undefined {
		const bot = this.telegram.bot(agentId);
		return bot === undefined ? undefined : standingOf(bot);
	}

	/**
	 * Gives an agent a bot, and answers with what it takes to finish.
	 *
	 * The token is checked against Telegram before it is written down, because a token that turns out
	 * to be a typo would otherwise be discovered as an agent that never answers — and nothing about
	 * that failure points at the line where it was pasted.
	 *
	 * Connecting leaves the bot listening to nobody at all. Pairing is what binds an account to it,
	 * and until somebody has tapped the link the plane has a bot and no operator for it.
	 */
	async connectTelegram(agentId: string, token: string): Promise<TelegramStanding> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		const identity = await this.telegram.identify(token);
		const bot: Bot = {
			agentId,
			token,
			...(identity.username !== undefined ? { username: identity.username } : {}),
			operators: [],
			chats: [],
			pairing: pairingPhrase(),
		};
		await this.#bots.save(bot);
		this.telegram.add(bot);
		return standingOf(bot);
	}

	/** Puts an agent's bot down, and says whether there was one. The token stays BotFather's. */
	async disconnectTelegram(agentId: string): Promise<boolean> {
		const had = await this.#bots.forget(agentId);
		this.telegram.remove(agentId);
		return had;
	}

	/** The plane's mailbox seen from one agent's place in it, or nothing if none is connected. */
	emailStanding(agentId: string): EmailStanding | undefined {
		const account = this.email.account;
		if (account === undefined) return undefined;
		return {
			mailbox: account.address,
			address: addressFor(account.address, agentId),
			host: account.host,
			port: account.port,
			guessed: account.found === "guess",
			writes: account.outgoing !== undefined,
			mute: this.#mailMute,
			fallback: account.fallback,
			operators: account.operators,
			phrase: account.pairing,
			trouble: this.#mailTrouble,
		};
	}

	/**
	 * Works out where an address's mail lives, and holds the answer against the password to come.
	 *
	 * Nothing is connected here and nothing is written down, because two of the three things this can
	 * discover are reasons not to go on: a provider that stopped issuing app passwords, and one whose
	 * mail is only reachable through a bridge running on a desktop this plane is not sitting at.
	 * Finding either of those out after asking somebody for a password wastes the one thing that has
	 * to be gone and found on another machine.
	 */
	async offerEmail(address: string): Promise<EmailOffer> {
		const base = baseAddress(address);
		const [servers, closed] = await Promise.all([discover(base), closedTo(base)]);
		const { incoming, outgoing } = servers;
		const offer: EmailOffer = {
			address: base,
			host: incoming.host,
			port: incoming.port,
			found: incoming.found,
			appPasswords: appPasswordPage(base),
			closed: closed?.why,
			bridge: needsBridge(incoming),
			...(outgoing !== undefined ? { outgoing } : {}),
		};
		this.#offered = offer;
		return offer;
	}

	/**
	 * Finishes the offer with a password, and starts reading.
	 *
	 * Logged into before it is written down, for the same reason a bot token is: a password with a
	 * character missing off the end becomes a mailbox that is listed as connected and never delivers
	 * anything, and nothing about that silence points back at the line where it was pasted.
	 *
	 * The mailbox arrives listening to nobody. What binds an operator is the phrase mailed back in
	 * from an address the sending domain signed, because `From:` is a line the sender chose and a
	 * mailbox that trusted it would take instructions from whoever could type the right address.
	 */
	async connectEmail(agentId: string, password: string): Promise<EmailStanding> {
		const offer = this.#offered;
		if (offer === undefined) throw new Error("No address to connect. Type /email <address> first.");

		const account: Account = {
			address: offer.address,
			host: offer.host,
			port: offer.port,
			username: offer.address,
			password,
			found: offer.found,
			// Mail with no tag on it has to reach somebody, and the agent this was typed at is the one
			// whose address the operator was just told. Not every provider does plus-addressing, and on
			// one that does not the bare address would otherwise be read and silently dropped.
			fallback: agentId,
			operators: [],
			pairing: pairingPhrase(),
			...(offer.outgoing !== undefined ? { outgoing: offer.outgoing } : {}),
		};

		// Reading decides whether there is a mailbox; sending only decides what it can do. A submission
		// server that refuses the same password leaves an account written down with nowhere to hand mail
		// in, which is a thing that can be said out loud — where a mailbox recorded as able to write back
		// and unable to would be an answer disappearing at the far end of every turn.
		const mute = await this.email.verify(account);
		const { outgoing: _refused, ...reading } = account;
		const settled = mute === undefined ? account : reading;

		await this.#mailbox.save(settled);
		this.#mailTrouble = undefined;
		this.#mailMute = mute;
		this.#offered = undefined;
		this.email.set(settled);
		return this.emailStanding(agentId) as EmailStanding;
	}

	/** This plane's email as the config screen has it, which is both halves of it at once. */
	async mail(): Promise<MailStanding> {
		const account = this.email.account;
		const resolved = account?.carrier === undefined ? undefined : resolveCarrier(account.carrier);
		const carrier = typeof resolved === "object" ? resolved : undefined;
		const keyEnv = carrier?.keyEnv;
		const held =
			keyEnv === undefined
				? account?.outgoing !== undefined
				: ((await this.#keys.resolve({ ref: keyEnv })) ?? "").length > 0;
		return {
			mailbox: account?.address,
			host: account?.host,
			carrier: account?.carrier?.carrier ?? "",
			domain: account?.carrier?.domain ?? "",
			keyEnv,
			held,
			here: keyEnv !== undefined && (await this.#keys.here()).has(keyEnv),
			writes: account !== undefined && held,
			senders: account?.operators ?? [],
			phrase: account?.pairing,
			// A carrier resolving to a sentence is a carrier chosen and not finished — the domain it will
			// not send without — and that is the trouble worth saying here over anything the reader hit.
			trouble: typeof resolved === "string" ? resolved : (this.#mailTrouble ?? this.#mailMute),
		};
	}

	/**
	 * Chooses who carries the mail out, or hands it back to the mailbox's own submission server.
	 *
	 * Written to the account rather than to a file of its own, because it is a fact about the mailbox
	 * in exactly the way the submission server it was discovered beside is. Nothing is verified here:
	 * a key can be pasted after the carrier is named, and a screen that refused the order would be a
	 * screen with one right order and no way to know it.
	 */
	async setCarrier(spec: CarrierSpec | undefined): Promise<void> {
		const account = this.email.account;
		if (account === undefined) throw new Error("There is no mailbox to send from yet.");
		// The name only. A carrier that still needs its domain is a half-filled row on the screen that
		// asked for it, and the screen says so; it is not a reason to refuse the name it was given.
		if (spec !== undefined && CARRIERS[spec.carrier] === undefined) {
			throw new Error(
				`nothing here knows how to send with "${spec.carrier}". Known: ${Object.keys(CARRIERS).join(", ")}`,
			);
		}
		const { carrier: _was, ...rest } = account;
		const settled: Account = spec === undefined ? rest : { ...rest, carrier: spec };
		await this.#mailbox.save(settled);
		this.#mailTrouble = undefined;
		this.email.set(settled);
	}

	/**
	 * Lets somebody write to the agents, and answers with the line as the list now holds it.
	 *
	 * Whoever is added here is an operator: their mail is read as instructions, spends turns and is
	 * answered from the agent's address. There is no lesser rung, and a screen that offered one would
	 * be offering to read mail it then had to decide what to do about.
	 *
	 * Two refusals, both said here rather than discovered later. Something that is neither an address
	 * nor a domain would sit on the list matching nothing, and a domain anybody can sign up at is a
	 * list entry that says colleagues and means the internet.
	 */
	allowSender(typed: string): string {
		if (this.email.account === undefined) {
			throw new Error("There is no mailbox yet, so there is nobody to let write to it.");
		}
		const entry = asOperator(typed);
		if (entry === undefined) {
			throw new Error(`"${typed}" is neither an address nor a domain, like *@company.com.`);
		}
		const wide = tooWide(entry);
		if (wide !== undefined) throw new Error(wide);

		const held = this.email.account.operators;
		if (!held.includes(entry)) this.email.allow([...held, entry]);
		return entry;
	}

	/**
	 * Takes one off, and says whether it was on.
	 *
	 * Taken literally rather than resolved: `*@company.com` is removed by naming that line, and never
	 * by naming somebody who was let in through it. A list where removing an address silently left it
	 * admitted would be a list that cannot be read.
	 *
	 * Written the same way as it was added, though. `allow company.com` goes on as `*@company.com`, so
	 * `deny company.com` has to find it — an entry that can only be taken off in a spelling nobody used
	 * to put it on is an entry that reads as stuck.
	 */
	denySender(entry: string): boolean {
		const account = this.email.account;
		if (account === undefined) return false;
		const wanted = asOperator(entry) ?? entry.trim().toLowerCase();
		const left = account.operators.filter((one) => one.toLowerCase() !== wanted);
		if (left.length === account.operators.length) return false;
		this.email.allow(left);
		return true;
	}

	/** Puts the mailbox down for the whole plane, and says whether there was one. */
	async disconnectEmail(): Promise<boolean> {
		const had = await this.#mailbox.forget();
		this.email.remove();
		this.#offered = undefined;
		this.#mailTrouble = undefined;
		this.#mailMute = undefined;
		return had;
	}

	/**
	 * Runs a line the operator typed as a command rather than as a message.
	 *
	 * Both halves go into the conversation, because that is where they were typed and where the
	 * answer will be read: a ceiling that changed with nothing to show for it is one nobody can
	 * later work out the reason for. The agent is not woken — this is the operator talking about
	 * the agent, not to it, and a turn spent reading a settings change is a turn wasted.
	 */
	async command(agentId: string, line: string): Promise<string> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		// The line is written down without its secret half: `/telegram <token>` is a credential typed
		// into a prompt, and a transcript is read back on a screen and kept on disk long after.
		await this.#record(agentId, { from: "operator", text: withoutSecrets(line) });
		const answer = await runCommand(line, this.#commandContext(agentId));
		await this.#record(agentId, { from: "plane", text: answer });
		return answer;
	}

	/**
	 * Everything a command may do to one agent, in one place because two things run commands at it.
	 *
	 * The operator types them and the agent asks for them, and they get the same context on purpose:
	 * what an agent may ask for is decided before this, by the list of lines it may send, and never by
	 * a quieter version of the plane. Two contexts would be two answers to "what does /mcp add do",
	 * and the day they drifted apart nothing would say so.
	 */
	#commandContext(agentId: string): CommandContext {
		return {
			agent: { id: agentId, created: this.#createdIds.has(agentId) },
			// The only thing in here that destroys anything, and it is given the agent the line was
			// typed at rather than a name off the line: whatever is typed after `/delete` is a word to be
			// checked against this agent, never a way to reach a different one.
			remove: () => this.remove(agentId, { purge: true }),
			clear: () => this.clear(agentId),
			account: () => this.#account(agentId),
			setLimit: (usd) => this.#spend.setLimit(agentId, usd),
			models: async () => ({
				all: await this.models(),
				// Falls back to the name in the config, so a plane with no list still answers the
				// question the command was typed to ask.
				using:
					(await this.#modelFor(agentId))?.id ??
					this.#agents.find((agent) => agent.id === agentId)?.model,
				keyless: await this.#keyless(),
			}),
			// No reregistering after it: every configured model was already reachable, which is the
			// whole reason this one is allowed to be a command at all.
			setModel: (id) => this.#choices.choose(agentId, id),
			mcp: async () => ({
				shelf: await this.#mcp.servers(),
				held: await this.#serversFor(agentId),
			}),
			served: async () => {
				const all = await this.#served.all();
				// Every port another agent is already coming out on, so an answer about a number that
				// moved can say whose it was rather than that it was somebody's.
				const theirs = new Map<number, string>();
				for (const [id, ports] of Object.entries(all)) {
					if (id === agentId) continue;
					for (const one of ports) theirs.set(one.at, id);
				}
				return { mine: all[agentId] ?? [], theirs };
			},
			serve: (port) => this.#served.open(agentId, port),
			unserve: (port) => this.#served.close(agentId, port),
			screen: () => this.screenStanding(agentId),
			setScreen: (on) => this.setScreen(agentId, on),
			vision: async () => ({ using: await this.vision(), offers: await this.visionOffers() }),
			chooseVision: (spec) => this.chooseVision(spec),
			piped: () => this.piped(),
			pipe: (host, on) => this.pipe(host, on),
			listening: (port) => this.#listening(agentId, port),
			// Asked of the same set the proxy will ask, so what the operator is told here is what the
			// agent will actually meet — rather than a second opinion that can be right while the wire
			// says otherwise.
			granted: async (host) => new GrantSet(await this.#grantsFor(agentId)).allowsHost(host),
			askReach: async (host) => this.#askReach(agentId, host),
			team: () => this.team(agentId),
			triggers: () => this.triggers(),
			addTrigger: (name, from, only, says) => this.addTrigger(agentId, name, from, only, says),
			describeTrigger: (name, says) => this.describeTrigger(name, says),
			dropTrigger: (name) => this.dropTrigger(name),
			skills: () => this.skills(agentId),
			keepSkill: (name, about) => this.keepSkill(agentId, name, about),
			giveSkill: (name, to) => this.giveSkill(agentId, to, name),
			gates: () => this.gates(agentId),
			setGate: (gate, hold) => this.setGate(agentId, gate, hold),
			holdTeam: (to) => this.holdTeam(agentId, to),
			dropTeam: (to) => this.dropTeam(agentId, to),
			repos: () => this.repos(agentId),
			holdRepo: (spec) => this.holdRepo(agentId, spec),
			keepGithubToken: (token) => this.keepGithubToken(agentId, token),
			dropRepo: (repo) => this.dropRepo(agentId, repo),
			addServer: (name, server) => this.#mcp.add(name, server),
			// Attaching and dropping change what the agent may reach, because a login's grant lasts only
			// as long as the agent is holding the server it was made for.
			attachServer: async (name) => {
				await this.#mcp.attach(agentId, name);
				await this.#reregister(agentId);
			},
			detachServer: async (name) => {
				await this.#mcp.detach(agentId, name);
				await this.#reregister(agentId);
			},
			forgetServer: async (name) => {
				await this.#mcp.forget(name);
				await this.#reregisterAll();
			},
			reach: (server) => this.#reach(server),
			loginStatus: (name) => this.#logins.status(name),
			login: (name, clientId) => this.#login(agentId, name, clientId),
			returned: async (name, redirected) => {
				await this.#desk.returned(name, redirected);
				await this.#reregisterAll();
			},
			logout: async (name) => {
				await this.#desk.cancel(name);
				const held = await this.#logins.forget(name);
				if (held) await this.#reregisterAll();
				return held;
			},
			telegram: async () => this.telegramStanding(agentId),
			connectTelegram: (token) => this.connectTelegram(agentId, token),
			disconnectTelegram: () => this.disconnectTelegram(agentId),
			email: async () => this.emailStanding(agentId),
			offerEmail: (address) => this.offerEmail(address),
			connectEmail: (password) => this.connectEmail(agentId, password),
			disconnectEmail: () => this.disconnectEmail(),
			allowSender: async (typed) => this.allowSender(typed),
			denySender: async (entry) => this.denySender(entry),
		};
	}

	/**
	 * Runs the commands an agent asked for at the end of its own turn.
	 *
	 * Both halves go into the conversation, exactly as the operator's do, and the agent's line is
	 * written down as the agent's: it is not the operator typing, and a transcript that showed it as
	 * one would be a transcript you cannot read back to find out who asked for a server.
	 *
	 * The answer goes to the operator rather than to the agent, and that is the point rather than a
	 * limitation. The one command worth asking for is the one that ends at a consent screen, and a
	 * consent screen is no use to the agent: the console opens it in the operator's browser, which is
	 * the whole of what the agent could not do for itself.
	 */
	async #applyAsked(agentId: string, asked: readonly string[]): Promise<void> {
		for (const line of asked) {
			// Checked each time round rather than once, because the line before this one may have been
			// the ceiling moving, and a pair of them is otherwise both measured against the old one.
			const { limitUsd } = await this.#account(agentId);
			// Marked the way the agent's own wakeup note is, because unmarked is how the console draws the
			// agent answering: a bare `/mcp login notion` sitting among replies is a line the operator has
			// to remember not having typed. `‹ask›` says the agent asked for this one.
			await this.#record(agentId, { from: "agent", via: "ask", text: line });

			const refusal = agentMayNot(line, { agentId, limitUsd });
			if (refusal !== undefined) {
				await this.#record(agentId, { from: "plane", tone: "bad", text: refusal });
				continue;
			}
			try {
				const answer = await runCommand(line, this.#commandContext(agentId));
				await this.#record(agentId, { from: "plane", text: answer });
			} catch (error) {
				// Caught so it stays caught, on the wakeup's terms: a throw here would leave the events
				// queued and the turn taken again, and an agent whose request could not be run would go on
				// paying for the turn that asked for it.
				await this.#record(agentId, {
					from: "plane",
					tone: "bad",
					text: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Runs a command inside an agent's sandbox and answers with what it printed.
	 *
	 * The operator is outside the box, so this grants nothing: whoever can reach the control socket
	 * already holds the Docker socket the plane runs on, and could open the same shell the long way
	 * round. What it saves is leaving the console to do it, which is why the question — what does it
	 * actually look like in there — usually went unasked.
	 *
	 * It runs where the agent runs, as the agent, so the answer is about the agent's world rather
	 * than about a shell that happens to be nearby: the same working directory, the same
	 * environment, and the same proxy, so `!curl` is refused exactly where the agent's would be.
	 * Independent of the turn, so an agent that is thinking can be looked at while it thinks — which
	 * is when there is most to see.
	 *
	 * The script goes in on stdin rather than in the command line, because arguments are visible to
	 * every process in the container, and the one other process in there is the agent.
	 *
	 * Where it ends up is remembered, so a `cd` is worth typing: the point of being let into the box
	 * is walking around it, and a shell that forgets between commands is one where every path has to
	 * be written out from the root every time.
	 */
	async shell(agentId: string, line: string): Promise<{ text: string; cwd: string }> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		await this.#record(agentId, { from: "operator", text: `!${line}` });

		const text = await this.#runShell(agentId, line);
		await this.#record(agentId, { from: "shell", text });
		return { text, cwd: this.#cwd.get(agentId) ?? SANDBOX_REPO_PATH };
	}

	/**
	 * What a half-typed path inside the sandbox could still become.
	 *
	 * Nothing about this is recorded. A tab is not a thing that was said: a conversation with a row
	 * in it for every key pressed while finding a directory is one nobody can read back through, and
	 * the transcript is what an agent's turn is reconstructed from.
	 *
	 * The word goes in as an argument to `node` rather than into a shell line, so that a directory
	 * called `; rm -rf ~` is a directory and never a command. Reading is all it does — the same
	 * reason it does not go through the shell at all, where a completion could have side effects.
	 */
	async complete(agentId: string, word: string): Promise<readonly string[]> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		const cwd = this.#cwd.get(agentId) ?? SANDBOX_REPO_PATH;
		const found = await this.sandboxes
			.exec(agentId, ["node", "-e", COMPLETE_SCRIPT, cwd, word])
			.catch(() => undefined);
		if (found === undefined || found.exitCode !== 0) return [];
		return found.stdout.split("\n").filter((option) => option.length > 0);
	}

	/**
	 * What is at a path inside an agent's box: the names in that folder, or that it is a file.
	 *
	 * The same reach as the shell above it and none of its shape. `!ls` answers a screenful of text
	 * that has to be read, remembered and typed against; this answers rows, which is what a person
	 * pointing at a folder is asking for. Nothing here is a new authority — whoever can reach this
	 * socket already holds that shell — and what it buys is that the question gets asked at all.
	 *
	 * Independent of the turn, like the shell, so an agent that is working can be looked at while it
	 * works. That is when there is most to see: a file appearing under a name nobody expected is the
	 * fastest way to find out what a turn actually decided to do.
	 */
	async files(agentId: string, at: string): Promise<Listing> {
		const path = this.#insideBox(agentId, at);
		const found = await this.sandboxes.exec(agentId, [
			"node",
			"-e",
			LIST_SCRIPT,
			path,
			String(MOST_ENTRIES),
		]);
		if (found.exitCode !== 0)
			throw new Error(refused(found.stderr, `Nothing is readable at ${tilde(path)}.`));
		return readAnswer<Listing>(found.stdout);
	}

	/**
	 * As much of one of its files as an answer carries, from a byte offset, as base64.
	 *
	 * In chunks rather than whole because a file has no upper bound and a protocol line does: the
	 * relay in front of a plane that is not on this machine refuses a frame over a quarter of a
	 * megabyte, and an answer that worked locally and failed over a link would be a feature that
	 * works on the developer's desk.
	 *
	 * base64 rather than text because half of what is worth looking at is not text — a screenshot,
	 * a PDF, the sqlite file a project keeps its state in — and a reader that could only carry
	 * strings would have to decide what a file is before it has read a byte of it.
	 */
	async readFile(agentId: string, at: string, from = 0): Promise<Slice> {
		const path = this.#insideBox(agentId, at);
		const found = await this.sandboxes.exec(agentId, [
			"node",
			"-e",
			READ_SCRIPT,
			path,
			String(Math.max(0, Math.floor(from))),
			String(FILE_CHUNK),
		]);
		if (found.exitCode !== 0)
			throw new Error(refused(found.stderr, `${tilde(path)} could not be read.`));
		return readAnswer<Slice>(found.stdout);
	}

	/**
	 * What the server behind one of its served ports is printing, from a byte offset.
	 *
	 * The half of `/serve` that was missing. A port opens a link to something an agent started, and
	 * when that something answers with a stack trace or does not answer at all, the only way to the
	 * reason was to spend a turn asking the agent to read its own log out loud — a conversation about
	 * a file, in the thread that is supposed to be about the work.
	 *
	 * Nothing is captured here and nothing is started here: the plane never held that process and has
	 * no pipe on it. What it does is what a person would do at a prompt in that container — find who
	 * holds the port, see where its output goes, read the file. Which means the answer is sometimes
	 * that the output goes somewhere nobody can read behind its back, and that is said as it is.
	 *
	 * No turn is spent and the agent is not woken. Reading what a program printed is not a thing to
	 * interrupt anybody over.
	 */
	async printing(agentId: string, port: number, from = -1): Promise<Printed> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`${port} is not a port.`);
		}
		const key = `${agentId}:${port}`;
		const found = await this.sandboxes.exec(agentId, [
			"node",
			"-e",
			LOGS_SCRIPT,
			"/proc",
			String(port),
			String(Math.floor(from)),
			String(LOG_CHUNK),
			this.#printing.get(key) ?? "",
		]);
		if (found.exitCode !== 0)
			throw new Error(refused(found.stderr, `Nothing in there could say what is on ${port}.`));
		const printed = readAnswer<Printed>(found.stdout);
		if (printed.at !== undefined) this.#printing.set(key, printed.at);
		return printed;
	}

	/**
	 * Puts a file into the box: one chunk, at an offset, and the last of them says so.
	 *
	 * The other direction, and the one that had no answer at all. An operator holding a PDF had to
	 * talk the agent into fetching it from somewhere the agent could reach — which means standing up
	 * a web server for a file that is already on the desk, or pasting it into the conversation as
	 * text it is not. Dropped on the screen instead, and it is in there.
	 *
	 * The last chunk is what writes the line into the conversation, and that line is the whole point
	 * of saying anything: a file that lands in a container nobody mentions is a file nobody knows
	 * arrived. The agent is not woken for it — a drop is not a turn, and spending one on every file
	 * of a folder is a bill for saying hello — so the console offers the sentence and the operator
	 * sends it.
	 */
	async putFile(
		agentId: string,
		at: string,
		data: string,
		from: number,
		last: boolean,
	): Promise<Wrote> {
		const path = this.#insideBox(agentId, at);
		const result = await this.sandboxes.run(
			agentId,
			[
				"node",
				"-e",
				WRITE_SCRIPT,
				path,
				String(Math.max(0, Math.floor(from))),
				last ? "last" : "more",
			],
			data,
			{ timeoutMs: SHELL_TIMEOUT_MS },
		);
		if (result.exitCode !== 0) {
			throw new Error(refused(result.stderr, `${tilde(path)} could not be written.`));
		}
		const wrote = readAnswer<Wrote>(result.stdout);
		if (last) {
			await this.#record(agentId, {
				from: "plane",
				text: `You left ${nameOfPath(path)} in ${tilde(folderOf(path))}.`,
			});
			this.#emit({ kind: "note", who: agentId, action: "given", detail: tilde(path) });
		}
		return wrote;
	}

	/**
	 * The agent this is about, and where in its box the path lands — or a refusal, before anything
	 * is run.
	 *
	 * Both questions in one because they are asked together every time and both have to be settled
	 * before a container is touched: a path is checked here rather than in the script inside the box,
	 * so that the edge of what this screen shows is a fact about the plane and not about whatever
	 * program happened to run.
	 */
	#insideBox(agentId: string, at: string): string {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		return insideBox(at);
	}

	async #runShell(agentId: string, line: string): Promise<string> {
		const cwd = this.#cwd.get(agentId) ?? SANDBOX_REPO_PATH;
		const { script, mark } = shellScript(line, cwd);
		try {
			const result = await this.sandboxes.run(agentId, ["sh", "-s"], script, {
				timeoutMs: SHELL_TIMEOUT_MS,
				workingDir: SANDBOX_REPO_PATH,
			});
			const ended = endedIn(result.stdout, mark);
			if (ended.cwd !== undefined) this.#cwd.set(agentId, ended.cwd);
			// A `cd` prints nothing, and "(no output)" under it would hide the one thing it did.
			const moved = ended.cwd !== undefined && ended.cwd !== cwd ? ended.cwd : undefined;
			return shellOutput({ ...result, stdout: ended.text }, moved);
		} catch (error) {
			// Said as output rather than thrown, because a command that could not run is an answer to
			// what was typed: a stopped sandbox and a command that exits 1 are the same kind of news.
			return (error as Error).message;
		}
	}

	/**
	 * Whether anything is listening on a port inside the sandbox, asked from inside the sandbox.
	 *
	 * The port is handed over as an argument rather than written into the script, so that nothing
	 * about a number becomes a line of the program that dials it.
	 */
	async #listening(agentId: string, port: number): Promise<boolean> {
		const probe = [
			'const s = require("node:net").connect({ port: Number(process.argv[1]), host: "127.0.0.1" });',
			"s.setTimeout(1000);",
			's.on("connect", () => { s.destroy(); process.exit(0); });',
			's.on("error", () => process.exit(1));',
			's.on("timeout", () => process.exit(1));',
		].join("\n");
		const probed = await this.sandboxes
			.exec(agentId, ["node", "-e", probe, String(port)])
			.catch(() => undefined);
		return probed?.exitCode === 0;
	}

	/**
	 * Opens a byte channel to a port inside an agent's sandbox, for the console to put a link on.
	 *
	 * An exec stream rather than a dial, for the same reason the pi session is one: the sandbox
	 * network is internal and a plane on the host cannot reach it over TCP, and giving it a routable
	 * one would hand the agent back the way out the sandbox exists to remove. This needs no port
	 * published anywhere and behaves the same whether the plane runs in a container or beside one.
	 *
	 * It goes to loopback inside the box, which is the part worth having: sandboxes share a network
	 * and can dial each other, so a server on 0.0.0.0 is one every other agent can reach — and a
	 * server on 127.0.0.1 is one only this reaches. The operator gets the link either way.
	 *
	 * Refused for a port nobody asked to serve. Not a boundary — whoever holds this socket can run
	 * anything they like in there — but the list is what the console binds and what the conversation
	 * says, and a way in that answered for ports on neither would make both of them fiction.
	 */
	async forward(agentId: string, port: number): Promise<Duplex> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		if (!(await this.#served.of(agentId)).some((one) => one.port === port)) {
			throw new Error(`${agentId} is not serving ${port}. /serve ${port} opens it.`);
		}
		// Long enough to ride out a dev server restarting under a page that is being reloaded, short
		// enough that a port with nothing behind it fails while the person is still looking at it.
		const relay = ["node", RELAY_PATH, String(port), String(FORWARD_CONNECT_MS)];
		// The one port that is not in the sandbox at all. A screen is a second container, and its live
		// view is on that container's loopback — which is what keeps it out of the agent's reach, since
		// the agent shares a network with it and not a loopback. Same tunnel, one door along.
		const stream =
			port === SCREEN_VIEW_PORT && (await this.wantsScreen(agentId))
				? await this.screens.attach(agentId, relay)
				: await this.sandboxes.attach(agentId, relay);
		return new ExecStream(stream);
	}

	/**
	 * Whether this agent's turns get the screen tools, which is two questions and not one.
	 *
	 * It has to have a screen, and its sandbox has to be able to use one. The second is not a detail:
	 * the tools ship in the sandbox image, and an agent running an image from before they existed is
	 * one pi will refuse to start for if it is handed them.
	 */
	async #screenTools(agentId: string): Promise<boolean> {
		return (await this.wantsScreen(agentId)) && (await this.sandboxHasScreenTools(agentId));
	}

	/**
	 * Whether the screen tools are in this agent's sandbox, asked of the sandbox and remembered.
	 *
	 * One exec the first time and nothing afterwards. The answer is a property of the image the
	 * container was made from, which cannot change while the container exists.
	 */
	async sandboxHasScreenTools(agentId: string): Promise<boolean> {
		const status = await this.sandboxes.status(agentId).catch(() => undefined);
		if (status === undefined) return false;
		const known = this.#screenToolsIn.get(status.containerId);
		if (known !== undefined) return known;
		const probed = await this.sandboxes
			.exec(agentId, ["test", "-f", SANDBOX_SCREEN_EXTENSION])
			.catch(() => undefined);
		// An exec that would not run at all is not an answer, and remembering it as "no" would leave an
		// agent without its browser until somebody restarted something. Asked again next turn instead.
		if (probed === undefined) return false;
		const has = probed.exitCode === 0;
		this.#screenToolsIn.set(status.containerId, has);
		return has;
	}

	/** Whether this agent is meant to have a browser: what the file said, unless the console differs. */
	async wantsScreen(agentId: string): Promise<boolean> {
		const declared = this.#agents.find((agent) => agent.id === agentId)?.screen;
		return hasScreen(declared, await this.#screenChoices.of(agentId));
	}

	/**
	 * Turns a screen on or off and makes it so, answering with where it ended up.
	 *
	 * `null` hands the decision back to the operator's file rather than setting it to off, which is
	 * the difference between "not for this agent" and "I have stopped having an opinion".
	 */
	async setScreen(agentId: string, on: boolean | null): Promise<ScreenStanding> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		await this.#screenChoices.set(agentId, on);
		await this.#settleScreen(agentId);
		return this.screenStanding(agentId);
	}

	/** What to say about an agent's screen: whether it is meant to be there, and whether it is. */
	async screenStanding(agentId: string): Promise<ScreenStanding> {
		const on = await this.wantsScreen(agentId);
		const status = await this.screens.status(agentId).catch(() => undefined);
		const at = (await this.#served.of(agentId)).find((one) => one.port === SCREEN_VIEW_PORT);
		// Asked only of a screen that is up, and left out when even that would not answer: a container
		// that is starting has no opinion about who is driving yet, and inventing one would put the
		// word "agent" in front of an operator at the moment they were about to take it.
		const keyboard = status?.running === true ? await this.#keyboardOf(agentId) : undefined;
		// Asked only of an agent that is meant to have one, because the answer costs an exec and means
		// nothing for an agent with no screen: every sandbox on a plane where nobody uses this would
		// otherwise be probed for a file it has no use for.
		const tools = on ? await this.sandboxHasScreenTools(agentId) : true;
		return {
			on,
			running: status?.running === true,
			...(tools ? {} : { toolless: true }),
			...(at === undefined ? {} : { at }),
			...(keyboard === undefined ? {} : { keyboard }),
			...(this.buildingScreen ? { building: true } : {}),
		};
	}

	/**
	 * Who is holding the keyboard, asked of the screen itself.
	 *
	 * Asked rather than remembered, because the plane is not where that is decided: the keyboard is
	 * taken on the live view and expires on a lease, and a copy of it here would be a copy that is
	 * wrong for ninety seconds every time somebody closes the tab. An exec is slow and this is a
	 * console command, which is the one place that is affordable.
	 */
	async #keyboardOf(agentId: string): Promise<"agent" | "operator" | undefined> {
		const asked = [
			`fetch("http://127.0.0.1:${SCREEN_VIEW_PORT}/state")`,
			".then((r) => r.text())",
			".then((t) => process.stdout.write(t))",
			".catch(() => process.exit(1))",
		].join("");
		const read = await this.screens.exec(agentId, ["node", "-e", asked]).catch(() => undefined);
		if (read?.exitCode !== 0) return undefined;
		try {
			const state: unknown = JSON.parse(read.stdout);
			const holder = (state as { holder?: unknown }).holder;
			return holder === "operator" ? "operator" : "agent";
		} catch {
			return undefined;
		}
	}

	/**
	 * Makes the browser match the decision about it, and opens or closes the way in to it.
	 *
	 * Called on every start and every time the decision changes, so it has to be safe to run against
	 * a screen that is already exactly right — which is most of the times it runs.
	 *
	 * The container is replaced rather than reused when the image moved or the egress credential did.
	 * Cheap, and the alternative is worse in a way that is hard to see: a screen adopted with a stale
	 * token is a browser whose every request is refused at the proxy, which looks from the inside like
	 * a browser with no internet and from the console like nothing at all.
	 */
	async #settleScreen(agentId: string): Promise<void> {
		const wanted = await this.wantsScreen(agentId);
		let existing = await this.screens.status(agentId).catch(() => undefined);

		if (!wanted) {
			if (existing !== undefined) await this.screens.destroy(agentId);
			// The way in goes with it. A link that opens onto a container that is not there is worse
			// than no link, because it is indistinguishable from the screen being broken.
			await this.#served.close(agentId, SCREEN_VIEW_PORT);
			return;
		}

		const token = this.#tokens.get(agentId);
		// No token means the sandbox has not started yet, and a browser carrying no egress credential
		// is one that reaches nothing. Settling happens again right after the sandbox does.
		if (token === undefined) return;
		const proxyUrl = `http://${encodeURIComponent(agentId)}:${token}@${this.#proxyOrigin}`;

		if (existing !== undefined) {
			const wantedImage = await this.screens.imageId().catch(() => undefined);
			const current = wantedImage === undefined || wantedImage === existing.imageId;
			if (!current || existing.proxyUrl !== proxyUrl) {
				await this.screens.destroy(agentId);
				existing = undefined;
			}
		}

		if (existing === undefined) {
			// The image is built here, on the machine that runs it, the first time anybody asks for a
			// screen. Started and not waited for: it is a gigabyte of Chromium and several minutes on a
			// small machine, and a console that hung for those minutes would look like one that had
			// crashed. The screen comes up when the build lands.
			if ((await this.screens.imageId().catch(() => undefined)) === undefined) {
				this.#buildScreenImage(agentId);
				return;
			}
			await this.screens.create({
				agentId,
				proxyUrl,
				caCertHostPath: this.caCertPath,
				// Handed down from this process's own environment, which is where a deployment says where
				// it is: compose passes TZ and SQUAD_SCREEN_LANG through, and an install that says neither
				// gets a browser with Chromium's own defaults rather than a guess about its operator.
				...(process.env.SQUAD_SCREEN_LANG ? { lang: process.env.SQUAD_SCREEN_LANG } : {}),
				...(process.env.TZ ? { timezone: process.env.TZ } : {}),
			});
		}
		await this.screens.start(agentId);
		await this.#served.open(agentId, SCREEN_VIEW_PORT);
	}

	/** Whether the browser image is being built right now, which is what an empty screen is waiting on. */
	get buildingScreen(): boolean {
		return this.#buildingScreens !== undefined;
	}

	/**
	 * Builds the browser image, says so in the conversation of whoever is waiting for it, and settles
	 * the screen again when it lands.
	 *
	 * Reported into the agent's own pane rather than only into the log, because the operator who
	 * typed `/screen on` is looking at that pane and is about to wonder why nothing opened. Two lines
	 * and not the build's four hundred: what it is doing, and how it went.
	 */
	#buildScreenImage(agentId: string): void {
		if (this.#buildingScreens !== undefined) return;
		void this.#record(agentId, {
			from: "plane",
			text: "Building the browser image. It is Chromium, so this takes a few minutes the first time — the screen comes up on its own when it lands, with nothing to type here.",
		});
		this.#buildingScreens = buildScreenImage({
			engine: this.#docker,
			image: this.screens.image,
			dir: screenImagePath(),
			// Swallowed rather than emitted line by line. A Docker build narrates four hundred lines and
			// every one of them would be in somebody's conversation, which is how a feed stops being read.
			say: () => {},
		})
			.then(async () => {
				void this.#record(agentId, { from: "plane", tone: "good", text: "The browser is built." });
				this.#buildingScreens = undefined;
				await this.#settleScreen(agentId);
			})
			.catch((error: unknown) => {
				this.#buildingScreens = undefined;
				this.#reportError(agentId, error as Error);
			});
	}

	/**
	 * Books a wakeup on the operator's say-so, from a console rather than from their file.
	 *
	 * Operator trust, because that is who typed it: the same sentence in the configuration file
	 * carries it, and a console is the same person saying the same thing somewhere the plane can
	 * also forget it again. Which is the whole of the difference and why it is written down as a
	 * third author — what the file declares is not this plane's to take away, and this is.
	 */
	async schedule(
		agentId: string,
		when: string,
		body: string,
		timeZone?: string,
	): Promise<Schedule> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`There is no agent called "${agentId}"`);
		}
		const said = body.trim();
		if (said.length === 0) throw new Error("A wakeup is a thing to be told. Say what to do.");
		const read = readWhen(when);
		if ("refused" in read) throw new Error(read.refused);
		return this.scheduler.add({
			agentId,
			...(read.kind === "cron"
				? { kind: "cron" as const, expression: read.expression }
				: { kind: "once" as const, runAt: read.runAt }),
			...(timeZone !== undefined && timeZone.length > 0 ? { timeZone } : {}),
			// Its own channel: a wakeup booked here belongs to no conversation in particular, and what
			// the agent says on waking goes where it says everything else.
			channel: WAKE_CHANNEL,
			body: said,
			trust: "operator",
			createdBy: "console",
		});
	}

	/**
	 * Stops the turn an agent is taking, and says whether there was one to stop.
	 *
	 * The turn ends where it is rather than failing: its events are answered for, so nothing takes it
	 * again. That is the difference between stopping something and interrupting it — an interrupted
	 * turn comes back, which is what whoever asked for this was trying to prevent.
	 */
	stopTurn(agentId: string): boolean {
		return this.#runners.get(agentId)?.stop?.(agentId) ?? false;
	}

	/**
	 * Throws away the conversation an agent is in, in all three places it is kept.
	 *
	 * The three are one thing to a person and three to this: what the model is shown at the start of
	 * the next turn, the transcript that outlives the console, and whatever pane is displaying it.
	 * Clearing fewer than all of them is worse than clearing none — an agent whose pane went empty
	 * while it still remembered everything would look cleared and answer as though it were not.
	 *
	 * The turn in flight goes first, and that is not a courtesy. pi holds the session open for the
	 * length of a turn and writes it out at the end, so a file deleted underneath a running turn comes
	 * straight back with everything in it: the clear would appear to work and be undone a minute
	 * later, which is the one outcome worth ruling out. Stopping is also what the operator meant —
	 * the thought in progress is part of what they asked to be rid of.
	 */
	async clear(agentId: string): Promise<{ stopped: boolean; remembered: boolean }> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		// Before anything is thrown away, and synchronously with the stop: a stopped turn still has its
		// half-answer to hand in, and a line handed in after this would be the one part of the
		// conversation that survived being cleared.
		this.#clearedMidTurn.add(agentId);
		const stopped = this.stopTurn(agentId);
		if (!stopped) this.#clearedMidTurn.delete(agentId);
		const remembered = (await this.#runners.get(agentId)?.forget?.(agentId)) ?? false;
		await this.#transcript.forget(agentId);
		this.#emit({ kind: "cleared", agentId });
		this.#emit({ kind: "note", who: agentId, action: "cleared", detail: "the conversation" });
		return { stopped, remembered };
	}

	/**
	 * Settles the one appointment an agent keeps with itself: books it, moves it, or drops it.
	 *
	 * The bounds are applied here and not only in the tool that writes the request, because the tool
	 * is a convenience inside a sandbox where the agent has a shell and could write the file itself.
	 * They clamp rather than refuse, because both ends of the range are ways of saying something an
	 * agent can mean: no wait at all becomes the next second, and a year becomes a month.
	 *
	 * Clamping is also why cancelling has to be its own request rather than a very distant time: with
	 * every number landing inside the range, there is none an agent could send that means "not at all".
	 *
	 * At most one wakeup is pending, so asking again moves the appointment instead of adding to it —
	 * without that, an agent that asks every turn fans out into as many turns as it has asked. The
	 * existing one goes either way, and only what replaces it differs.
	 */
	async #applyWake(agentId: string, wake: WakeChange, answering?: string): Promise<void> {
		try {
			for (const schedule of await this.scheduler.list(agentId)) {
				if (schedule.createdBy === "agent") await this.scheduler.remove(schedule.id);
			}
			// Unbooking the appointment is not enough, because an appointment that has already come due
			// is no longer only an appointment. A wakeup that fires while the agent is mid-turn queues
			// behind that turn, so an agent asked to do something else spends a turn deciding to be woken
			// no longer and is then woken anyway — by a note it wrote to a self it has stopped being.
			// Only its own bookings go: whoever spoke to it while it was busy is still owed an answer.
			await this.bus.discard(agentId, isOwnNote);
			if ("cancel" in wake) return;

			const afterSeconds = Math.min(
				Math.max(Math.round(wake.afterSeconds), MIN_WAKE_SECONDS),
				MAX_WAKE_SECONDS,
			);
			await this.scheduler.add({
				agentId,
				kind: "once",
				runAt: new Date(Date.now() + afterSeconds * 1000).toISOString(),
				// The channel the agent was talking on when it booked, so what it says on waking goes
				// back to whoever it is talking to. Answering to itself is what a wakeup did before,
				// and it meant that "un chiste cada un minuto" asked for by mail sent the first joke
				// by mail and every one after it to a pane nobody was watching. Its own channel is
				// left for a wakeup that belongs to no conversation.
				channel: answering ?? WAKE_CHANNEL,
				body: wake.note,
				// Never operator, however the agent asks. A single successful injection would otherwise
				// become permanent: the injected turn books a wakeup that instructs on the next one.
				trust: "participant",
				createdBy: "agent",
			});
		} catch (error) {
			// Caught here so it stays caught: a throw would leave the events queued and the turn taken
			// again, and an agent whose wakeup cannot be written would repeat the turn that asked for it.
			this.#reportError(
				`${agentId} wakeup`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	#emit(event: PlaneEvent): void {
		for (const watcher of this.#watchers) watcher(event);
	}

	/**
	 * A turn beginning: said out loud, and written down for whoever is not here yet.
	 *
	 * The writing down is the whole of what makes a reloaded console honest. Everything a turn does
	 * arrives as events, and events reach whoever was subscribed at the time — so the record of what
	 * is happening right now lived only in the browsers that happened to be open, and closing one
	 * threw away the only copy.
	 */
	#began(agentId: string): void {
		const at = new Date().toISOString();
		this.#inFlight.set(agentId, { at, steps: [], text: "" });
		this.#emit({ kind: "thinking", agentId, at });
	}

	/**
	 * Puts a line in the conversation: out to whoever is watching now, and down for whoever opens a
	 * console later.
	 *
	 * Said before it is written, and the write is not what the caller waits on. A transcript is a
	 * courtesy to the reader, and a disk that cannot take it is not a reason to hold up the turn.
	 */
	async #record(agentId: string, said: Utterance, queued = false): Promise<void> {
		// Stamped here rather than by the transcript, so the copy that goes out on the wire and the
		// copy that is written down are the same message. They were not: a line arrived live with no
		// time on it and grew one on the next reload, which is a conversation that quietly rewrites
		// itself behind whoever is reading it.
		const one: Utterance = { at: new Date().toISOString(), ...said };
		this.#emit({ kind: "said", agentId, said: one, ...(queued ? { queued: true } : {}) });
		// Said to whoever is watching, but not written down for an agent the plane no longer has: the
		// last thing anyone says about an agent is that it is gone, and writing that line would put
		// back the file the removal just took away.
		if (!this.#agents.some((agent) => agent.id === agentId)) return;
		await this.#transcript.append(agentId, one).catch((error: Error) => {
			this.#onError?.(`${agentId} transcript`, error);
		});
	}

	/**
	 * A turn somebody stopped, said as what it is in each of the two places it is heard.
	 *
	 * It goes out as a failure, because that is what it is to anything waiting on the answer: a
	 * `wake` holding on for the rest of it is released by this and would otherwise wait out its whole
	 * timeout for something that is not coming.
	 *
	 * In the conversation it is not a failure, and it used to be drawn as one — a red word under the
	 * last thing the agent said. The person reading that is the person who pressed the button, and a
	 * red word there reads as the agent having broken: something to go and look into, rather than the
	 * thing they just asked for. What it says now is what happened and what it means for the answer
	 * above it.
	 */
	#reportStopped(agentId: string): void {
		const said = new Error("stopped");
		this.#onError?.(agentId, said);
		this.#emit({ kind: "error", context: agentId, message: said.message });
		// The one case where they already know: the conversation this would go into has just been
		// thrown away, and by the same hand.
		if (this.#clearedMidTurn.has(agentId)) return;
		void this.#record(agentId, {
			from: "plane",
			text: "Stopped. Whatever it had said is above; the rest of that turn is not coming.",
		});
	}

	#reportError(context: string, error: Error): void {
		this.#onError?.(context, error);
		this.#emit({ kind: "error", context, message: error.message });
		// A failure reported against an agent's own name is a turn that did not answer, and the person
		// who asked is owed that in the conversation rather than only in a log they are not reading —
		// unless the conversation it would be owed in has just been thrown away, which is the one case
		// where they know why the turn did not answer: they ended it.
		if (this.#agents.some((agent) => agent.id === context) && !this.#clearedMidTurn.has(context)) {
			void this.#record(context, { from: "plane", tone: "bad", text: error.message });
		}
	}

	/** The proxy credential issued to an agent. Present only after start. */
	proxyToken(agentId: string): string | undefined {
		return this.#tokens.get(agentId);
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;

		await mkdir(join(this.#stateDir, "events"), { recursive: true });
		await this.broker.listen(this.#proxyPort, "0.0.0.0");
		// Before the port opens, so the first delivery to arrive finds the hooks already up rather
		// than being told that a trigger somebody has been using for a month does not exist.
		await this.#raiseTriggers();
		await this.webhooks.listen(this.#webhookPort, "0.0.0.0");
		await this.sandboxes.ensureNetwork();

		// The ones deleted in an earlier life, taken out before anything is started. The config still
		// declares them and always will, so this is the only thing standing between an agent somebody
		// threw away and a container coming back up under its name.
		for (const agentId of await this.#deleted.list()) {
			const index = this.#agents.findIndex((agent) => agent.id === agentId);
			if (index !== -1) this.#agents.splice(index, 1);
		}

		// The ones made from the CLI in an earlier life. A name the config has since claimed is the
		// config's: it says more about the agent than a name on its own ever could.
		for (const agentId of await this.#created.list()) {
			this.#createdIds.add(agentId);
			if (!this.#agents.some((agent) => agent.id === agentId)) {
				this.#agents.push(withDefaults({ id: agentId }, this.#defaults));
			}
		}

		// Put in place before the agents and read from after them, which are two different moments and
		// have to be. Starting an agent hands it whatever was left queued for it, so a turn runs here —
		// and a turn that ends before its channel exists is an answer thrown away, which for mail is
		// somebody who wrote in and got silence back. Reading, meanwhile, still has to wait: a message
		// arriving before the agents are up would name an agent this plane does not have yet and be
		// dropped as addressed to nobody.
		//
		// A bot whose agent is gone is left on the shelf rather than put in: the token is still good,
		// and it comes back with the name if the name does.
		for (const bot of await this.#bots.all()) {
			if (this.#agents.some((agent) => agent.id === bot.agentId)) this.telegram.add(bot);
		}
		const mailbox = await this.#mailbox.get();
		if (mailbox !== undefined) this.email.set(mailbox);

		// The cards that were on the screen when this process last stopped, back before anything can be
		// said to an agent: a question survives a restart because nothing makes an agent ask it twice.
		for (const [agentId, held] of Object.entries(await this.#standing.all())) {
			if (this.#agents.some((agent) => agent.id === agentId)) this.#questions.set(agentId, held);
		}

		for (const agent of this.#agents) await this.#startAgent(agent);

		this.telegram.start();
		this.email.start();

		// Anything left queued by a previous process is delivered before new work arrives.
		await this.bus.recover();
		this.scheduler.start();
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;

		this.scheduler.stop();
		this.telegram.stop();
		this.email.stop();
		await this.webhooks.close();
		await this.broker.close();
		// Sandboxes are left running. They are the agents, not this process's scratch space.
	}

	async #startAgent(agent: AgentConfig): Promise<void> {
		const proxyToken = await this.#adoptOrCreateSandbox(agent);
		this.#tokens.set(agent.id, proxyToken);
		await this.#reregister(agent.id);

		await this.sandboxes.start(agent.id);
		// After the sandbox rather than beside it, because the screen carries the agent's egress
		// credential and the credential is not known until the sandbox it belongs to exists. Failing
		// here is reported and not thrown: a screen that will not come up is a missing browser, and an
		// agent that cannot start at all because of one would be a far larger outage than the feature.
		await this.#settleScreen(agent.id).catch((error: unknown) =>
			this.#reportError(agent.id, error as Error),
		);
		// The manifest wants the model qualified by whoever serves it, so a configured one is written
		// out in full rather than by the short name it is picked by here.
		const thinking = await this.#modelFor(agent.id);
		const named = thinking !== undefined ? `${thinking.provider}/${thinking.model}` : agent.model;
		await ensureSelfRepo({
			sandbox: this.sandboxes,
			agentId: agent.id,
			...(agent.description !== undefined ? { description: agent.description } : {}),
			...(named !== undefined ? { model: named } : {}),
		});

		const runner = new PiTurnRunner({
			sandbox: this.sandboxes,
			onStep: (agentId, step) => {
				const turn = this.#inFlight.get(agentId);
				// The tail, because that is the part a pane has room for and the part still worth reading:
				// a turn four hundred steps deep is not four hundred things somebody arriving wants.
				if (turn !== undefined) turn.steps = [...turn.steps, step].slice(-KEPT_STEPS);
				this.#emit({ kind: "step", agentId, step });
			},
			// Asked again each turn rather than read once here, so a server added from the console
			// reaches an agent that is already up on its next turn, without recreating anything.
			servers: (agentId) => this.#serversFor(agentId),
			// Asked again each turn for the same reason, so `/model` reaches an agent that is already
			// up on its next turn rather than on its next container.
			model: (agentId) => this.#thinksWith(agentId),
			// And again for the same reason: a search provider chosen at the console searches on the
			// next turn rather than on the next container.
			search: () => this.search(),
			// And the model that looks, asked again each turn for the reason the search provider is: one
			// chosen at the console reaches an agent that is already up, on its next turn.
			vision: () => this.vision(),
			// And the repositories, so one given at the console is in front of the agent on its next
			// turn, with the branches it may push named before it tries one it may not.
			repos: (agentId) => this.repos(agentId),
			// And whether it has a browser, asked again each turn for the reason the rest are: a screen
			// turned on at the console is a screen the next turn can use, without the container that
			// the tools would otherwise have to be rebuilt into.
			screen: (agentId) => this.#screenTools(agentId),
			// And the other agents, asked again each turn because the answer changes within one: a door
			// opened at the console, and the one an operator opens by naming an agent in the message
			// that started this very turn.
			team: (agentId) => this.team(agentId),
			...(this.#turnIdleMs !== undefined ? { idleMs: this.#turnIdleMs } : {}),
		});
		await this.attach(agent.id, runner);

		for (const schedule of agent.schedules ?? []) {
			await this.scheduler.add({ ...schedule, agentId: agent.id });
		}
	}

	/**
	 * The agent's egress credential, and a sandbox that presents it.
	 *
	 * The token is baked into the container's environment when it is created, and the container is
	 * not recreated while it exists — so the container is the only record of what the proxy will
	 * actually be shown, and the plane has to read it back rather than decide it. A plane that
	 * decided instead came back from a restart denying every request its own agents made, the model
	 * included, and the only cure was destroying the sandbox that holds the agent.
	 *
	 * A container with no token to recover is one from before it was written there. It is replaced,
	 * which is cheap: the volume is the agent, and it is not what goes away.
	 */
	async #adoptOrCreateSandbox(agent: AgentConfig): Promise<string> {
		// By id, because the tag is rebuilt in place: a sandbox running last week's image answers to
		// the same name as one running today's, and the tools shipped in it are the difference.
		// Unknown means the daemon would not say, and churning every sandbox on that is worse.
		const wanted = await this.sandboxes.imageId(this.#image).catch(() => undefined);
		const existing = await this.sandboxes.status(agent.id);
		if (existing !== undefined) {
			const adopted = proxyTokenOf(existing.proxyUrl, agent.id);
			const current = wanted === undefined || wanted === existing.imageId;
			if (adopted !== undefined && current && carriesEnv(existing.env, agent.env)) return adopted;
			await this.sandboxes.destroy(agent.id, { discardState: false });
		}

		const proxyToken = randomBytes(24).toString("base64url");
		await this.sandboxes.create({
			agentId: agent.id,
			image: this.#image,
			proxyUrl: `http://${encodeURIComponent(agent.id)}:${proxyToken}@${this.#proxyOrigin}`,
			caCertHostPath: this.caCertPath,
			...(agent.env !== undefined ? { env: agent.env } : {}),
			...(agent.memoryBytes !== undefined ? { memoryBytes: agent.memoryBytes } : {}),
			...(agent.nanoCpus !== undefined ? { nanoCpus: agent.nanoCpus } : {}),
		});
		return proxyToken;
	}
}

/**
 * Where the browser image's sources are, relative to this file.
 *
 * The same shape as the console bundle's path, and for the same reason: the plane runs from the
 * repository whether it was installed by cloning it or by pulling an image that copied it in, so a
 * path from here is the one thing that is true in both.
 */
function screenImagePath(): string {
	return join(import.meta.dirname, "..", "..", "screen", "image");
}

/**
 * Whether a running sandbox still holds what the configuration says the agent is run with.
 *
 * Adoption keeps an agent alive across restarts, but a container's environment cannot be edited, so
 * an adopted sandbox is running on whatever it was born with. Change the provider and the agents
 * still up keep the old one's variables: every turn then dies inside pi, complaining about models,
 * naming nothing the operator edited. Recreating is cheap and the volume — the agent — is not what
 * goes away.
 *
 * Only the declared names are compared. The rest of the environment is the image's and the plane's
 * own, and demanding they match would recreate every sandbox on every unrelated change.
 */
export function carriesEnv(
	actual: Readonly<Record<string, string>>,
	declared: Readonly<Record<string, string>> | undefined,
): boolean {
	return Object.entries(declared ?? {}).every(([name, value]) => actual[name] === value);
}

/**
 * The token inside a sandbox's proxy URL, if it is this agent's to use.
 *
 * The user half is checked because the proxy authenticates on both: a container carrying another
 * agent's name would be denied whatever the token said, so recovering it would only postpone the
 * failure to the first request.
 */
/**
 * How narrowly a login's grant can be drawn, which depends on which transport it is.
 *
 * A streamable server is one URL and every message goes to it, so the grant can be that exact path
 * and nothing else on the host. An SSE server names its own posting address in the first event it
 * sends — a path this plane has not seen and cannot guess — so scoping to the stream's path would
 * grant the one request that never carries anything and deny the rest. Host-wide is the honest
 * answer there, and the host is still only the one the operator logged in to.
 */
export function endpointPath(server: McpServer): string | undefined {
	if (server.transport !== "http") return undefined;
	try {
		return new URL(server.url).pathname;
	} catch {
		return undefined;
	}
}

/**
 * What the MCP extension said would not connect, out of everything a turn wrote to stderr.
 *
 * A turn that succeeds throws its stderr away, and a server that never answered does not fail the
 * turn — so without this the one thing the operator has to go and fix is the one thing nobody is
 * told, and the only way to find out is a curl inside the container.
 */
export function troubledServers(stderr: string): readonly string[] {
	const mark = "[mcp] ";
	return stderr
		.split("\n")
		.filter((line) => line.startsWith(mark))
		.map((line) => line.slice(mark.length).trim());
}

export function proxyTokenOf(proxyUrl: string | undefined, agentId: string): string | undefined {
	if (proxyUrl === undefined) return undefined;
	try {
		const { username, password } = new URL(proxyUrl);
		if (password === "" || decodeURIComponent(username) !== agentId) return undefined;
		return decodeURIComponent(password);
	} catch {
		return undefined;
	}
}
