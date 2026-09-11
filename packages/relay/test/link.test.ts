import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link } from "../src/link.ts";
import { Rendezvous } from "../src/rendezvous.ts";

const SECRET = "MekEy-WJ4RPyWP3PjCEntVGhlJN56bE0uNffl2Obhls";

let relay: Rendezvous;
let origin: string;

beforeEach(async () => {
	relay = new Rendezvous({ port: 0, host: "127.0.0.1", idleMs: 50 });
	origin = `http://127.0.0.1:${await relay.listen()}`;
});

afterEach(async () => {
	await relay.close();
});

const settle = (ms = 80) => new Promise((go) => setTimeout(go, ms));

describe("two ends of a room", () => {
	it("carry protocol lines both ways", async () => {
		const atPlane: string[] = [];
		const atConsole: string[] = [];
		const plane = await link({
			origin,
			secret: SECRET,
			side: "plane",
			onLine: (l) => atPlane.push(l),
			onDown: () => {},
		});
		const console_ = await link({
			origin,
			secret: SECRET,
			side: "console",
			onLine: (l) => atConsole.push(l),
			onDown: () => {},
		});
		await settle();

		await console_.send('{"id":"1","op":"agents"}');
		await settle();
		expect(atPlane).toEqual(['{"id":"1","op":"agents"}']);

		await plane.send('{"id":"1","ok":true,"agents":[]}');
		await settle();
		expect(atConsole).toEqual(['{"id":"1","ok":true,"agents":[]}']);

		plane.close();
		console_.close();
	});

	// The subscription is the case the browser wire got wrong once: many lines down one connection,
	// none of them an answer to anything.
	it("carry many lines one after another", async () => {
		const heard: string[] = [];
		const plane = await link({
			origin,
			secret: SECRET,
			side: "plane",
			onLine: (l) => heard.push(l),
			onDown: () => {},
		});
		const console_ = await link({
			origin,
			secret: SECRET,
			side: "console",
			onLine: () => {},
			onDown: () => {},
		});
		await settle();
		for (const n of [1, 2, 3, 4, 5]) await console_.send(`{"n":${n}}`);
		await settle();
		expect(heard).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}', '{"n":5}']);
		plane.close();
		console_.close();
	});

	it("do not hear a plane holding a different token", async () => {
		const refused: Error[] = [];
		const heard: string[] = [];
		const plane = await link({
			origin,
			secret: SECRET,
			side: "plane",
			onLine: (l) => heard.push(l),
			onDown: () => {},
			onRefused: (why) => refused.push(why),
		});
		await settle();

		// Same room, wrong key: only somebody who guessed the room could do this, and all they get is
		// a frame the far end drops.
		const room = await (await import("../src/seal.ts")).roomOf(SECRET);
		const wrong = await (await import("../src/seal.ts")).keyOf("not the token");
		const sealer = new (await import("../src/seal.ts")).Sealer(wrong, room);
		await fetch(`${origin}/r/${room}/console`, {
			method: "POST",
			body: await sealer.seal('{"op":"shell"}'),
		});
		await settle();

		expect(heard).toEqual([]);
		expect(refused).toHaveLength(1);
		plane.close();
	});
});
