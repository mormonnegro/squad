import { PassThrough } from "node:stream";
import { CARRIERS, type CarrierSpec } from "@squad/channels";
import { render } from "ink";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { App, bare, type Talk } from "../src/console.ts";
import type { ControlClient } from "../src/control-client.ts";
import type { AgentSummary, PlaneEvent } from "../src/control-plane.ts";
import type { GrantStanding } from "../src/grants.ts";
import type { MailStanding } from "../src/mailbox.ts";
import type { McpServer, ServerStanding } from "../src/mcp.ts";
import type { ModelOffer, ModelSpec, ModelStanding, ProviderStanding } from "../src/models.ts";
import { resolveSearch, type Search, type SearchSpec } from "../src/search.ts";
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
const ENTER = "\r";
const TAB = "\t";
/** The way back up the column, which every terminal sends and no terminal keeps for itself. */
const SHIFT_TAB = "\u001b[Z";
/** What the key marked backspace actually sends, which is what the delete key sends too. */
const BACKSPACE = "\u007F";
const ESCAPE = "\u001B";

/** No mailbox at all, which is what a plane nobody has pasted an address into says. */
const NO_MAIL: MailStanding = {
	mailbox: undefined,
	host: undefined,
	carrier: "",
	domain: "",
	keyEnv: undefined,
	held: false,
	here: false,
	writes: false,
	trouble: undefined,
};

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
		paysSearch?: boolean;
		shelf?: readonly ServerStanding[];
		reaches?: readonly GrantStanding[];
		refusesGrant?: string;
		posts?: MailStanding;
		refusesMail?: string;
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
	const aimed: SearchSpec[] = [];
	const shelved: [string, McpServer][] = [];
	const handed: [string, string, boolean][] = [];
	const unshelved: string[] = [];
	const opened: string[] = [];
	const closed: string[] = [];
	const offered: string[] = [];
	const connected: [string, string][] = [];
	const carried: (CarrierSpec | undefined)[] = [];
	const unmailed: string[] = [];
	// What the plane would say it has if it were asked right now, which a command can change.
	let roster = options.has ?? [];
	// Where the search is pointed. Answered back the way the plane answers it — read again after
	// every change — because the screen shows what the plane says and not what the keyboard did.
	let pointed: SearchSpec = { provider: "openai", model: "gpt-5-mini" };
	// The mail the same way: named through the client, read back off the plane. Naming a carrier
	// changes what the next `mail()` says, so the screen can be asserted on rather than the keyboard.
	let posted: MailStanding = options.posts ?? NO_MAIL;
	// Read back off the plane the way the search is: a host opened at the keyboard is on the list the
	// next time the screen asks, so what is asserted is what the plane says rather than what was typed.
	let reached: readonly GrantStanding[] = options.reaches ?? [];
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
		// Resolved through the real table, so that a provider chosen alone comes back with that
		// provider's own first model — which is the half of the answer the console never sends.
		search: async () => ({
			...(resolveSearch(pointed) as Search),
			chosen: true,
			held: options.paysSearch ?? true,
			here: false,
		}),
		setSearch: async (spec: SearchSpec) => {
			pointed = spec;
			aimed.push(spec);
		},
		servers: async () => options.shelf ?? [],
		grants: async () => reached,
		addGrant: async (host: string) => {
			opened.push(host);
			if (options.refusesGrant !== undefined) throw new Error(options.refusesGrant);
			reached = [...reached, { id: `reach:${host}`, host, origin: "here" as const }];
		},
		dropGrant: async (host: string) => {
			closed.push(host);
			reached = reached.filter((grant) => grant.host !== host);
		},
		addServer: async (name: string, server: McpServer) => {
			shelved.push([name, server]);
		},
		holdServer: async (agentId: string, name: string, held: boolean) => {
			handed.push([agentId, name, held]);
		},
		forgetServer: async (name: string) => {
			unshelved.push(name);
		},
		mail: async () => posted,
		offerMail: async (address: string) => {
			offered.push(address);
			if (options.refusesMail !== undefined) throw new Error(options.refusesMail);
			return {
				address,
				host: "imap.fastmail.com",
				port: 993,
				found: "the provider publishes it",
				appPasswords: "https://app.fastmail.com/settings/security/devicekeys",
				closed: undefined,
				bridge: false,
				outgoing: { host: "smtp.fastmail.com", port: 465 },
			};
		},
		connectMail: async (agentId: string, password: string) => {
			connected.push([agentId, password]);
			posted = { ...posted, mailbox: "desk@squad.dev", host: "imap.fastmail.com" };
			return "desk@squad.dev";
		},
		setCarrier: async (spec: CarrierSpec | undefined) => {
			carried.push(spec);
			// Which key pays for it is the carrier's own business and not something the console sends,
			// so the plane answers it back — and so does this, or the key row would never appear.
			const keyEnv = spec === undefined ? undefined : CARRIERS[spec.carrier]?.keyEnv;
			const held = keyEnv === undefined || given.some(([env]) => env === keyEnv);
			posted = {
				...posted,
				carrier: spec?.carrier ?? "",
				domain: spec?.domain ?? "",
				keyEnv,
				held,
				writes: posted.mailbox !== undefined && held,
			};
		},
		forgetMail: async () => {
			unmailed.push(posted.mailbox ?? "");
			posted = NO_MAIL;
		},
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
		aimed,
		shelved,
		handed,
		unshelved,
		opened,
		closed,
		offered,
		connected,
		carried,
		unmailed,
		built: (id: string) => finish(listed(id)),
		/** The plane is what says an agent is thinking, so the console is told the way it tells it. */
		thinking: (id: string) => feed({ kind: "thinking", agentId: id }),
		said: (id: string, said: Utterance) => feed({ kind: "said", agentId: id, said }),
		broke: (why: string) => fail(new Error(why)),
	};
}

/**
 * What the panel beside the column is showing, which is what its title row says.
 *
 * The title row is the first the two boxes share, so it is the first line with both their borders
 * on it. Read off the screen rather than off the state, because which screen a key opens is exactly
 * what these tests are about.
 */
const showing = (screen: string): string => {
	const row = screen.split("\n").find((line) => line.includes("││")) ?? "";
	// What the row says at its left end, which is the title. The numbers at its right end are the
	// selected agent's, and they are somebody else's test.
	return (
		bare(row.split("││")[1] ?? "")
			.trim()
			.split(/\s{2,}/)[0] ?? ""
	).trim();
};

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
			expect(showing(console_.screen())).toBe("new agent");
		} finally {
			console_.close();
		}
	});

	// The whole of moving around here, in one key: the column is one list, tab walks it, and the row
	// that makes an agent is the row after the last one. There is nothing else to know to get there.
	it("walks the column on tab, from the plane's rows down to the row that makes an agent", async () => {
		const { client, asked } = plane();
		const console_ = open(client, [listed("demo"), listed("maxi")]);
		try {
			expect(showing(console_.screen())).toBe("demo");

			await console_.press(TAB);
			expect(showing(console_.screen())).toBe("maxi");

			await console_.press(TAB);
			expect(showing(console_.screen())).toBe("new agent");

			await console_.press("scout", ENTER);

			expect(asked).toEqual(["scout"]);
		} finally {
			console_.close();
		}
	});

	/**
	 * The feed and the config screen were panels of an agent, and neither is about an agent: the feed
	 * is the plane's one stream and the screen is the plane's keys. They stand at the foot of the
	 * column now, and the same key reaches them.
	 */
	it("carries on past the last row into the plane's own two", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(TAB);
			expect(showing(console_.screen())).toBe("new agent");

			await console_.press(TAB);
			expect(showing(console_.screen())).toBe("logs");

			await console_.press(TAB);
			expect(showing(console_.screen())).toBe("config");

			await console_.press(TAB);
			expect(showing(console_.screen())).toBe("demo");
		} finally {
			console_.close();
		}
	});

	/** The way back up the column, which is what shift with this key is everywhere else. */
	it("walks the other way with shift held", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(SHIFT_TAB);

			expect(showing(console_.screen())).toBe("config");
		} finally {
			console_.close();
		}
	});

	/**
	 * Up and down, which is what a list answers to on every screen that draws one.
	 *
	 * The whole column, not the agents alone: carrying on down past the row that makes one has to
	 * reach the feed and the config screen, or those two are reachable only by a key nobody was
	 * already pressing to get anywhere else on this screen.
	 */
	it("walks the whole column on up and down, past the row that makes an agent", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo"), listed("maxi")]);
		try {
			await console_.press(DOWN);
			expect(showing(console_.screen())).toBe("maxi");

			await console_.press(DOWN);
			expect(showing(console_.screen())).toBe("new agent");

			await console_.press(DOWN);
			expect(showing(console_.screen())).toBe("logs");

			await console_.press(DOWN);
			expect(showing(console_.screen())).toBe("config");
		} finally {
			console_.close();
		}
	});

	/** The way back is the same key, so nothing reached with these two is a room without a door. */
	it("comes back up the column the way it went down", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(DOWN);
			await console_.press(DOWN);
			expect(showing(console_.screen())).toBe("logs");

			await console_.press(UP);
			expect(showing(console_.screen())).toBe("new agent");

			await console_.press(UP);
			expect(showing(console_.screen())).toBe("demo");
		} finally {
			console_.close();
		}
	});

	/**
	 * The config screen draws a list of its own, and arriving beside it is not the same as being in
	 * it: the walk down the column ends on the row that opens the screen, and the key that got there
	 * still walks the column until something says to hand it over.
	 */
	it("leaves the arrows on the column when the walk down reaches the config screen", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(SHIFT_TAB);
			expect(showing(console_.screen())).toBe("config");

			await console_.press(DOWN);
			await console_.press(DOWN);

			expect(showing(console_.screen())).toBe("config");
			expect(console_.screen()).toContain("↑↓ moves");
		} finally {
			console_.close();
		}
	});

	/** And back up the column from there, because nothing on the way down took the key. */
	it("steps off the config screen on the key that arrived at it", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(SHIFT_TAB);
			expect(showing(console_.screen())).toBe("config");

			await console_.press(UP);

			expect(showing(console_.screen())).toBe("logs");
		} finally {
			console_.close();
		}
	});

	/** Said in the column itself, because the row at the foot of the screen is not where it is asked. */
	it("says in the column which key walks it", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press();

			expect(console_.screen()).toContain("↑↓ moves");
		} finally {
			console_.close();
		}
	});

	/**
	 * Once the config screen's list has been handed the arrows they are its until it runs out, so the
	 * column names the key that answers there whatever row the cursor is on.
	 */
	it("names tab in the column once the arrows belong to the screen beside it", async () => {
		const { client } = plane();
		const console_ = open(client, [listed("demo")]);
		try {
			await console_.press(SHIFT_TAB);
			await console_.press(RIGHT);

			expect(showing(console_.screen())).toBe("config");
			expect(console_.screen()).toContain("tab moves");
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
			expect(showing(console_.screen())).toBe("scout");
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
			await console_.press(TAB);
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
			expect(showing(console_.screen())).toBe("new agent");
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
			await console_.press(TAB);
			expect(showing(console_.screen())).toBe("new agent");

			await console_.press(SHIFT_TAB);

			expect(showing(console_.screen())).toBe("demo");
			expect(console_.screen()).toContain("! shell");
		} finally {
			console_.close();
		}
	});
});

/**
 * The prompt, walked back through and taken back from.
 *
 * Left and right rather than up and down, which cost the prompt nothing: this one takes no cursor,
 * so there was never a line to walk along with them, and up and down went to the agents, which are
 * the list this screen actually draws. Left is older because left is back.
 */
describe("the prompt, walked back through", () => {
	const spoke = (agentId: string, ...lines: string[]): Talk =>
		new Map([[agentId, lines.map((text) => ({ from: "operator" as const, text }))]]);

	it("puts the last line back in the prompt on a left arrow", async () => {
		const { client } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")], spoke("demo", "hola", "que hora es"));
		try {
			await console_.press(LEFT);

			expect(console_.screen()).toContain("> que hora es");
		} finally {
			console_.close();
		}
	});

	it("keeps going back, and stops on the oldest", async () => {
		const { client } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo")], spoke("demo", "hola", "que hora es"));
		try {
			await console_.press(LEFT);
			await console_.press(LEFT);
			await console_.press(LEFT);

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
			await console_.press(LEFT);
			expect(console_.screen()).toContain("> hola");

			await console_.press(RIGHT);

			expect(console_.screen()).toContain("> medio escr");
		} finally {
			console_.close();
		}
	});

	/** And the agents stay put while it happens: the two walks are different keys and different lists. */
	it("leaves the agent where it is while the line is walked back", async () => {
		const { client } = plane({ has: [listed("demo")] });
		const console_ = open(client, [listed("demo"), listed("maxi")], spoke("demo", "hola"));
		try {
			await console_.press(LEFT);

			expect(console_.screen()).toContain("> hola");
			expect(showing(console_.screen())).toBe("demo");
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
			expect(showing(console_.screen())).toBe("demo");
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
 * The names were only ever written down on the config screen, two panes away, so moving an agent was
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
 * The second way into the config screen: typed, from wherever the hand already is.
 *
 * The first way is the column, and it is two moves — down to the last row, then into the section. The
 * word is one, and it is the same word every other console spells the same way. Only true as
 * keystrokes: what makes this the screen and not a command is that nothing goes down the socket.
 */
describe("/config, typed at an agent", () => {
	const chatting = () => {
		const it_ = plane({ has: [listed("demo")] });
		return { ...it_, ...open(it_.client, [listed("demo")]) };
	};

	// The whole of the confusion this has to avoid: the line is typed at `demo`, and what it opens is
	// not `demo`'s. The column is what says so, by highlighting the plane's row instead of the agent's.
	it("opens the plane's screen rather than answering in the agent's conversation", async () => {
		const screen = chatting();
		try {
			await screen.press("/config");
			await screen.press(ENTER);

			expect(showing(screen.screen())).toBe("config");
			expect(screen.screen()).toContain("⏎ open");
			expect(screen.commanded).toEqual([]);
		} finally {
			screen.close();
		}
	});

	// The point of taking an argument at all: the column walk and the section list are both skipped,
	// and one line gets from talking to an agent to the mailbox every agent is reached at.
	it("lands inside the section it names, past the list of them", async () => {
		const screen = chatting();
		try {
			await screen.press("/config email");
			await screen.press(ENTER);

			expect(showing(screen.screen())).toBe("config");
			expect(screen.screen()).toContain("mailbox");
			expect(screen.screen()).not.toContain("⏎ open");
		} finally {
			screen.close();
		}
	});

	// With the sections spelled out on the row, because that is what makes the argument typeable on the
	// first go: a word you have to open the screen to learn is a word the menu might as well not take.
	it("offers it in the menu under a slash, with the sections it takes", async () => {
		const screen = chatting();
		try {
			await screen.press("/co");

			expect(screen.screen()).toContain("/config [models|search|grants|mcp|email]");
		} finally {
			screen.close();
		}
	});

	// A typo is left to go down rather than swallowed. The console can only act on a word it knows, and
	// silently opening the list on the wrong one reads as a command that worked and landed elsewhere.
	it("sends a word that is not a section to the plane, and stays where it was", async () => {
		const screen = chatting();
		try {
			await screen.press("/config emial");
			await screen.press(ENTER);

			expect(screen.commanded).toEqual(["/config emial"]);
			expect(showing(screen.screen())).toBe("demo");
		} finally {
			screen.close();
		}
	});

	// The prompt is the sandbox's in shell mode, where a slash starts a path: `/config` is a directory
	// that may well exist, and taking it for the screen would be the mode not holding.
	it("is a path and not a screen at a shell prompt", async () => {
		const screen = chatting();
		try {
			await screen.press("!");
			await screen.press("/config");
			await screen.press(ENTER);

			expect(screen.shelled).toEqual(["/config"]);
			expect(showing(screen.screen())).toBe("demo");
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
describe("the config screen, pressed at", () => {
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

	/** Opens the console and tabs to the config screen, which is where every one of these starts. */
	async function config(options: Parameters<typeof plane>[0] = { pays, thinks }) {
		const it_ = plane(options);
		const console_ = open(it_.client, [listed("demo")]);
		// Up rather than down: the screen is the last row of the column, so from the first agent it is
		// one press back, and a walk through every agent the plane has the other way.
		await console_.press(SHIFT_TAB);
		return { ...it_, ...console_ };
	}

	/**
	 * The same, with the arrows handed to the screen's own list.
	 *
	 * Arriving is not entering: the column keeps them until a key says otherwise, so every one of
	 * these starts with the press that says it.
	 */
	async function sections(options: Parameters<typeof plane>[0] = { pays, thinks }) {
		const screen = await config(options);
		await screen.press(RIGHT);
		return screen;
	}

	/** The same, with the models section already open, which is where most of these start. */
	async function models(options: Parameters<typeof plane>[0] = { pays, thinks }) {
		const screen = await sections(options);
		await screen.press(ENTER);
		return screen;
	}

	it("is a row of the column, and opens on what there is to set", async () => {
		const screen = await config();
		try {
			expect(screen.screen()).toContain("models");
			expect(screen.screen()).toContain("search");
			expect(screen.screen()).toContain("⏎ open");
		} finally {
			screen.close();
		}
	});

	it("opens a section on return, with what the plane could pay for on it", async () => {
		const screen = await models();
		try {
			expect(screen.screen()).toContain("DEEPSEEK_API_KEY");
			expect(screen.screen()).toContain("flash");
			expect(screen.screen()).toContain("⏎ set key");
		} finally {
			screen.close();
		}
	});

	// The way back is the way in: escape leaves the section, and the cursor is left on the row that
	// opened it rather than at the top of a list it has already walked past.
	it("goes back to the sections on escape, standing on the one it left", async () => {
		const screen = await models();
		try {
			await screen.press(ESCAPE);
			expect(screen.screen()).toContain("⏎ open");

			await screen.press(DOWN);
			await screen.press(ENTER);

			expect(screen.screen()).toContain("OPENAI_API_KEY");
			expect(screen.screen()).toContain("gpt-5-mini");
		} finally {
			screen.close();
		}
	});

	// Left is back, which is what left is in every column of lists. It matters more than a second way
	// of doing something usually would: a hand that walked in on the arrows never lets go of them, and
	// escape is across the keyboard from where that hand is.
	it("goes back to the sections on a left arrow, standing on the one it left", async () => {
		const screen = await models();
		try {
			await screen.press(LEFT);
			expect(screen.screen()).toContain("⏎ open");

			await screen.press(DOWN);
			await screen.press(ENTER);

			expect(screen.screen()).toContain("OPENAI_API_KEY");
		} finally {
			screen.close();
		}
	});

	// Deep in a section the arrows belong to that section's list, and left has to reach past however
	// far down it the cursor has walked — otherwise it is a way back that stops working where it is
	// most wanted.
	it("goes back from any row of a section, not only its first", async () => {
		const screen = await models();
		try {
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(LEFT);

			expect(screen.screen()).toContain("⏎ open");
		} finally {
			screen.close();
		}
	});

	// Both keys, because both are named on the row at the foot: a hand on the arrows walks across and
	// a hand that reads the row presses return, and neither should find the other one's key.
	it("hands the arrows to its own list on a return as well as on a right arrow", async () => {
		const screen = await config();
		try {
			expect(screen.screen()).toContain("↑↓ moves");

			await screen.press(ENTER);
			expect(screen.screen()).toContain("tab moves");

			// Standing on the first section rather than in it: the press that entered the list is not
			// also the press that opens what it is standing on.
			expect(screen.screen()).toContain("⏎ open");
		} finally {
			screen.close();
		}
	});

	// One level further out than a section, and the same key does it: the list of sections was itself
	// entered, so left leaves it and the column has the arrows again.
	it("gives the arrows back to the column on a left arrow at the list of sections", async () => {
		const screen = await sections();
		try {
			expect(screen.screen()).toContain("tab moves");

			await screen.press(LEFT);

			expect(showing(screen.screen())).toBe("config");
			expect(screen.screen()).toContain("↑↓ moves");
		} finally {
			screen.close();
		}
	});

	// Nothing left to leave: the column is already what is being walked, and a left that stepped off
	// the screen would be the arrows meaning somewhere else on the row they were pressed.
	it("does nothing on a left arrow once the column has them back", async () => {
		const screen = await config();
		try {
			await screen.press(LEFT);

			expect(showing(screen.screen())).toBe("config");
			expect(screen.screen()).toContain("⏎ open");
		} finally {
			screen.close();
		}
	});

	// Both named, because a hand coming out of a text box reaches for escape and a hand on the arrows
	// reaches for left, and a key that works and is not written down is a key nobody presses.
	it("names both ways back on the row that says what the keys do", async () => {
		const screen = await models();
		try {
			expect(screen.screen()).toContain("← esc back");
		} finally {
			screen.close();
		}
	});

	// The other half of the same idea: with right going in, the four arrows are the whole of moving
	// about this screen — two for the list you are on, two for which list that is.
	it("opens the section under the cursor on a right arrow", async () => {
		const screen = await sections();
		try {
			expect(screen.screen()).toContain("→ ⏎ open");

			await screen.press(RIGHT);
			expect(screen.screen()).toContain("DEEPSEEK_API_KEY");

			await screen.press(LEFT);
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(RIGHT);

			expect(screen.screen()).toContain("+ a host");
		} finally {
			screen.close();
		}
	});

	// Right does not stand in for return once a section is open. The rows in there open a box to type
	// a key into or a question to answer, and an arrow that sometimes opened a text box is an arrow
	// nobody presses freely — which would cost the three that only ever move.
	it("does nothing on a right arrow inside a section", async () => {
		const screen = await models();
		try {
			await screen.press(RIGHT);

			expect(screen.screen()).not.toContain("key for");
			expect(screen.screen()).toContain("⏎ set key");
		} finally {
			screen.close();
		}
	});

	// The same walk backwards, on the key that walks the list: one press per level, and the press
	// after the last one steps off the screen entirely.
	it("walks up out of a section before it walks off the screen", async () => {
		const screen = await models();
		try {
			await screen.press(DOWN);
			await screen.press(UP);
			await screen.press(UP);
			expect(screen.screen()).toContain("⏎ open");

			await screen.press(UP);
			expect(showing(screen.screen())).toBe("config");
			expect(screen.screen()).toContain("↑↓ moves");

			await screen.press(UP);
			expect(showing(screen.screen())).toBe("logs");
		} finally {
			screen.close();
		}
	});

	// A row of marks cannot say where a key came from, and that is the difference between changing it
	// here and going to look for the `.env` the plane was started with.
	it("says of the row it is standing on where that key came from", async () => {
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
		try {
			await screen.press(ENTER);
			await screen.press("sk-/limit!ls");

			expect(screen.screen()).not.toContain("/limit ");
			expect(screen.screen()).not.toContain("! shell");

			await screen.press(ESCAPE);
			await screen.press(TAB);

			expect(showing(screen.screen())).toBe("demo");
			expect(screen.screen()).not.toContain("sk-");
			expect(screen.screen()).not.toContain("ls");
		} finally {
			screen.close();
		}
	});

	/** The arrows walk one list, so the row after the last key is the first model and not nothing. */
	it("carries on into the models the keys are for", async () => {
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models({
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

	/** Opens the config screen with the cursor already on the row that adds a model, and enters it. */
	async function offering(options: Parameters<typeof plane>[0] = { pays, thinks, sells }) {
		const screen = await models(options);
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
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
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
		const screen = await models();
		try {
			for (const _ of pays) await screen.press(DOWN);
			await screen.press(BACKSPACE);

			expect(screen.screen()).toContain("drop it there");
			expect(screen.screen()).not.toContain("y drop");
		} finally {
			screen.close();
		}
	});

	/**
	 * The section that decides where an agent's one route to the web goes.
	 *
	 * All three of its rows are the plane's own answer read back: the console sends a name off a
	 * table and the plane fills in the model, the endpoint and what a search will cost.
	 */
	describe("the search section", () => {
		/** Opens the config screen with the search section already open, which is the second row. */
		async function searching(options: Parameters<typeof plane>[0] = { pays, thinks }) {
			const screen = await sections(options);
			await screen.press(DOWN);
			await screen.press(ENTER);
			return screen;
		}

		it("says where searching goes, and what it is driving", async () => {
			const screen = await searching();
			try {
				expect(screen.screen()).toContain("openai");
				expect(screen.screen()).toContain("gpt-5-mini");
				expect(screen.screen()).toContain("OPENAI_API_KEY");
			} finally {
				screen.close();
			}
		});

		// The whole of pointing it somewhere else: a list of the providers that will search, and the
		// one the arrows are on. Nothing is typed, because there is nothing here to spell wrong.
		it("points the search at another provider, off a list of them", async () => {
			const screen = await searching();
			try {
				await screen.press(ENTER);
				expect(screen.screen()).toContain("perplexity");

				await screen.press(DOWN);
				await screen.press(ENTER);

				expect(screen.aimed).toEqual([{ provider: "perplexity" }]);
				// The model came from the plane, not from here: naming a provider alone is naming its first.
				expect(screen.screen()).toContain("sonar");
				expect(screen.screen()).toContain("PERPLEXITY_API_KEY");
			} finally {
				screen.close();
			}
		});

		it("changes which model of that provider does the searching", async () => {
			const screen = await searching();
			try {
				await screen.press(DOWN);
				await screen.press(ENTER);
				await screen.press(DOWN);
				await screen.press(ENTER);

				expect(screen.aimed).toEqual([{ provider: "openai", model: "gpt-5" }]);
			} finally {
				screen.close();
			}
		});

		it("leaves the search where it was when the list is escaped", async () => {
			const screen = await searching();
			try {
				await screen.press(ENTER);
				await screen.press(DOWN);
				await screen.press(ESCAPE);

				expect(screen.aimed).toEqual([]);
				expect(screen.screen()).toContain("openai");
			} finally {
				screen.close();
			}
		});

		// The key that pays for it is taken here rather than on a screen two sections away, and taken
		// the way every key on this screen is: never a character of it on a terminal with scrollback.
		it("takes the key the searching is paid with, without showing it", async () => {
			const screen = await searching();
			try {
				await screen.press(DOWN);
				await screen.press(DOWN);
				await screen.press(ENTER);

				expect(screen.screen()).toContain("key for OPENAI_API_KEY");

				await screen.press("sk-searching");
				expect(screen.screen()).not.toContain("sk-searching");

				await screen.press(ENTER);
				expect(screen.given).toEqual([["OPENAI_API_KEY", "sk-searching"]]);
			} finally {
				screen.close();
			}
		});
	});

	/**
	 * The shelf, which is the plane's and not any one agent's.
	 *
	 * What cannot be drawn is that a URL typed here lands on the shelf and nowhere else: the pane one
	 * `tab` away is a chat, and a half-written server falling into it would be said to an agent.
	 */
	/**
	 * The section that exists so nobody has to open the config file to let an agent reach a host.
	 *
	 * One box, one word: what is typed here becomes reach and nothing else, so there is no id to
	 * invent, no method to pick, and nowhere for a key to go in.
	 */
	describe("the grants section", () => {
		/** Opens the config screen with the grants already open, which is the third row. */
		async function reached(options: Parameters<typeof plane>[0] = { pays, thinks }) {
			const screen = await sections(options);
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(ENTER);
			return screen;
		}

		it("opens on the row that adds one, when nothing was opened here yet", async () => {
			const screen = await reached();
			try {
				expect(screen.screen()).toContain("+ a host");
			} finally {
				screen.close();
			}
		});

		it("opens a host on one word and nothing else", async () => {
			const screen = await reached();
			try {
				await screen.press(ENTER);
				await screen.press("api.chess.com");
				expect(screen.screen()).toContain("api.chess.com");

				await screen.press(ENTER);
				expect(screen.opened).toEqual(["api.chess.com"]);
			} finally {
				screen.close();
			}
		});

		/**
		 * Sent as it was typed, URL and all, because the plane is where a host is read out of a line —
		 * the console checking first would be a second answer to get right before the first one works.
		 */
		it("hands the line to the plane rather than reading it here", async () => {
			const screen = await reached();
			try {
				await screen.press(ENTER);
				await screen.press("https://api.chess.com/pub/player/x");
				await screen.press(ENTER);

				expect(screen.opened).toEqual(["https://api.chess.com/pub/player/x"]);
			} finally {
				screen.close();
			}
		});

		it("says what was wrong with a line rather than leaving the box empty", async () => {
			const screen = await reached({
				pays,
				thinks,
				refusesGrant: '"api.chess.com and the rest" is more than one word — a host is one',
			});
			try {
				await screen.press(ENTER);
				await screen.press("api.chess.com and the rest");
				await screen.press(ENTER);

				expect(screen.screen()).toContain("more than one word");
			} finally {
				screen.close();
			}
		});

		it("gives up on a host without opening it", async () => {
			const screen = await reached();
			try {
				await screen.press(ENTER);
				await screen.press("api.chess.com");
				await screen.press(ESCAPE);

				expect(screen.opened).toEqual([]);
			} finally {
				screen.close();
			}
		});

		// The plane refuses what the file already grants, and the console says so where it was typed
		// rather than writing a second row that changes nothing.
		it("says why the plane would not open it", async () => {
			const screen = await reached({
				pays,
				thinks,
				refusesGrant: '"api.chess.com" is already open, from the config file',
			});
			try {
				await screen.press(ENTER);
				await screen.press("api.chess.com");
				await screen.press(ENTER);

				expect(screen.screen()).toContain("already open");
			} finally {
				screen.close();
			}
		});

		// Closing is wider than the row it is pressed on — it comes off every agent — so it is asked
		// before it happens, and answered by one key the way the rest of this screen is.
		it("asks before closing a host, and closes it when the answer is yes", async () => {
			const screen = await reached({
				pays,
				thinks,
				reaches: [{ id: "reach:api.chess.com", host: "api.chess.com", origin: "here" }],
			});
			try {
				await screen.press(BACKSPACE);
				expect(screen.screen()).toContain("y close");
				expect(screen.closed).toEqual([]);

				await screen.press("y");
				expect(screen.closed).toEqual(["api.chess.com"]);
			} finally {
				screen.close();
			}
		});

		it("keeps a host when the answer is anything else", async () => {
			const screen = await reached({
				pays,
				thinks,
				reaches: [{ id: "reach:api.chess.com", host: "api.chess.com", origin: "here" }],
			});
			try {
				await screen.press(BACKSPACE);
				await screen.press(ENTER);

				expect(screen.closed).toEqual([]);
			} finally {
				screen.close();
			}
		});

		/**
		 * Three of the four lists on this screen are not this console's to take back, and the refusal
		 * arrives on the key rather than after a question — a `y` that then did nothing would be worse
		 * than a key that says where the row is actually changed.
		 */
		it("refuses to close what another list decides, and says which", async () => {
			const screen = await reached({
				pays,
				thinks,
				reaches: [
					{ id: "github", host: "api.github.com", origin: "file", carries: "GITHUB_TOKEN" },
					{ id: "model:mini", host: "api.openai.com", origin: "model" },
				],
			});
			try {
				await screen.press(BACKSPACE);
				expect(screen.screen()).toContain("is the file's — close it there");
				expect(screen.closed).toEqual([]);

				await screen.press(DOWN);
				await screen.press(BACKSPACE);
				expect(screen.screen()).toContain("a model brings it");
				expect(screen.closed).toEqual([]);
			} finally {
				screen.close();
			}
		});
	});

	describe("the mcp section", () => {
		const shelf = [
			{
				name: "linear",
				server: { transport: "http" as const, url: "https://mcp.linear.app/mcp" },
				agents: ["demo"],
				loggedIn: false,
			},
		];

		/** Opens the config screen with the shelf already open, which is the fourth row. */
		async function shelved(options: Parameters<typeof plane>[0] = { pays, thinks, shelf }) {
			const screen = await sections(options);
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(ENTER);
			return screen;
		}

		it("lists the shelf, and the row that puts something on it", async () => {
			const screen = await shelved();
			try {
				expect(screen.screen()).toContain("linear");
				expect(screen.screen()).toContain("+ a server");
			} finally {
				screen.close();
			}
		});

		// The same grammar `/mcp add` takes, because a second way of writing down a server would be a
		// second thing that is nearly right.
		it("takes a server written out as a name and a URL", async () => {
			const screen = await shelved({ pays, thinks, shelf: [] });
			try {
				await screen.press(ENTER);
				await screen.press("linear https://mcp.linear.app/mcp");
				expect(screen.screen()).toContain("mcp.linear.app");

				await screen.press(ENTER);
				expect(screen.shelved).toEqual([
					["linear", { transport: "http", url: "https://mcp.linear.app/mcp" }],
				]);
			} finally {
				screen.close();
			}
		});

		// Anything that is not a URL is the command to start it with, which is the whole of how the two
		// are told apart — there is no keyword to remember and no field to put it in.
		it("reads a line that is not a URL as the command an agent runs", async () => {
			const screen = await shelved({ pays, thinks, shelf: [] });
			try {
				await screen.press(ENTER);
				await screen.press("files mcp-files /home/agent");
				await screen.press(ENTER);

				expect(screen.shelved).toEqual([
					["files", { transport: "stdio", command: "mcp-files", args: ["/home/agent"] }],
				]);
			} finally {
				screen.close();
			}
		});

		it("says what was wrong with a line rather than putting it on the shelf", async () => {
			const screen = await shelved({ pays, thinks, shelf: [] });
			try {
				await screen.press(ENTER);
				await screen.press("Linear https://mcp.linear.app/mcp");
				await screen.press(ENTER);

				expect(screen.shelved).toEqual([]);
				expect(screen.screen()).toContain("is not a name");
			} finally {
				screen.close();
			}
		});

		it("gives up on a server without putting it anywhere", async () => {
			const screen = await shelved({ pays, thinks, shelf: [] });
			try {
				await screen.press(ENTER);
				await screen.press("linear https://mcp.linear.app/mcp");
				await screen.press(ESCAPE);

				expect(screen.shelved).toEqual([]);
			} finally {
				screen.close();
			}
		});

		// Toggling, because the same row means both: an agent that already has it says so, and return
		// on that row is how it stops having it.
		it("gives one off the shelf to an agent, and takes it back", async () => {
			const screen = await shelved();
			try {
				await screen.press(ENTER);
				expect(screen.screen()).toContain("has it");

				await screen.press(ENTER);
				expect(screen.handed).toEqual([["demo", "linear", false]]);
			} finally {
				screen.close();
			}
		});

		// Wider than the row it is pressed on, so it is asked before it happens — and answered by one
		// key, the way every other question on this screen is.
		it("asks before forgetting a server, and forgets it when the answer is yes", async () => {
			const screen = await shelved();
			try {
				await screen.press(BACKSPACE);
				expect(screen.screen()).toContain("y forget");
				expect(screen.unshelved).toEqual([]);

				await screen.press("y");
				expect(screen.unshelved).toEqual(["linear"]);
			} finally {
				screen.close();
			}
		});

		it("keeps a server when the answer is anything else", async () => {
			const screen = await shelved();
			try {
				await screen.press(BACKSPACE);
				await screen.press(ENTER);

				expect(screen.unshelved).toEqual([]);
			} finally {
				screen.close();
			}
		});
	});

	/**
	 * The mailbox, and whoever carries what the agents write back.
	 *
	 * The half that cannot be drawn is the app password: it is typed here and it opens the whole
	 * account, so what has to be true is that no branch below this one ever sees it — a `/` in it is
	 * not a command, and the pane one `tab` away must never receive a character of it.
	 */
	describe("the email section", () => {
		const reading: MailStanding = {
			...NO_MAIL,
			mailbox: "desk@squad.dev",
			host: "imap.fastmail.com",
			writes: true,
		};

		/** Opens the config screen with the mail already open, which is the last row. */
		async function mailed(posts: MailStanding = reading, refusesMail?: string) {
			const screen = await sections({
				pays,
				thinks,
				posts,
				...(refusesMail !== undefined ? { refusesMail } : {}),
			});
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(DOWN);
			await screen.press(ENTER);
			return screen;
		}

		it("shows the mailbox and who takes the mail out", async () => {
			const screen = await mailed();
			try {
				expect(screen.screen()).toContain("desk@squad.dev");
				expect(screen.screen()).toContain("carrier");
				expect(screen.screen()).toContain("the mailbox's own server");
			} finally {
				screen.close();
			}
		});

		// Two lines and a round trip between them, because what the address turns out to be is what
		// decides whether asking for a password is worth anybody's time.
		it("takes an address, then the password, and never draws the password back", async () => {
			const screen = await mailed(NO_MAIL);
			try {
				expect(screen.screen()).toContain("nothing connected");

				await screen.press(ENTER);
				await screen.press("desk@squad.dev");
				await screen.press(ENTER);

				expect(screen.offered).toEqual(["desk@squad.dev"]);
				expect(screen.screen()).toContain("password");

				await screen.press("kwil-brac-nemo-shad");
				expect(screen.screen()).not.toContain("kwil-brac-nemo-shad");

				await screen.press(ENTER);
				expect(screen.connected).toEqual([["demo", "kwil-brac-nemo-shad"]]);
			} finally {
				screen.close();
			}
		});

		// The password arrives pasted, and the copy usually takes the newline with it. That newline is
		// the return key, so it must finish the line rather than land in the pane behind it.
		it("takes a password pasted with the newline the copy took", async () => {
			const screen = await mailed(NO_MAIL);
			try {
				await screen.press(ENTER);
				await screen.press("desk@squad.dev\n");
				await screen.press("kwil brac nemo shad\n");

				expect(screen.connected).toEqual([["demo", "kwil brac nemo shad"]]);
			} finally {
				screen.close();
			}
		});

		// Half the large providers stopped issuing app passwords. Finding that out is the whole point of
		// the round trip, so what comes back has to be said instead of a password box opening anyway.
		it("says why an address will not take a password, instead of asking for one", async () => {
			const screen = await mailed(NO_MAIL, "Google stopped issuing app passwords for this account");
			try {
				await screen.press(ENTER);
				await screen.press("desk@gmail.com");
				await screen.press(ENTER);

				expect(screen.screen()).toContain("stopped issuing app passwords");
				expect(screen.connected).toEqual([]);
			} finally {
				screen.close();
			}
		});

		// Picked, not typed: the companies that will do this are a table, and a name spelled wrong here
		// is a mailbox that reads and silently never answers.
		it("names a carrier off a list of them", async () => {
			const screen = await mailed();
			try {
				await screen.press(DOWN);
				await screen.press(ENTER);
				expect(screen.screen()).toContain("Mailgun");

				await screen.press(DOWN);
				await screen.press(ENTER);

				expect(screen.carried).toEqual([{ carrier: "mailgun", domain: "" }]);
			} finally {
				screen.close();
			}
		});

		// Mailgun will not guess, so naming it opens a row that was not there a moment ago — and the key
		// row with it, because a carrier that is not the mailbox's own server has to be paid for.
		it("asks for the domain only when the carrier will not guess it", async () => {
			const screen = await mailed();
			try {
				await screen.press(DOWN);
				await screen.press(ENTER);
				await screen.press(DOWN);
				await screen.press(ENTER);

				expect(screen.screen()).toContain("domain");
				expect(screen.screen()).toContain("MAILGUN_API_KEY");

				await screen.press(DOWN);
				await screen.press(ENTER);
				await screen.press("squad.dev");
				await screen.press(ENTER);

				expect(screen.carried).toEqual([
					{ carrier: "mailgun", domain: "" },
					{ carrier: "mailgun", domain: "squad.dev" },
				]);
			} finally {
				screen.close();
			}
		});

		it("leaves the carrier where it was when the list is escaped", async () => {
			const screen = await mailed();
			try {
				await screen.press(DOWN);
				await screen.press(ENTER);
				await screen.press(DOWN);
				await screen.press(ESCAPE);

				expect(screen.carried).toEqual([]);
			} finally {
				screen.close();
			}
		});

		// The key is taken on the screen the carrier was named on, and taken the way every key here is.
		it("takes the key the carrier is paid with, without showing it", async () => {
			const screen = await mailed({ ...reading, carrier: "resend", keyEnv: "RESEND_API_KEY" });
			try {
				await screen.press(DOWN);
				await screen.press(DOWN);
				await screen.press(ENTER);

				expect(screen.screen()).toContain("key for RESEND_API_KEY");

				await screen.press("re-carrying");
				expect(screen.screen()).not.toContain("re-carrying");

				await screen.press(ENTER);
				expect(screen.given).toEqual([["RESEND_API_KEY", "re-carrying"]]);
			} finally {
				screen.close();
			}
		});

		// Wider than the row: every agent stops being reachable, so it is asked before it happens and
		// answered by one key — and the address is not retyped to prove anything.
		it("asks before forgetting the mailbox, and forgets it when the answer is yes", async () => {
			const screen = await mailed();
			try {
				await screen.press(BACKSPACE);
				expect(screen.screen()).toContain("forget the mailbox at desk@squad.dev");
				expect(screen.screen()).toContain("y forget");
				expect(screen.unmailed).toEqual([]);

				await screen.press("y");
				expect(screen.unmailed).toEqual(["desk@squad.dev"]);
			} finally {
				screen.close();
			}
		});

		it("keeps the mailbox when the answer is anything else", async () => {
			const screen = await mailed();
			try {
				await screen.press(BACKSPACE);
				await screen.press(ENTER);

				expect(screen.unmailed).toEqual([]);
			} finally {
				screen.close();
			}
		});

		// A second address over the first is not a change, it is a disconnection and a connection. The
		// row says so rather than quietly opening a box that would half-replace the account.
		it("will not type a second address over a connected one", async () => {
			const screen = await mailed();
			try {
				await screen.press(ENTER);

				expect(screen.offered).toEqual([]);
				expect(screen.screen()).toContain("⌫ disconnects it");
			} finally {
				screen.close();
			}
		});
	});
});
