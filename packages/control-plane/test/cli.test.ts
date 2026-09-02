import { afterEach, describe, expect, it, vi } from "vitest";
import { addressee, cli, parseArgs } from "../src/cli.ts";
import type { AgentSummary } from "../src/control-plane.ts";

const summary = (id: string): AgentSummary => ({
	id,
	running: true,
	startedAt: undefined,
	grants: 0,
	schedules: 0,
	wakeAt: undefined,
	created: false,
	spentUsd: 0,
	limitUsd: undefined,
	model: undefined,
	served: [],
	asking: [],
	bot: undefined,
	mail: undefined,
});

const plane = (...ids: string[]) => ({ agents: async () => ids.map(summary) });

describe("parseArgs", () => {
	it("prefers the named directory over the environment", () => {
		const args = parseArgs(["ls", "--state", "/tmp/here"], { SQUAD_STATE: "/tmp/there" });
		expect(args).toMatchObject({ stateDir: "/tmp/here", named: true, rest: ["ls"] });
	});

	it("marks the default as unnamed, so the commands may go looking", () => {
		expect(parseArgs(["ls"], {})).toMatchObject({ named: false });
	});

	it("keeps flags out of the words the operator typed", () => {
		expect(parseArgs(["rm", "scout", "--purge"], {})).toMatchObject({
			purge: true,
			rest: ["rm", "scout"],
		});
	});
});

/**
 * The rule the operator meets first and never reads about: what `wake` does with the words after
 * it. Both halves of it were reported as bugs within an hour of each other — a name that was taken
 * for a message, and then a message that was taken for a name.
 */
describe("who the words after `wake` are for", () => {
	it("sends the whole line when the plane runs one agent", async () => {
		expect(await addressee(plane("demo"), ["hola", "que", "tal"])).toEqual({
			agent: summary("demo"),
			body: "hola que tal",
		});
	});

	it("takes a first word that names an agent as the address", async () => {
		expect(await addressee(plane("demo"), ["demo", "hola"])).toMatchObject({
			agent: { id: "demo" },
			body: "hola",
		});
	});

	it("gives the name the collision, and says so by asking for the text", async () => {
		// `squad wake hola` on a plane with an agent called "hola" is a greeting nobody can send. The
		// alternative is a message that silently goes to the wrong agent, which is the worse half.
		await expect(addressee(plane("hola", "demo"), ["hola"])).rejects.toThrow(
			"usage: squad wake hola <text>",
		);
	});

	it("refuses to guess when there is more than one agent and no name", async () => {
		await expect(addressee(plane("demo", "scout"), ["hola"])).rejects.toThrow(
			/More than one agent[\s\S]*squad wake demo "hola"[\s\S]*squad wake scout "hola"/,
		);
	});

	it("does not queue a turn for an agent nobody runs", async () => {
		await expect(addressee(plane(), ["hola"])).rejects.toThrow("This plane has no agents");
	});
});

/**
 * The one command this CLI is asked for and cannot do.
 *
 * On a server `squad` is a shim into this plane's container, so `squad update` typed on the machine
 * lands here — and half of what an update replaces is the process it landed in. The answer is the
 * two lines that do it, from outside.
 */
describe("an update, asked of the thing being updated", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	const said = async (): Promise<string> => {
		let text = "";
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			text += chunk.toString();
			return true;
		});
		await cli(["update"]);
		return text;
	};

	it("says where an update is run from, rather than that there is no such command", async () => {
		const text = await said();
		expect(text).toContain("outside it");
		expect(text).toContain("install.sh");
		expect(text).not.toContain("Unknown command");
	});

	// The whole usage under it would bury the two lines worth reading, and none of those commands is
	// the answer to what was asked.
	it("answers with the two ways and not with every other command", async () => {
		expect(await said()).not.toContain("squad relay");
	});

	// Nothing was updated, and a shell that was told otherwise is one that would go on to deploy.
	it("fails, because nothing was rebuilt", async () => {
		await said();
		expect(process.exitCode).toBe(1);
	});
});
