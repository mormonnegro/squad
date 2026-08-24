import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_NAME_PATTERN, SANDBOX_REPO_PATH } from "@agent-dive/agent-repo";
import { type Channel, ChannelRouter, type Hook, WebhookChannel } from "@agent-dive/channels";
import { EventBus, FileEventStore } from "@agent-dive/events";
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
} from "@agent-dive/proxy";
import { DockerEngine, DockerSandboxManager } from "@agent-dive/sandbox";
import { FileScheduleStore, type NewSchedule, Scheduler } from "@agent-dive/scheduler";
import {
	endedIn,
	type LoginPage,
	money,
	runCommand,
	SHELL_TIMEOUT_MS,
	shellOutput,
	shellScript,
} from "./commands.ts";
import { CreatedAgentStore } from "./created-agents.ts";
import { hostOf, type McpServer, McpShelf } from "./mcp.ts";
import { LoginDesk } from "./oauth-login.ts";
import type { AgentStep } from "./pi-output.ts";
import { ensureSelfRepo } from "./self.ts";
import { SpendLedger } from "./spend.ts";
import { overheard, Transcript, type Utterance } from "./transcript.ts";
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
	/** A line of the conversation, as it goes into the transcript that outlives the console. */
	| { readonly kind: "said"; readonly agentId: string; readonly said: Utterance }
	/**
	 * A turn starting, which is a different moment from the message that caused it: a burst is one
	 * turn, and a message arriving at a busy agent waits for the one in front of it to finish.
	 *
	 * The console needs this said outright. A turn nobody in the room asked for — a schedule, a
	 * webhook, an agent waking itself — looks exactly like one that never happened otherwise.
	 */
	| { readonly kind: "thinking"; readonly agentId: string }
	/** Something an agent did inside its sandbox, reported while the turn is still running. */
	| { readonly kind: "step"; readonly agentId: string; readonly step: AgentStep };

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
	 * What it thinks with, after the defaults have been folded in.
	 *
	 * The one fact about an agent that changes what every answer costs and how good it is, and the
	 * one nothing on screen used to say: the way to find it out was to go and read the operator's
	 * file, which is the wrong place to learn it from while an agent is answering badly.
	 */
	readonly model: string | undefined;
}

/**
 * The channel an agent's own wakeup arrives on, and answers back to.
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

const DEFAULT_IMAGE = "agent-dive/sandbox:dev";
const DEFAULT_NETWORK = "agent-dive-egress";
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

	readonly #agents: AgentConfig[];
	readonly #defaults: AgentDefaults | undefined;
	readonly #created: CreatedAgentStore;
	readonly #transcript: Transcript;
	readonly #runners = new Map<string, TurnRunner>();
	readonly #spend: SpendLedger;
	readonly #mcp: McpShelf;
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
		this.#stateDir = options.stateDir;
		this.#image = options.image ?? DEFAULT_IMAGE;
		this.#proxyPort = options.proxyPort ?? DEFAULT_PROXY_PORT;
		this.#proxyOrigin = options.proxyOrigin ?? `egress:${this.#proxyPort}`;
		this.#webhookPort = options.webhookPort ?? DEFAULT_WEBHOOK_PORT;
		this.#turnTimeoutMs = options.turnTimeoutMs;
		this.#onError = options.onError;
		this.#onTurn = options.onTurn;
		this.#created = new CreatedAgentStore(join(this.#stateDir, "agents.json"));
		this.#transcript = new Transcript(join(this.#stateDir, "transcript"));
		this.#spend = new SpendLedger(join(this.#stateDir, "spend.json"));
		this.#mcp = new McpShelf(join(this.#stateDir, "mcp.json"));
		this.#logins = new OAuthLogins(join(this.#stateDir, "oauth.json"));
		this.#desk = new LoginDesk(this.#logins);

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
				void this.#record(event.agentId, overheard(event));
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
			secrets: new OAuthSecretStore(this.#logins, options.secrets ?? new EnvSecretStore()),
			directory: this.directory,
			onAudit: (entry) => {
				options.onAudit?.(entry);
				this.#emit({ kind: "audit", entry });
			},
		});
		this.webhooks = new WebhookChannel({ hooks: options.hooks ?? [], publisher: this.bus });
		this.router.register(this.webhooks);
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
		return {
			...account,
			id: agent.id,
			running: status?.running ?? false,
			startedAt: status?.startedAt,
			grants: (await this.#grantsFor(agent.id)).length,
			schedules: schedules.length,
			wakeAt: schedules.find((schedule) => schedule.createdBy === "agent")?.nextRunAt,
			created: this.#createdIds.has(agent.id),
			model: agent.model,
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

		const agent = withDefaults({ id: agentId }, this.#defaults);
		await this.#created.add(agentId);
		this.#createdIds.add(agentId);
		this.#agents.push(agent);
		await this.#startAgent(agent);
		return this.#summarise(agent);
	}

	/**
	 * Takes an agent's sandbox away, and optionally the repository inside it.
	 *
	 * The volume is kept by default because it is the agent: its soul, what it chose to remember and
	 * the tools it wrote for itself. A container is replaceable and none of that is, so discarding it
	 * has to be asked for. A declared agent comes back on the next start either way, because it is in
	 * the config file, which this cannot write.
	 *
	 * An agent created at runtime is the exception, and only under --purge: nothing but this plane
	 * ever knew its name, so if the plane keeps it there is no file anywhere to take it out of.
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

		if (options.purge === true && this.#createdIds.delete(agentId)) {
			await this.#created.forget(agentId);
			await this.#spend.forget(agentId);
			// What it was given, not what was found: a server stays on the shelf for the agents that
			// are left, and for the one somebody makes next.
			await this.#mcp.forgetAgent(agentId);
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
			onTurn: (id, result) => {
				this.#onTurn?.(id, result);
				this.#emit({ kind: "turn", agentId: id, result });
				void this.#spend.record(id, result.costUsd);
				if (result.text.length > 0) {
					void this.#record(id, { from: "agent", text: result.text });
				}
				// Said as a failure because that is what it is to anyone who was waiting: an answer
				// that is not coming. It is also what releases them — a `wake` still holding on for
				// the rest of it would otherwise wait out its whole timeout for nothing.
				if (result.stopped) this.#reportError(id, new Error("stopped"));
			},
			onSay: (id, text) => this.#emit({ kind: "say", agentId: id, text }),
			onWake: (id, wake) => this.#applyWake(id, wake),
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
			await handler(wakeup);
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
		return [...declared, ...earned];
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
						text: `Logged in to ${host}. This agent can reach "${name}" now.`,
					});
				},
				async (error: Error) => {
					await this.#record(agentId, { from: "plane", text: `${name}: ${error.message}` });
				},
			)
			.catch(() => {});
		return { url: started.url, redirectUri: started.redirectUri };
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
		await this.#record(agentId, { from: "operator", text: line });
		const answer = await runCommand(line, {
			account: () => this.#account(agentId),
			setLimit: (usd) => this.#spend.setLimit(agentId, usd),
			mcp: async () => ({
				shelf: await this.#mcp.servers(),
				held: await this.#mcp.attached(agentId),
			}),
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
				this.#desk.cancel(name);
				const held = await this.#logins.forget(name);
				if (held) await this.#reregisterAll();
				return held;
			},
		});
		await this.#record(agentId, { from: "plane", text: answer });
		return answer;
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
	async #applyWake(agentId: string, wake: WakeChange): Promise<void> {
		try {
			for (const schedule of await this.scheduler.list(agentId)) {
				if (schedule.createdBy === "agent") await this.scheduler.remove(schedule.id);
			}
			if ("cancel" in wake) return;

			const afterSeconds = Math.min(
				Math.max(Math.round(wake.afterSeconds), MIN_WAKE_SECONDS),
				MAX_WAKE_SECONDS,
			);
			await this.scheduler.add({
				agentId,
				kind: "once",
				runAt: new Date(Date.now() + afterSeconds * 1000).toISOString(),
				channel: WAKE_CHANNEL,
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
	async #record(agentId: string, said: Utterance): Promise<void> {
		this.#emit({ kind: "said", agentId, said });
		await this.#transcript.append(agentId, said).catch((error: Error) => {
			this.#onError?.(`${agentId} transcript`, error);
		});
	}

	#reportError(context: string, error: Error): void {
		this.#onError?.(context, error);
		this.#emit({ kind: "error", context, message: error.message });
		// A failure reported against an agent's own name is a turn that did not answer, and the person
		// who asked is owed that in the conversation rather than only in a log they are not reading.
		if (this.#agents.some((agent) => agent.id === context)) {
			void this.#record(context, { from: "plane", text: error.message });
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

		// The ones made from the CLI in an earlier life. A name the config has since claimed is the
		// config's: it says more about the agent than a name on its own ever could.
		for (const agentId of await this.#created.list()) {
			this.#createdIds.add(agentId);
			if (!this.#agents.some((agent) => agent.id === agentId)) {
				this.#agents.push(withDefaults({ id: agentId }, this.#defaults));
			}
		}

		for (const agent of this.#agents) await this.#startAgent(agent);

		// Anything left queued by a previous process is delivered before new work arrives.
		await this.bus.recover();
		this.scheduler.start();
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;

		this.scheduler.stop();
		await this.webhooks.close();
		await this.broker.close();
		// Sandboxes are left running. They are the agents, not this process's scratch space.
	}

	async #startAgent(agent: AgentConfig): Promise<void> {
		const proxyToken = await this.#adoptOrCreateSandbox(agent);
		this.#tokens.set(agent.id, proxyToken);
		await this.#reregister(agent.id);

		await this.sandboxes.start(agent.id);
		await ensureSelfRepo({
			sandbox: this.sandboxes,
			agentId: agent.id,
			...(agent.description !== undefined ? { description: agent.description } : {}),
			...(agent.model !== undefined ? { model: agent.model } : {}),
		});

		const runner = new PiTurnRunner({
			sandbox: this.sandboxes,
			onStep: (agentId, step) => this.#emit({ kind: "step", agentId, step }),
			// Asked again each turn rather than read once here, so a server added from the console
			// reaches an agent that is already up on its next turn, without recreating anything.
			servers: (agentId) => this.#mcp.attached(agentId),
			...(agent.provider !== undefined ? { provider: agent.provider } : {}),
			...(agent.model !== undefined ? { model: agent.model } : {}),
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
