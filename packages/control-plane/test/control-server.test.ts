import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient, ControlError } from "../src/control-client.ts";
import { ControlPlane, type PlaneEvent } from "../src/control-plane.ts";
import { ControlServer } from "../src/control-server.ts";

describe("the control socket", () => {
	let stateDir: string;
	let plane: ControlPlane;
	let server: ControlServer;
	let client: ControlClient;

	/** Stands in for a sandbox: answers the turn without needing Docker. */
	const answerWith = async (agentId: string, say: (prompt: string) => string) => {
		await plane.attach(agentId, {
			run: async (_id, prompt) => ({
				text: say(prompt),
				exitCode: 0,
				stderr: "",
				ms: 0,
				tokens: 0,
				costUsd: 0,
			}),
		});
	};

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "agent-dive-control-"));
		plane = new ControlPlane({
			agents: [{ id: "scout", grants: [], schedules: [] }, { id: "scribe" }],
			stateDir,
		});
		server = new ControlServer({ plane, waitMs: 5_000 });
		await server.listen();
		client = new ControlClient(stateDir);
		await client.connect();
	});

	afterEach(async () => {
		client.close();
		await server.close();
		// A wake is answered before the turn is acknowledged, so the store may still be writing.
		await plane.bus.drain();
		await rm(stateDir, { recursive: true, force: true });
	});

	it("lists the agents an operator declared", async () => {
		expect((await client.agents()).map((agent) => agent.id)).toEqual(["scout", "scribe"]);
	});

	it("reports a sandbox that is not up rather than failing", async () => {
		expect((await client.agents())[0]).toMatchObject({ id: "scout", running: false });
	});

	it("answers the operator with what the agent said", async () => {
		await answerWith("scout", () => "four issues are open");

		expect(await client.wake("scout", "check the issues")).toBe("four issues are open");
	});

	it("hands the operator the answer in pieces, as the agent writes it", async () => {
		await plane.attach("scout", {
			run: async (_id, _prompt, onText) => {
				onText?.("cuatro ");
				onText?.("issues abiertos");
				return {
					text: "cuatro issues abiertos",
					exitCode: 0,
					stderr: "",
					ms: 0,
					tokens: 0,
					costUsd: 0,
				};
			},
		});

		const chunks: string[] = [];
		const text = await client.wake("scout", "revisá los issues", (chunk) => chunks.push(chunk));

		expect(chunks).toEqual(["cuatro ", "issues abiertos"]);
		expect(text).toBe("cuatro issues abiertos");
	});

	// A console watches a conversation it did not necessarily start — a schedule, a webhook — and an
	// answer it only learns about once finished is one it draws after the wait rather than during it.
	// What a feed does with the pieces is the feed's business; the socket carries them.
	it("carries the pieces of an answer to whoever is only watching", async () => {
		await plane.attach("scribe", {
			run: async (_id, _prompt, onText) => {
				onText?.("anot");
				onText?.("ado");
				return { text: "anotado", exitCode: 0, stderr: "", ms: 0, tokens: 0, costUsd: 0 };
			},
		});
		const seen: PlaneEvent[] = [];
		client.logs((event) => seen.push(event));
		await new Promise((resolve) => setTimeout(resolve, 50));

		await client.wake("scribe", "anotalo");

		expect(seen).toContainEqual({ kind: "say", agentId: "scribe", text: "anot" });
		expect(seen).toContainEqual(expect.objectContaining({ kind: "turn", agentId: "scribe" }));
	});

	// Both halves of the turn, so that a console opening later can read back who asked for what.
	it("keeps what was said for a console that was not open at the time", async () => {
		await plane.attach("scribe", {
			run: async () => ({ text: "anotado", exitCode: 0, stderr: "", ms: 0, tokens: 0, costUsd: 0 }),
		});

		await client.wake("scribe", "anotalo");

		expect((await client.transcripts()).scribe).toMatchObject([
			{ from: "operator", text: "anotalo" },
			{ from: "agent", text: "anotado" },
		]);
	});

	it("tells the operator the turn failed instead of waiting out the timeout", async () => {
		// The events stay queued for a retry either way. What must not happen is that the person who
		// typed the command sits through waitMs and is then told the agent said nothing.
		await plane.attach("scout", {
			run: async () => {
				throw new Error('Turn for "scout" exited 1: denied CONNECT api.anthropic.com');
			},
		});

		await expect(client.wake("scout", "check the issues")).rejects.toThrow(/denied CONNECT/);
	});

	it("wakes the agent with operator trust, so the message may instruct", async () => {
		let prompt = "";
		await answerWith("scout", (received) => {
			prompt = received;
			return "ok";
		});

		await client.wake("scout", "deploy the branch");

		expect(prompt).toContain("Message from the operator");
		expect(prompt).not.toContain("UNTRUSTED");
	});

	it("answers both operators when their messages become one turn", async () => {
		await answerWith("scout", () => "one answer");
		const other = new ControlClient(stateDir);
		await other.connect();

		try {
			// A burst is coalesced into a single turn, so the two get the same words; what matters is
			// that whoever spoke second is answered rather than left waiting for a turn already taken.
			expect(
				await Promise.all([client.wake("scout", "first"), other.wake("scout", "second")]),
			).toEqual(["one answer", "one answer"]);
		} finally {
			other.close();
		}
	});

	it("keeps one operator's answer out of another's terminal", async () => {
		await answerWith("scout", (prompt) => (prompt.includes("first") ? "one" : "two"));
		const other = new ControlClient(stateDir);
		await other.connect();

		try {
			expect(await client.wake("scout", "first")).toBe("one");
			expect(await other.wake("scout", "second")).toBe("two");
		} finally {
			other.close();
		}
	});

	it("streams turns to a follower", async () => {
		await answerWith("scribe", () => "noted");
		const seen: PlaneEvent[] = [];
		client.logs((event) => seen.push(event));
		await new Promise((resolve) => setTimeout(resolve, 50));

		await client.wake("scribe", "write it down");

		expect(seen).toContainEqual(expect.objectContaining({ kind: "turn", agentId: "scribe" }));
	});

	it("streams the reason an agent failed", async () => {
		await plane.bus.register("scout", async () => {
			throw new Error("sandbox unavailable");
		});
		const seen: PlaneEvent[] = [];
		client.logs((event) => seen.push(event));
		await new Promise((resolve) => setTimeout(resolve, 50));

		await plane.bus.publish({
			agentId: "scout",
			source: "webhook",
			trust: "public",
			channel: "webhook:x",
			body: "x",
		});
		await plane.bus.drain();

		expect(seen).toContainEqual(
			expect.objectContaining({ kind: "error", message: "sandbox unavailable" }),
		);
	});

	it("refuses to remove an agent this plane does not run", async () => {
		// Named, not matched loosely: `agent rm` takes a name, and the one thing worse than refusing a
		// typo is destroying something else that answered to it.
		await expect(client.remove("scou", false)).rejects.toThrow(/No agent "scou"/);
	});

	it("lets only its owner near it, because holding it is the whole authorization", async () => {
		const mode = (await stat(server.socketPath)).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

describe("the control client without a plane", () => {
	it("says nothing is listening instead of hanging", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-dive-empty-"));
		try {
			await expect(new ControlClient(dir).connect()).rejects.toThrow(ControlError);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
