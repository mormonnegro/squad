import { SANDBOX_REPO_PATH } from "@agent-dive/agent-repo";
import { describe, expect, it } from "vitest";
import {
	buildContainerConfig,
	buildEnv,
	buildNetworkConfig,
	CA_CERT_PATH,
	containerName,
	type SandboxSpec,
} from "../src/spec.ts";

const spec: SandboxSpec = {
	agentId: "emma",
	image: "agent-dive/sandbox:latest",
	volumeName: "agent-dive-emma-self",
	networkName: "agent-dive-egress",
	proxyUrl: "http://emma:tok@egress:8080",
	caCertHostPath: "/host/pki/ca.crt",
};

describe("network containment", () => {
	it("is internal, so the proxy is the only route off-host", () => {
		expect(buildNetworkConfig("agent-dive-egress")).toMatchObject({ Internal: true });
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
		expect(config.HostConfig.NetworkMode).toBe("agent-dive-egress");
	});

	it("caps process count", () => {
		expect(config.HostConfig.PidsLimit).toBe(512);
	});

	it("applies resource limits only when asked", () => {
		expect(config.HostConfig.Memory).toBeUndefined();
		const limited = buildContainerConfig({ ...spec, memoryBytes: 2 ** 31, nanoCpus: 2e9 });
		expect(limited.HostConfig.Memory).toBe(2 ** 31);
		expect(limited.HostConfig.NanoCpus).toBe(2e9);
	});
});

describe("mounts", () => {
	const binds = buildContainerConfig(spec).HostConfig.Binds as string[];

	it("mounts the agent repository volume at the sandbox repo path", () => {
		expect(binds).toContain(`agent-dive-emma-self:${SANDBOX_REPO_PATH}`);
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
		expect(env.get("AGENT_DIVE_REPO")).toBe(SANDBOX_REPO_PATH);
		expect(env.get("AGENT_DIVE_AGENT_ID")).toBe("emma");
	});

	it("lets callers add variables but not override containment", () => {
		const withExtra = buildEnv({ ...spec, env: { TZ: "America/Montevideo" } });
		expect(withExtra).toContain("TZ=America/Montevideo");
	});
});

describe("naming", () => {
	it("namespaces containers by agent", () => {
		expect(containerName("emma")).toBe("agent-dive-emma");
	});
});
