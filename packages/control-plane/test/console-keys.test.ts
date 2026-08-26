import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { App, type Talk } from "../src/console.ts";
import type { ControlClient } from "../src/control-client.ts";
import type { AgentSummary, PlaneEvent } from "../src/control-plane.ts";
import type { ModelOffer, ModelSpec, ModelStanding, ProviderStanding } from "../src/models.ts";
import type { Utterance } from "../src/transcript.ts";

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
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
/** Next and previous agent. Chords, because the bare arrows belong to the line being typed. */
const NEXT = "\u000e";
const PREVIOUS = "\u0010";
/** The same move said the way a hand reaches for it, which not every terminal sends. */
const CTRL_DOWN = "\u001b[1;5B";
const CTRL_UP = "\u001b[1;5A";
const ENTER = "\r";
const TAB = "\t";
/** What the key marked backspace actually sends, which is what the delete key sends too. */
const BACKSPACE = "\u007F";
const ESCAPE = "\u001B";

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
	served: [],
});

/**
 * A plane that answers, and a record of what it was asked.
 *
 * `create` is deliberately not instant: the console has to keep drawing while an agent is built,
 * and a fake that resolved in the same tick would never show whether it does.
 */
function plane(
	options: {
		refuses?: string;
		has?: readonly AgentSummary[];
		pays?: readonly ProviderStanding[];
		thinks?: readonly ModelStanding[];
		refusesModel?: string;
		sells?: readonly ModelOffer[];
		unreachable?: readonly string[];
		completes?: readonly string[];
	} = {},
) {
	const asked: string[] = [];
	const commanded: string[] = [];
	const shelled: string[] = [];
	const asking: string[] = [];
	const stopped: string[] = [];
	const given: [string, string][] = [];
	const written: ModelSpec[] = [];
	const dropped: string[] = [];
	// What the plane would say it has if it were asked right now, which a command can change.
	let roster = options.has ?? [];
	let finish: (agent: AgentSummary) => void = () => {};
	let feed: (event: PlaneEvent) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const client = {
		agents: async () => roster,
		transcripts: async () => ({}),
		logs: (onEvent: (event: PlaneEvent) => void) => {
			feed = onEvent;
		},
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
		shell: async (_agentId: string, line: string) => {
			shelled.push(line);
			return { text: "", cwd: "/" };
		},
		complete: async (_agentId: string, word: string) => {
			asking.push(word);
			return (options.completes ?? []).filter((option) => option.startsWith(word));
		},
		stop: async (agentId: string) => {
			stopped.push(agentId);
			return true;
		},
		providers: async () => options.pays ?? [],
		setKey: async (keyEnv: string, value: string) => {
			given.push([keyEnv, value]);
		},
		models: async () => options.thinks ?? [],
		addModel: async (spec: ModelSpec) => {
			written.push(spec);
			// The plane refuses a model it cannot resolve, and the screen has to say so rather than
			// quietly redraw a list the model is not in.
			if (options.refusesModel !== undefined) throw new Error(options.refusesModel);
		},
		dropModel: async (modelId: string) => {
			dropped.push(modelId);
		},
		offers: async () => ({
			offers: options.sells ?? [],
			trouble: options.unreachable ?? [],
		}),
	} as unknown as ControlClient;
	return {
		client,
		asked,
		commanded,
		shelled,
		asking,
		stopped,
		given,
		written,
		dropped,
		built: (id: string) => finish(listed(id)),
		/** The plane is what says an agent is thinking, so the console is told the way it tells it. */
		thinking: (id: string) => feed({ kind: "thinking", agentId: id }),
		said: (id: string, said: Utterance) => feed({ kind: "said", agentId: id, said }),
		broke: (why: string) => fail(new Error(why)),
	};
}

/** Renders the console over a keyboard nothing is attached to, and hands back what it drew. */
function open(
	client: ControlClient,
	initial: readonly AgentSummary[],
	conversations: Talk = new Map(),
) {
	const stdin = new Keyboard();
	const stdout = new PassThrough();
	let drawn = "";
	stdout.on("data", (chunk: Buffer) => {
		drawn = chunk.toString("utf8");
	});
	const app = render(h(App, { client, initial, conversations }), {
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
			await new Promise((resolve) => setTimeout(resolve, 40));
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

			expect(console_.screen()).toContain("+ new agent");
			expect(console_.screen()).toContain("new agent   chat");
		} finally {
			console_.close();
		}
	});

	// The whole of the feature in one chord: what moves between agents is what arrives at making one,
	// and there is nothing else to know to get there.
	it("reaches that row from the last agent with the chord that moves between them", async () => {
		const { client, asked } = plane();
		const console_ = open(client, [listed("demo"), listed("maxi")]);
		try {
			// One at a time: two of these written together arrive as one chunk, which is a paste.
			await console_.press(NEXT);
			await console_.press(NEXT);
			expect(console_.screen()).toContain("new agent   chat");

			await console_.press("scout", ENTER);

			expect(asked).toEqual(["scout"]);
		} finally {
			console_.close();
		}
	});

	/**
	 * The same move on the chord a hand actually reaches for, which is up and down with control held.
	 * Kept beside the letters rather than instead of them: whether this sequence arrives at all is the
	 * terminal's decision, and the footer names the pair that always does.
	 */
	it("reaches it with a modified arrow too, where the terminal sends one", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(CTRL_DOWN);
			expect(console_.screen()).toContain("new agent   chat");

			await console_.press(CTRL_UP);

			expect(console_.screen()).toContain("demo   chat");
		} finally {
			console_.close();
		}
	});

	/** They belong to the line being typed now, and a line with no cursor has nowhere to go. */
	it("leaves the agents where they are on a bare left or right", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(RIGHT, RIGHT, LEFT);

			expect(console_.screen()).toContain("demo   chat");
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
			expect(console_.screen()).toContain("● scout");
			expect(console_.screen()).toContain("scout   chat");
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
			await console_.press(NEXT);
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
	 * after the command is dropped and only the bare form goes down, which destroys nothing.
	 *
	 * What the prompt asks for is a key. The first version wanted the name typed back and was found
	 * unanswerable at the keyboard — an empty red box with a cursor in it says a word is wanted but
	 * not which, and the two keys are in the prompt now so there is nothing to work out.
	 */
	it("asks before it deletes, and says which agent and which keys", async () => {
		const { client, commanded } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("/delete demo", ENTER);

			expect(commanded).toEqual(["/delete"]);
			expect(console_.screen()).toContain("delete demo?");
			expect(console_.screen()).toContain("y / n");
			expect(console_.screen()).toContain("y delete");
			expect(console_.screen()).toContain("● demo");
		} finally {
			console_.close();
		}
	});

	/**
	 * The whole of the safety, and the reason `y` is the key rather than the return.
	 *
	 * Every key that is not `y` is a no, including the return that was pressed a moment ago to ask
	 * the question — which is the key a hand is already on, and the one an accident lands on. So the
	 * arrows, the tab and the letters cannot answer it either: the question has the keyboard until
	 * it is answered, and one that could be arrowed away from is not a question.
	 */
	it("takes anything that is not y for a no, and deletes nothing", async () => {
		const { client, commanded } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("/delete", ENTER);
			expect(console_.screen()).toContain("delete demo?");

			await console_.press(ENTER);

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
	it("deletes on a y, and shows the agent gone as soon as that has answered", async () => {
		const { client, commanded } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("/delete", ENTER);
			await console_.press("y");

			expect(commanded).toEqual(["/delete", "/delete demo"]);
			expect(console_.screen()).not.toContain("● demo");
			expect(console_.screen()).toContain("new agent   chat");
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
			await console_.press(NEXT);
			expect(console_.screen()).toContain("new agent   chat");

			await console_.press(PREVIOUS);

			expect(console_.screen()).toContain("demo   chat");
			expect(console_.screen()).toContain("! shell");
		} finally {
			console_.close();
		}
	});
});

/**
 * The prompt, walked back through and taken back from.
 *
 * All three of these are keys a hand already knows from somewhere else — a shell, a browser, every
 * other prompt — and a console that took them for something of its own would be a console where
 * that knowledge is worth nothing.
 */
describe("the prompt, walked back through", () => {
	const spoke = (agentId: string, ...lines: string[]): Talk =>
		new Map([[agentId, lines.map((text) => ({ from: "operator" as const, text }))]]);

	it("puts the last line back in the prompt on an up arrow", async () => {
		const { client } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")], spoke("demo", "hola", "que hora es"));
		try {
			await console_.press(UP);

			expect(console_.screen()).toContain("> que hora es");
		} finally {
			console_.close();
		}
	});

	it("keeps going back, and stops on the oldest", async () => {
		const { client } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")], spoke("demo", "hola", "que hora es"));
		try {
			await console_.press(UP, UP, UP);

			expect(console_.screen()).toContain("> hola");
		} finally {
			console_.close();
		}
	});

	/** The half-written line survives the walk, which is the whole reason the walk is safe to press. */
	it("gives back what was being typed when the walk ends", async () => {
		const { client } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")], spoke("demo", "hola"));
		try {
			await console_.press("medio escr");
			await console_.press(UP);
			expect(console_.screen()).toContain("> hola");

			await console_.press(DOWN);

			expect(console_.screen()).toContain("> medio escr");
		} finally {
			console_.close();
		}
	});
});

/**
 * Escape, which stops a turn and gives the question back.
 *
 * A turn is stopped because it was asked the wrong thing, nearly every time. Leaving the question
 * standing alone in the conversation and the prompt empty makes asking it again a retyping job,
 * which is work the console can do and the hand should not have to.
 */
describe("a turn stopped with escape", () => {
	it("does nothing at an agent with nothing to stop", async () => {
		const { client, stopped } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(ESCAPE);

			expect(stopped).toEqual([]);
		} finally {
			console_.close();
		}
	});

	it("stops the turn, and puts the question back where it was typed", async () => {
		const { client, stopped, thinking, said } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("que hora es", ENTER);
			said("demo", { from: "operator", text: "que hora es" });
			thinking("demo");
			await console_.press();

			await console_.press(ESCAPE);

			expect(stopped).toEqual(["demo"]);
			expect(console_.screen()).toContain("> que hora es");
		} finally {
			console_.close();
		}
	});

	/** A prompt with something in it is a hand mid-sentence, and nothing gets to overwrite that. */
	it("leaves a half-written line alone", async () => {
		const { client, stopped, thinking, said } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("que hora es", ENTER);
			said("demo", { from: "operator", text: "que hora es" });
			thinking("demo");
			await console_.press("y donde");

			await console_.press(ESCAPE);

			expect(stopped).toEqual(["demo"]);
			expect(console_.screen()).toContain("> y donde");
		} finally {
			console_.close();
		}
	});
});

/**
 * The tab at a shell prompt, which is the shell's.
 *
 * A hand that opened a box to walk around it will press tab looking for a directory, because that
 * is what tab is at every prompt that takes a path. Swapping the pane out from under that is wrong
 * twice: the completion did not happen, and the pane went somewhere nobody asked for.
 */
describe("the shell prompt, tabbed at", () => {
	it("types out the one path that matches, instead of changing panes", async () => {
		const { client, asking } = plane({ has: [listed("demo")], completes: ["README.md"] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("!");
			await console_.press("cat READ");
			await console_.press(TAB);

			expect(asking).toEqual(["READ"]);
			expect(console_.screen()).toContain("cat README.md");
			expect(console_.screen()).toContain("demo   chat");
		} finally {
			console_.close();
		}
	});

	it("leaves the hand inside a directory rather than past it", async () => {
		const { client, shelled } = plane({ has: [listed("demo")], completes: ["packages/"] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("!");
			await console_.press("cd pack");
			await console_.press(TAB);
			expect(console_.screen()).toContain("cd packages/");

			await console_.press(ENTER);

			// No space between the directory and the return, which is what a next tab goes into.
			expect(shelled).toEqual(["cd packages/"]);
		} finally {
			console_.close();
		}
	});

	it("types as far as they agree and offers the rest, the way a slash offers commands", async () => {
		const { client } = plane({
			has: [listed("demo")],
			completes: ["control-plane/", "control-server/"],
		});
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("!");
			await console_.press("cd co");
			await console_.press(TAB);

			expect(console_.screen()).toContain("cd control-");
			expect(console_.screen()).toContain("control-plane/");
			expect(console_.screen()).toContain("control-server/");
			expect(console_.screen()).toContain("↑↓ path");
		} finally {
			console_.close();
		}
	});

	it("takes the row the arrows are standing on, and sends it on the return after", async () => {
		const { client, shelled } = plane({
			has: [listed("demo")],
			completes: ["control-plane/", "control-server/"],
		});
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("!");
			await console_.press("cd co");
			await console_.press(TAB);
			await console_.press(DOWN);
			await console_.press(ENTER);
			expect(console_.screen()).toContain("cd control-server/");

			await console_.press(ENTER);

			expect(shelled).toEqual(["cd control-server/"]);
		} finally {
			console_.close();
		}
	});

	/** The way to the other panes is still there, over a line with nothing on it to complete. */
	it("still changes panes over an empty prompt", async () => {
		const { client } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press("!");
			await console_.press(TAB);

			expect(console_.screen()).toContain("logs");
		} finally {
			console_.close();
		}
	});
});

/**
 * The list of models, offered where the command that uses one is typed.
 *
 * The names were only ever written down on the setup screen, two panes away, so moving an agent was
 * remembering a word or leaving the prompt to go and read it. Only true as keystrokes: what the menu
 * is offering depends on how much of the line is typed, and the return that takes a row off it is the
 * same key that sends the line under it.
 */
describe("the model menu, pressed at", () => {
	const thinks: readonly ModelStanding[] = [
		{
			id: "flash",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			host: "api.deepseek.com",
			keyEnv: "DEEPSEEK_API_KEY",
			added: false,
			held: true,
		},
		{
			id: "mini",
			provider: "openai",
			model: "gpt-5-mini",
			host: "api.openai.com",
			keyEnv: "OPENAI_API_KEY",
			added: true,
			held: true,
		},
	];

	const chatting = () => {
		const it_ = plane({ has: [listed("demo")], thinks });
		return { ...it_, ...open(it_.client, [listed("demo")]) };
	};

	it("offers the models this plane has, instead of asking for a name", async () => {
		const screen = chatting();
		try {
			await screen.press("/model ");

			expect(screen.screen()).toContain("/model flash");
			expect(screen.screen()).toContain("deepseek/deepseek-v4-flash");
			expect(screen.screen()).toContain("↑↓ model");
		} finally {
			screen.close();
		}
	});

	// The gesture the space costs nothing for: taking the command off the menu leaves the space
	// behind it, so one return gets from a half-typed `/mo` to the list of models.
	it("opens the list with the same return that took the command off the menu", async () => {
		const screen = chatting();
		try {
			await screen.press("/mo");
			await screen.press(ENTER);

			expect(screen.screen()).toContain("/model mini");
		} finally {
			screen.close();
		}
	});

	it("puts the model the arrows are standing on into the line, and sends it on the next", async () => {
		const screen = chatting();
		try {
			await screen.press("/model ");
			await screen.press(DOWN);
			await screen.press(ENTER);
			// Not sent yet: what goes to the plane is on screen first, the way a completed line is
			// everywhere else a prompt completes one.
			expect(screen.commanded).toEqual([]);
			expect(screen.screen()).toContain("/model mini");

			await screen.press(ENTER);

			expect(screen.commanded).toEqual(["/model mini"]);
		} finally {
			screen.close();
		}
	});

	it("narrows the list to what has been typed", async () => {
		const screen = chatting();
		try {
			await screen.press("/model fla");

			expect(screen.screen()).toContain("/model flash");
			expect(screen.screen()).not.toContain("/model mini");
		} finally {
			screen.close();
		}
	});

	// Typed in full the menu is agreeing rather than offering, and a menu that agreed would be sitting
	// on the return that sends the line it agreed with.
	it("sends a name typed out in full on the first return", async () => {
		const screen = chatting();
		try {
			await screen.press("/model flash");
			await screen.press(ENTER);

			expect(screen.commanded).toEqual(["/model flash"]);
		} finally {
			screen.close();
		}
	});
});

/**
 * The screen where a key is given, which only exists as keystrokes.
 *
 * A provider row is drawn in `console.test.ts`. What cannot be drawn is that the letters of an API
 * key go into it and nowhere else — every pane behind this one would take some of them for something
 * it does, and the first that did would leave the rest of a live key in a message to an agent.
 */
describe("the setup screen, pressed at", () => {
	const paying = (
		id: string,
		keyEnv: string,
		models: readonly string[],
		held = false,
		here = false,
	): ProviderStanding => ({ id, keyEnv, models, held, here });

	const pays = [
		paying("deepseek", "DEEPSEEK_API_KEY", ["flash"]),
		paying("openai", "OPENAI_API_KEY", ["mini"], true),
		paying("anthropic", "ANTHROPIC_API_KEY", [], true, true),
	];

	const thinking = (
		id: string,
		provider: string,
		added: boolean,
		held: boolean,
	): ModelStanding => ({
		id,
		provider,
		model: id,
		host: `api.${provider}.com`,
		keyEnv: `${provider.toUpperCase()}_API_KEY`,
		added,
		held,
	});

	const thinks = [
		thinking("flash", "deepseek", false, false),
		thinking("mini", "openai", true, true),
	];

	/** Opens the console and tabs to the setup screen, which is where every one of these starts. */
	async function setup(options: Parameters<typeof plane>[0] = { pays, thinks }) {
		const it_ = plane(options);
		const console_ = open(it_.client, [listed("demo")]);
		// One at a time: two writes in a tick arrive as one chunk, which is one keystroke to a terminal
		// and would be a tab nobody pressed.
		await console_.press(TAB);
		await console_.press(TAB);
		return { ...it_, ...console_ };
	}

	it("is where the tab that cycles the panes arrives, with what the plane could pay for on it", async () => {
		const screen = await setup();
		try {
			expect(screen.screen()).toContain("DEEPSEEK_API_KEY");
			expect(screen.screen()).toContain("flash");
			expect(screen.screen()).toContain("⏎ set key");
		} finally {
			screen.close();
		}
	});

	// A row of marks cannot say where a key came from, and that is the difference between changing it
	// here and going to look for the `.env` the plane was started with.
	it("says of the row it is standing on where that key came from", async () => {
		const screen = await setup();
		try {
			expect(screen.screen()).toContain("no key, refused at the proxy");

			await screen.press(DOWN);
			expect(screen.screen()).toContain("from this plane's environment");

			await screen.press(DOWN);
			expect(screen.screen()).toContain("set here");
		} finally {
			screen.close();
		}
	});

	it("takes a key without putting it on the screen", async () => {
		const screen = await setup();
		try {
			await screen.press(ENTER);
			expect(screen.screen()).toContain("key for DEEPSEEK_API_KEY");

			await screen.press("sk-typed");

			expect(screen.screen()).not.toContain("sk-typed");
			expect(screen.screen()).toContain("••••");
			expect(screen.screen()).toContain("⏎ save");
		} finally {
			screen.close();
		}
	});

	it("hands the key to the plane when it is entered", async () => {
		const screen = await setup();
		try {
			await screen.press(ENTER);
			await screen.press("sk-typed");
			await screen.press(ENTER);

			expect(screen.given).toEqual([["DEEPSEEK_API_KEY", "sk-typed"]]);
			expect(screen.screen()).toContain("no key, refused at the proxy");
		} finally {
			screen.close();
		}
	});

	// A key half typed at the wrong provider is the ordinary mistake here, and escape is where every
	// hand goes for it. Nothing is sent, which is what makes it safe to press.
	it("gives up on a key without giving it", async () => {
		const screen = await setup();
		try {
			await screen.press(ENTER);
			await screen.press("sk-typed");
			await screen.press(ESCAPE);

			expect(screen.given).toEqual([]);
			expect(screen.screen()).not.toContain("key for DEEPSEEK_API_KEY");
		} finally {
			screen.close();
		}
	});

	// The way to take back a key given here. Nothing else on this screen can say it, and without it a
	// key typed at the wrong provider would be one there is no way to undo from the console.
	it("takes an empty line for taking the key back", async () => {
		const screen = await setup();
		try {
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(ENTER);
			await screen.press(ENTER);

			expect(screen.given).toEqual([["ANTHROPIC_API_KEY", ""]]);
		} finally {
			screen.close();
		}
	});

	// A key is pasted rather than typed, and it arrives with the newline of whatever it was copied out
	// of about as often as not. That newline is the return, not a character of the key.
	it("enters a key that arrived with its newline still on it", async () => {
		const screen = await setup();
		try {
			await screen.press(ENTER);
			await screen.press("sk-pasted\n");

			expect(screen.given).toEqual([["DEEPSEEK_API_KEY", "sk-pasted"]]);
		} finally {
			screen.close();
		}
	});

	/**
	 * The reason the key prompt is checked before every pane rather than inside one.
	 *
	 * An API key holds any character, and a console where a `/` opened the command menu and a `!` was
	 * the start of a shell would take a pasted key apart into things it does. What lands in the chat
	 * draft is on its way to an agent, and a secret is the one thing that may never get there.
	 */
	it("never lets a character of a key reach the agent behind the screen", async () => {
		const screen = await setup();
		try {
			await screen.press(ENTER);
			await screen.press("sk-/limit!ls");

			expect(screen.screen()).not.toContain("/limit ");
			expect(screen.screen()).not.toContain("! shell");

			await screen.press(ESCAPE);
			await screen.press(TAB);

			expect(screen.screen()).toContain("demo   chat");
			expect(screen.screen()).not.toContain("sk-");
			expect(screen.screen()).not.toContain("ls");
		} finally {
			screen.close();
		}
	});

	/** The arrows walk one list, so the row after the last key is the first model and not nothing. */
	it("carries on into the models the keys are for", async () => {
		const screen = await setup();
		try {
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(DOWN);

			expect(screen.screen()).toContain("declared in deploy/config.yaml");

			await screen.press(DOWN);
			expect(screen.screen()).toContain("added here");
			expect(screen.screen()).toContain("⌫ drop model");
		} finally {
			screen.close();
		}
	});

	// The whole of "all the configuration from the program": a model this plane never had, given a
	// name and a provider at a keyboard, with no file edited and nothing restarted.
	it("takes a model written out on the row that adds one", async () => {
		const screen = await setup();
		try {
			for (const _ of pays) await screen.press(DOWN);
			for (const _ of thinks) await screen.press(DOWN);
			await screen.press(ENTER);

			expect(screen.screen()).toContain("⏎ add");

			await screen.press("sonnet anthropic claude-sonnet-4-6");
			// Written out rather than hidden: this is a name and a provider, not a secret.
			expect(screen.screen()).toContain("sonnet anthropic");

			await screen.press(ENTER);
			expect(screen.written).toEqual([
				{ id: "sonnet", provider: "anthropic", model: "claude-sonnet-4-6" },
			]);
		} finally {
			screen.close();
		}
	});

	// The provider's own name for a model is the id far more often than not, so leaving it out is the
	// short way to say the ordinary thing rather than a line the plane has to refuse.
	it("leaves the provider's own name out when it was not said", async () => {
		const screen = await setup();
		try {
			for (const _ of [...pays, ...thinks]) await screen.press(DOWN);
			await screen.press(ENTER);
			await screen.press("sonnet anthropic");
			await screen.press(ENTER);

			expect(screen.written).toEqual([{ id: "sonnet", provider: "anthropic" }]);
		} finally {
			screen.close();
		}
	});

	it("says why a model was refused, instead of a list it is quietly not in", async () => {
		const screen = await setup({
			pays,
			thinks,
			refusesModel: 'nothing here knows "my-gateway"',
		});
		try {
			for (const _ of [...pays, ...thinks]) await screen.press(DOWN);
			await screen.press(ENTER);
			await screen.press("k2 my-gateway");
			await screen.press(ENTER);

			expect(screen.screen()).toContain("my-gateway");
		} finally {
			screen.close();
		}
	});

	const sells = [
		{ provider: "openai", id: "gpt-5" },
		{ provider: "openai", id: "gpt-5-mini" },
		{ provider: "anthropic", id: "claude-opus-4-7" },
	];

	/** Opens the setup screen with the cursor already on the row that adds a model, and enters it. */
	async function offering(options: Parameters<typeof plane>[0] = { pays, thinks, sells }) {
		const screen = await setup(options);
		for (const _ of [...pays, ...thinks]) await screen.press(DOWN);
		await screen.press(ENTER);
		return screen;
	}

	// The point of the whole thing: handing over a key and then being asked for a model name is being
	// asked the one fact the key just made this plane able to look up.
	it("offers what the keys it holds can buy, instead of asking for a name", async () => {
		const screen = await offering();
		try {
			expect(screen.screen()).toContain("gpt-5-mini");
			expect(screen.screen()).toContain("3 on offer");
			expect(screen.screen()).toContain("↑↓ move");
		} finally {
			screen.close();
		}
	});

	it("narrows the offers to what has been typed, in any order", async () => {
		const screen = await offering();
		try {
			await screen.press("openai mini");

			expect(screen.screen()).toContain("gpt-5-mini");
			expect(screen.screen()).not.toContain("claude-opus-4-7");
			expect(screen.screen()).toContain("1 on offer");
		} finally {
			screen.close();
		}
	});

	// The id is the provider's own name for it, which is what somebody typing it out would have
	// written anyway — so picking one is the whole of adding it.
	it("adds the offer the arrows are standing on, under the name the provider gave it", async () => {
		const screen = await offering();
		try {
			await screen.press(DOWN);
			await screen.press(ENTER);

			expect(screen.written).toEqual([{ id: "gpt-5-mini", provider: "openai" }]);
		} finally {
			screen.close();
		}
	});

	// The escape hatch: a name of your own, or a provider this console has no catalog for, is still
	// three words typed out — and saying the third one is what says the list is not what was meant.
	it("takes a model written out in full over the offer under the cursor", async () => {
		const screen = await offering();
		try {
			await screen.press("mini openai gpt-5-mini");
			await screen.press(ENTER);

			expect(screen.written).toEqual([{ id: "mini", provider: "openai", model: "gpt-5-mini" }]);
		} finally {
			screen.close();
		}
	});

	// An empty list is the shape both "this key is wrong" and "this provider has nothing" arrive in,
	// and only one of those is worth telling somebody about.
	it("says which provider could not be asked, rather than offering nothing", async () => {
		const screen = await offering({ pays, thinks, unreachable: ["openai answered 401"] });
		try {
			expect(screen.screen()).toContain("openai answered 401");
		} finally {
			screen.close();
		}
	});

	it("gives up on a model without adding it", async () => {
		const screen = await setup();
		try {
			for (const _ of [...pays, ...thinks]) await screen.press(DOWN);
			await screen.press(ENTER);
			await screen.press("sonnet anthropic");
			await screen.press(ESCAPE);

			expect(screen.written).toEqual([]);
		} finally {
			screen.close();
		}
	});

	// Asked before it happens, and answered by one key, because the cursor is already on the row and
	// the hand is already on the keys that would answer it by accident.
	it("asks before dropping a model, and drops it when the answer is yes", async () => {
		const screen = await setup();
		try {
			for (const _ of pays) await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(BACKSPACE);

			expect(screen.screen()).toContain("y drop");
			expect(screen.dropped).toEqual([]);

			await screen.press("y");
			expect(screen.dropped).toEqual(["mini"]);
		} finally {
			screen.close();
		}
	});

	it("keeps a model when the answer is anything else", async () => {
		const screen = await setup();
		try {
			for (const _ of pays) await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(BACKSPACE);
			await screen.press("n");

			expect(screen.dropped).toEqual([]);
		} finally {
			screen.close();
		}
	});

	/**
	 * The half of the list this screen may read and not write.
	 *
	 * The plane would refuse it anyway, but the refusal would arrive after the question was answered
	 * — and a question answered `y` that then does nothing is worse than one that was never asked.
	 */
	it("sends a model the file declared back to the file", async () => {
		const screen = await setup();
		try {
			for (const _ of pays) await screen.press(DOWN);
			await screen.press(BACKSPACE);

			expect(screen.screen()).toContain("drop it there");
			expect(screen.screen()).not.toContain("y drop");
		} finally {
			screen.close();
		}
	});
});
