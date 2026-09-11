import { describe, expect, it } from "vitest";
import { keyOf, Opener, roomOf, Sealer } from "../src/seal.ts";

const SECRET = "MekEy-WJ4RPyWP3PjCEntVGhlJN56bE0uNffl2Obhls";

async function pair(secret = SECRET) {
	const room = await roomOf(secret);
	const key = await keyOf(secret);
	return { room, sealer: new Sealer(key, room), opener: new Opener(key, room) };
}

describe("the room", () => {
	it("is the same on both ends and says nothing about the secret", async () => {
		expect(await roomOf(SECRET)).toBe(await roomOf(SECRET));
		expect(await roomOf(SECRET)).not.toContain(SECRET.slice(0, 8));
		expect(await roomOf(SECRET)).toMatch(/^[0-9a-f]{32}$/);
	});

	it("is a different room for a different plane", async () => {
		expect(await roomOf(SECRET)).not.toBe(await roomOf(`${SECRET}x`));
	});
});

describe("sealing", () => {
	it("comes back as what went in", async () => {
		const { sealer, opener } = await pair();
		const line = JSON.stringify({ id: "1", op: "agents" });
		expect(await opener.open(await sealer.seal(line))).toBe(line);
	});

	it("carries nothing readable on the way", async () => {
		const { sealer } = await pair();
		expect(await sealer.seal('{"op":"agents"}')).not.toContain("agents");
	});

	// The relay is the thing this is for: it holds every frame it forwards, and holding them must not
	// be the same as reading them.
	it("cannot be opened with the room number alone", async () => {
		const { room, sealer } = await pair();
		const stranger = new Opener(await keyOf("some other token"), room);
		await expect(stranger.open(await sealer.seal("hello"))).rejects.toThrow();
	});

	it("refuses a frame it has already opened", async () => {
		const { sealer, opener } = await pair();
		const frame = await sealer.seal("once");
		expect(await opener.open(frame)).toBe("once");
		await expect(opener.open(frame)).rejects.toThrow("already arrived");
	});

	// Both ends hold the same key, so a counter alone would have each of them opening at zero and
	// producing the same nonce for their first frame. That is the one mistake AES-GCM does not
	// survive, so it is worth a test that would notice it coming back.
	it("gives each direction a nonce space of its own", async () => {
		const key = await keyOf(SECRET);
		const room = await roomOf(SECRET);
		const one = await new Sealer(key, room).seal("first");
		const other = await new Sealer(key, room).seal("first");
		expect(one.slice(0, 16)).not.toBe(other.slice(0, 16));
	});

	it("refuses a frame lifted into another room", async () => {
		const key = await keyOf(SECRET);
		const sealed = await new Sealer(key, await roomOf(SECRET)).seal("hello");
		await expect(
			new Opener(key, "00000000000000000000000000000000").open(sealed),
		).rejects.toThrow();
	});

	it("refuses a frame somebody edited", async () => {
		const { sealer, opener } = await pair();
		const frame = await sealer.seal("hello");
		const bent = `${frame.slice(0, -2)}${frame.slice(-2) === "aa" ? "bb" : "aa"}`;
		await expect(opener.open(bent)).rejects.toThrow();
	});

	it("keeps its order across many frames", async () => {
		const { sealer, opener } = await pair();
		const sent = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const frames = [];
		for (const line of sent) frames.push(await sealer.seal(line));
		const got = [];
		for (const frame of frames) got.push(await opener.open(frame));
		expect(got).toEqual(sent);
	});
});
