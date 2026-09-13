import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewAgentEvent } from "@squad/events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nameRefused, RoomChannel, Rooms, roomIn } from "../src/rooms.ts";

describe("a room", () => {
	let dir: string;
	let rooms: Rooms;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "squad-rooms-"));
		rooms = new Rooms(join(dir, "rooms.json"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("keeps who is in it, and survives being read back", async () => {
		await rooms.make("standup", ["scout", "dev"]);
		expect(await rooms.all()).toEqual([{ name: "standup", members: ["scout", "dev"] }]);
		const again = new Rooms(join(dir, "rooms.json"));
		expect(await again.of("standup")).toEqual({ name: "standup", members: ["scout", "dev"] });
	});

	it("refuses a second room of the same name", async () => {
		await rooms.make("standup", []);
		await expect(rooms.make("standup", [])).rejects.toThrow(/already a room/);
	});

	// The console has to be able to tell a change from a thing that was already true, or "added" is
	// printed at somebody who added nobody.
	it("says whether joining and leaving changed anything", async () => {
		await rooms.make("standup", ["scout"]);
		expect(await rooms.join("standup", "dev")).toBe(true);
		expect(await rooms.join("standup", "dev")).toBe(false);
		expect(await rooms.leave("standup", "dev")).toBe(true);
		expect(await rooms.leave("standup", "dev")).toBe(false);
	});

	it("names everybody an agent shares a room with, and never the agent", async () => {
		await rooms.make("standup", ["scout", "dev"]);
		await rooms.make("ops", ["scout", "mcp"]);
		expect([...(await rooms.mates("scout"))].sort()).toEqual(["dev", "mcp"]);
		expect(await rooms.mates("nobody")).toEqual([]);
	});

	/**
	 * A name is reused. An agent deleted and made again is a different agent wearing the old one's
	 * name, and a room that still had it in the roster would be showing a stranger the work.
	 */
	it("takes a deleted agent out of every room and leaves the rooms standing", async () => {
		await rooms.make("standup", ["scout", "dev"]);
		await rooms.make("ops", ["scout"]);
		await rooms.forget("scout");
		expect(await rooms.all()).toEqual([
			{ name: "ops", members: [] },
			{ name: "standup", members: ["dev"] },
		]);
	});

	it("takes a room away, and says when there was none to take", async () => {
		await rooms.make("standup", []);
		expect(await rooms.drop("standup")).toBe(true);
		expect(await rooms.drop("standup")).toBe(false);
	});

	it("keeps the file to itself", async () => {
		await rooms.make("standup", ["scout"]);
		const written = await readFile(join(dir, "rooms.json"), "utf8");
		expect(JSON.parse(written)).toEqual({ standup: ["scout"] });
	});

	it("is named like an agent, because it is typed and put in a URL", () => {
		expect(nameRefused("standup")).toBeUndefined();
		expect(nameRefused("the-2026-plan")).toBeUndefined();
		expect(nameRefused("")).toBeDefined();
		expect(nameRefused("Standup")).toBeDefined();
		expect(nameRefused("#standup")).toBeDefined();
		expect(nameRefused("con espacios")).toBeDefined();
	});

	it("reads its own channel and nobody else's", () => {
		expect(roomIn("room:standup")).toBe("standup");
		expect(roomIn("room:")).toBeUndefined();
		expect(roomIn("agent:scout")).toBeUndefined();
	});
});

describe("what an agent says in a room", () => {
	const madeIn = (members: readonly string[], hops = 1) => {
		const posted: { from: string; body: string }[] = [];
		const woken: NewAgentEvent[] = [];
		const channel = new RoomChannel({
			members: async () => members,
			post: async (_name, from, body) => {
				posted.push({ from, body });
			},
			publish: async (event) => {
				woken.push(event);
			},
			hops: () => hops,
		});
		return { channel, posted, woken };
	};

	it("is posted in the room whoever it was for", async () => {
		const { channel, posted, woken } = madeIn(["scout", "dev"]);
		await channel.send({ agentId: "scout", channel: "room:standup", body: "Done, it deploys." });
		expect(posted).toEqual([{ from: "scout", body: "Done, it deploys." }]);
		// Nobody was named, so nobody pays for a turn to be told something they can read.
		expect(woken).toEqual([]);
	});

	/**
	 * Naming somebody is the whole of the door, and deliberately the same gesture the operator makes.
	 * An answer that woke the room would cost a turn per member per exchange, and by the third one
	 * the room is talking rather than working.
	 */
	it("wakes the agents it names, and only those", async () => {
		const { channel, woken } = madeIn(["scout", "dev", "mcp"]);
		await channel.send({
			agentId: "scout",
			channel: "room:standup",
			body: "@dev, the migration is yours. mcp already looked at it.",
		});
		expect(woken).toHaveLength(1);
		expect(woken[0]?.agentId).toBe("dev");
		expect(woken[0]?.trust).toBe("participant");
		expect(woken[0]?.actor).toEqual({ id: "scout" });
		expect(woken[0]?.channel).toBe("room:standup");
		expect(woken[0]?.metadata?.hops).toBe("2");
		// So the one that wakes knows who else is hearing this, which is what a room is.
		expect(woken[0]?.metadata?.with).toBe("scout, mcp");
	});

	it("stops the chain where a conversation between people would have stopped", async () => {
		const { channel, posted, woken } = madeIn(["scout", "dev"], 4);
		await expect(
			channel.send({ agentId: "scout", channel: "room:standup", body: "@dev one more thing" }),
		).rejects.toThrow(/hop 5/);
		// Still readable by the operator, who is the one who can start it again.
		expect(posted).toHaveLength(1);
		expect(woken).toEqual([]);
	});

	it("refuses to carry anything for an agent that is no longer in the room", async () => {
		const { channel } = madeIn(["dev"]);
		await expect(
			channel.send({ agentId: "scout", channel: "room:standup", body: "hello" }),
		).rejects.toThrow(/not in #standup/);
	});
});
