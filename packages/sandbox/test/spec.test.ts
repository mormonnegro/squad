import { SANDBOX_REPO_PATH } from "@squad/agent-repo";
import { describe, expect, it } from "vitest";
import {
	buildContainerConfig,
	buildEnv,
	buildNetworkConfig,
	CA_CERT_PATH,
	containerName,
	SANDBOX_WORKSPACE_PATH,
	type SandboxSpec,
} from "../src/spec.ts";

const spec: SandboxSpec = {
	agentId: "emma",
	image: "squad/sandbox:latest",
	volumeName: "squad-emma-self",
	workspaceVolumeName: "squad-emma-work",
	networkName: "squad-egress",
	proxyUrl: "http://emma:tok@egress:8080",
	caCertHostPath: "/host/pki/ca.crt",
};

describe("network containment", () => {
	it("is internal, so the proxy is the only route off-host", () => {
		expect(buildNetworkConfig("squad-egress")).toMatchObject({
			Internal: true,
		});
	});
});

describe("container hardening", () => {
	const config = buildContainerConfig(spec);

	it("runs as a non-root user", () => {
		expect(config.User).toBe("1000:1000");
	});

	it("drops all capabilities and forbids privilege escalation", () => {
		expect(config.HostConfig.CapDrop).toEqual(["ALL"]);
		expect(config.HostConfig.SecurityOpt).toContain("no-new-privileges");
	});

	it("joins the internal network rather than the default bridge", () => {
		expect(config.HostConfig.NetworkMode).toBe("squad-egress");
	});

	it("caps process count", () => {
		expect(config.HostConfig.PidsLimit).toBe(512);
	});

	// The cap above is what makes this matter: the image's PID 1 is a `sleep`, which reaps nothing, so
	// every background server the agent restarts leaves a zombie holding one of the 512.
	it("gets an init that reaps what a served port leaves behind", () => {
		expect(config.HostConfig.Init).toBe(true);
	});

	it("applies resource limits only when asked", () => {
		expect(config.HostConfig.Memory).toBeUndefined();
		const limited = buildContainerConfig({
			...spec,
			memoryBytes: 2 ** 31,
			nanoCpus: 2e9,
		});
		expect(limited.HostConfig.Memory).toBe(2 ** 31);
		expect(limited.HostConfig.NanoCpus).toBe(2e9);
	});
});

describe("mounts", () => {
	const binds = buildContainerConfig(spec).HostConfig.Binds as string[];

	it("mounts the agent repository volume at the sandbox repo path", () => {
		expect(binds).toContain(`squad-emma-self:${SANDBOX_REPO_PATH}`);
	});

	/**
	 * On a volume rather than in the container, because a container is thrown away and rebuilt every
	 * time the image changes. What the agent built would go with it, and a place work evaporates from
	 * is a place nobody would put work.
	 */
	it("mounts the workspace volume beside it, so what the agent builds outlives the container", () => {
		expect(binds).toContain(`squad-emma-work:${SANDBOX_WORKSPACE_PATH}`);
	});

	it("mounts the proxy CA read-only", () => {
		expect(binds).toContain(`/host/pki/ca.crt:${CA_CERT_PATH}:ro`);
	});
});

describe("environment", () => {
	const env = new Map(
		buildEnv(spec).map((entry) => {
			const separator = entry.indexOf("=");
			return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
		}),
	);

	it("points both cased proxy variables at the broker", () => {
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
			expect(env.get(key)).toBe(spec.proxyUrl);
		}
	});

	it("teaches every common runtime to trust the interception CA", () => {
		for (const key of [
			"NODE_EXTRA_CA_CERTS",
			"REQUESTS_CA_BUNDLE",
			"SSL_CERT_FILE",
			"CURL_CA_BUNDLE",
			"GIT_SSL_CAINFO",
		]) {
			expect(env.get(key)).toBe(CA_CERT_PATH);
		}
	});

	it("exposes the repo path to the agent", () => {
		expect(env.get("SQUAD_REPO")).toBe(SANDBOX_REPO_PATH);
		expect(env.get("SQUAD_AGENT_ID")).toBe("emma");
	});

	/** So a script the agent writes can name the place without hard-coding somebody's home directory. */
	it("exposes the workspace path too", () => {
		expect(env.get("SQUAD_WORKSPACE")).toBe(SANDBOX_WORKSPACE_PATH);
	});

	it("lets callers add variables but not override containment", () => {
		const withExtra = buildEnv({ ...spec, env: { TZ: "America/Montevideo" } });
		expect(withExtra).toContain("TZ=America/Montevideo");
	});
});

describe("naming", () => {
	it("namespaces containers by agent", () => {
		expect(containerName("emma")).toBe("squad-emma");
	});
});
