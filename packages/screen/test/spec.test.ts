import { readFileSync } from "node:fs";
import { CA_CERT_PATH } from "@squad/sandbox";
import { describe, expect, it } from "vitest";
import {
	buildScreenConfig,
	buildScreenEnv,
	SCREEN_PROFILE_PATH,
	SCREEN_VERB_PORT,
	SCREEN_VIEW_PORT,
	type ScreenSpec,
	screenAlias,
	screenContainerName,
	screenUrl,
	screenVolumeName,
	VAULT_TOKEN_ENV,
	vaultMark,
} from "../src/spec.ts";

const spec: ScreenSpec = {
	agentId: "emma",
	image: "squad/screen:latest",
	volumeName: "squad-emma-screen",
	networkName: "squad-egress",
	proxyUrl: "http://emma:tok@egress:8080",
	caCertHostPath: "/host/pki/ca.crt",
};

describe("what a screen is called", () => {
	it("names the container and the volume under the deployment, so two planes do not share one", () => {
		expect(screenContainerName("emma", "other")).toBe("other-emma-screen");
		expect(screenVolumeName("emma", "other")).toBe("other-emma-screen");
	});

	it("gives the agent an address it can work out from its own name", () => {
		expect(screenUrl("emma")).toBe(`http://emma-screen:${SCREEN_VERB_PORT}`);
	});
});

describe("container hardening", () => {
	const config = buildScreenConfig(spec);

	it("runs as a non-root user with no capabilities", () => {
		expect(config.User).toBe("1000:1000");
		expect(config.HostConfig.CapDrop).toEqual(["ALL"]);
		expect(config.HostConfig.SecurityOpt).toContain("no-new-privileges");
	});

	it("mounts the profile and the certificate, and nothing of the agent's", () => {
		const binds = config.HostConfig.Binds as readonly string[];
		expect(binds).toContain(`squad-emma-screen:${SCREEN_PROFILE_PATH}`);
		expect(binds).toContain(`/host/pki/ca.crt:${CA_CERT_PATH}:ro`);
		// The point of the whole arrangement: nothing the agent can read is in here, and nothing here
		// is in the agent. A bind that reached the agent's own volumes would hand back the cookie jar.
		expect(binds.some((bind) => bind.includes("-self") || bind.includes("-work"))).toBe(false);
	});

	it("gives the browser the shared memory and the processes a browser needs", () => {
		// Both of these fail as something else when they are wrong: 64 MB of /dev/shm is a tab that
		// crashes on an ordinary page, and too few processes is a page that will not open.
		expect(config.HostConfig.ShmSize).toBeGreaterThan(64 * 1024 * 1024);
		expect(config.HostConfig.PidsLimit).toBeGreaterThan(512);
		expect(config.HostConfig.Init).toBe(true);
	});

	it("is on the sandbox network under a name the agent can dial", () => {
		expect(config.HostConfig.NetworkMode).toBe("squad-egress");
		expect(config.NetworkingConfig).toEqual({
			EndpointsConfig: { "squad-egress": { Aliases: [screenAlias("emma")] } },
		});
	});
});

describe("what the browser is given", () => {
	const env = buildScreenEnv(spec);

	it("carries the agent's own egress credential, so its reach is the agent's reach", () => {
		expect(env).toContain("SQUAD_EGRESS_PROXY=http://emma:tok@egress:8080");
	});

	it("has no vault in it until the operator has connected one", () => {
		const names = env.map((entry) => entry.split("=")[0] ?? "");
		expect(names).not.toContain(VAULT_TOKEN_ENV);
	});

	it("opens the vault with the token it was given, under the name the CLI looks for", () => {
		expect(buildScreenEnv({ ...spec, vaultToken: "ops_abc" })).toContain(
			`${VAULT_TOKEN_ENV}=ops_abc`,
		);
	});

	it("holds nothing of the agent's own", () => {
		// A screen is not a second sandbox. None of what an agent is given to think with belongs in
		// here, and a variable that leaked in would be one a browser could be talked into using.
		const names = env.map((entry) => entry.split("=")[0] ?? "");
		expect(names).not.toContain("SQUAD_REPO");
		expect(names).not.toContain("SQUAD_WAKE_FILE");
		expect(names.some((name) => name.endsWith("_API_KEY"))).toBe(false);
	});
});

describe("telling one vault token from another", () => {
	it("marks a token without being one", () => {
		const mark = vaultMark("ops_abc");
		expect(mark).not.toBeUndefined();
		expect(mark).not.toContain("ops_abc");
		expect(vaultMark("ops_abc")).toBe(mark);
		expect(vaultMark("ops_xyz")).not.toBe(mark);
	});

	it("says nothing where there is nothing, so a screen with no vault is not one with a stale one", () => {
		expect(vaultMark(undefined)).toBeUndefined();
		expect(vaultMark("")).toBeUndefined();
	});
});

describe("the two halves of the tunnel", () => {
	it("ships the same relay as the sandbox image, because the plane execs it by path in both", () => {
		// Two files rather than one because a Docker build context cannot reach out of its own
		// directory, and the drift this guards against is somebody fixing a bug in one of them.
		const ours = readFileSync(new URL("../image/relay.mjs", import.meta.url), "utf8");
		const theirs = readFileSync(new URL("../../sandbox/image/relay.mjs", import.meta.url), "utf8");
		expect(ours).toBe(theirs);
	});

	it("keeps the view off the network the agent is on", () => {
		// Not a property of this file, but of where each port is bound — asserted here so that the two
		// numbers are never quietly made the same one. The view is loopback and the verbs are not.
		expect(SCREEN_VIEW_PORT).not.toBe(SCREEN_VERB_PORT);
	});
});
