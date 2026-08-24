import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, createEvent } from "@agent-dive/events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { overheard, Transcript } from "../src/transcript.ts";

const arriving = (input: Parameters<typeof createEvent>[0]): AgentEvent => createEvent(input);

/**
 * Who is speaking, which is not the same question as how it arrived.
 *
 * A webhook body and a line typed by the operator are both text addressed to the agent, and the
 * difference between them is the only thing standing between "do what this says" and a stranger
 * with a URL.
 */
describe("overheard", () => {
	it("is the operator when the trust says so, and says nothing more", () => {
		const said = overheard(
			arriving({
				agentId: "scout",
				source: "channel",
				trust: "operator",
				channel: "cli:abc",
				body: "hola",
			}),
		);

		expect(said).toEqual({ from: "operator", text: "hola" });
	});

	// Operator trust is minted at the socket and nowhere else, so a cron the operator wrote is still
	// the operator talking — but it did not arrive by anyone typing, and the pane should say which.
	it("keeps an operator's schedule apart from an operator at the keyboard", () => {
		const said = overheard(
			arriving({
				agentId: "scout",
				source: "schedule",
				trust: "operator",
				channel: "wake",
				body: "revisar la cola",
			}),
		);

		expect(said.from).toBe("operator");
		expect(said.via).toBe("schedule");
	});

	it("is the agent, named as its own wakeup, when the agent booked it", () => {
		const said = overheard(
			arriving({
				agentId: "scout",
				source: "schedule",
				trust: "participant",
				channel: "wake",
				body: "seguir chequeando",
				metadata: { createdBy: "agent" },
			}),
		);

		expect(said).toEqual({ from: "agent", via: "wake", text: "seguir chequeando" });
	});

	// The bug this exists to prevent: a webhook drawn the way the operator is drawn, in a pane that
	// is read back through to work out who asked for what.
	it("is somebody else, named for the channel, when it is not trusted", () => {
		const said = overheard(
			arriving({
				agentId: "scout",
				source: "webhook",
				trust: "public",
				channel: "webhook:github",
				body: "ship it",
			}),
		);

		expect(said).toEqual({ from: "other", via: "webhook:github", text: "ship it" });
	});
});

describe("Transcript", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agent-dive-transcript-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("has nothing for a conversation that has not happened", async () => {
		expect(await new Transcript(dir).read("scout")).toEqual([]);
	});

	// The whole point: a console is a window onto a conversation, not the conversation itself.
	it("keeps what was said for whoever opens a console next", async () => {
		const written = new Transcript(dir);
		await written.append("scout", { from: "operator", text: "hola" });
		await written.append("scout", { from: "agent", text: "hola vos" });

		const reopened = await new Transcript(dir).read("scout");
		expect(reopened.map((said) => said.text)).toEqual(["hola", "hola vos"]);
		expect(reopened[0]?.at).toBeDefined();
	});

	it("keeps each agent's conversation to itself", async () => {
		const transcript = new Transcript(dir);
		await transcript.append("scout", { from: "operator", text: "para scout" });
		await transcript.append("scribe", { from: "operator", text: "para scribe" });

		expect((await transcript.read("scribe")).map((said) => said.text)).toEqual(["para scribe"]);
	});

	// Nobody is administering the machine this runs on, so the window is the record.
	it("keeps the last of a long conversation rather than all of it", async () => {
		const transcript = new Transcript(dir, { keep: 3 });
		for (const text of ["a", "b", "c", "d"]) {
			await transcript.append("scout", { from: "operator", text });
		}

		expect((await transcript.read("scout")).map((said) => said.text)).toEqual(["b", "c", "d"]);
	});

	// An agent id reaches this from a config file, and a name with a slash in it would otherwise be
	// a path: the file has to land in the directory it was given.
	it("writes a name with a slash in it as a name", async () => {
		const transcript = new Transcript(dir);
		await transcript.append("../escape", { from: "operator", text: "hola" });

		expect((await transcript.read("../escape")).map((said) => said.text)).toEqual(["hola"]);
	});
});
