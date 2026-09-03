import { LESSONS_FILE, SANDBOX_REPO_PATH } from "@squad/agent-repo";

/** Where the egress proxy's root certificate is mounted inside the sandbox. */
export const CA_CERT_PATH = "/etc/squad/ca.crt";

export const SANDBOX_HOME = "/home/agent";

/**
 * Where the agent puts the things it builds, on a volume of its own.
 *
 * Beside the repository rather than inside it, because the repository is the agent — its soul, its
 * skills, what it chose to remember — and a to-do list app checked in among those is a change to who
 * the agent is. An agent given nowhere else works where it is standing, and where it was standing
 * was `.self`; this is somewhere else to stand.
 *
 * Its own volume rather than a directory under the home, because only a volume survives the
 * container being replaced, and a container is replaced every time the image is rebuilt. Work that
 * evaporates on the next `squad up` is work nobody would leave here.
 */
export const SANDBOX_WORKSPACE_PATH = `${SANDBOX_HOME}/workspace`;

/** Non-root uid:gid the agent process runs as. Must match the sandbox image. */
export const SANDBOX_USER = "1000:1000";

/** The extension that gives the agent a way to ask for its next turn. Shipped in the image. */
export const SANDBOX_WAKE_EXTENSION = "/usr/local/lib/squad/extensions/wake.ts";

/** The extension that gives the agent a way to reach the web. Shipped in the image. */
export const SANDBOX_SEARCH_EXTENSION = "/usr/local/lib/squad/extensions/search.ts";

/**
 * The extension that gives the agent the tools the operator connected it to. Shipped in the image.
 *
 * pi has no MCP of its own and says so on purpose, pointing at extensions as the way to add it. So
 * this is not configuration being passed along: it is a whole MCP client, and it is ours.
 */
export const SANDBOX_MCP_EXTENSION = "/usr/local/lib/squad/extensions/mcp.ts";

/**
 * The extension that lets an agent ask for the console commands that concern itself. Shipped in the
 * image.
 *
 * The alternative it replaces is the agent writing a paragraph asking the operator to go and type
 * something — which is how an agent that needed one server ends up blocked for a day on a line
 * nobody was there to read.
 */
export const SANDBOX_CONSOLE_EXTENSION = "/usr/local/lib/squad/extensions/console.ts";

/**
 * The extension that lets an agent write down what it got wrong. Shipped in the image.
 *
 * The only one of these whose file the agent keeps rather than hands over, and the only one whose
 * effect lands on a turn nobody has asked for yet.
 */
export const SANDBOX_REMEMBER_EXTENSION = "/usr/local/lib/squad/extensions/remember.ts";

/**
 * Every extension the plane hands the agent, which is a list because there is more than one and
 * naming only the first is a silent way to lose the rest. An extension in the image that nothing
 * names is one the agent never finds, and what that looks like from outside is not an error: it is
 * the agent solving the problem some worse way it does have — reaching for `curl` where it had a
 * tool, and reporting the proxy's refusal as though the web were down.
 */
export const SANDBOX_EXTENSIONS: readonly string[] = [
	SANDBOX_WAKE_EXTENSION,
	SANDBOX_SEARCH_EXTENSION,
	SANDBOX_MCP_EXTENSION,
	SANDBOX_CONSOLE_EXTENSION,
	SANDBOX_REMEMBER_EXTENSION,
];

/**
 * Where that extension leaves the request, and the plane looks for it once the turn is over.
 *
 * Outside the agent's repository on purpose: the repository is the agent's own and everything in it
 * is committed, and a request the plane consumes within the minute is not something to keep.
 */
export const SANDBOX_WAKE_FILE = `${SANDBOX_HOME}/.run/wake.json`;

/**
 * Where the plane leaves the servers this agent has been given, for the extension to read at the
 * start of every turn.
 *
 * Beside the wakeup rather than in the repository, and for a stronger version of the same reason:
 * the shelf is the plane's and this is a copy of the part of it that concerns one agent. Keeping it
 * on the agent's own volume would make it something the agent could edit — which is to say, a way
 * to be connected to a server nobody granted.
 */
export const SANDBOX_MCP_FILE = `${SANDBOX_HOME}/.run/mcp.json`;

/**
 * Where the plane leaves the search provider it has chosen, read at the start of every turn.
 *
 * Beside the servers and for the same reason: which provider searches, what it drives and what that
 * costs are the plane's to decide, and a copy on the agent's own volume would be a copy the agent
 * could edit — which is to say, a way to search somewhere nobody granted and bill it as nothing.
 */
export const SANDBOX_SEARCH_FILE = `${SANDBOX_HOME}/.run/search.json`;

/**
 * Where the agent leaves the console commands it is asking for, read once the turn is over.
 *
 * A list rather than one line, unlike the wakeup, because these are steps: adding a server and then
 * logging into it is one intention, and an agent that could only ask for the first half would spend
 * a turn waiting to be allowed to ask for the second.
 */
export const SANDBOX_CONSOLE_FILE = `${SANDBOX_HOME}/.run/console.json`;

/**
 * Where the agent writes down what it got wrong, and the plane reads it back to it every turn.
 *
 * Inside the repository, unlike the four above, because this one is not a message: it is part of
 * what the agent has become, it belongs in the same git history as the soul it sits beside, and an
 * agent whose lessons lived on the plane's side would be an agent that cannot reread or rewrite its
 * own. That it can rewrite this is the design and not a hole — the file is a copy of its judgement,
 * and nothing is granted by it.
 */
export const SANDBOX_LESSONS_FILE = `${SANDBOX_REPO_PATH}/${LESSONS_FILE}`;

export interface SandboxSpec {
	readonly agentId: string;
	readonly image: string;
	/** Named Docker volume holding the agent repository. Survives container replacement. */
	readonly volumeName: string;
	/** Named Docker volume holding what the agent builds. Survives container replacement too. */
	readonly workspaceVolumeName: string;
	/** Internal Docker network. Must have no route off-host except through the proxy. */
	readonly networkName: string;
	/** Reachable from inside the network, e.g. "http://agent-1:token@egress:8080". */
	readonly proxyUrl: string;
	/** Host path of the proxy CA certificate, mounted read-only. */
	readonly caCertHostPath: string;
	readonly memoryBytes?: number;
	readonly nanoCpus?: number;
	readonly env?: Readonly<Record<string, string>>;
	/** Overrides the image's default command. */
	readonly cmd?: readonly string[];
}

export function containerName(agentId: string): string {
	return `squad-${agentId}`;
}

/**
 * Environment that points every common runtime at the egress proxy and at our CA.
 *
 * The proxy variables are a convenience, not the security boundary: an agent running arbitrary
 * code can ignore them. Containment comes from the network being internal, so the proxy is the
 * only reachable route off-host. The CA variables are what stop TLS interception from breaking
 * Node, Python and curl.
 */
export function buildEnv(spec: SandboxSpec): string[] {
	const env: Record<string, string> = {
		HOME: SANDBOX_HOME,
		SQUAD_AGENT_ID: spec.agentId,
		SQUAD_REPO: SANDBOX_REPO_PATH,
		SQUAD_WORKSPACE: SANDBOX_WORKSPACE_PATH,
		SQUAD_WAKE_FILE: SANDBOX_WAKE_FILE,
		SQUAD_MCP_FILE: SANDBOX_MCP_FILE,
		SQUAD_SEARCH_FILE: SANDBOX_SEARCH_FILE,
		SQUAD_CONSOLE_FILE: SANDBOX_CONSOLE_FILE,
		SQUAD_LESSONS_FILE: SANDBOX_LESSONS_FILE,
		HTTP_PROXY: spec.proxyUrl,
		HTTPS_PROXY: spec.proxyUrl,
		http_proxy: spec.proxyUrl,
		https_proxy: spec.proxyUrl,
		NO_PROXY: "localhost,127.0.0.1",
		no_proxy: "localhost,127.0.0.1",
		NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
		REQUESTS_CA_BUNDLE: CA_CERT_PATH,
		SSL_CERT_FILE: CA_CERT_PATH,
		CURL_CA_BUNDLE: CA_CERT_PATH,
		GIT_SSL_CAINFO: CA_CERT_PATH,
		// Whose name the agent's commits carry, and a git that never stops to ask for a password: the
		// proxy puts the credential on the wire, so a prompt is a turn hung on a question nobody answers.
		GIT_AUTHOR_NAME: spec.agentId,
		GIT_AUTHOR_EMAIL: `${spec.agentId}@squad.local`,
		GIT_COMMITTER_NAME: spec.agentId,
		GIT_COMMITTER_EMAIL: `${spec.agentId}@squad.local`,
		GIT_TERMINAL_PROMPT: "0",
		// Sent outright rather than probed for. Left to itself git has curl ask the proxy which auth it
		// wants, which is a 407 and a second CONNECT on every connection before anything git-shaped.
		GIT_HTTP_PROXY_AUTHMETHOD: "basic",
		...spec.env,
	};
	return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

export interface ContainerConfig {
	readonly Image: string;
	readonly User: string;
	readonly Env: readonly string[];
	readonly WorkingDir: string;
	readonly Cmd?: readonly string[];
	readonly Labels: Readonly<Record<string, string>>;
	readonly HostConfig: Readonly<Record<string, unknown>>;
}

export function buildContainerConfig(spec: SandboxSpec): ContainerConfig {
	return {
		Image: spec.image,
		User: SANDBOX_USER,
		Env: buildEnv(spec),
		WorkingDir: SANDBOX_HOME,
		...(spec.cmd !== undefined ? { Cmd: spec.cmd } : {}),
		Labels: {
			"dev.squad.agent-id": spec.agentId,
			"dev.squad.managed": "true",
		},
		HostConfig: {
			Binds: [
				`${spec.volumeName}:${SANDBOX_REPO_PATH}`,
				`${spec.workspaceVolumeName}:${SANDBOX_WORKSPACE_PATH}`,
				`${spec.caCertHostPath}:${CA_CERT_PATH}:ro`,
			],
			NetworkMode: spec.networkName,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			PidsLimit: 512,
			// An init that reaps, because the image's own PID 1 is a `sleep` and a `sleep` never waits on
			// anything. A dev server the agent leaves running is orphaned the moment the turn's shell
			// exits, and when it is next killed it becomes a zombie holding one of the 512 above. An
			// agent iterating on a server it restarts all afternoon would arrive at a sandbox that cannot
			// fork, and nothing in there would say why.
			Init: true,
			...(spec.memoryBytes !== undefined ? { Memory: spec.memoryBytes } : {}),
			...(spec.nanoCpus !== undefined ? { NanoCpus: spec.nanoCpus } : {}),
			RestartPolicy: { Name: "unless-stopped" },
		},
	};
}

/**
 * Internal networks get no gateway to the outside world, which is what makes the proxy
 * unavoidable rather than merely configured.
 */
export function buildNetworkConfig(networkName: string): Record<string, unknown> {
	return {
		Name: networkName,
		Driver: "bridge",
		Internal: true,
		CheckDuplicate: true,
		Labels: { "dev.squad.managed": "true" },
	};
}

export function buildVolumeConfig(volumeName: string, agentId: string): Record<string, unknown> {
	return {
		Name: volumeName,
		Labels: {
			"dev.squad.agent-id": agentId,
			"dev.squad.managed": "true",
		},
	};
}
