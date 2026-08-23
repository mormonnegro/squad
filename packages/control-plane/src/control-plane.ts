import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
import { ProxyTokenStore } from "./proxy-tokens.ts";
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

export interface ControlPlaneOptions {
	readonly agents: readonly AgentConfig[];
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

	readonly #agents: readonly AgentConfig[];
	readonly #stateDir: string;
	readonly #image: string;
	readonly #proxyPort: number;
	readonly #proxyOrigin: string;
	readonly #webhookPort: number;
	readonly #turnTimeoutMs: number | undefined;
	readonly #proxyTokens: ProxyTokenStore;
	readonly #tokens = new Map<string, string>();
	readonly #onError: ((context: string, error: Error) => void) | undefined;
	readonly #onTurn: ((agentId: string, result: TurnResult) => void) | undefined;
	readonly #watchers = new Set<(event: PlaneEvent) => void>();
	#started = false;

	constructor(options: ControlPlaneOptions) {
		this.#agents = options.agents;
		this.#stateDir = options.stateDir;
		this.#image = options.image ?? DEFAULT_IMAGE;
		this.#proxyPort = options.proxyPort ?? DEFAULT_PROXY_PORT;
		this.#proxyOrigin = options.proxyOrigin ?? `egress:${this.#proxyPort}`;
		this.#webhookPort = options.webhookPort ?? DEFAULT_WEBHOOK_PORT;
		this.#turnTimeoutMs = options.turnTimeoutMs;
		this.#onError = options.onError;
		this.#onTurn = options.onTurn;
		this.#proxyTokens = new ProxyTokenStore(join(this.#stateDir, "proxy-tokens.json"));

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
		return Promise.all(
			this.#agents.map(async (agent) => {
				const status = await this.sandboxes.status(agent.id).catch(() => undefined);
				return {
					id: agent.id,
					running: status?.running ?? false,
					startedAt: status?.startedAt,
					grants: agent.grants?.length ?? 0,
					schedules: agent.schedules?.length ?? 0,
				};
			}),
		);
	}

	/**
	 * Takes an agent's sandbox away, and optionally the repository inside it.
	 *
	 * The volume is kept by default because it is the agent: its soul, what it chose to remember and
	 * the tools it wrote for itself. A container is replaceable and none of that is, so discarding it
	 * has to be asked for. Either way the agent is still in the config file, which this cannot write,
	 * so it comes back when the plane next starts.
	 */
	async remove(agentId: string, options: { purge?: boolean } = {}): Promise<void> {
		if (!this.#agents.some((agent) => agent.id === agentId)) {
			throw new Error(`No agent "${agentId}" in this plane`);
		}
		this.bus.unregister(agentId);
		await this.sandboxes.destroy(agentId, { discardState: options.purge === true });
		// The token was baked into the container that just went away, so nothing holds it any more.
		await this.#proxyTokens.forget(agentId);
		this.#tokens.delete(agentId);
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
		const proxyToken = await this.#proxyTokens.ensure(agent.id);
		this.#tokens.set(agent.id, proxyToken);
		this.directory.register({
			agentId: agent.id,
			proxyToken,
			grants: agent.grants ?? [],
		});

		if (!(await this.sandboxes.status(agent.id))) {
			await this.sandboxes.create({
				agentId: agent.id,
				image: this.#image,
				proxyUrl: `http://${encodeURIComponent(agent.id)}:${proxyToken}@${this.#proxyOrigin}`,
				caCertHostPath: this.caCertPath,
				...(agent.env !== undefined ? { env: agent.env } : {}),
				...(agent.memoryBytes !== undefined ? { memoryBytes: agent.memoryBytes } : {}),
				...(agent.nanoCpus !== undefined ? { nanoCpus: agent.nanoCpus } : {}),
			});
		}
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
}
