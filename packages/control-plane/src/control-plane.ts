import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_NAME_PATTERN } from "@agent-dive/agent-repo";
import { ChannelRouter, type Hook, WebhookChannel } from "@agent-dive/channels";
import { EventBus, FileEventStore } from "@agent-dive/events";
import {
	type AuditEntry,
	EgressBroker,
	EnvSecretStore,
	type Grant,
	loadOrCreateCertificateAuthority,
	type SecretStore,
	StaticAgentDirectory,
} from "@agent-dive/proxy";
import { DockerEngine, DockerSandboxManager } from "@agent-dive/sandbox";
import { FileScheduleStore, type NewSchedule, Scheduler } from "@agent-dive/scheduler";
import { CreatedAgentStore } from "./created-agents.ts";
import { ensureSelfRepo } from "./self.ts";
import { createTurnHandler, PiTurnRunner, type TurnResult, type TurnRunner } from "./turn.ts";

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
	| { readonly kind: "error"; readonly context: string; readonly message: string };

export interface AgentSummary {
	readonly id: string;
	readonly running: boolean;
	readonly startedAt: string | undefined;
	readonly grants: number;
	readonly schedules: number;
	/** Made here rather than declared in the config, which is the only kind the plane may forget. */
	readonly created: boolean;
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

		this.sandboxes = new DockerSandboxManager(
			new DockerEngine(),
			options.networkName ?? DEFAULT_NETWORK,
		);
		this.bus = new EventBus({
			store: new FileEventStore(join(this.#stateDir, "events")),
			onError: (agentId, error) => this.#reportError(agentId, error),
		});
		this.scheduler = new Scheduler({
			publisher: this.bus,
			store: new FileScheduleStore(join(this.#stateDir, "schedules.json")),
			onError: (schedule, error) => this.#reportError(`schedule ${schedule.id}`, error),
		});
		this.broker = new EgressBroker({
			ca: loadOrCreateCertificateAuthority(join(this.#stateDir, "pki")),
			secrets: options.secrets ?? new EnvSecretStore(),
			directory: this.directory,
			onAudit: (entry) => {
				options.onAudit?.(entry);
				this.#emit({ kind: "audit", entry });
			},
		});
		this.webhooks = new WebhookChannel({ hooks: options.hooks ?? [], publisher: this.bus });
		this.router.register(this.webhooks);
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

	/** What each agent is and whether its sandbox is up. */
	async agents(): Promise<AgentSummary[]> {
		return Promise.all(this.#agents.map((agent) => this.#summarise(agent)));
	}

	async #summarise(agent: AgentConfig): Promise<AgentSummary> {
		const status = await this.sandboxes.status(agent.id).catch(() => undefined);
		return {
			id: agent.id,
			running: status?.running ?? false,
			startedAt: status?.startedAt,
			grants: agent.grants?.length ?? 0,
			schedules: agent.schedules?.length ?? 0,
			created: this.#createdIds.has(agent.id),
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
		await this.sandboxes.destroy(agentId, { discardState: options.purge === true });
		this.#tokens.delete(agentId);

		if (options.purge === true && this.#createdIds.delete(agentId)) {
			await this.#created.forget(agentId);
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
		await this.bus.register(
			agentId,
			createTurnHandler({
				runner,
				router: this.router,
				onTurn: (id, result) => {
					this.#onTurn?.(id, result);
					this.#emit({ kind: "turn", agentId: id, result });
				},
				// Named by destination, not by agent, so an operator waiting on their own reply is not
				// told that somebody else's channel is the reason.
				onUndelivered: (id, channel, error) => this.#reportError(`${id} -> ${channel}`, error),
			}),
		);
	}

	#emit(event: PlaneEvent): void {
		for (const watcher of this.#watchers) watcher(event);
	}

	#reportError(context: string, error: Error): void {
		this.#onError?.(context, error);
		this.#emit({ kind: "error", context, message: error.message });
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
		this.directory.register({
			agentId: agent.id,
			proxyToken,
			grants: agent.grants ?? [],
		});

		await this.sandboxes.start(agent.id);
		await ensureSelfRepo({
			sandbox: this.sandboxes,
			agentId: agent.id,
			...(agent.description !== undefined ? { description: agent.description } : {}),
			...(agent.model !== undefined ? { model: agent.model } : {}),
		});

		const runner = new PiTurnRunner({
			sandbox: this.sandboxes,
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
		const existing = await this.sandboxes.status(agent.id);
		if (existing !== undefined) {
			const adopted = proxyTokenOf(existing.proxyUrl, agent.id);
			if (adopted !== undefined) return adopted;
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
 * The token inside a sandbox's proxy URL, if it is this agent's to use.
 *
 * The user half is checked because the proxy authenticates on both: a container carrying another
 * agent's name would be denied whatever the token said, so recovering it would only postpone the
 * failure to the first request.
 */
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
