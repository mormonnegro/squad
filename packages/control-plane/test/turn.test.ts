import { EventBus } from "@squad/events";
import { type ExecResult, SANDBOX_EXTENSIONS } from "@squad/sandbox";
import { describe, expect, it } from "vitest";
import type { NamedServer } from "../src/mcp.ts";
import {
	createTurnHandler,
	HOUSE_RULES,
	LESSON_BYTES,
	MOST_ASKED,
	MOST_LESSONS,
	PiTurnRunner,
	parseAsked,
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
	readonly idleMs: number | undefined;
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
	/** What it left in the console file: the commands it is asking for. Absent is having asked for none. */
	asked: string | undefined;
	/** A command that says its piece and then runs until something stops it, like a turn does. */
	holds = false;
	/** A sandbox that will not take the servers, to see what the turn does about it. */
	refusesWrites = false;
	/** The session files pi has left behind, which are what forgetting a conversation reaches. */
	sessions: string[] = [];
	/** What the agent has written down about its own mistakes. Empty is an agent yet to be wrong. */
	lessons = "";
	/** A sandbox where that file cannot be read at all, which is what a new agent's volume is. */
	readsLessons = true;

	async run(
		agentId: string,
		cmd: readonly string[],
		input: string,
		options: {
			timeoutMs?: number;
			idleMs?: number;
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
			idleMs: options.idleMs,
			workingDir: options.workingDir,
		});
		if (cmd[0] === "find") return this.#find(cmd);
		if (cmd[0] === "sh") {
			// Three things arrive as a shell: the servers going in, and the wakeup and the commands
			// coming out. Told apart by what the script does and which file it names, since taking one
			// for the other reads as an agent having asked for something it never asked for.
			if (String(cmd[2]).includes("cat >")) {
				if (this.refusesWrites) return { exitCode: 1, stdout: "", stderr: "read-only" };
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// Read and left, unlike the two below, and cut where the real head would cut it.
			if (String(cmd[2]).startsWith("head")) {
				if (!this.readsLessons) return { exitCode: 1, stdout: "", stderr: "no such file" };
				const lines = Number(cmd[5]);
				const bytes = Number(cmd[6]);
				const cut = this.lessons.split("\n").slice(0, lines).join("\n").slice(0, bytes);
				return { exitCode: 0, stdout: cut, stderr: "" };
			}
			const asking = String(cmd[4]).includes("console.json");
			const held = asking ? this.asked : this.left;
			if (held === undefined) return { exitCode: 1, stdout: "", stderr: "" };
			// Taken away by the reading, which is the whole point of reading it that way.
			if (asking) this.asked = undefined;
			else this.left = undefined;
			return { exitCode: 0, stdout: held, stderr: "" };
		}
		if (this.result.stdout.length > 0) options.onStdout?.(this.result.stdout);
		if (this.holds && options.signal !== undefined) {
			// Checked as well as listened for, as the real one is: a stop can land before the command
			// starts, and a listener alone would wait forever for an event that already happened.
			await new Promise<void>((resolve) => {
				if (options.signal?.aborted === true) resolve();
				else options.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			// Killed, which is what a signal leaves behind rather than a clean exit.
			return { exitCode: 137, stdout: this.result.stdout, stderr: "" };
		}
		return this.result;
	}

	/**
	 * Enough of `find` to be worth testing against: the one pattern shape the runner asks for.
	 *
	 * Matching is the whole point of the stub. A sandbox that answered "yes, deleted" to any pattern
	 * would pass a runner that cleared every agent on the box.
	 */
	#find(cmd: readonly string[]): ExecResult {
		const pattern = cmd[cmd.indexOf("-name") + 1] ?? "";
		const tail = pattern.startsWith("*") ? pattern.slice(1) : pattern;
		const hit = this.sessions.filter((name) =>
			pattern.startsWith("*") ? name.endsWith(tail) : name === tail,
		);
		if (cmd.includes("-delete")) this.sessions = this.sessions.filter((one) => !hit.includes(one));
		return { exitCode: 0, stdout: hit.join("\n"), stderr: "" };
	}
}

/**
 * The turn itself, out of everything a turn does around it.
 *
 * Found rather than indexed because a turn keeps growing another step in front of pi — servers,
 * search, the model, the lessons — and every one of those has been a morning spent on tests that
 * were only ever counting.
 */
const piCall = (sandbox: StubSandbox): Invocation | undefined =>
	sandbox.calls.find((call) => call.cmd[0] === "pi");

describe("PiTurnRunner", () => {
	it("runs pi non-interactively with the prompt on stdin", async () => {
		const sandbox = new StubSandbox();
		const runner = new PiTurnRunner({ sandbox });

		const result = await runner.run("a1", "something happened");

		expect(result.text).toBe("done");
		expect(piCall(sandbox)?.input).toBe("something happened");
		expect(piCall(sandbox)?.cmd).toEqual([
			"pi",
			"--print",
			"--mode",
			"json",
			"--session-id",
			"squad-a1",
			"--session-dir",
			"/home/agent/.self/.sessions",
			"--append-system-prompt",
			"/home/agent/.self/soul.md",
			"--append-system-prompt",
			HOUSE_RULES,
			"--skill",
			"/home/agent/.self/skills",
			"--extension",
			"/usr/local/lib/squad/extensions/wake.ts",
			"--extension",
			"/usr/local/lib/squad/extensions/search.ts",
			"--extension",
			"/usr/local/lib/squad/extensions/mcp.ts",
			"--extension",
			"/usr/local/lib/squad/extensions/console.ts",
			"--extension",
			"/usr/local/lib/squad/extensions/remember.ts",
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

	/**
	 * The shelf is the plane's and the file is a copy of the part of it that concerns one agent, so
	 * it is written again every turn: an agent given a server between one turn and the next hears
	 * about it on the next one, without a container being recreated to tell it.
	 */
	it("puts the servers the agent holds in front of it before pi starts", async () => {
		const sandbox = new StubSandbox();
		let held: readonly NamedServer[] = [];
		const runner = new PiTurnRunner({ sandbox, servers: async () => held });

		await runner.run("a1", "hi");

		expect(sandbox.calls[0]?.cmd).toContain("/home/agent/.run/mcp.json");
		expect(sandbox.calls[0]?.input).toBe("[]");
		expect(piCall(sandbox)).toBeDefined();

		held = [{ name: "linear", server: { transport: "http", url: "https://mcp.linear.app/mcp" } }];
		await runner.run("a1", "otra vez");

		// Found rather than counted to: what this is about is that the second turn wrote it again, and
		// an index would make that assertion break every time a turn grows another step.
		const wrote = sandbox.calls.filter((call) => call.cmd.includes("/home/agent/.run/mcp.json"));
		expect(wrote).toHaveLength(2);
		expect(JSON.parse(wrote.at(-1)?.input ?? "null")).toEqual(held);
	});

	// Fewer tools is a worse turn. No turn is worse than that.
	it("takes the turn anyway when the servers could not be written", async () => {
		const sandbox = new StubSandbox();
		sandbox.refusesWrites = true;
		const runner = new PiTurnRunner({
			sandbox,
			servers: async () => [
				{ name: "linear", server: { transport: "http", url: "https://x/mcp" } },
			],
		});

		expect((await runner.run("a1", "hi")).text).toBe("done");
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

	/**
	 * The bug: an agent asked for a to-do list built it in `.self`, among its soul and its skills,
	 * because that was where it was standing. The soul, the skills and the session are all named by
	 * absolute path on the command, so none of them needs the turn to start in the repository.
	 */
	it("takes the turn in the workspace, so what it builds is not built inside itself", async () => {
		const sandbox = new StubSandbox();

		await new PiTurnRunner({ sandbox }).run("a1", "hello");

		expect(piCall(sandbox)?.workingDir).toBe("/home/agent/workspace");
	});

	/**
	 * The half of remembering that the agent cannot do for itself: the turn where a lesson would save
	 * something is the turn where nothing reminds the agent that it has one.
	 */
	it("reads back what the agent wrote down about its own mistakes", async () => {
		const sandbox = new StubSandbox();
		sandbox.lessons = "- The proxy refuses any host nobody granted.\n";

		await new PiTurnRunner({ sandbox }).run("a1", "hi");

		const said = piCall(sandbox)?.cmd.join("\n") ?? "";
		expect(said).toContain("The proxy refuses any host nobody granted.");
		expect(said).toContain("do not have to learn them a second time");
	});

	// An agent that has never been wrong should not carry a heading saying so, on every turn, forever.
	it("says nothing at all when the agent has no lessons", async () => {
		const sandbox = new StubSandbox();

		await new PiTurnRunner({ sandbox }).run("a1", "hi");

		const cmd = piCall(sandbox)?.cmd ?? [];
		expect(cmd.filter((one) => one === "--append-system-prompt")).toHaveLength(2);
	});

	/**
	 * The file is the agent's own and it has an editor, so the count it was told is a count it can
	 * walk past. What that costs is not a broken turn — it is a slow expensive one, every turn, that
	 * nobody notices until the bill, which is why the cut that decides is this one and not the tool's.
	 */
	it("cuts the lessons in the sandbox, so a file somebody filled never crosses the socket", async () => {
		const sandbox = new StubSandbox();
		sandbox.lessons = Array.from({ length: 500 }, (_, index) => `- lesson ${index}`).join("\n");

		await new PiTurnRunner({ sandbox }).run("a1", "hi");

		const read = sandbox.calls.find((call) => String(call.cmd[2]).startsWith("head"));
		expect(read?.cmd).toEqual(expect.arrayContaining([String(MOST_LESSONS), String(LESSON_BYTES)]));
		const said = piCall(sandbox)?.cmd.join("\n") ?? "";
		expect(said).toContain("lesson 19");
		expect(said).not.toContain("lesson 20");
	});

	// Fewer lessons is a worse turn. No turn is worse than that, and a new agent has no file at all.
	it("takes the turn anyway when the lessons could not be read", async () => {
		const sandbox = new StubSandbox();
		sandbox.readsLessons = false;

		const result = await new PiTurnRunner({ sandbox }).run("a1", "hi");

		expect(result.text).toBe("done");
	});

	// Every turn and not only the first, because tidiness is a habit; and from the plane rather than
	// from `soul.md`, because a rule the agent can rewrite is not a rule.
	it("says the house rule on every turn, where the agent cannot edit it", async () => {
		const sandbox = new StubSandbox();
		const runner = new PiTurnRunner({ sandbox });

		await runner.run("a1", "hello");
		await runner.run("a1", "again");

		const turns = sandbox.calls.filter((call) => call.cmd[0] === "pi");
		expect(turns).toHaveLength(2);
		for (const turn of turns) expect(turn.cmd).toContain(HOUSE_RULES);
		expect(HOUSE_RULES).toContain("/home/agent/workspace");
	});

	it("keeps every wakeup in one session per agent", () => {
		const runner = new PiTurnRunner({ sandbox: new StubSandbox() });
		expect(runner.sessionId("a1")).toBe("squad-a1");
		expect(runner.sessionId("a2")).not.toBe(runner.sessionId("a1"));
	});

	it("keeps sessions on the agent's own volume so a new container remembers", () => {
		const runner = new PiTurnRunner({ sandbox: new StubSandbox() });
		expect(runner.commandFor("a1")).toContain("/home/agent/.self/.sessions");
	});

	it("passes the model it was given for this agent", () => {
		const runner = new PiTurnRunner({ sandbox: new StubSandbox() });

		expect(runner.commandFor("a1", { provider: "anthropic", model: "claude-opus-4-7" })).toEqual(
			expect.arrayContaining(["--provider", "anthropic", "--model", "claude-opus-4-7"]),
		);
	});

	/**
	 * Asked again every turn rather than held from the start, so an agent moved onto another model
	 * answers with it next time it says anything. Held, and the only way to change what a running
	 * agent thinks with would be to take its container away.
	 */
	it("asks what to think with at the start of every turn", async () => {
		const sandbox = new StubSandbox();
		const asked: string[] = [];
		const models = ["claude-opus-4-7", "claude-haiku-4-5"];
		const runner = new PiTurnRunner({
			sandbox,
			model: async (agentId) => {
				asked.push(agentId);
				return { provider: "anthropic", model: models[asked.length - 1] ?? "" };
			},
		});

		await runner.run("a1", "hi");
		await runner.run("a1", "again");

		expect(asked).toEqual(["a1", "a1"]);
		const ran = sandbox.calls.filter((call) => call.cmd[0] === "pi");
		expect(ran[0]?.cmd).toEqual(expect.arrayContaining(["--model", "claude-opus-4-7"]));
		expect(ran[1]?.cmd).toEqual(expect.arrayContaining(["--model", "claude-haiku-4-5"]));
	});

	it("bounds a turn by its silence rather than by how long it takes", async () => {
		const sandbox = new StubSandbox();
		await new PiTurnRunner({ sandbox, idleMs: 1000 }).run("a1", "hi");
		expect(piCall(sandbox)?.idleMs).toBe(1000);
		expect(piCall(sandbox)?.timeoutMs).toBeUndefined();
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

	it("forgets the session pi keeps for the agent", async () => {
		const sandbox = new StubSandbox();
		sandbox.sessions = ["2026-08-25T05-09-25-472Z_squad-scout.jsonl"];

		expect(await new PiTurnRunner({ sandbox }).forget("scout")).toBe(true);
		expect(sandbox.sessions).toEqual([]);
	});

	// One agent's name ending in another's is not a coincidence to be ruled out, it is how people name
	// things. The underscore pi writes between the timestamp and the id is what keeps them apart.
	it("leaves alone an agent whose name ends in the one being forgotten", async () => {
		const sandbox = new StubSandbox();
		const neighbour = "2026-08-25T05-09-25-472Z_squad-my-squad-scout.jsonl";
		sandbox.sessions = [neighbour, "2026-08-25T06-00-00-000Z_squad-scout.jsonl"];

		await new PiTurnRunner({ sandbox }).forget("scout");

		expect(sandbox.sessions).toEqual([neighbour]);
	});

	it("says there was nothing when the agent has never taken a turn", async () => {
		expect(await new PiTurnRunner({ sandbox: new StubSandbox() }).forget("scout")).toBe(false);
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

	it("brings back the commands the turn asked for, in the order it asked", async () => {
		const sandbox = new StubSandbox();
		sandbox.asked = JSON.stringify([
			"/mcp add ahrefs https://mcp.ahrefs.com/mcp",
			"/mcp login ahrefs",
		]);

		const result = await new PiTurnRunner({ sandbox }).run("a1", "hi");

		expect(result.asked).toEqual([
			"/mcp add ahrefs https://mcp.ahrefs.com/mcp",
			"/mcp login ahrefs",
		]);
	});

	it("says nothing about a turn that asked for none", async () => {
		expect((await new PiTurnRunner({ sandbox: new StubSandbox() }).run("a1", "hi")).asked).toBe(
			undefined,
		);
	});

	// Read and removed together, for the wakeup's reason: a list left in place is one the next turn
	// finds, and an agent that connected a server once would be connecting it every turn from then on.
	it("does not run them again on the turn after", async () => {
		const sandbox = new StubSandbox();
		sandbox.asked = JSON.stringify(["/model"]);
		const runner = new PiTurnRunner({ sandbox });

		await runner.run("a1", "hi");

		expect((await runner.run("a1", "otra vez")).asked).toBeUndefined();
	});

	// The one the screenshot was about: the turn died for want of the server it was asking for, and
	// dropping the request with the turn is how an agent stays broken across every retry.
	it("still brings them back from a turn that failed", async () => {
		const sandbox = new StubSandbox();
		sandbox.result = { exitCode: 1, stdout: "", stderr: "boom" };
		sandbox.asked = JSON.stringify(["/mcp login ahrefs"]);

		await expect(new PiTurnRunner({ sandbox }).run("a1", "hi")).rejects.toMatchObject({
			result: { asked: ["/mcp login ahrefs"] },
		});
	});

	// A login opening in the operator's browser after they stopped the turn is the turn carrying on
	// without them. Still taken off the disk, so the next turn does not find it and ask again.
	it("runs none of them from a turn that was stopped", async () => {
		const sandbox = new StubSandbox();
		sandbox.holds = true;
		sandbox.asked = JSON.stringify(["/mcp login ahrefs"]);
		const runner = new PiTurnRunner({ sandbox });

		const turn = runner.run("a1", "hi");
		runner.stop("a1");

		expect((await turn).asked).toBeUndefined();
		expect(sandbox.asked).toBeUndefined();
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

/** The same question about the same kind of file, which the agent could also have written by hand. */
describe("parseAsked", () => {
	it("reads the list as the tool writes it", () => {
		expect(
			parseAsked('["/mcp add linear https://mcp.linear.app/mcp","/mcp login linear"]\n'),
		).toEqual(["/mcp add linear https://mcp.linear.app/mcp", "/mcp login linear"]);
	});

	it("believes nothing it cannot read", () => {
		expect(parseAsked("conectame a linear")).toBeUndefined();
		expect(parseAsked("")).toBeUndefined();
		expect(parseAsked('{"line":"/mcp"}')).toBeUndefined();
	});

	// A line that is not a command is not a command however it got here. What it would be instead is
	// a message put into the conversation by something with no business putting one there.
	it("keeps only what is a command at all", () => {
		expect(parseAsked('["/model","dame acceso","",12]')).toEqual(["/model"]);
		expect(parseAsked('["dame acceso"]')).toBeUndefined();
	});

	// Two commands under one answer is a second one nobody reading has any reason to look for.
	it("drops a line with another one hidden inside it", () => {
		expect(parseAsked('["/model\\n/limit 50"]')).toBeUndefined();
	});

	// The tool caps this too. It is capped here because the tool is a convenience in a sandbox where
	// the agent has a shell, and a turn that asked for four hundred is a console nothing else fits in.
	it("takes no more than a turn is allowed to ask for", () => {
		const many = Array.from({ length: MOST_ASKED + 5 }, (_, index) => `/model m${index}`);

		expect(parseAsked(JSON.stringify(many))).toHaveLength(MOST_ASKED);
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

	// An agent asking to be woken is carrying on the conversation it is in, so whoever books the turn
	// has to be told which one that is. Without it, somebody who asked by mail for a joke every minute
	// is mailed the first joke and no others: every turn after it answers to nowhere.
	it("hands over the channel it was answering when it booked the next turn", async () => {
		const booked: Array<string | undefined> = [];
		const handler = createTurnHandler({
			runner: {
				run: async () => ({
					...answered("dale"),
					wake: { afterSeconds: 60, note: "el que sigue" },
				}),
			},
			onWake: async (_id, _wake, answering) => {
				booked.push(answering);
			},
		});

		await handler({
			agentId: "a1",
			events: [wakeup("cli:abc", "hola"), wakeup("email:vos@example.com", "un chiste por minuto")],
			prompt: "p",
		});

		expect(booked).toEqual(["email:vos@example.com"]);
	});

	// A console channel names one request, which is answered and then gone. Inherited, it puts the
	// address of something that no longer exists on a wakeup due days from now — and buys nothing,
	// since the console is shown every turn as it is taken, whoever booked it.
	it("books on nowhere when the conversation was one console request", async () => {
		const booked: Array<string | undefined> = [];
		const handler = createTurnHandler({
			runner: {
				run: async () => ({
					...answered("dale"),
					wake: { afterSeconds: 60, note: "el que sigue" },
				}),
			},
			onWake: async (_id, _wake, answering) => {
				booked.push(answering);
			},
		});

		await handler({ agentId: "a1", events: [wakeup("cli:40c5abdd", "hola")], prompt: "p" });

		expect(booked).toEqual([undefined]);
	});

	/**
	 * The bug this exists to prevent, and it took a second try to find: a wakeup that came due while
	 * the mail was being written landed last in the same burst, won the tie, and booked the next turn
	 * to answer to nobody. From there it was permanent — every turn after it had only its own note in
	 * front of it, and booked another one just like it.
	 */
	it("books on the conversation rather than on its own note, whichever came in last", async () => {
		const booked: Array<string | undefined> = [];
		const handler = createTurnHandler({
			runner: {
				run: async () => ({
					...answered("dale"),
					wake: { afterSeconds: 60, note: "el que sigue" },
				}),
			},
			onWake: async (_id, _wake, answering) => {
				booked.push(answering);
			},
		});
		const ownNote = {
			...wakeup("wake", "contá el que sigue"),
			source: "schedule",
			metadata: { createdBy: "agent" },
		} as const;

		await handler({
			agentId: "a1",
			events: [wakeup("email:vos@example.com", "un chiste por minuto"), ownNote],
			prompt: "p",
		});
		// And a turn nobody spoke into keeps whatever channel its own note is already carrying, which
		// is how a cycle stays where it began instead of drifting home after the first quiet minute.
		await handler({
			agentId: "a1",
			events: [{ ...ownNote, channel: "email:vos@example.com" }],
			prompt: "p",
		});

		expect(booked).toEqual(["email:vos@example.com", "email:vos@example.com"]);
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

	// The answer is written into the conversation here, and an answer that left by mail should say so
	// there: a pane that shows the agent answering and nothing about the mail reads like no mail went.
	it("says where the answer is going, along with the turn", async () => {
		const told: Array<readonly string[]> = [];
		const handler = createTurnHandler({
			runner: { run: async () => answered("dale") },
			router: { send: async () => undefined },
			onTurn: (_id, _result, to) => told.push(to),
		});

		await handler({
			agentId: "a1",
			events: [wakeup("email:vos@example.com", "un chiste"), wakeup("cli:abc", "y otro")],
			prompt: "p",
		});

		expect(told).toEqual([["email:vos@example.com", "cli:abc"]]);
	});

	// Nothing leaves a turn that was stopped, and an answer marked as sent that was never sent is
	// worse than an unmarked one: the pane would be the only evidence, and it would be wrong.
	it("says the answer of a stopped turn is going nowhere", async () => {
		const told: Array<readonly string[]> = [];
		const handler = createTurnHandler({
			runner: { run: async () => ({ ...answered("iba por la mit"), stopped: true as const }) },
			router: { send: async () => undefined },
			onTurn: (_id, _result, to) => told.push(to),
		});

		await handler({ agentId: "a1", events: [wakeup("email:vos@example.com", "x")], prompt: "p" });

		expect(told).toEqual([[]]);
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

	// The commands are state and the reply is a courtesy, so the server the agent connected itself to
	// is there before the answer goes out to whoever is about to be told about it.
	it("runs what the turn asked for before it answers anyone", async () => {
		const order: string[] = [];
		const handler = createTurnHandler({
			runner: { run: async () => ({ ...answered("listo"), asked: ["/mcp login ahrefs"] }) },
			router: {
				send: async () => {
					order.push("replied");
				},
			},
			onAsked: async (_id, asked) => {
				order.push(asked.join(", "));
			},
		});

		await handler({ agentId: "a1", events: [wakeup("webhook:deploys", "x")], prompt: "p" });

		expect(order).toEqual(["/mcp login ahrefs", "replied"]);
	});

	it("asks for nothing when the turn asked for nothing", async () => {
		let called = 0;
		const handler = createTurnHandler({
			runner: { run: async () => answered("listo") },
			onAsked: async () => {
				called += 1;
			},
		});

		await handler({ agentId: "a1", events: [wakeup("webhook:deploys", "x")], prompt: "p" });

		expect(called).toBe(0);
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
