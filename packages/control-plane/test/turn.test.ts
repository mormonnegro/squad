import { EventBus } from "@agent-dive/events";
import { type ExecResult, SANDBOX_EXTENSIONS } from "@agent-dive/sandbox";
import { describe, expect, it } from "vitest";
import {
	createTurnHandler,
	PiTurnRunner,
	parseWake,
	TurnError,
	type TurnResult,
	type TurnSandbox,
} from "../src/turn.ts";

interface Invocation {
	readonly agentId: string;
	readonly cmd: readonly string[];
	readonly input: string;
	readonly timeoutMs: number | undefined;
	readonly workingDir: string | undefined;
}

/** What pi writes when it says one thing, as the events it writes it in. */
const said = (text: string): string =>
	`${JSON.stringify({ assistantMessageEvent: { type: "text_start" } })}\n${JSON.stringify({
		assistantMessageEvent: { type: "text_delta", delta: text },
	})}\n${JSON.stringify({ assistantMessageEvent: { type: "text_end", content: text } })}\n`;

/** A turn that went fine, for the handler tests, which are about where the answer goes. */
const answered = (text: string): TurnResult => ({
	text,
	exitCode: 0,
	stderr: "",
	ms: 0,
	tokens: 0,
	costUsd: 0,
});

class StubSandbox implements TurnSandbox {
	readonly calls: Invocation[] = [];
	result: ExecResult = { exitCode: 0, stdout: said("done"), stderr: "" };
	/** What the turn left in the wake file, if anything. Absent is the file not being there. */
	left: string | undefined;
	/** A command that says its piece and then runs until something stops it, like a turn does. */
	holds = false;

	async run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options: {
			timeoutMs?: number;
			workingDir?: string;
			onStdout?: (chunk: string) => void;
			signal?: AbortSignal;
		} = {},
	): Promise<ExecResult> {
		this.calls.push({
			agentId,
			cmd,
			input,
			timeoutMs: options.timeoutMs,
			workingDir: options.workingDir,
		});
		if (cmd[0] === "sh") {
			if (this.left === undefined) return { exitCode: 1, stdout: "", stderr: "" };
			const stdout = this.left;
			// Taken away by the reading, which is the whole point of reading it that way.
			this.left = undefined;
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (this.result.stdout.length > 0) options.onStdout?.(this.result.stdout);
		if (this.holds && options.signal !== undefined) {
			await new Promise<void>((resolve) => {
				options.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			// Killed, which is what a signal leaves behind rather than a clean exit.
			return { exitCode: 137, stdout: this.result.stdout, stderr: "" };
		}
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
			"--mode",
			"json",
			"--session-id",
			"agent-dive-a1",
			"--session-dir",
			"/home/agent/.self/.sessions",
			"--append-system-prompt",
			"/home/agent/.self/soul.md",
			"--skill",
			"/home/agent/.self/skills",
			"--extension",
			"/usr/local/lib/agent-dive/extensions/wake.ts",
			"--extension",
			"/usr/local/lib/agent-dive/extensions/search.ts",
		]);
	});

	// The bug this exists for is silence rather than an error: search shipped in the image and was
	// never named on the command, so the agent had no tool for the web and went at it with curl —
	// and reported the proxy refusing every domain as though the internet were down.
	it("hands over every extension in the image, not only the first one written", () => {
		const command = new PiTurnRunner({ sandbox: new StubSandbox() }).commandFor("a1");
		const named = command.filter((_, index) => command[index - 1] === "--extension");

		expect(named).toEqual(SANDBOX_EXTENSIONS);
	});

	it("hands over the answer as it is written, not only when the turn is over", async () => {
		const sandbox = new StubSandbox();
		sandbox.result = {
			exitCode: 0,
			stdout: [
				JSON.stringify({ assistantMessageEvent: { type: "text_start" } }),
				JSON.stringify({ assistantMessageEvent: { type: "text_delta", delta: "half " } }),
				JSON.stringify({ assistantMessageEvent: { type: "text_delta", delta: "an answer" } }),
				JSON.stringify({
					assistantMessageEvent: { type: "text_end", content: "half an answer" },
				}),
				"",
			].join("\n"),
			stderr: "",
		};
		const seen: string[] = [];

		const result = await new PiTurnRunner({ sandbox }).run("a1", "hi", (text) => seen.push(text));

		expect(seen).toEqual(["half ", "an answer"]);
		expect(result.text).toBe("half an answer");
	});

	it("gives the agent its own soul and skills, not pi's defaults", () => {
		const runner = new PiTurnRunner({ sandbox: new StubSandbox(), repoPath: "/srv/self" });

		expect(runner.commandFor("a1")).toEqual(
			expect.arrayContaining([
				"--append-system-prompt",
				"/srv/self/soul.md",
				"--skill",
				"/srv/self/skills",
			]),
		);
	});

	it("takes the turn inside the agent's repository, so memory is where it works", async () => {
		const sandbox = new StubSandbox();

		await new PiTurnRunner({ sandbox }).run("a1", "hello");

		expect(sandbox.calls[0]?.workingDir).toBe("/home/agent/.self");
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

	it("brings back what the agent asked for its own next turn", async () => {
		const sandbox = new StubSandbox();
		sandbox.left = JSON.stringify({ afterSeconds: 1200, note: "seguir con la migración" });

		const result = await new PiTurnRunner({ sandbox }).run("a1", "hi");

		expect(result.wake).toEqual({ afterSeconds: 1200, note: "seguir con la migración" });
	});

	it("says nothing about a turn that asked for nothing", async () => {
		expect((await new PiTurnRunner({ sandbox: new StubSandbox() }).run("a1", "hi")).wake).toBe(
			undefined,
		);
	});

	// The request is taken away as it is read. Left in place it is a request the next turn finds and
	// asks again, and an agent woken once would be waking for ever without having asked twice.
	it("does not ask again on the turn after", async () => {
		const sandbox = new StubSandbox();
		sandbox.left = JSON.stringify({ afterSeconds: 1200, note: "seguir" });
		const runner = new PiTurnRunner({ sandbox });

		await runner.run("a1", "hi");

		expect((await runner.run("a1", "otra vez")).wake).toBe(undefined);
	});

	// The whole point of stopping something. A stopped turn that came back as an error would be left
	// queued and taken again, which is the one thing whoever stopped it was asking not to happen.
	it("ends a stopped turn without calling it a failure", async () => {
		const sandbox = new StubSandbox();
		sandbox.holds = true;
		sandbox.result = { exitCode: 137, stdout: said("iba por la mit"), stderr: "" };
		const runner = new PiTurnRunner({ sandbox });

		const turn = runner.run("a1", "hi");
		expect(runner.stop("a1")).toBe(true);

		const result = await turn;
		expect(result.stopped).toBe(true);
		// As far as it got, which is what the person watching it be written already saw.
		expect(result.text).toBe("iba por la mit");
	});

	it("says there was nothing to stop when the agent was not taking a turn", () => {
		expect(new PiTurnRunner({ sandbox: new StubSandbox() }).stop("a1")).toBe(false);
	});

	// Being woken a second later by the very turn somebody just stopped is not stopping. The request
	// is still taken off the disk, so the next turn does not find it and act on it.
	it("does not book the next turn from one that was stopped", async () => {
		const sandbox = new StubSandbox();
		sandbox.holds = true;
		sandbox.left = JSON.stringify({ afterSeconds: 1, note: "seguir" });
		const runner = new PiTurnRunner({ sandbox });

		const turn = runner.run("a1", "hi");
		runner.stop("a1");

		expect((await turn).wake).toBeUndefined();
		expect(sandbox.left).toBeUndefined();
	});

	// A turn that died is the one most worth coming back to, and the one that can no longer ask.
	it("still brings it back from a turn that failed", async () => {
		const sandbox = new StubSandbox();
		sandbox.result = { exitCode: 1, stdout: "", stderr: "boom" };
		sandbox.left = JSON.stringify({ afterSeconds: 300, note: "reintentar" });

		await expect(new PiTurnRunner({ sandbox }).run("a1", "hi")).rejects.toMatchObject({
			result: { wake: { afterSeconds: 300, note: "reintentar" } },
		});
	});
});

/**
 * What may be believed about a file the agent could have written by hand — it has a shell, and the
 * tool that normally writes this is a convenience rather than a gate.
 */
describe("parseWake", () => {
	it("reads a request as the tool writes it", () => {
		expect(parseWake('{"afterSeconds":1200,"note":"seguir"}\n')).toEqual({
			afterSeconds: 1200,
			note: "seguir",
		});
	});

	// Its own shape rather than a very distant time, because every time is clamped into a range the
	// plane can honour: there is no number that means "not at all".
	it("reads a cancellation as the tool writes it", () => {
		expect(parseWake('{"cancel":true}\n')).toEqual({ cancel: true });
	});

	it("takes nothing else for a cancellation", () => {
		expect(parseWake('{"cancel":false}')).toBeUndefined();
		expect(parseWake('{"cancel":"yes"}')).toBeUndefined();
	});

	it("believes nothing it cannot read", () => {
		expect(parseWake("en veinte minutos")).toBeUndefined();
		expect(parseWake("")).toBeUndefined();
		expect(parseWake("null")).toBeUndefined();
	});

	it("refuses a delay that is not a number of seconds", () => {
		expect(parseWake('{"afterSeconds":"1200","note":"seguir"}')).toBeUndefined();
		expect(parseWake('{"note":"seguir"}')).toBeUndefined();
	});

	// Waking with nothing to be told is waking with amnesia, which is worse than not waking: it
	// costs a turn and produces an agent asking what it is doing here.
	it("refuses a wakeup that would say nothing", () => {
		expect(parseWake('{"afterSeconds":1200,"note":"   "}')).toBeUndefined();
		expect(parseWake('{"afterSeconds":1200}')).toBeUndefined();
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
			runner: { run: async () => answered("on it") },
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
			runner: { run: async () => answered("on it") },
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

	it("keeps a taken turn when a channel cannot carry the reply", async () => {
		// A hook without a reply URL is a legitimate one-way channel, and it used to be fatal: the
		// send threw, the handler threw, the events were requeued, and the next attempt hit the same
		// hook. That agent could never finish a turn again, and paid for the model every time round.
		const undelivered: Array<{ channel: string; message: string }> = [];
		const delivered: string[] = [];
		const handler = createTurnHandler({
			runner: { run: async () => answered("on it") },
			router: {
				send: async (reply) => {
					if (reply.channel.startsWith("webhook:")) throw new Error("no reply URL configured");
					delivered.push(reply.channel);
				},
			},
			onUndelivered: (_id, channel, error) => undelivered.push({ channel, message: error.message }),
		});

		await expect(
			handler({
				agentId: "a1",
				events: [wakeup("webhook:ping", "one"), wakeup("cli:abc", "two")],
				prompt: "p",
			}),
		).resolves.toBeUndefined();

		// And the operator who could be answered still was, rather than losing their turn to a
		// destination that has nothing to do with them.
		expect(delivered).toEqual(["cli:abc"]);
		expect(undelivered).toEqual([{ channel: "webhook:ping", message: "no reply URL configured" }]);
	});

	it("says nothing when the turn produced nothing", async () => {
		const sent: string[] = [];
		const handler = createTurnHandler({
			runner: { run: async () => answered("") },
			router: {
				send: async (reply) => {
					sent.push(reply.body);
				},
			},
		});

		await handler({ agentId: "a1", events: [wakeup("webhook:deploys", "x")], prompt: "p" });

		expect(sent).toEqual([]);
	});

	// Half an answer read as a whole one is worse than none, and the only person it was owed to is the
	// one who stopped it — who was watching it be written and has already seen this much.
	it("says nothing on the channel for a turn that was stopped", async () => {
		const sent: string[] = [];
		const handler = createTurnHandler({
			runner: { run: async () => ({ ...answered("iba por la mit"), stopped: true as const }) },
			router: {
				send: async (reply) => {
					sent.push(reply.body);
				},
			},
		});

		await handler({ agentId: "a1", events: [wakeup("webhook:deploys", "x")], prompt: "p" });

		expect(sent).toEqual([]);
	});

	// Stopping and failing look alike from here and must not be treated alike: a failed turn is queued
	// for another attempt, and a stopped one that came back would spend the money again on the work
	// somebody just interrupted.
	it("does not take a stopped turn again", async () => {
		const bus = new EventBus();
		await bus.register(
			"a1",
			createTurnHandler({
				runner: { run: async () => ({ ...answered("iba por la mit"), stopped: true as const }) },
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

		expect(retried).toBe(0);
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
