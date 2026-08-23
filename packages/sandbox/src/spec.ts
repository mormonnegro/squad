import { SANDBOX_REPO_PATH } from "@agent-dive/agent-repo";

/** Where the egress proxy's root certificate is mounted inside the sandbox. */
export const CA_CERT_PATH = "/etc/agent-dive/ca.crt";

export const SANDBOX_HOME = "/home/agent";

/** Non-root uid:gid the agent process runs as. Must match the sandbox image. */
export const SANDBOX_USER = "1000:1000";

export interface SandboxSpec {
	readonly agentId: string;
	readonly image: string;
	/** Named Docker volume holding the agent repository. Survives container replacement. */
	readonly volumeName: string;
	/** Internal Docker network. Must have no route off-host except through the proxy. */
	readonly networkName: string;
	/** Reachable from inside the network, e.g. "http://agent-1:token@egress:8080". */
	readonly proxyUrl: string;
	/** Host path of the proxy CA certificate, mounted read-only. */
	readonly caCertHostPath: string;
	readonly memoryBytes?: number;
	readonly nanoCpus?: number;
	readonly env?: Readonly<Record<string, string>>;
}

export function containerName(agentId: string): string {
	return `agent-dive-${agentId}`;
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
		AGENT_DIVE_AGENT_ID: spec.agentId,
		AGENT_DIVE_REPO: SANDBOX_REPO_PATH,
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
		...spec.env,
	};
	return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

export interface ContainerConfig {
	readonly Image: string;
	readonly User: string;
	readonly Env: readonly string[];
	readonly WorkingDir: string;
	readonly Labels: Readonly<Record<string, string>>;
	readonly HostConfig: Readonly<Record<string, unknown>>;
}

export function buildContainerConfig(spec: SandboxSpec): ContainerConfig {
	return {
		Image: spec.image,
		User: SANDBOX_USER,
		Env: buildEnv(spec),
		WorkingDir: SANDBOX_HOME,
		Labels: {
			"dev.agent-dive.agent-id": spec.agentId,
			"dev.agent-dive.managed": "true",
		},
		HostConfig: {
			Binds: [
				`${spec.volumeName}:${SANDBOX_REPO_PATH}`,
				`${spec.caCertHostPath}:${CA_CERT_PATH}:ro`,
			],
			NetworkMode: spec.networkName,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			PidsLimit: 512,
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
		Labels: { "dev.agent-dive.managed": "true" },
	};
}

export function buildVolumeConfig(volumeName: string, agentId: string): Record<string, unknown> {
	return {
		Name: volumeName,
		Labels: {
			"dev.agent-dive.agent-id": agentId,
			"dev.agent-dive.managed": "true",
		},
	};
}
