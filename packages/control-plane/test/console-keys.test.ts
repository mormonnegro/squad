import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { App } from "../src/console.ts";
import type { ControlClient } from "../src/control-client.ts";
import type { AgentSummary, PlaneEvent } from "../src/control-plane.ts";

/**
 * The console driven by keystrokes, which is the only way some of it is true at all.
 *
 * Each pane can be drawn on its own and is, in `console.test.ts`. What cannot be drawn is which
 * pane a key reaches: the arrows move a cursor that decides whether the next letter is a message,
 * a name or nothing, and every one of those is one `if` away from the others.
 */

/** A terminal that is not one: raw mode is what `useInput` refuses to start without. */
class Keyboard extends PassThrough {
	isTTY = true;
	setRawMode(): this {
		return this;
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
}

const DOWN = "[B";
const UP = "[A";
const ENTER = "\r";
const BACKSPACE = "\x7f";

const listed = (id: string): AgentSummary => ({
	id,
	running: true,
	startedAt: undefined,
	grants: 1,
	schedules: 0,
	wakeAt: undefined,
	created: true,
	spentUsd: 0,
	limitUsd: undefined,
	model: undefined,
});

/**
 * A plane that answers, and a record of what it was asked.
 *
 * `create` is deliberately not instant: the console has to keep drawing while an agent is built,
 * and a fake that resolved in the same tick would never show whether it does.
 */
function plane(options: { refuses?: string; has?: readonly AgentSummary[] } = {}) {
	const asked: string[] = [];
	const commanded: string[] = [];
	// What the plane would say it has if it were asked right now, which a command can change.
	let roster = options.has ?? [];
	let finish: (agent: AgentSummary) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const client = {
		agents: async () => roster,
		transcripts: async () => ({}),
		logs: (_onEvent: (event: PlaneEvent) => void) => {},
		create: async (agentId: string) => {
			asked.push(agentId);
			if (options.refuses !== undefined) throw new Error(options.refuses);
			return new Promise<AgentSummary>((resolve, reject) => {
				finish = resolve;
				fail = reject;
			});
		},
		wake: async () => "",
		command: async (agentId: string, line: string) => {
			commanded.push(line);
			// The one command that changes what the plane has, and only in its confirmed form. Answered
			// the way the plane answers it: by being gone from the list the next time anyone asks.
			if (line.startsWith("/delete ")) roster = roster.filter((one) => one.id !== agentId);
			return "";
		},
		shell: async () => ({ text: "", cwd: "/" }),
		stop: async () => false,
	} as unknown as ControlClient;
	return {
		client,
		asked,
		commanded,
		built: (id: string) => finish(listed(id)),
		broke: (why: string) => fail(new Error(why)),
	};
}

/** Renders the console over a keyboard nothing is attached to, and hands back what it drew. */
function open(client: ControlClient, initial: readonly AgentSummary[]) {
	const stdin = new Keyboard();
	const stdout = new PassThrough();
	let drawn = "";
	stdout.on("data", (chunk: Buffer) => {
		drawn = chunk.toString("utf8");
	});
	const app = render(h(App, { client, initial, conversations: new Map() }), {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	return {
		screen: () => drawn,
		press: async (...keys: string[]): Promise<void> => {
			for (const key of keys) stdin.write(key);
			// A keystroke is a state change and a state change is a render, neither of which has
			// happened by the time `write` returns.
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
		close: () => app.unmount(),
	};
}

describe("the console, pressed at", () => {
	it("opens on the row that makes an agent when the plane has none", async () => {
		const { client } = plane();
		const console_ = open(client, []);
		try {
			await console_.press();

			expect(console_.screen()).toContain("▸ + new agent");
			expect(console_.screen()).toContain("new agent   chat");
		} finally {
			console_.close();
		}
	});

	// The whole of the feature in one press: the arrow that moves between agents is the arrow that
	// arrives at making one, and there is nothing else to know to get there.
	it("reaches that row from the last agent with the same arrow that moves between them", async () => {
		const { client, asked } = plane();
		const console_ = open(client, [listed("demo"), listed("maxi")]);
		try {
			await console_.press(DOWN, DOWN);
			expect(console_.screen()).toContain("▸ + new agent");

			await console_.press("scout", ENTER);

			expect(asked).toEqual(["scout"]);
		} finally {
			console_.close();
		}
	});

	it("says which name it is building until the plane has built it", async () => {
		const { client, built } = plane();
		const console_ = open(client, []);
		try {
			await console_.press("scout", ENTER);
			expect(console_.screen()).toContain("creating scout");

			built("scout");
			await console_.press();

			expect(console_.screen()).not.toContain("creating scout");
			// Appended where the plane appends it, which is the row the cursor was already on.
			expect(console_.screen()).toContain("▸ ● scout");
		} finally {
			console_.close();
		}
	});

	// The name that earned the refusal is still in the prompt, which is the one place the answer is
	// any use: a message said in a log nobody has open is a name nobody knows how to fix.
	it("keeps a refused name where it was typed, with what the plane said about it", async () => {
		const { client } = plane({ refuses: '"Scout" is not a name: lowercase, digits and dashes' });
		const console_ = open(client, []);
		try {
			await console_.press("Scout", ENTER);

			expect(console_.screen()).toContain("is not a name");
			expect(console_.screen()).toContain("+ Scout");
		} finally {
			console_.close();
		}
	});

	// A name is not a message and not a command. Both of these mean something at the prompt one row
	// above, and neither can mean it at an agent that does not exist yet: there is nothing for a
	// command to be about, and no sandbox for a bang to open.
	it("takes a name and nothing else at that prompt", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(DOWN);
			await console_.press("!ls");
			expect(console_.screen()).toContain("+ !ls");

			await console_.press("/");

			expect(console_.screen()).not.toContain("/limit");
			expect(console_.screen()).toContain("⏎ create");
		} finally {
			console_.close();
		}
	});

	/**
	 * The confirmation, which is the console's and not the plane's.
	 *
	 * It has to be here because this is the only place it can be skipped: a plane that took
	 * `/delete demo` from anywhere would let one line be the whole of an agent. So whatever is typed
	 * after the command is dropped, the bare form goes down — which destroys nothing and says what
	 * this would cost — and the prompt asks by name for the word that finishes it.
	 */
	it("asks before it deletes, and says which agent it is asking about", async () => {
		const { client, commanded } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("/delete demo", ENTER);

			expect(commanded).toEqual(["/delete"]);
			expect(console_.screen()).toContain("delete demo?");
			expect(console_.screen()).toContain("⌫ cancel");
			expect(console_.screen()).toContain("● demo");
		} finally {
			console_.close();
		}
	});

	// Backspacing off an empty line is how the shell prompt is left, and a question is a mode like any
	// other: there has to be a way out of it that is not answering it.
	it("leaves the question on a backspace, with the agent still there", async () => {
		const { client, commanded } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("/delete", ENTER);
			expect(console_.screen()).toContain("delete demo?");

			await console_.press(BACKSPACE);

			expect(console_.screen()).not.toContain("delete demo?");
			expect(commanded).toEqual(["/delete"]);
			expect(console_.screen()).toContain("● demo");
		} finally {
			console_.close();
		}
	});

	/**
	 * The list is polled every couple of seconds, and this test does not wait that long on purpose.
	 *
	 * A command is the one thing typed here that changes what the plane has, and an agent still
	 * sitting in the column after `/delete` took it away is a deletion that looks like it did not
	 * happen. So the list is asked for again the moment the command answers, not at the next poll.
	 */
	it("shows an agent gone as soon as the confirmed delete has answered", async () => {
		const { client, commanded } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("/delete", ENTER);
			await console_.press("demo", ENTER);

			expect(commanded).toEqual(["/delete", "/delete demo"]);
			expect(console_.screen()).not.toContain("● demo");
			expect(console_.screen()).toContain("▸ + new agent");
		} finally {
			console_.close();
		}
	});

	// Moving back is moving back to a conversation: the row above is an agent, and what is typed
	// there is said to it rather than taken for the name of another one.
	it("goes back to the agents, and to talking to them", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(DOWN);
			expect(console_.screen()).toContain("▸ + new agent");

			await console_.press(UP);

			expect(console_.screen()).toContain("▸ ● demo");
			expect(console_.screen()).toContain("! shell");
		} finally {
			console_.close();
		}
	});
});
