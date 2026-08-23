import { describe, expect, it } from "vitest";
import { addressee, parseArgs } from "../src/cli.ts";
import type { AgentSummary } from "../src/control-plane.ts";

const summary = (id: string): AgentSummary => ({
	id,
	running: true,
	startedAt: undefined,
	grants: 0,
	schedules: 0,
	created: false,
});

const plane = (...ids: string[]) => ({ agents: async () => ids.map(summary) });

describe("parseArgs", () => {
	it("prefers the named directory over the environment", () => {
		const args = parseArgs(["ls", "--state", "/tmp/here"], { AGENT_DIVE_STATE: "/tmp/there" });
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
		// `agent wake hola` on a plane with an agent called "hola" is a greeting nobody can send. The
		// alternative is a message that silently goes to the wrong agent, which is the worse half.
		await expect(addressee(plane("hola", "demo"), ["hola"])).rejects.toThrow(
			"usage: agent wake hola <text>",
		);
	});

	it("refuses to guess when there is more than one agent and no name", async () => {
		await expect(addressee(plane("demo", "scout"), ["hola"])).rejects.toThrow(
			/More than one agent[\s\S]*agent wake demo "hola"[\s\S]*agent wake scout "hola"/,
		);
	});

	it("does not queue a turn for an agent nobody runs", async () => {
		await expect(addressee(plane(), ["hola"])).rejects.toThrow("This plane has no agents");
	});
});
