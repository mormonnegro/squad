import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rendezvous } from "../src/rendezvous.ts";
import { keyOf, Opener, roomOf, Sealer } from "../src/seal.ts";

let relay: Rendezvous;
let origin: string;

beforeEach(async () => {
	relay = new Rendezvous({ port: 0, host: "127.0.0.1", idleMs: 20 });
	origin = `http://127.0.0.1:${await relay.listen()}`;
});

afterEach(async () => {
	await relay.close();
});

/** One end of a room, reading the stream the way an EventSource would. */
async function join(room: string, side: "plane" | "console") {
	const stream = await fetch(`${origin}/r/${room}/${side}`, {
		headers: { accept: "text/event-stream" },
	});
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	const decode = new TextDecoder();
	let buffered = "";
	const heard: string[] = [];
	const pump = (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffered += decode.decode(value, { stream: true });
			let cut = buffered.indexOf("\n\n");
			while (cut !== -1) {
				const frame = buffered.slice(0, cut);
				buffered = buffered.slice(cut + 2);
				const data = /^data: (.*)$/m.exec(frame)?.[1];
				if (data !== undefined) heard.push(data);
				cut = buffered.indexOf("\n\n");
			}
		}
	})();
	return {
		heard,
		say: (frame: string) => fetch(`${origin}/r/${room}/${side}`, { method: "POST", body: frame }),
		leave: async () => {
			await reader.cancel().catch(() => {});
			await pump.catch(() => {});
		},
	};
}

const settle = (ms = 60) => new Promise((go) => setTimeout(go, ms));
const ROOM = "a".repeat(32);

describe("carrying", () => {
	it("puts what one end says in front of the other", async () => {
		const plane = await join(ROOM, "plane");
		const console_ = await join(ROOM, "console");
		await settle();
		await console_.say("hello");
		await settle();
		expect(plane.heard).toEqual(["hello"]);
		// And never back to the end that said it.
		expect(console_.heard).toEqual([]);
		await plane.leave();
		await console_.leave();
	});

	it("keeps what was said while the far end was away, and delivers it on arrival", async () => {
		const console_ = await join(ROOM, "console");
		await settle();
		await console_.say("while you were out");
		const plane = await join(ROOM, "plane");
		await settle();
		expect(plane.heard).toEqual(["while you were out"]);
		await plane.leave();
		await console_.leave();
	});

	// A switchboard that stores without end is storage, and storage is a thing strangers fill up.
	it("holds only so much for an end that is not there", async () => {
		const small = new Rendezvous({ port: 0, host: "127.0.0.1", queueLimit: 3 });
		const at = `http://127.0.0.1:${await small.listen()}`;
		for (const n of [1, 2, 3, 4, 5]) {
			await fetch(`${at}/r/${ROOM}/console`, { method: "POST", body: `frame ${n}` });
		}
		const stream = await fetch(`${at}/r/${ROOM}/plane`, {
			headers: { accept: "text/event-stream" },
		});
		const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
		const text = new TextDecoder().decode((await reader.read()).value);
		// The oldest gave way, which is the right end to lose: a console reconnecting asks again.
		expect(text).not.toContain("frame 1");
		expect(text).toContain("frame 5");
		await reader.cancel();
		await small.close();
	});

	it("refuses a frame past its size", async () => {
		const answer = await fetch(`${origin}/r/${ROOM}/plane`, {
			method: "POST",
			body: "x".repeat(300 * 1024),
		});
		expect(answer.status).toBe(413);
	});

	it("knows nothing about a path that is not a room", async () => {
		expect((await fetch(`${origin}/r/not-a-room/plane`)).status).toBe(404);
		expect((await fetch(`${origin}/r/${ROOM}/somebody`)).status).toBe(404);
		expect((await fetch(`${origin}/health`)).status).toBe(200);
	});

	it("forgets a room once both ends have gone", async () => {
		const plane = await join(ROOM, "plane");
		await settle();
		expect(relay.rooms).toBe(1);
		await plane.leave();
		await settle(400);
		expect(relay.rooms).toBe(0);
	});
});

describe("what the relay can see", () => {
	// The whole argument for a relay being acceptable is this test: it holds every frame it forwards
	// and can read none of them.
	it("is a room number and ciphertext", async () => {
		const secret = "MekEy-WJ4RPyWP3PjCEntVGhlJN56bE0uNffl2Obhls";
		const room = await roomOf(secret);
		const key = await keyOf(secret);
		const fromConsole = new Sealer(key, room);
		const atPlane = new Opener(key, room);

		const plane = await join(room, "plane");
		const console_ = await join(room, "console");
		await settle();

		const line = JSON.stringify({ id: "1", op: "wake", agentId: "scout", body: "ship it" });
		await console_.say(await fromConsole.seal(line));
		await settle();

		const [carried] = plane.heard;
		expect(carried).toBeDefined();
		expect(carried).not.toContain("scout");
		expect(carried).not.toContain("wake");
		expect(await atPlane.open(carried as string)).toBe(line);
		// And the room it was carried in tells nobody whose plane it is.
		expect(room).not.toContain(secret.slice(0, 8));

		await plane.leave();
		await console_.leave();
	});
});
