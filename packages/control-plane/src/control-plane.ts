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
	resolveCarrier,
	startLink,
	TelegramChannel,
	tooWide,
	WebhookChannel,
} from "@squad/channels";
import { EventBus, FileEventStore, isOwnNote } from "@squad/events";
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
import { DockerEngine, DockerSandboxManager } from "@squad/sandbox";
import { FileScheduleStore, type NewSchedule, Scheduler } from "@squad/scheduler";
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
	AddedGrants,
	carriedBy,
	type GrantStanding,
	originOf,
	reachId,
	readHost,
} from "./grants.ts";
import { ProviderKeys } from "./keys.ts";
import { MailboxStore, type MailStanding } from "./mailbox.ts";
import { hostOf, type McpServer, McpShelf, readName, type ServerStanding } from "./mcp.ts";
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
import { LoginDesk } from "./oauth-login.ts";
import type { AgentStep } from "./pi-output.ts";
import { RELAY_PATH } from "./pi-session.ts";
import { type Served, ServedPorts } from "./ports.ts";
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
import { SpendLedger } from "./spend.ts";
import { TelegramBots } from "./telegram.ts";
import { overheard, sentTo, Transcript, type Utterance } from "./transcript.ts";
import {
	createTurnHandler,
	PiTurnRunner,
	type TurnResult,
	type TurnRunner,
	type WakeChange,
} from "./turn.ts";

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
	readonly provider?: string;
	readonly model?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly memoryBytes?: number;
	readonly nanoCpus?: number;
	readonly schedules?: readonly Omit<NewSchedule, "agentId">[];
	/**
	 * The most this agent may spend in a day, in US dollars.
	 *
	 * An agent that books its own next turn can spend all night without anybody deciding that it
	 * should, which is the one failure here that arrives as a bill rather than as a bug. A ceiling
	 * set at the keyboard overrides this one, and neither is written back to the operator's file.
	 */
	readonly limitUsd?: number;
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
	readonly hooks?: readonly Hook[];
	readonly secrets?: SecretStore;
	readonly networkName?: string;
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
	readonly turnTimeoutMs?: number;
	readonly onAudit?: (entry: AuditEntry) => void;
	readonly onError?: (context: string, error: Error) => void;
	/** Called with whatever the agent said. Without it a running control plane is silent. */
	readonly onTurn?: (agentId: string, result: TurnResult) => void;
}

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
	 * A turn starting, which is a different moment from the message that caused it: a burst is one
	 * turn, and a message arriving at a busy agent waits for the one in front of it to finish.
	 *
	 * The console needs this said outright. A turn nobody in the room asked for — a schedule, a
	 * webhook, an agent waking itself — looks exactly like one that never happened otherwise.
	 */
	| { readonly kind: "thinking"; readonly agentId: string }
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
	/** When the agent asked to be woken next, if it did. ISO instant. */
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
	/** The ones the operator's file declared. The console adds to these; it never rewrites them. */
	readonly #declaredModels: readonly Model[];
	readonly #addedModels: AddedModels;
	/** The hosts opened at the console, on top of the ones the file grants every agent. */
	readonly #addedGrants: AddedGrants;
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
	readonly #turnTimeoutMs: number | undefined;
	readonly #tokens = new Map<string, string>();
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
		this.#turnTimeoutMs = options.turnTimeoutMs;
		this.#onError = options.onError;
		this.#onTurn = options.onTurn;
		this.#created = new AgentNameStore(join(this.#stateDir, "agents.json"), "createdAt");
		this.#deleted = new AgentNameStore(join(this.#stateDir, "deleted.json"), "deletedAt");
		this.#transcript = new Transcript(join(this.#stateDir, "transcript"));
		this.#spend = new SpendLedger(join(this.#stateDir, "spend.json"));
		this.#served = new ServedPorts(join(this.#stateDir, "served.json"));
		this.#declaredModels = options.models ?? [];
		this.#addedModels = new AddedModels(join(this.#stateDir, "added-models.json"));
		this.#addedGrants = new AddedGrants(join(this.#stateDir, "added-grants.json"));
		this.#choices = new ModelChoices(join(this.#stateDir, "models.json"));
		this.#keys = new ProviderKeys(
			join(this.#stateDir, "keys.json"),
			options.secrets ?? new EnvSecretStore(),
		);
		this.#secrets = this.#keys;
		this.#mcp = new McpShelf(join(this.#stateDir, "mcp.json"));
		this.#search = new SearchChoice(join(this.#stateDir, "search.json"));
		this.#bots = new TelegramBots(join(this.#stateDir, "telegram.json"));
		this.#mailbox = new MailboxStore(join(this.#stateDir, "mailbox.json"));
		this.#logins = new OAuthLogins(join(this.#stateDir, "oauth.json"));
		this.#desk = new LoginDesk(this.#logins, (url) => this.#emit({ kind: "open", url }));

		this.sandboxes = new DockerSandboxManager(
			new DockerEngine(),
			options.networkName ?? DEFAULT_NETWORK,
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
		this.webhooks = new WebhookChannel({ hooks: options.hooks ?? [], publisher: this.bus });
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
	}

	/** Host path of the CA certificate mounted into every sandbox. */
	get caCertPath(): string {
		return join(this.#stateDir, "pki", "ca.crt");
	}

	get stateDir(): string {
		return this.#stateDir;
	}

	/** Subscribes to everything the plane does. Returns the unsubscribe. */
	observe(listener: (event: PlaneEvent) => void): () => void {
		this.#watchers.add(listener);
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
		return Object.fromEntries(conversations);
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
			wakeAt: schedules.find((schedule) => schedule.createdBy === "agent")?.nextRunAt,
			created: this.#createdIds.has(agent.id),
			model: (await this.#modelFor(agent.id))?.id ?? agent.model,
			served: await this.#served.of(agent.id),
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
		this.#tokens.delete(agentId);
		// The directory was inside the container that just went. Whatever comes back is at its door.
		this.#cwd.delete(agentId);

		if (options.purge === true) {
			if (this.#createdIds.delete(agentId)) await this.#created.forget(agentId);
			else await this.#deleted.add(agentId);
			await this.#spend.forget(agentId);
			await this.#choices.forget(agentId);
			// The ports go with the container they pointed into. Left behind, the next agent to take
			// this name would inherit links to servers it never started.
			await this.#served.forget(agentId);
			// The conversation goes with the name. What was said to this agent is about the repository
			// that just went, and keeping it would hand a conversation to whoever gets the name next.
			await this.#transcript.forget(agentId);
			// What it was given, not what was found: a server stays on the shelf for the agents that
			// are left, and for the one somebody makes next.
			await this.#mcp.forgetAgent(agentId);
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
			router: this.router,
			onStart: (id) => this.#emit({ kind: "thinking", agentId: id }),
			onTurn: (id, result, to) => {
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
				// Said as a failure because that is what it is to anyone who was waiting: an answer
				// that is not coming. It is also what releases them — a `wake` still holding on for
				// the rest of it would otherwise wait out its whole timeout for nothing.
				if (result.stopped) this.#reportError(id, new Error("stopped"));
			},
			onSay: (id, text) => this.#emit({ kind: "say", agentId: id, text }),
			onWake: (id, wake, answering) => this.#applyWake(id, wake, answering),
			onAsked: (id, asked) => this.#applyAsked(id, asked),
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
			try {
				await handler(wakeup);
			} finally {
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
		for (const { name, server } of await this.#mcp.attached(agentId)) {
			const host = hostOf(server);
			if (host === undefined) continue;
			if ((await this.#logins.get(name)) === undefined) continue;
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
			...(await this.#thinking(declared)),
			...(await this.#searching(declared)),
			...earned,
			...(await this.#reached(declared)),
		];
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

	async #reached(declared: readonly Grant[]): Promise<readonly Grant[]> {
		return (await this.#addedGrants.all()).filter(
			(grant) => !declared.some((own) => own.id === grant.id),
		);
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
	 * Opens a login for a server on the shelf, and arranges for its landing to be said out loud.
	 *
	 * The command answers long before the operator does, so what happens at the far end of the browser
	 * has to arrive in the conversation on its own: a login that succeeded silently would leave them
	 * looking at a tab saying it worked and a console saying nothing, with no way to tell whether the
	 * plane heard about it.
	 */
	async #login(agentId: string, name: string, clientId?: string): Promise<LoginPage> {
		const found = (await this.#mcp.servers()).find((one) => one.name === name);
		if (found === undefined) throw new Error(`There is no server called "${name}".`);
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
		});
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
				held: await this.#mcp.attached(agentId),
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
			listening: (port) => this.#listening(agentId, port),
			// Asked of the same set the proxy will ask, so what the operator is told here is what the
			// agent will actually meet — rather than a second opinion that can be right while the wire
			// says otherwise.
			granted: async (host) => new GrantSet(await this.#grantsFor(agentId)).allowsHost(host),
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
		const stream = await this.sandboxes.attach(agentId, [
			"node",
			RELAY_PATH,
			String(port),
			String(FORWARD_CONNECT_MS),
		]);
		return new ExecStream(stream);
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
	 * Puts a line in the conversation: out to whoever is watching now, and down for whoever opens a
	 * console later.
	 *
	 * Said before it is written, and the write is not what the caller waits on. A transcript is a
	 * courtesy to the reader, and a disk that cannot take it is not a reason to hold up the turn.
	 */
	async #record(agentId: string, said: Utterance, queued = false): Promise<void> {
		this.#emit({ kind: "said", agentId, said, ...(queued ? { queued: true } : {}) });
		// Said to whoever is watching, but not written down for an agent the plane no longer has: the
		// last thing anyone says about an agent is that it is gone, and writing that line would put
		// back the file the removal just took away.
		if (!this.#agents.some((agent) => agent.id === agentId)) return;
		await this.#transcript.append(agentId, said).catch((error: Error) => {
			this.#onError?.(`${agentId} transcript`, error);
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
			onStep: (agentId, step) => this.#emit({ kind: "step", agentId, step }),
			// Asked again each turn rather than read once here, so a server added from the console
			// reaches an agent that is already up on its next turn, without recreating anything.
			servers: (agentId) => this.#mcp.attached(agentId),
			// Asked again each turn for the same reason, so `/model` reaches an agent that is already
			// up on its next turn rather than on its next container.
			model: (agentId) => this.#thinksWith(agentId),
			// And again for the same reason: a search provider chosen at the console searches on the
			// next turn rather than on the next container.
			search: () => this.search(),
			...(this.#turnTimeoutMs !== undefined ? { timeoutMs: this.#turnTimeoutMs } : {}),
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
