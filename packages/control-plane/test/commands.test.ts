import { describe, expect, it } from "vitest";
import {
	COMMANDS,
	type CommandContext,
	completions,
	endedIn,
	isCommand,
	isShell,
	money,
	runCommand,
	shellOutput,
	shellScript,
} from "../src/commands.ts";
import type { McpServer } from "../src/mcp.ts";

/** A context that remembers what was asked of it, which is the half a string cannot show. */
function context(
	start: {
		spentUsd?: number;
		limitUsd?: number;
		/** Hosts the operator granted. Nothing a command does can add to this, which is the point. */
		grants?: readonly string[];
		/** Servers already on the shelf, as another agent's `/mcp add` would have left them. */
		shelf?: Record<string, McpServer>;
	} = {},
) {
	const state = { spentUsd: start.spentUsd ?? 0, limitUsd: start.limitUsd };
	const set: (number | null)[] = [];
	const shelf = new Map<string, McpServer>(Object.entries(start.shelf ?? {}));
	const held = new Set<string>();
	const named = (name: string) => {
		const server = shelf.get(name);
		return server === undefined ? [] : [{ name, server }];
	};
	return {
		set,
		shelf,
		held,
		context: {
			account: async () => state,
			setLimit: async (usd: number | null) => {
				set.push(usd);
				state.limitUsd = usd ?? undefined;
			},
			mcp: async () => ({
				shelf: [...shelf.keys()].flatMap(named),
				held: [...held].flatMap(named),
			}),
			granted: async (host: string) => (start.grants ?? []).includes(host),
			addServer: async (name: string, server: McpServer) => {
				shelf.set(name, server);
			},
			attachServer: async (name: string) => {
				held.add(name);
			},
			detachServer: async (name: string) => {
				held.delete(name);
			},
			forgetServer: async (name: string) => {
				shelf.delete(name);
				held.delete(name);
			},
		} satisfies CommandContext,
	};
}

describe("isCommand", () => {
	it("is the slash and nothing else about the line", () => {
		expect(isCommand("/limit 5")).toBe(true);
		expect(isCommand("/")).toBe(true);
		expect(isCommand("limit 5")).toBe(false);
		// A message can be about a path, and the agent is the one who should read it.
		expect(isCommand("look at src/limit.ts")).toBe(false);
	});
});

/**
 * A command nobody can name is a command nobody has, and the names were only ever written down in
 * the answer to a command you had to already know the name of to ask for.
 */
describe("completions", () => {
	it("offers everything there is under a bare slash", () => {
		expect(completions("/")).toEqual(COMMANDS);
	});

	it("narrows to what the line could still become", () => {
		expect(completions("/li").map((command) => command.name)).toEqual(["/limit"]);
		expect(completions("/limit").map((command) => command.name)).toEqual(["/limit"]);
	});

	it("offers nothing for a line that is not a command", () => {
		expect(completions("hola")).toEqual([]);
		expect(completions("")).toEqual([]);
		// A message about a path is a message, and the agent is the one who should read it.
		expect(completions("/etc/hosts is wrong")).toEqual([]);
	});

	// The space is what says the command has been chosen and the argument is what is being typed
	// now. Without this a menu offering `/limit` would sit over `/limit 5` stealing its return.
	it("closes the moment an argument is being typed", () => {
		expect(completions("/limit ")).toEqual([]);
		expect(completions("/limit 5")).toEqual([]);
	});
});

/**
 * Money is read at a glance to decide whether to worry, so the two things it has to do are never
 * show a turn as costing nothing and never show a day as a wall of digits.
 */
describe("money", () => {
	it("keeps the price of a cheap turn from rounding away to zero", () => {
		expect(money(0.0009)).toBe("$0.0009");
	});

	it("is two decimals once there is a cent to see", () => {
		expect(money(1.5)).toBe("$1.50");
		expect(money(0)).toBe("$0.00");
	});
});

describe("runCommand", () => {
	it("reports what has been spent and against what", async () => {
		const { context: ctx, set } = context({ spentUsd: 0.42, limitUsd: 5 });

		const answer = await runCommand("/limit", ctx);

		expect(answer).toContain("$0.42");
		expect(answer).toContain("$5.00");
		// Asking is not setting. A bare `/limit` that wrote would make reading the number dangerous.
		expect(set).toEqual([]);
	});

	it("says there is no ceiling rather than leaving the question open", async () => {
		const answer = await runCommand("/limit", context().context);

		expect(answer).toContain("no limit");
	});

	it("sets a ceiling in dollars a day", async () => {
		const { context: ctx, set } = context();

		const answer = await runCommand("/limit 5", ctx);

		expect(set).toEqual([5]);
		expect(answer).toContain("$5.00");
	});

	// The number is about money, so the character people put in front of money should not be an error.
	it("takes the dollar sign people type anyway", async () => {
		const { context: ctx, set } = context();

		await runCommand("/limit $5.50", ctx);

		expect(set).toEqual([5.5]);
	});

	/**
	 * `null` rather than "unset", because the two are different answers. Unsetting would hand back
	 * whatever the config declared, which is the ceiling the operator is at that moment removing.
	 */
	it("takes a ceiling off without restoring the one in the file", async () => {
		const { context: ctx, set } = context({ limitUsd: 5 });

		const answer = await runCommand("/limit off", ctx);

		expect(set).toEqual([null]);
		expect(answer).toContain("No spending limit");
	});

	it("says nothing about a limit it refuses to set", async () => {
		const { context: ctx, set } = context();

		for (const line of ["/limit cinco", "/limit 0", "/limit -3", "/limit 5 dollars"]) {
			const answer = await runCommand(line, ctx);
			expect(answer).toContain("not an amount");
		}

		expect(set).toEqual([]);
	});

	/** Somebody who typed a command that does not exist is somebody who wants the list. */
	it("answers an unknown command with the ones there are", async () => {
		const answer = await runCommand("/spend", context().context);

		expect(answer).toContain('No command "/spend"');
		expect(answer).toContain("/limit");
	});

	it("answers a bare slash with the same list", async () => {
		const bare = await runCommand("/", context().context);

		expect(bare).toBe(await runCommand("/help", context().context));
		expect(bare).toContain("/limit");
	});
});

describe("/mcp", () => {
	const linear = "https://mcp.linear.app/mcp";

	it("says there are none, and the three ways to add one", async () => {
		const answer = await runCommand("/mcp", context().context);

		expect(answer).toContain("No MCP servers yet");
		expect(answer).toContain("/mcp add <name> <url>");
		expect(answer).toContain("sse");
		expect(answer).toContain("<command>");
	});

	it("puts a server on the shelf and gives it to this agent in one line", async () => {
		const { context: ctx, shelf, held } = context({ grants: ["mcp.linear.app"] });

		const answer = await runCommand(`/mcp add linear ${linear}`, ctx);

		expect(shelf.get("linear")).toEqual({ transport: "http", url: linear });
		expect(held.has("linear")).toBe(true);
		expect(answer).toContain('"linear" is on the shelf');
	});

	/** The whole reason the shelf is a shelf: from the second agent on it is a name off a list. */
	it("gives an agent one somebody else already found, by name alone", async () => {
		const { context: ctx, held } = context({
			grants: ["mcp.linear.app"],
			shelf: { linear: { transport: "http", url: linear } },
		});

		const answer = await runCommand("/mcp linear", ctx);

		expect(held.has("linear")).toBe(true);
		expect(answer).toContain(linear);
	});

	it("says which ones are there to be asked for", async () => {
		const { context: ctx } = context({ shelf: { linear: { transport: "http", url: linear } } });

		const answer = await runCommand("/mcp", ctx);

		expect(answer).toContain("This agent has none of them");
		expect(answer).toContain("On the shelf");
		expect(answer).toContain("/mcp linear gives this agent that one");
	});

	/**
	 * The failure this is here to prevent: a server that is attached, listed, and answers every tool
	 * call with the proxy's refusal — discovered mid-turn, by the agent, in the middle of doing
	 * something else.
	 */
	it("says a remote server cannot be reached, and what would grant it", async () => {
		const { context: ctx, held } = context();

		const answer = await runCommand(`/mcp add linear ${linear}`, ctx);

		// Still attached: the operator asked for it, and it works the moment the grant exists.
		expect(held.has("linear")).toBe(true);
		expect(answer).toContain("cannot be reached yet");
		expect(answer).toContain("host: mcp.linear.app");
		expect(answer).toContain("LINEAR_TOKEN");
	});

	it("says nothing about grants for a server the operator did grant", async () => {
		const { context: ctx } = context({ grants: ["mcp.linear.app"] });

		expect(await runCommand(`/mcp add linear ${linear}`, ctx)).not.toContain("cannot be reached");
	});

	// It has nowhere to go on its own account: what it reaches for is the sandbox's own road out.
	it("says nothing about grants for a server that is a process", async () => {
		const { context: ctx } = context();

		const answer = await runCommand("/mcp add files mcp-files /tmp", ctx);

		expect(answer).not.toContain("cannot be reached");
	});

	it("marks the ones nothing can reach in the list too", async () => {
		const { context: ctx } = context({ shelf: { linear: { transport: "http", url: linear } } });

		expect(await runCommand("/mcp", ctx)).toContain("(no grant for mcp.linear.app)");
	});

	it("takes one off this agent while leaving it for the others", async () => {
		const { context: ctx, shelf, held } = context({ grants: ["mcp.linear.app"] });
		await runCommand(`/mcp add linear ${linear}`, ctx);

		const answer = await runCommand("/mcp drop linear", ctx);

		expect(held.has("linear")).toBe(false);
		expect(shelf.has("linear")).toBe(true);
		// Which of the two words does what is not obvious from either, and nobody should have to learn
		// it by typing the wrong one at the server they spent an afternoon setting up.
		expect(answer).toContain("still on the shelf");
	});

	it("takes a forgotten one off the shelf and off this agent at once", async () => {
		const { context: ctx, shelf, held } = context();
		await runCommand("/mcp add files mcp-files", ctx);

		await runCommand("/mcp forget files", ctx);

		expect(shelf.has("files")).toBe(false);
		expect(held.has("files")).toBe(false);
	});

	it("answers a name nothing is called with the names there are", async () => {
		const { context: ctx } = context({ shelf: { linear: { transport: "http", url: linear } } });

		const answer = await runCommand("/mcp githob", ctx);

		expect(answer).toContain('no server called "githob"');
		expect(answer).toContain("linear");
	});

	it("says an agent already has what it already has, rather than saying it twice", async () => {
		const { context: ctx } = context({ grants: ["mcp.linear.app"] });
		await runCommand(`/mcp add linear ${linear}`, ctx);

		expect(await runCommand("/mcp linear", ctx)).toContain("already has");
	});

	// `/mcp drop` would then be ambiguous forever, and the ambiguity would be discovered by whoever
	// tried to drop it.
	it("refuses a name it uses for something else", async () => {
		const { context: ctx, shelf } = context();

		const answer = await runCommand("/mcp add drop mcp-files", ctx);

		expect(answer).toContain("is a word /mcp uses");
		expect(shelf.size).toBe(0);
	});

	it("refuses a name no model could spell back", async () => {
		const { context: ctx, shelf } = context();

		expect(await runCommand("/mcp add My_Server mcp-files", ctx)).toContain("not a name");
		expect(shelf.size).toBe(0);
	});

	it("says what it is missing rather than storing half a server", async () => {
		const { context: ctx, shelf } = context();

		expect(await runCommand("/mcp add", ctx)).toContain("needs a name");
		expect(await runCommand("/mcp add linear", ctx)).toContain("needs a URL");
		expect(shelf.size).toBe(0);
	});

	it("does not pretend to drop something this agent never had", async () => {
		const { context: ctx } = context({ shelf: { linear: { transport: "http", url: linear } } });

		expect(await runCommand("/mcp drop linear", ctx)).toContain("does not have");
	});
});

describe("isShell", () => {
	it("is the bang and nothing else about the line", () => {
		expect(isShell("!ls -la")).toBe(true);
		expect(isShell("!")).toBe(true);
		expect(isShell("ls -la")).toBe(false);
		// Excitement is not a command, and this is a box people type Spanish into.
		expect(isShell("qué bueno!")).toBe(false);
	});
});

/** ESC written as its six characters, because a raw one in a source file does not survive editing. */
const ESC = "\u001b";

describe("shellOutput", () => {
	const ran = (over: Partial<Parameters<typeof shellOutput>[0]>) =>
		shellOutput({ stdout: "", stderr: "", exitCode: 0, ...over });

	it("is what the command printed", () => {
		expect(ran({ stdout: "README.md\nsrc\n" })).toBe("README.md\nsrc");
	});

	// A command that printed nothing and worked is the most confusing thing a pane can show, because
	// it is identical to a console that dropped the request.
	it("says so when a command printed nothing at all", () => {
		expect(ran({})).toBe("(no output)");
	});

	it("keeps what went to stderr, which is where the reason usually is", () => {
		expect(ran({ stderr: "sh: nope: not found", exitCode: 127 })).toBe(
			"sh: nope: not found\nexit 127",
		);
	});

	/** The difference between a test run that reported failures and one that died before it could. */
	it("says how it ended whenever that is not well", () => {
		expect(ran({ stdout: "2 failed", exitCode: 1 })).toBe("2 failed\nexit 1");
		expect(ran({ exitCode: 1 })).toBe("exit 1");
	});

	it("does not say how it ended when it ended well", () => {
		expect(ran({ stdout: "ok" })).toBe("ok");
	});

	/**
	 * The one place a file the agent wrote is drawn on the operator's terminal. A `!cat` of something
	 * it authored must not be able to move the cursor around the console doing the reading.
	 */
	it("takes the escape sequences out, so output cannot redraw the console", () => {
		expect(ran({ stdout: `${ESC}[31mred${ESC}[39m\n` })).toBe("red");
		expect(ran({ stdout: `${ESC}[2Jcleared\n` })).toBe("cleared");
		expect(ran({ stdout: `${ESC}[1;1Hhome\n` })).toBe("home");
		expect(ran({ stdout: `a${ESC}7b\n` })).toBe("ab");
	});

	it("keeps the tab and the newline, which are the two a pane can draw", () => {
		expect(ran({ stdout: "one\ttwo\nthree\n" })).toBe("one\ttwo\nthree");
	});

	it("takes the carriage return with them, since a pane has no margin to go back to", () => {
		expect(ran({ stdout: "10%\r20%\r30%\n" })).toBe("10%20%30%");
	});

	/**
	 * The transcript is rewritten whole on every line, so one `find /` left in it is paid for by
	 * every line said after it. The middle goes: the first lines say what it did and the last say
	 * how it ended.
	 */
	it("cuts the middle out of output nobody is going to read", () => {
		const printed = ran({ stdout: Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") });
		const lines = printed.split("\n");

		expect(lines).toHaveLength(201);
		expect(lines[0]).toBe("line 0");
		expect(lines.at(-1)).toBe("line 499");
		expect(printed).toContain("300 more lines");
	});

	it("leaves output that fits exactly as it was", () => {
		const printed = ran({ stdout: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") });

		expect(printed.split("\n")).toHaveLength(200);
		expect(printed).not.toContain("more lines");
	});

	// A `cd` prints nothing, and "(no output)" under it would hide the one thing it did.
	it("can be given something to say instead of nothing at all", () => {
		expect(shellOutput({ stdout: "", stderr: "", exitCode: 0 }, "/tmp")).toBe("/tmp");
		// Not when the command printed: what it said is the answer, and the directory is the prompt's.
		expect(shellOutput({ stdout: "hola", stderr: "", exitCode: 0 }, "/tmp")).toBe("hola");
	});
});

/**
 * Standing somewhere, which is what separates a shell from a way of running one command. Every `!`
 * is a new `sh`, so where the last one ended has to be carried to the next one by hand.
 */
describe("shellScript", () => {
	it("starts the shell where the last one ended", () => {
		const { script } = shellScript("ls", "/home/agent/.self/src");

		expect(script).toContain("cd '/home/agent/.self/src'");
		expect(script).toContain("ls");
	});

	/**
	 * Not the exec's working directory, which is refused outright when it no longer exists: a
	 * directory the agent deleted under the operator should put them back at its door, not stop them
	 * from running anything at all.
	 */
	it("does not let a directory that is gone take the shell with it", () => {
		expect(shellScript("ls", "/gone").script).toContain("2>/dev/null");
	});

	// The mark is what the answer is found by, so two commands must never share one.
	it("marks each run with something the last one did not use", () => {
		expect(shellScript("ls", "/tmp").mark).not.toBe(shellScript("ls", "/tmp").mark);
	});

	// A name with a quote in it is a name, and the shell has to be handed it as one word.
	it("hands the shell a directory it cannot misread", () => {
		expect(shellScript("ls", "/home/agent/it's").script).toContain(`cd '/home/agent/it'\\''s'`);
	});

	/** Asking where it ended is a command too, and would otherwise be the exit code that is reported. */
	it("reports what the line exited with, not what the asking did", () => {
		const { script } = shellScript("false", "/tmp");

		expect(script).toContain("__status=$?");
		expect(script).toContain("exit $__status");
	});
});

describe("endedIn", () => {
	it("takes the directory and the mark off what was printed", () => {
		expect(endedIn("README.md\nsrc\ncwd-abc/tmp/here", "cwd-abc")).toEqual({
			text: "README.md\nsrc\n",
			cwd: "/tmp/here",
		});
	});

	// A shell that exited before it could say — `!exit`, or a command that killed it — left no answer,
	// and the last directory anybody knew of is a better guess than the door.
	it("says nothing about where it ended when the shell never got to", () => {
		expect(endedIn("killed", "cwd-abc")).toEqual({ text: "killed", cwd: undefined });
	});
});
