import { EventBus } from "@agent-dive/events";
import type { ExecResult } from "@agent-dive/sandbox";
import { describe, expect, it } from "vitest";
import { createTurnHandler, PiTurnRunner, TurnError, type TurnSandbox } from "../src/turn.ts";

interface Invocation {
	readonly agentId: string;
	readonly cmd: readonly string[];
	readonly input: string;
	readonly timeoutMs: number | undefined;
}

class StubSandbox implements TurnSandbox {
	readonly calls: Invocation[] = [];
	result: ExecResult = { exitCode: 0, stdout: "done\n", stderr: "" };

	async run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options: { timeoutMs?: number } = {},
	): Promise<ExecResult> {
		this.calls.push({ agentId, cmd, input, timeoutMs: options.timeoutMs });
		return this.result;
	}
}

describe("PiTurnRunner", () => {
	it("runs pi non-interactively with the prompt on stdin", async () => {
		const sandbox = new StubSandbox();
		const runner = new PiTurnRunner({ sandbox });

		const result = await runner.run("a1", "something happened");

		expect(result.text).toBe("done");
		expect(sandbox.calls[0]?.input).toBe("something happened");
		expect(sandbox.calls[0]?.cmd).toEqual([
			"pi",
			"--print",
			"--session-id",
			"agent-dive-a1",
			"--session-dir",
			"/home/agent/.self/.sessions",
		]);
	});

	it("keeps every wakeup in one session per agent", () => {
		const runner = new PiTurnRunner({ sandbox: new StubSandbox() });
		expect(runner.sessionId("a1")).toBe("agent-dive-a1");
		expect(runner.sessionId("a2")).not.toBe(runner.sessionId("a1"));
	});

	it("keeps sessions on the agent's own volume so a new container remembers", () => {
		const runner = new PiTurnRunner({ sandbox: new StubSandbox() });
		expect(runner.commandFor("a1")).toContain("/home/agent/.self/.sessions");
	});

	it("passes the configured provider and model", () => {
		const runner = new PiTurnRunner({
			sandbox: new StubSandbox(),
			provider: "anthropic",
			model: "claude-opus-4-7",
		});

		expect(runner.commandFor("a1")).toEqual(
			expect.arrayContaining(["--provider", "anthropic", "--model", "claude-opus-4-7"]),
		);
	});

	it("bounds a turn so a stuck agent cannot hold its sandbox forever", async () => {
		const sandbox = new StubSandbox();
		await new PiTurnRunner({ sandbox, timeoutMs: 1000 }).run("a1", "hi");
		expect(sandbox.calls[0]?.timeoutMs).toBe(1000);
	});

	it("reports a failed turn instead of returning empty output", async () => {
		const sandbox = new StubSandbox();
		sandbox.result = { exitCode: 1, stdout: "", stderr: "No API key found\n" };

		await expect(new PiTurnRunner({ sandbox }).run("a1", "hi")).rejects.toThrow(TurnError);
	});

	it("carries the failure detail on the error", async () => {
		const sandbox = new StubSandbox();
		sandbox.result = { exitCode: 2, stdout: "", stderr: "No API key found\n" };

		await expect(new PiTurnRunner({ sandbox }).run("a1", "hi")).rejects.toMatchObject({
			result: { exitCode: 2, stderr: "No API key found" },
		});
	});
});

describe("createTurnHandler", () => {
	const wakeup = (channel: string, body: string) =>
		({
			id: `${channel}-${body}`,
			agentId: "a1",
			source: "webhook",
			trust: "public",
			channel,
			body,
			receivedAt: "2026-03-01T00:00:00.000Z",
		}) as const;

	it("answers on the channel the wakeup came from", async () => {
		const sent: Array<{ channel: string; body: string }> = [];
		const handler = createTurnHandler({
			runner: { run: async () => ({ text: "on it", exitCode: 0, stderr: "" }) },
			router: {
				send: async (reply) => {
					sent.push({ channel: reply.channel, body: reply.body });
				},
			},
		});

		await handler({ agentId: "a1", events: [wakeup("webhook:deploys", "x")], prompt: "p" });

		expect(sent).toEqual([{ channel: "webhook:deploys", body: "on it" }]);
	});

	it("answers everyone whose message was folded into the turn", async () => {
		const channels: string[] = [];
		const handler = createTurnHandler({
			runner: { run: async () => ({ text: "on it", exitCode: 0, stderr: "" }) },
			router: {
				send: async (reply) => {
					channels.push(reply.channel);
				},
			},
		});

		await handler({
			agentId: "a1",
			events: [
				wakeup("webhook:deploys", "one"),
				wakeup("slack:C1", "two"),
				wakeup("webhook:deploys", "three"),
			],
			prompt: "p",
		});

		expect(channels).toEqual(["webhook:deploys", "slack:C1"]);
	});

	it("says nothing when the turn produced nothing", async () => {
		const sent: string[] = [];
		const handler = createTurnHandler({
			runner: { run: async () => ({ text: "", exitCode: 0, stderr: "" }) },
			router: {
				send: async (reply) => {
					sent.push(reply.body);
				},
			},
		});

		await handler({ agentId: "a1", events: [wakeup("webhook:deploys", "x")], prompt: "p" });

		expect(sent).toEqual([]);
	});

	it("leaves the events queued when the turn fails", async () => {
		const bus = new EventBus();
		await bus.register(
			"a1",
			createTurnHandler({
				runner: {
					run: async () => {
						throw new Error("sandbox unavailable");
					},
				},
			}),
		);

		await bus.publish({
			agentId: "a1",
			source: "webhook",
			trust: "public",
			channel: "webhook:deploys",
			body: "x",
		});
		await bus.drain();

		let retried = 0;
		bus.unregister("a1");
		await bus.register("a1", async () => {
			retried += 1;
		});
		await bus.drain();

		expect(retried).toBe(1);
	});
});
