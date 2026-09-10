import { describe, expect, it } from "vitest";
import {
	containerName,
	DEFAULT_DEPLOYMENT,
	volumeName,
	workspaceVolumeName,
} from "../src/index.ts";

describe("what a deployment calls its things", () => {
	// The property the whole change rests on: an install that never heard of deployments keeps every
	// name it already gave a container and a volume. Break this and an upgrade renames somebody's
	// running agents, which reads to Docker as a fresh agent with no memory.
	it("names them exactly as they were named before deployments existed", () => {
		expect(containerName("scout")).toBe("squad-scout");
		expect(volumeName("scout")).toBe("squad-scout-self");
		expect(workspaceVolumeName("scout")).toBe("squad-scout-work");
		expect(DEFAULT_DEPLOYMENT).toBe("squad");
	});

	// The reason it exists: two environments on one machine with an agent of the same name in each.
	// Sharing these is not a port conflict to be worked around — it is one agent's soul on another's.
	it("keeps two deployments apart even when they hold the same name", () => {
		expect(containerName("scout", "home")).toBe("home-scout");
		expect(containerName("scout", "work")).toBe("work-scout");
		expect(volumeName("scout", "home")).not.toBe(volumeName("scout", "work"));
		expect(workspaceVolumeName("scout", "home")).not.toBe(workspaceVolumeName("scout", "work"));
	});

	it("keeps the two volumes of one agent apart", () => {
		expect(volumeName("scout", "home")).not.toBe(workspaceVolumeName("scout", "home"));
	});
});
