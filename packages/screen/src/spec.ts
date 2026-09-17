import { createHash } from "node:crypto";
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
 * The environment variable the browser opens a vault with, spelled the way 1Password spells it.
 *
 * Theirs rather than ours because the program that reads it is theirs: `op` in the screen image
 * looks this name up itself, and a name of our own would only be a name we then had to translate.
 * It is the one secret this plane holds that no model is paid with, which is why it is not on the
 * providers' list — a vault is not something an agent thinks with.
 */
export const VAULT_TOKEN_ENV = "OP_SERVICE_ACCOUNT_TOKEN";

/**
 * Where the 1Password CLI goes when it opens a vault, which the proxy has to be told about.
 *
 * Nothing in these containers has a route off the host except through the egress proxy, and the
 * proxy refuses what no grant names — so without this, connecting a vault ends in a browser that
 * says the vault would not open, with nothing anywhere saying it was a grant. A wildcard each
 * because the host is the account's sign-in domain: `my` for most, `ent` for the enterprise ones,
 * and the region the account was made in decides the rest.
 *
 * What is granted carries nothing of ours. The token is in this container's environment and goes
 * out in the CLI's own request, so an agent that reached this host itself would be an agent making
 * an unauthenticated call to somebody else's API — which is why this is a host and not a secret.
 */
export const VAULT_HOSTS = ["*.1password.com", "*.1password.eu", "*.1password.ca"] as const;

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
	/** What the browser says it reads, e.g. `es-AR,es;q=0.9,en;q=0.8`. The plane's, not a guess. */
	readonly lang?: string;
	/** What clock it keeps, e.g. `America/Argentina/Buenos_Aires`. */
	readonly timezone?: string;
	/**
	 * The token this browser reads its operator's vault with, when the operator has connected one.
	 *
	 * In this container and in no other, which is the whole of the feature: the one process that can
	 * read a password is the one the agent has no filesystem in and no route to, and what crosses
	 * into a page from here is keystrokes. A screen without it is exactly the browser it was, and
	 * says so in a sentence when it is asked to sign into something.
	 */
	readonly vaultToken?: string;
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
		/*
		 * Where the operator is, as far as the browser is concerned.
		 *
		 * Passed through from the plane rather than decided here, because nothing in a container knows
		 * what time zone its operator keeps or what language they buy things in — and a browser whose
		 * language and clock disagree with the address it is coming from is not lying about being a
		 * browser, but it is inconsistent, and inconsistency is what the systems that refuse these
		 * connections actually measure.
		 */
		...(spec.lang === undefined ? {} : { SQUAD_SCREEN_LANG: spec.lang }),
		...(spec.timezone === undefined ? {} : { TZ: spec.timezone }),
		/*
		 * The vault, for the one thing in here that opens one.
		 *
		 * A secret in a container's environment is a thing to be deliberate about, so: what reads it
		 * is `op`, run by our own server in this container; what can ask that server to run it is the
		 * plane's tunnel onto loopback and the agent's door, and the agent's door answers only for
		 * hosts the operator opened. It is not passed to the sandbox, where an agent could read it out
		 * of its own environment in one command.
		 */
		...(spec.vaultToken === undefined ? {} : { [VAULT_TOKEN_ENV]: spec.vaultToken }),
		/*
		 * The proxy's certificate, for the programs in here that are neither Node nor Chromium.
		 *
		 * Which is `op`: a Go binary, and Go reads these two and not the ones above it. Both are set
		 * rather than one — the file is this deployment's own CA, for the connections the proxy opens
		 * and re-signs, and the directory is the ordinary store, for a host the operator has since
		 * told the proxy to tunnel rather than read. Naming only the file would trust our CA and
		 * nothing else, which is exactly the configuration that breaks the day somebody pipes one.
		 */
		SSL_CERT_FILE: CA_CERT_PATH,
		SSL_CERT_DIR: "/etc/ssl/certs",
		// For the screen server itself, which fetches nothing off the machine but is a Node process in
		// a container with no route out, and would otherwise hang rather than fail if it ever tried.
		HTTP_PROXY: spec.proxyUrl,
		HTTPS_PROXY: spec.proxyUrl,
		NO_PROXY: "localhost,127.0.0.1",
		NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
	}).map(([name, value]) => `${name}=${value}`);
}

/**
 * A token by its shadow: enough to tell this one from the one before it, and not enough to be one.
 *
 * What the plane needs to know about a running screen is whether it is holding the token the
 * operator has now, and that is a comparison rather than a value. Read back whole, a token would be
 * a secret sitting on a status object — which is how a secret ends up in a log, printed by somebody
 * who was looking at the thing next to it.
 */
export function vaultMark(token: string | undefined): string | undefined {
	if (token === undefined || token === "") return undefined;
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
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
