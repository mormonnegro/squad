import { CA_CERT_PATH, type ContainerConfig, DEFAULT_DEPLOYMENT } from "@squad/sandbox";

/**
 * A browser of the agent's own, in a container the agent is not inside.
 *
 * The whole of why this is a second container rather than a second process in the sandbox: a
 * logged-in browser is a cookie jar, and a cookie jar in the sandbox is a file the agent can read.
 * An operator who signs into their mail so an agent can answer it has, in that arrangement, handed
 * the agent their mail — not the use of it, the credential itself, to keep and to send anywhere its
 * grants reach. Here the profile is mounted where the agent has no filesystem at all, and what the
 * agent gets instead is a list of things it may ask for.
 */

/** Where the operator's live view answers, inside the screen container. */
export const SCREEN_VIEW_PORT = 7180;

/**
 * Where the agent's verbs are answered, inside the screen container.
 *
 * A different port from the view rather than a path on it, because they are opened to different
 * people: the view is forwarded to the operator by the plane, and this one is reachable from the
 * sandbox network and from nowhere else. One port carrying both would mean the operator's forwarded
 * link also drove the browser, which is a way for a page the agent serves to drive it too.
 */
export const SCREEN_VERB_PORT = 7181;

/**
 * Where the browser's own credentialled way out listens, on loopback inside the screen container.
 *
 * Chromium takes a proxy as an address and drops the credential out of it, then answers the 407 by
 * asking a person — which in a headless browser is a request that hangs until it fails. So nothing
 * tells Chromium the credential: it is given an unauthenticated proxy on its own loopback, and that
 * proxy is the one that writes the agent's egress token onto every request it passes on.
 */
export const SCREEN_PROXY_PORT = 7182;

/** Where Chromium answers its debugging protocol. Loopback, and only ever spoken to from inside. */
export const SCREEN_DEBUG_PORT = 9222;

export const SCREEN_HOME = "/home/screen";

/**
 * The browser profile: cookies, sessions, saved logins, everything a signed-in browser is.
 *
 * On a volume rather than in the container, because a container is replaced every time the image is
 * rebuilt, and an operator who has to sign into Google again after every update signs in once and
 * then stops using the feature.
 */
export const SCREEN_PROFILE_PATH = `${SCREEN_HOME}/profile`;

/** Non-root uid:gid the screen runs as. Must match the screen image. */
export const SCREEN_USER = "1000:1000";

/** What the screen image is called when nobody says otherwise. */
export const DEFAULT_SCREEN_IMAGE = "squad/screen:dev";

/**
 * How much memory a browser gets before the kernel takes it away.
 *
 * Higher than an agent's default on purpose: a sandbox runs a coding agent that spends its life in
 * files, and this runs Chromium, which spends its life in a heap. A screen killed for being a
 * browser would look from the console like a screen that simply stopped answering.
 */
export const SCREEN_MEMORY_BYTES = 1_536 * 1024 * 1024;

/**
 * Shared memory for the browser, which is not the default 64 MB and cannot be.
 *
 * Chromium puts rendered frames in /dev/shm, and at 64 MB it does not fail politely: tabs crash
 * with "Aw, Snap" on pages that were fine yesterday, and nothing in any log here says the word
 * memory. The alternative flag — telling Chromium to use temporary files instead — trades that for
 * a browser that is slow in a way nobody can explain either.
 */
export const SCREEN_SHM_BYTES = 512 * 1024 * 1024;

/**
 * More processes than a sandbox gets, because a browser is made of them.
 *
 * Chromium forks a process per renderer, per frame, per utility, per GPU pretence; a tab with a few
 * iframes is already a dozen, and a limit reached looks like a page that will not open.
 */
export const SCREEN_PIDS_LIMIT = 2_048;

export function screenContainerName(agentId: string, deployment = DEFAULT_DEPLOYMENT): string {
	return `${deployment}-${agentId}-screen`;
}

/** The volume holding the profile. Named apart from the agent's two, because it outlives neither. */
export function screenVolumeName(agentId: string, deployment = DEFAULT_DEPLOYMENT): string {
	return `${deployment}-${agentId}-screen`;
}

/**
 * The name the agent dials its screen by, which is a name on the network rather than a number.
 *
 * Not the container name, because that carries the deployment and the agent has no business knowing
 * which deployment it is in — and because an alias is what makes the address the same in every
 * install, so the extension in the image can work it out from the one thing it already knows about
 * itself.
 */
export function screenAlias(agentId: string): string {
	return `${agentId}-screen`;
}

/** Where the agent posts what it wants done. Derived, so nothing has to be passed in to say it. */
export function screenUrl(agentId: string): string {
	return `http://${screenAlias(agentId)}:${SCREEN_VERB_PORT}`;
}

export interface ScreenSpec {
	readonly agentId: string;
	readonly image: string;
	/** Named Docker volume holding the browser profile. Survives container replacement. */
	readonly volumeName: string;
	/** The same internal network the sandbox is on, so the agent can reach this and the proxy can. */
	readonly networkName: string;
	/**
	 * The agent's own egress credential, in the URL the proxy expects.
	 *
	 * The agent's rather than one of the screen's own, and that is the design: a browser that could
	 * reach hosts the agent may not would be a way around the grants, opened by the operator asking
	 * for a screen. What the browser reaches is what the agent reaches, and the bill is the agent's.
	 */
	readonly proxyUrl: string;
	/** Host path of the proxy CA certificate, mounted read-only. */
	readonly caCertHostPath: string;
	readonly memoryBytes?: number;
	readonly nanoCpus?: number;
}

/**
 * Environment for the screen container.
 *
 * Deliberately little: this container runs one program of ours and one browser, and neither of them
 * is the agent. There is no repository here, no model key, no wakeup file — the things a sandbox's
 * environment is mostly made of are things a browser has no use for and no business holding.
 */
export function buildScreenEnv(spec: ScreenSpec): string[] {
	return Object.entries({
		HOME: SCREEN_HOME,
		SQUAD_AGENT_ID: spec.agentId,
		SQUAD_SCREEN_PROFILE: SCREEN_PROFILE_PATH,
		SQUAD_SCREEN_CA: CA_CERT_PATH,
		// Read by our own forwarder rather than by anything that speaks HTTP here: the credential is
		// in this URL, and what it is for is being written onto requests Chromium makes without it.
		SQUAD_EGRESS_PROXY: spec.proxyUrl,
		// For the screen server itself, which fetches nothing off the machine but is a Node process in
		// a container with no route out, and would otherwise hang rather than fail if it ever tried.
		HTTP_PROXY: spec.proxyUrl,
		HTTPS_PROXY: spec.proxyUrl,
		NO_PROXY: "localhost,127.0.0.1",
		NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
	}).map(([name, value]) => `${name}=${value}`);
}

export function buildScreenConfig(spec: ScreenSpec): ContainerConfig & {
	readonly NetworkingConfig: Readonly<Record<string, unknown>>;
} {
	return {
		Image: spec.image,
		User: SCREEN_USER,
		Env: buildScreenEnv(spec),
		WorkingDir: SCREEN_HOME,
		Labels: {
			"dev.squad.agent-id": spec.agentId,
			"dev.squad.managed": "true",
			"dev.squad.screen": "true",
		},
		HostConfig: {
			Binds: [
				`${spec.volumeName}:${SCREEN_PROFILE_PATH}`,
				`${spec.caCertHostPath}:${CA_CERT_PATH}:ro`,
			],
			NetworkMode: spec.networkName,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			PidsLimit: SCREEN_PIDS_LIMIT,
			ShmSize: SCREEN_SHM_BYTES,
			// Chromium orphans processes as a matter of course, and PID 1 here is a Node server that
			// waits on none of them. Without an init that reaps, a browser restarted a few times is a
			// container full of zombies holding the process limit above.
			Init: true,
			Memory: spec.memoryBytes ?? SCREEN_MEMORY_BYTES,
			...(spec.nanoCpus !== undefined ? { NanoCpus: spec.nanoCpus } : {}),
			RestartPolicy: { Name: "unless-stopped" },
		},
		// The alias is what makes `scout-screen` resolve on the sandbox network, which is the whole of
		// how the agent finds this without being told a number by anybody.
		NetworkingConfig: {
			EndpointsConfig: {
				[spec.networkName]: { Aliases: [screenAlias(spec.agentId)] },
			},
		},
	};
}
