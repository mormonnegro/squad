import type { ExecResult } from "@agent-dive/sandbox";
import { describe, expect, it } from "vitest";
import { ensureSelfRepo } from "../src/self.ts";
import type { TurnSandbox } from "../src/turn.ts";

/** A sandbox that remembers what was written to it, so a second boot sees the first one's files. */
class FakeSandbox implements TurnSandbox {
	readonly files = new Map<string, string>();
	readonly commands: string[][] = [];

	async run(_agentId: string, cmd: readonly string[], input: string): Promise<ExecResult> {
		this.commands.push([...cmd]);
		const empty = { stdout: "", stderr: "" };

		if (cmd[0] === "test") {
			return { ...empty, exitCode: this.files.has(cmd[2] ?? "") ? 0 : 1 };
		}
		if (cmd.some((part) => part.includes("cat >"))) {
			this.files.set(cmd.at(-1) ?? "", input);
			return { ...empty, exitCode: 0 };
		}
		return { ...empty, exitCode: 0 };
	}
}

describe("the agent's own repository", () => {
	it("gives a new agent a manifest, a soul and somewhere to keep memory", async () => {
		const sandbox = new FakeSandbox();

		expect(await ensureSelfRepo({ sandbox, agentId: "scout" })).toBe(true);

		expect([...sandbox.files.keys()]).toEqual([
			"/home/agent/.self/agent.yaml",
			"/home/agent/.self/soul.md",
			"/home/agent/.self/skills/.gitkeep",
			"/home/agent/.self/tools/.gitkeep",
			"/home/agent/.self/memory/users/.gitkeep",
			"/home/agent/.self/memory/projects/.gitkeep",
			"/home/agent/.self/memory/reference/.gitkeep",
		]);
	});

	it("names the agent after its id, because the manifest and the grants must agree", async () => {
		const sandbox = new FakeSandbox();

		await ensureSelfRepo({ sandbox, agentId: "scout", description: "watches the build" });

		expect(sandbox.files.get("/home/agent/.self/agent.yaml")).toContain("name: scout");
		expect(sandbox.files.get("/home/agent/.self/soul.md")).toContain("watches the build");
	});

	it("asks for nothing, so a new agent can reach nothing until an operator says so", async () => {
		const sandbox = new FakeSandbox();

		await ensureSelfRepo({ sandbox, agentId: "scout" });

		expect(sandbox.files.get("/home/agent/.self/agent.yaml")).toContain("requests: []");
	});

	it("leaves a repository the agent has already edited alone", async () => {
		const sandbox = new FakeSandbox();
		await ensureSelfRepo({ sandbox, agentId: "scout" });
		sandbox.files.set("/home/agent/.self/soul.md", "# scout\n\nI learned who I am.\n");

		expect(await ensureSelfRepo({ sandbox, agentId: "scout" })).toBe(false);

		expect(sandbox.files.get("/home/agent/.self/soul.md")).toContain("I learned who I am");
	});

	it("makes it a git repository, so the agent can see what it changed about itself", async () => {
		const sandbox = new FakeSandbox();

		await ensureSelfRepo({ sandbox, agentId: "scout" });

		expect(sandbox.commands.some((cmd) => cmd.join(" ").includes("git init"))).toBe(true);
	});

	it("never puts file contents on a command line", async () => {
		const sandbox = new FakeSandbox();

		await ensureSelfRepo({ sandbox, agentId: "scout", description: "$(rm -rf /)" });

		expect(sandbox.commands.flat().join(" ")).not.toContain("rm -rf");
	});
});
