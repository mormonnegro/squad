import { describe, expect, it } from "vitest";
import {
	agentMayNot,
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
	type TelegramStanding,
	withoutSecrets,
} from "../src/commands.ts";
import type { McpServer } from "../src/mcp.ts";
import type { Model } from "../src/models.ts";
import type { Served } from "../src/ports.ts";

/** Where a started login says it is listening, which is the address a paste has to come back to. */
const WAITING_AT = "http://localhost:54321/callback";

/** A context that remembers what was asked of it, which is the half a string cannot show. */
function context(
	start: {
		spentUsd?: number;
		limitUsd?: number;
		/** Hosts the operator granted. Nothing a command does can add to this, which is the point. */
		grants?: readonly string[];
		/** Servers already on the shelf, as another agent's `/mcp add` would have left them. */
		shelf?: Record<string, McpServer>;
		/** What a server says when asked whether it wants an account. Open unless said otherwise. */
		wantsAccount?: readonly string[];
		/** Servers the plane already holds a login for. */
		loggedIn?: readonly string[];
		/** Which agent the line is being typed at, since `/delete` asks for that name back. */
		agentId?: string;
		/** Made at a keyboard rather than declared, which decides whether deleting it is the last of it. */
		created?: boolean;
		/** The models the operator configured, which is the whole of what `/model` may choose from. */
		models?: readonly Model[];
		/** The one this agent is on, by whatever name the plane knows it under. */
		using?: string;
		/** Models the plane holds no key for: configured, and still not something to think with. */
		keyless?: readonly string[];
		/** Ports this agent already has open, as an earlier `/serve` would have left them. */
		serving?: readonly Served[];
		/** Where another agent already comes out, which is what makes a number give way. */
		takenBy?: ReadonlyMap<number, string>;
		/** Ports something is actually listening on inside the sandbox. */
		bound?: readonly number[];
		/** The bot this agent already answers on, as an earlier `/telegram <token>` would have left it. */
		bot?: TelegramStanding;
		/** What Telegram says about a token it will not have, which the command has to pass on. */
		refuses?: string;
	} = {},
) {
	const state = { spentUsd: start.spentUsd ?? 0, limitUsd: start.limitUsd };
	const set: (number | null)[] = [];
	const using = { id: start.using };
	/** Every move that got as far as the plane, which is what a sentence about one cannot show. */
	const moved: string[] = [];
	const shelf = new Map<string, McpServer>(Object.entries(start.shelf ?? {}));
	const held = new Set<string>();
	const logins = new Set<string>(start.loggedIn ?? []);
	const started: { name: string; clientId: string | undefined }[] = [];
	const pasted: { name: string; redirected: string }[] = [];
	/** Every deletion that got as far as the plane, which is the half no answer can show. */
	const removed: string[] = [];
	const serving = [...(start.serving ?? [])];
	const takenBy = start.takenBy ?? new Map<number, string>();
	const bot = { held: start.bot };
	/** Every token the command handed on, which is what tells a refusal apart from a typo caught early. */
	const offered: string[] = [];
	const named = (name: string) => {
		const server = shelf.get(name);
		return server === undefined ? [] : [{ name, server }];
	};
	const nameOf = (server: McpServer) =>
		[...shelf.entries()].find(([, one]) => one === server)?.[0] ?? "";
	return {
		set,
		moved,
		shelf,
		held,
		logins,
		started,
		pasted,
		removed,
		serving,
		bot,
		offered,
		context: {
			agent: { id: start.agentId ?? "scout", created: start.created ?? true },
			remove: async () => {
				removed.push(start.agentId ?? "scout");
			},
			account: async () => state,
			setLimit: async (usd: number | null) => {
				set.push(usd);
				state.limitUsd = usd ?? undefined;
			},
			models: async () => ({
				all: start.models ?? [],
				using: using.id,
				keyless: start.keyless ?? [],
			}),
			setModel: async (id: string) => {
				moved.push(id);
				using.id = id;
			},
			mcp: async () => ({
				shelf: [...shelf.keys()].flatMap(named),
				held: [...held].flatMap(named),
			}),
			served: async () => ({ mine: [...serving], theirs: takenBy }),
			serve: async (port: number) => {
				const already = serving.find((one) => one.port === port);
				if (already !== undefined) return already;
				// The same rule the store follows: a number another agent already came out on gives way.
				let at = port;
				while (takenBy.has(at) || serving.some((one) => one.at === at)) at += 1;
				const opened = { port, at };
				serving.push(opened);
				return opened;
			},
			unserve: async (port: number) => {
				const at = serving.findIndex((one) => one.port === port);
				if (at === -1) return false;
				serving.splice(at, 1);
				return true;
			},
			listening: async (port: number) => (start.bound ?? []).includes(port),
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
			reach: async (server: McpServer) =>
				(start.wantsAccount ?? []).includes(nameOf(server))
					? ({ kind: "authorize" } as const)
					: ({ kind: "open" } as const),
			loginStatus: async (name: string) =>
				logins.has(name)
					? { host: "example.test", at: "now", expiresAt: undefined, renewable: true }
					: undefined,
			login: async (name: string, clientId?: string) => {
				started.push({ name, clientId });
				return { url: `https://auth.test/authorize?for=${name}`, redirectUri: WAITING_AT };
			},
			returned: async (name: string, redirected: string) => {
				pasted.push({ name, redirected });
				logins.add(name);
			},
			logout: async (name: string) => logins.delete(name),
			telegram: async () => bot.held,
			connectTelegram: async (token: string) => {
				offered.push(token);
				if (start.refuses !== undefined) throw new Error(start.refuses);
				// What the plane does with a fresh token: a bot nobody is paired to yet, and a link to fix that.
				const standing = {
					username: "scout_test_bot",
					paired: false,
					chats: 0,
					link: "https://t.me/scout_test_bot?start=kqm3nvbh27",
					phrase: "kqm3nvbh27",
				};
				bot.held = standing;
				return standing;
			},
			disconnectTelegram: async () => {
				const had = bot.held !== undefined;
				bot.held = undefined;
				return had;
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

	/**
	 * The argument that is a name off a list, offered where the command is typed.
	 *
	 * The name was only ever written down two panes away, on a screen about keys, so moving an agent
	 * meant remembering a word or going to look it up and coming back to a prompt you had cleared.
	 */
	describe("under /model", () => {
		const standing = [
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
				id: "sonnet",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				host: "api.anthropic.com",
				keyEnv: "ANTHROPIC_API_KEY",
				added: true,
				held: false,
			},
		];
		const offered = (draft: string, using?: string) =>
			completions(draft, standing, using).map((command) => command.name);

		// Which is also the gesture: taking `/model` off the menu leaves the space behind it, so the
		// return that chose the command is the one that opens the list.
		it("offers the models once the space after the command is there", () => {
			expect(offered("/model")).toEqual(["/model"]);
			expect(offered("/model ")).toEqual(["/model flash", "/model sonnet"]);
		});

		it("narrows to what has been typed", () => {
			expect(offered("/model fla")).toEqual(["/model flash"]);
		});

		// Half of remembering a model is remembering whose it is, and the id is the half that was
		// invented here — the provider's name is the one that was not.
		it("finds one by the provider, or by the provider's own name for it", () => {
			expect(offered("/model anthropic")).toEqual(["/model sonnet"]);
			expect(offered("/model claude")).toEqual(["/model sonnet"]);
		});

		// At which point the menu is agreeing rather than offering, and a menu that agrees is a menu
		// holding on to the return that would have sent the line.
		it("closes once a name is typed in full, so the line can be sent", () => {
			expect(offered("/model sonnet")).toEqual([]);
			expect(offered("/model sonnet ")).toEqual([]);
		});

		it("offers nothing for a name off the list, rather than the whole list back", () => {
			expect(offered("/model zzz")).toEqual([]);
		});

		// The two facts about a model that are not its name, which is what makes one row worth picking
		// over another — and the one that says a row will be refused at the proxy.
		it("says whose each one is, which it is on, and which cannot be paid for", () => {
			const said = completions("/model ", standing, "flash").map((command) => command.does);

			expect(said[0]).toBe("deepseek/deepseek-v4-flash   (this one)");
			expect(said[1]).toBe("anthropic/claude-sonnet-4-6   (no ANTHROPIC_API_KEY)");
		});

		it("offers nothing when the plane configures no models", () => {
			expect(completions("/model ")).toEqual([]);
		});
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

/**
 * The one command that destroys something, and therefore the one whose refusals matter more than
 * what it does. Every test here that ends in `removed` being empty is a way somebody could have
 * lost an agent by typing.
 */
describe("/delete", () => {
	// The bare command is the question, not a shorter way to do the thing. Everything below depends
	// on that: if this ever deleted, the console's confirmation would be asking after the fact.
	it("asks, and deletes nothing while it is asking", async () => {
		const { context: ctx, removed } = context({ agentId: "scout" });

		const answer = await runCommand("/delete", ctx);

		expect(answer).toContain("Nothing has been deleted yet");
		expect(answer).toContain("nothing here can put it back");
		expect(removed).toEqual([]);
	});

	// The confirmation is the agent's own name, borrowed from the CLI, which asks for the same word
	// before the same thing. It is not a way to name a different agent: there is no different agent
	// a command can reach, so anything else is a mistake and is answered as one.
	it("refuses a name that is not this agent's", async () => {
		const { context: ctx, removed } = context({ agentId: "scout" });

		const answer = await runCommand("/delete maxi", ctx);

		expect(answer).toContain('"maxi" is not this agent');
		expect(removed).toEqual([]);
	});

	// The repository goes too, always. A delete that left it behind is what sent the operator back
	// here to type the same thing again, having been told the first one worked.
	it("takes the whole agent when the name comes back, and says that was the last of it", async () => {
		const { context: ctx, removed } = context({ agentId: "scout", created: true });

		const answer = await runCommand("/delete scout", ctx);

		expect(removed).toEqual(["scout"]);
		expect(answer).toContain("the last of it");
	});

	// A declared agent goes the same way as any other — an earlier version of this said it would be
	// back at the next start, which is a delete that did not delete however true the sentence was.
	// What is left to say is the one thing the operator can act on: the name is still in their file.
	it("deletes a declared agent too, and says the config still has the name", async () => {
		const { context: ctx, removed } = context({ agentId: "scout", created: false });

		const answer = await runCommand("/delete scout", ctx);

		expect(removed).toEqual(["scout"]);
		expect(answer).toContain("stays gone across restarts");
		expect(answer).toContain("Take it out of the config");
	});

	// The name is the whole of what this takes. A word after it was meant to be something, and
	// guessing which of the two things it meant is how the wrong one happens.
	it("deletes nothing on a word it does not know", async () => {
		const { context: ctx, removed } = context({ agentId: "scout" });

		const answer = await runCommand("/delete scout --purge", ctx);

		expect(answer).toContain("Only the name is");
		expect(removed).toEqual([]);
	});
});

/**
 * The one command that opens something rather than describing it, and the only one whose two halves
 * are on different machines: the plane keeps the record, and a console somewhere else is what turns
 * it into a listener. So what the answer says is mostly about where a link works and what it needs
 * before it does — an operator who reads this as "published" has been told the wrong thing.
 */
describe("/serve", () => {
	it("opens a port and gives back the address it comes out at", async () => {
		const plane = context({ agentId: "scout" });
		const said = await runCommand("/serve 3000", plane.context);

		expect(said).toContain("scout is serving 3000");
		expect(said).toContain("http://scout.localhost:3000");
		expect(plane.serving).toEqual([{ port: 3000, at: 3000 }]);
	});

	// Two agents both land on 3000 without either of them having chosen it, and the machine at the
	// other end has one 3000. The answer has to name both numbers, or the operator opens the wrong one.
	it("says whose the number was when it had to give way", async () => {
		const plane = context({ agentId: "scribe", takenBy: new Map([[3000, "scout"]]) });
		const said = await runCommand("/serve 3000", plane.context);

		expect(said).toContain("3000 is scout's here, so this one is on 3001");
		expect(said).toContain("http://scribe.localhost:3001");
	});

	// The link is opened whether or not anything is behind it, because the agent that asks for one is
	// usually about to start the server. Saying which of the two it is turns a dead link into a step.
	it("says nothing is listening in there yet, and that the link waits", async () => {
		const said = await runCommand("/serve 3000", context().context);

		expect(said).toContain("Nothing is listening on 3000 inside the sandbox yet");
		expect(said).toContain("starts working the moment something binds that port");
	});

	it("says the link has something behind it when something is bound in there", async () => {
		const said = await runCommand("/serve 3000", context({ bound: [3000] }).context);

		expect(said).toContain("Something is listening on 3000 in there");
	});

	// Nothing is published off the server and the sandbox network is as unrouted as it was. An answer
	// that left that out would read as a port on the internet, which is the opposite of what this is.
	it("says where the link works, every time it prints one", async () => {
		const opened = await runCommand("/serve 3000", context().context);
		const listed = await runCommand(
			"/serve",
			context({ serving: [{ port: 3000, at: 3000 }] }).context,
		);

		for (const said of [opened, listed]) expect(said).toContain("and from nowhere else");
	});

	it("takes a port written with the colon a person would type", async () => {
		const plane = context();
		await runCommand("/serve :8080", plane.context);
		expect(plane.serving).toEqual([{ port: 8080, at: 8080 }]);
	});

	// Refused where the sentence can explain itself, rather than at a console on somebody else's
	// machine where it would be a bind error nobody was looking at.
	it("refuses a port the console would need root for, and one that is not a port", async () => {
		const plane = context();
		expect(await runCommand("/serve 80", plane.context)).toContain("under 1024");
		expect(await runCommand("/serve nine", plane.context)).toContain("not a port");
		expect(plane.serving).toEqual([]);
	});

	// The agent that restarts its server has no way of knowing whether the last turn already asked.
	it("does not move a port that was already open", async () => {
		const plane = context({ serving: [{ port: 3000, at: 3001 }] });
		const said = await runCommand("/serve 3000", plane.context);

		expect(said).toContain("http://scout.localhost:3001");
		expect(plane.serving).toEqual([{ port: 3000, at: 3001 }]);
	});

	it("lists what is open, and how to close one", async () => {
		const plane = context({
			serving: [
				{ port: 3000, at: 3000 },
				{ port: 8080, at: 8081 },
			],
			takenBy: new Map([[8080, "scribe"]]),
		});
		const said = await runCommand("/serve", plane.context);

		expect(said).toContain("http://scout.localhost:3000");
		expect(said).toContain("http://scout.localhost:8081");
		expect(said).toContain("(8080 is scribe's here)");
		expect(said).toContain("/serve stop 3000");
	});

	it("says what it would open when nothing is open yet", async () => {
		expect(await runCommand("/serve", context().context)).toContain("scout is serving nothing");
	});

	it("closes one", async () => {
		const plane = context({ serving: [{ port: 3000, at: 3000 }] });
		const said = await runCommand("/serve stop 3000", plane.context);

		expect(said).toContain("scout is not serving 3000 any more");
		expect(plane.serving).toEqual([]);
	});

	// The two halves are in different places and only one of them just changed. An operator who read
	// this as "stopped" would go looking for a process that is exactly where they left it.
	it("says closing the way in did not stop the server behind it", async () => {
		const plane = context({ serving: [{ port: 3000, at: 3000 }] });
		const said = await runCommand("/serve stop 3000", plane.context);

		expect(said).toContain("is still listening");
	});

	it("says there was nothing to close", async () => {
		expect(await runCommand("/serve stop 3000", context().context)).toBe(
			"scout was not serving 3000.",
		);
	});

	it("asks which port when the close has none", async () => {
		expect(await runCommand("/serve stop", context().context)).toContain("Which port?");
	});
});

/**
 * A command that chooses and never grants. Every model it can name was already reachable by every
 * agent before it was typed, because configuring one is what granted it — so every test here that
 * ends in `moved` being empty is a way somebody could have thought they had switched and had not.
 */
describe("/model", () => {
	const flash: Model = {
		id: "flash",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		host: "api.deepseek.com",
		keyEnv: "DEEPSEEK_API_KEY",
	};
	const sonnet: Model = {
		id: "sonnet",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		host: "api.anthropic.com",
		keyEnv: "ANTHROPIC_API_KEY",
		header: "x-api-key",
	};
	const both = [flash, sonnet];

	it("says what this one thinks with and what else there is", async () => {
		const answer = await runCommand("/model", context({ models: both, using: "flash" }).context);

		expect(answer).toContain("thinks with flash");
		// The real name beside the nickname: an id is what the operator chose to call it, and the
		// question behind `/model` is usually which actual model is answering.
		expect(answer).toContain("deepseek/deepseek-v4-flash");
		expect(answer).toContain("anthropic/claude-sonnet-4-6");
		expect(answer).toContain("(this one)");
	});

	it("reading the list moves nothing", async () => {
		const { context: ctx, moved } = context({ models: both, using: "flash" });

		await runCommand("/model", ctx);

		expect(moved).toEqual([]);
	});

	it("says what to type to move it, with a name that would work", async () => {
		const answer = await runCommand("/model", context({ models: both, using: "flash" }).context);

		expect(answer).toContain("/model sonnet");
	});

	it("moves the agent onto another configured model", async () => {
		const { context: ctx, moved } = context({ models: both, using: "flash" });

		const answer = await runCommand("/model sonnet", ctx);

		expect(moved).toEqual(["sonnet"]);
		expect(answer).toContain("anthropic/claude-sonnet-4-6");
	});

	/**
	 * The change looks instant and is not: a turn already running was handed its model when it
	 * started, and its answer arriving afterwards reads like the switch having done nothing.
	 */
	it("says the turn in flight finishes on the old one", async () => {
		const answer = await runCommand(
			"/model sonnet",
			context({ models: both, using: "flash" }).context,
		);

		expect(answer).toContain("next turn");
		expect(answer).toContain("already running");
	});

	// The list is the operator's file read back. A name that is not on it is not something to create,
	// which is the whole reason a command may touch this at all.
	it("refuses a name nobody configured, and says the ones there are", async () => {
		const { context: ctx, moved } = context({ models: both, using: "flash" });

		const answer = await runCommand("/model opus", ctx);

		expect(answer).toContain('no model called "opus"');
		expect(answer).toContain("flash, sonnet");
		expect(moved).toEqual([]);
	});

	it("says an agent is already on the one it was asked for", async () => {
		const { context: ctx, moved } = context({ models: both, using: "flash" });

		const answer = await runCommand("/model flash", ctx);

		expect(answer).toContain("already thinks with flash");
		expect(moved).toEqual([]);
	});

	/**
	 * Configured and unusable read exactly alike until a turn dies at the proxy against a key this
	 * plane never had. Said here because here is where the answer is to paste one in and try again.
	 */
	it("marks the models this plane holds no key for", async () => {
		const answer = await runCommand(
			"/model",
			context({ models: both, using: "flash", keyless: ["sonnet"] }).context,
		);

		expect(answer).toContain("no ANTHROPIC_API_KEY");
	});

	// Done rather than refused: the operator asked for it and can export the key without touching
	// the choice again. Refusing would be this deciding what they meant.
	it("moves onto a keyless model anyway, and warns", async () => {
		const { context: ctx, moved } = context({ models: both, using: "flash", keyless: ["sonnet"] });

		const answer = await runCommand("/model sonnet", ctx);

		expect(moved).toEqual(["sonnet"]);
		expect(answer).toContain("ANTHROPIC_API_KEY");
		expect(answer).toContain("refused at the proxy");
	});

	/** The oldest configurations have no list at all, and typing this is how somebody finds out. */
	it("shows how to configure one when the plane configures none", async () => {
		const answer = await runCommand("/model", context().context);

		expect(answer).toContain("configures no models");
		expect(answer).toContain("models:");
		expect(answer).toContain("provider: anthropic");
	});

	it("names the model a hand-written config put the agent on", async () => {
		const answer = await runCommand("/model", context({ using: "claude-opus-4-7" }).context);

		expect(answer).toContain("claude-opus-4-7");
		expect(answer).toContain("by hand");
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
		expect(answer).toContain("injection: { kind: none }");
	});

	/**
	 * The whole point of asking the server rather than the operator: telling somebody to invent a
	 * bearer token for something that was about to offer them a consent screen is how they lose an
	 * afternoon in a developer portal for a credential they never needed.
	 */
	it("offers a login instead of YAML when the server says it wants an account", async () => {
		const { context: ctx } = context({ wantsAccount: ["linear"] });

		const answer = await runCommand(`/mcp add linear ${linear}`, ctx);

		expect(answer).toContain("/mcp login linear");
		expect(answer).not.toContain("host: mcp.linear.app");
	});

	it("says the plane cannot reach it either, rather than blaming the grant", async () => {
		const { context: ctx } = context();
		const unreachable = {
			...ctx,
			reach: async () => ({ kind: "unreachable", why: "getaddrinfo ENOTFOUND" }) as const,
		};

		expect(await runCommand(`/mcp add linear ${linear}`, unreachable)).toContain(
			"cannot reach mcp.linear.app either",
		);
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

		expect(await runCommand("/mcp", ctx)).toContain("(no grant)");
	});

	// The stronger of the two facts, and the only one the operator can do anything about from here.
	it("marks a logged-in one as logged in rather than as ungranted", async () => {
		const { context: ctx } = context({
			shelf: { linear: { transport: "http", url: linear } },
			loggedIn: ["linear"],
		});

		const answer = await runCommand("/mcp", ctx);

		expect(answer).toContain("(logged in)");
		expect(answer).not.toContain("(no grant)");
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

describe("/mcp login", () => {
	const linear = "https://mcp.linear.app/mcp";
	const shelf = { linear: { transport: "http", url: linear } as const };

	it("sends the operator to a page, and says where the answer is expected back", async () => {
		const { context: ctx, started } = context({ shelf });

		const answer = await runCommand("/mcp login linear", ctx);

		expect(started).toEqual([{ name: "linear", clientId: undefined }]);
		expect(answer).toContain("https://auth.test/authorize?for=linear");
		// Both halves matter: the address it is waiting at, and what to do if that page cannot reach it.
		expect(answer).toContain(WAITING_AT);
		expect(answer).toContain("/mcp login linear <address>");
	});

	/** For a server that will not register a client, where the operator made one themselves. */
	it("passes on a client id the operator has in hand", async () => {
		const { context: ctx, started } = context({ shelf });

		await runCommand("/mcp login linear abc123", ctx);

		expect(started).toEqual([{ name: "linear", clientId: "abc123" }]);
	});

	/**
	 * One word for both halves, because it is one thing to the person doing it: the second argument is
	 * whatever they have in hand, and an address bar is legible as an address bar.
	 */
	it("finishes the login from a URL pasted back, for a plane the browser cannot see", async () => {
		const { context: ctx, started, pasted, logins } = context({ shelf });
		const landed = `${WAITING_AT}?code=abc&state=xyz`;

		const answer = await runCommand(`/mcp login linear ${landed}`, ctx);

		expect(pasted).toEqual([{ name: "linear", redirected: landed }]);
		expect(started).toEqual([]);
		expect(logins.has("linear")).toBe(true);
		expect(answer).toContain("Logged in to mcp.linear.app");
	});

	// A login that could not start is news about the server, and it belongs next to the command.
	it("answers with why a login would not start rather than throwing", async () => {
		const { context: ctx } = context({ shelf });
		const refuses = {
			...ctx,
			login: async () => {
				throw new Error("This server does not register clients.");
			},
		};

		expect(await runCommand("/mcp login linear", refuses)).toContain("does not register clients");
	});

	it("has no account to offer for a server that is a process", async () => {
		const { context: ctx, started } = context({
			shelf: { files: { transport: "stdio", command: "mcp-files", args: [] } },
		});

		expect(await runCommand("/mcp login files", ctx)).toContain("not a place with an account");
		expect(started).toEqual([]);
	});

	it("asks which one when there is more than nothing to log in to", async () => {
		const { context: ctx } = context({ shelf });

		expect(await runCommand("/mcp login", ctx)).toContain("/mcp login linear");
	});

	it("takes the token away again, and says the reach went with it", async () => {
		const { context: ctx, logins } = context({ shelf, loggedIn: ["linear"] });

		const answer = await runCommand("/mcp logout linear", ctx);

		expect(logins.has("linear")).toBe(false);
		expect(answer).toContain("Logged out of mcp.linear.app");
	});

	it("does not claim to have logged out of something nothing was logged in to", async () => {
		const { context: ctx } = context({ shelf });

		expect(await runCommand("/mcp logout linear", ctx)).toContain("was not logged in");
	});

	// Otherwise `/mcp login` would be ambiguous forever, discovered by whoever tried to use it.
	it("refuses to name a server after either of its own words", async () => {
		const { context: ctx, shelf: added } = context();

		expect(await runCommand(`/mcp add login ${linear}`, ctx)).toContain("is a word /mcp uses");
		expect(await runCommand(`/mcp add logout ${linear}`, ctx)).toContain("is a word /mcp uses");
		expect(added.size).toBe(0);
	});
});

describe("/telegram", () => {
	/** Shaped like BotFather's: a public bot id, a colon, and the half that is the account. */
	const TOKEN = "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

	it("sends whoever has no bot to @BotFather", async () => {
		const { context: ctx } = context();

		const answer = await runCommand("/telegram", ctx);

		expect(answer).toContain("has no Telegram bot");
		expect(answer).toContain("@BotFather");
	});

	it("gives back a link to press rather than an id to look up", async () => {
		const { context: ctx, bot, offered } = context();

		const answer = await runCommand(`/telegram ${TOKEN}`, ctx);

		expect(offered).toEqual([TOKEN]);
		expect(answer).toContain("https://t.me/scout_test_bot?start=");
		expect(bot.held?.paired).toBe(false);
	});

	// Whoever presses Start is the operator, so an unpressed link is the whole of what is left to do.
	it("keeps offering the link until somebody has taken it", async () => {
		const { context: ctx } = context({
			bot: {
				username: "scout_bot",
				paired: false,
				chats: 0,
				link: "https://t.me/scout_bot?start=x",
				phrase: "x",
			},
		});

		expect(await runCommand("/telegram", ctx)).toContain("Nobody is paired to it yet");
	});

	// Telegram Web opens the chat without handing the bot what is behind `?start=`, so the link alone
	// strands whoever is on a desktop: they press Start, nothing pairs, and there is nothing to type.
	it("gives the phrase on its own, for where the link does not carry it", async () => {
		const { context: ctx } = context({
			bot: {
				username: "scout_bot",
				paired: false,
				chats: 0,
				link: "https://t.me/scout_bot?start=kqm3nvbh27",
				phrase: "kqm3nvbh27",
			},
		});

		const answer = await runCommand("/telegram", ctx);

		expect(answer).toContain("@scout_bot");
		expect(answer).toContain("Telegram Web");
		// On a line of its own, rather than only inside the URL where it cannot be copied out.
		expect(answer).toMatch(/^\s+kqm3nvbh27$/m);
	});

	it("says where a paired bot answers, in the plural or not", async () => {
		const one = context({
			bot: { username: "scout_bot", paired: true, chats: 1, link: undefined, phrase: undefined },
		});
		const three = context({
			bot: { username: "scout_bot", paired: true, chats: 3, link: undefined, phrase: undefined },
		});

		expect(await runCommand("/telegram", one.context)).toContain("the chat you paired in");
		expect(await runCommand("/telegram", three.context)).toContain("3 chats");
	});

	// A bot BotFather never gave a @name to: there is no link to build, and a broken one would be worse.
	it("says a nameless bot needs a name before it can be paired", async () => {
		const { context: ctx } = context({
			bot: { username: undefined, paired: false, chats: 0, link: undefined, phrase: undefined },
		});

		const answer = await runCommand("/telegram", ctx);

		expect(answer).toContain("no @name");
		expect(answer).not.toContain("https://t.me/");
	});

	it("passes on Telegram's own words about a token it will not have", async () => {
		const { context: ctx, bot } = context({ refuses: "Unauthorized" });

		expect(await runCommand(`/telegram ${TOKEN}`, ctx)).toContain("Unauthorized");
		expect(bot.held).toBeUndefined();
	});

	it("does not hand on something that is not a token at all", async () => {
		const { context: ctx, offered } = context();

		expect(await runCommand("/telegram hunter2", ctx)).toContain("not a bot token");
		expect(await runCommand(`/telegram ${TOKEN} and more`, ctx)).toContain("A token is one word");
		expect(offered).toEqual([]);
	});

	// The pairing on the old bot is not carried over, and saying so is the difference between an
	// operator who presses the new link and one who waits for messages that never come.
	it("says a replacement starts pairing again", async () => {
		const { context: ctx } = context({
			bot: { username: "old_bot", paired: true, chats: 2, link: undefined, phrase: undefined },
		});

		const answer = await runCommand(`/telegram ${TOKEN}`, ctx);

		expect(answer).toContain("@old_bot");
		expect(answer).toContain("Pairing starts again");
	});

	it("puts a bot down, and does not claim to have put down nothing", async () => {
		const { context: ctx, bot } = context({
			bot: { username: "scout_bot", paired: true, chats: 1, link: undefined, phrase: undefined },
		});

		expect(await runCommand("/telegram off", ctx)).toContain("no longer has a bot");
		expect(bot.held).toBeUndefined();
		expect(await runCommand("/telegram off", ctx)).toContain("had no bot to put down");
	});
});

describe("withoutSecrets", () => {
	it("spends the token and keeps the bot it names", () => {
		expect(withoutSecrets("/telegram 8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(
			"/telegram 8123456789:…",
		);
	});

	it("leaves a line with nothing to hide exactly as it was typed", () => {
		expect(withoutSecrets("/telegram off")).toBe("/telegram off");
		expect(withoutSecrets("/serve 3000")).toBe("/serve 3000");
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

/**
 * The line between what an agent may ask for itself and what stays with the operator.
 *
 * Not "destructive versus not": the question is whether an agent that has been argued into this by
 * something in its own context could get anywhere by it. So nothing here may widen what it reaches
 * or what it spends, and everything that cannot is allowed to just happen.
 */
describe("agentMayNot", () => {
	const scout = { agentId: "scout", limitUsd: 5 };

	it("lets it connect itself to a server, which grants it nothing", () => {
		expect(agentMayNot("/mcp add ahrefs https://mcp.ahrefs.com/mcp", scout)).toBeUndefined();
		expect(agentMayNot("/mcp ahrefs", scout)).toBeUndefined();
		expect(agentMayNot("/mcp", scout)).toBeUndefined();
	});

	/**
	 * The one it was built for. A login ends at a consent screen with the host name in front of a
	 * person, which this codebase already treats as a stronger approval than a line of YAML — and it
	 * is the one thing the agent could not do for itself, since it has no browser and no operator.
	 */
	it("lets it send its operator to a consent screen", () => {
		expect(agentMayNot("/mcp login ahrefs", scout)).toBeUndefined();
	});

	// The half that carries an address is the operator walking back from that screen. An agent
	// holding one has not been to a screen: it has an address it got somewhere.
	it("does not let it walk back from the consent screen itself", () => {
		const refusal = agentMayNot("/mcp login ahrefs https://localhost/callback?code=x", scout);

		expect(refusal).toContain("yours to make");
		expect(refusal).toContain("/mcp login ahrefs <address>");
	});

	it("lets it change what it thinks with, and give a server up", () => {
		expect(agentMayNot("/model", scout)).toBeUndefined();
		expect(agentMayNot("/model sonnet", scout)).toBeUndefined();
		expect(agentMayNot("/mcp drop ahrefs", scout)).toBeUndefined();
		expect(agentMayNot("/help", scout)).toBeUndefined();
	});

	// Every other command guarded here is about what an agent can reach outwards. This is the
	// opposite direction — a way in, from the console the operator is sitting at, to loopback inside
	// a box whoever typed it could already have run anything they liked in.
	it("lets it put a port of its own in front of its operator", () => {
		expect(agentMayNot("/serve 3000", scout)).toBeUndefined();
		expect(agentMayNot("/serve stop 3000", scout)).toBeUndefined();
		expect(agentMayNot("/serve", scout)).toBeUndefined();
	});

	it("lets it ask to be held to less than it is", () => {
		expect(agentMayNot("/limit 2", scout)).toBeUndefined();
		expect(agentMayNot("/limit", scout)).toBeUndefined();
	});

	// Not a raise: it is the first ceiling there has been, and an agent asking to be held to
	// something tighter than nothing is asking for less than it had.
	it("lets it set the first ceiling where there was none", () => {
		expect(agentMayNot("/limit 3", { agentId: "scout", limitUsd: undefined })).toBeUndefined();
	});

	it("refuses a ceiling above the one it has, and says what to type", () => {
		const refusal = agentMayNot("/limit 50", scout);

		expect(refusal).toContain("$50.00");
		expect(refusal).toContain("$5.00");
		expect(refusal).toContain("/limit $50.00");
	});

	it("refuses taking the ceiling off at all", () => {
		expect(agentMayNot("/limit off", scout)).toContain("/limit off");
		expect(agentMayNot("/limit none", scout)).toContain("/limit off");
	});

	// The word for it is the operator's, and this is where they find out it exists.
	it("refuses deleting, and names the line that would", () => {
		expect(agentMayNot("/delete", scout)).toContain("/delete scout");
		expect(agentMayNot("/delete scout", scout)).toContain("/delete scout");
	});

	// The shelf is shared. A drop is this agent giving one up; a forget takes it off every agent
	// that has it, including the ones nobody was looking at.
	it("refuses taking a server off every other agent", () => {
		const refusal = agentMayNot("/mcp forget ahrefs", scout);

		expect(refusal).toContain("every agent");
		expect(refusal).toContain("/mcp forget ahrefs");
	});

	it("refuses closing an account the operator opened", () => {
		expect(agentMayNot("/mcp logout ahrefs", scout)).toContain("/mcp logout ahrefs");
	});

	/**
	 * The only refusal here that does not tell the operator what to type. Every other one ends at a
	 * line worth running, but a bot an agent found somewhere is a bot the agent chose, and pairing it
	 * would hand an account the agent picked the right to give it orders. Echoing the token would be
	 * putting that line one paste away.
	 */
	it("refuses the whole of Telegram, without repeating what it asked for", () => {
		const refusal = agentMayNot(`/telegram 8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`, scout);

		expect(refusal).toContain("who may instruct it");
		expect(refusal).not.toContain("AAHdq");
		expect(agentMayNot("/telegram", scout)).toBeDefined();
		expect(agentMayNot("/telegram off", scout)).toBeDefined();
	});

	// Answered by the command itself, which says what there is instead. A refusal here would be this
	// list having to know every command there is in order to say that one is not among them.
	it("lets a command that does not exist be answered as one", () => {
		expect(agentMayNot("/parametros", scout)).toBeUndefined();
	});
});
