import type { PlaneEvent } from "@squad/control-plane";
import { beforeEach, describe, expect, it } from "vitest";
import { Plane, type Session, type Wire } from "../src/plane.ts";

/** The connection, as something a test can drive from the plane's end. */
class FakeWire implements Wire {
	sent: string[] = [];
	#say: ((line: string) => void) | undefined;
	#down: ((why: Error) => void) | undefined;
	#up: (() => void) | undefined;

	async open(
		onLine: (line: string) => void,
		onDown: (why: Error) => void,
		onUp?: () => void,
	): Promise<Session> {
		this.#say = onLine;
		this.#down = onDown;
		this.#up = onUp;
		return {
			post: async (line) => {
				this.sent.push(line);
			},
			close: () => {},
		};
	}

	/** What the plane would have written back down the socket. */
	answer(answer: unknown): void {
		this.#say?.(JSON.stringify(answer));
	}

	drop(why = "gone"): void {
		this.#down?.(new Error(why));
	}

	/** What an EventSource does on its own a moment after it dropped. */
	back(): void {
		this.#up?.();
	}

	/** The id the client put on the nth thing it asked. */
	idOf(nth: number): string {
		return (JSON.parse(this.sent[nth] ?? "{}") as { id?: string }).id ?? "";
	}
}

let wire: FakeWire;
let plane: Plane;

beforeEach(async () => {
	wire = new FakeWire();
	plane = new Plane(wire);
	await plane.connect();
});

const said = (agentId: string, text: string): PlaneEvent => ({
	kind: "said",
	agentId,
	said: { from: "plane", text },
});

describe("watching", () => {
	// The bug this exists for: an event is not a chunk, so a dispatcher that spent the handler on
	// anything but a chunk unregistered the subscription on its first event. What that looked like
	// was a console where the first thing said arrived and nothing ever did again.
	it("keeps carrying events after the first one", () => {
		const seen: PlaneEvent[] = [];
		plane.watch((event) => seen.push(event));
		const id = wire.idOf(0);

		wire.answer({ id, event: said("scout", "one") });
		wire.answer({ id, event: said("scout", "two") });
		wire.answer({ id, event: said("scout", "three") });

		expect(seen).toHaveLength(3);
	});

	it("subscribes once however many are watching", () => {
		plane.watch(() => {});
		plane.watch(() => {});
		expect(wire.sent.filter((line) => line.includes('"logs"'))).toHaveLength(1);
	});

	it("tells everyone watching", () => {
		const one: PlaneEvent[] = [];
		const other: PlaneEvent[] = [];
		plane.watch((event) => one.push(event));
		plane.watch((event) => other.push(event));
		wire.answer({ id: wire.idOf(0), event: said("scout", "heard") });
		expect(one).toHaveLength(1);
		expect(other).toHaveLength(1);
	});
});

describe("asking", () => {
	it("answers the request that asked, by id", async () => {
		const asked = plane.agents();
		wire.answer({ id: wire.idOf(0), ok: true, agents: [{ id: "scout" }] });
		expect((await asked).map((one) => one.id)).toEqual(["scout"]);
	});

	// An older plane sent neither, and a console that assumed them crashed on the first row rather
	// than on the field it wanted.
	it("fills in what an older plane did not send", async () => {
		const asked = plane.agents();
		wire.answer({ id: wire.idOf(0), ok: true, agents: [{ id: "scout" }] });
		const [only] = await asked;
		expect(only?.asking).toEqual([]);
		expect(only?.wants).toEqual([]);
	});

	it("keeps the handler while the answer is still being written", async () => {
		const pieces: string[] = [];
		const asked = plane.wake("scout", "hello", (text) => pieces.push(text));
		const id = wire.idOf(0);
		wire.answer({ id, chunk: "one " });
		wire.answer({ id, chunk: "two " });
		wire.answer({ id, ok: true, text: "one two three" });
		await asked;
		expect(pieces).toEqual(["one ", "two "]);
	});

	it("refuses in the words the plane used", async () => {
		const asked = plane.command("scout", "/nope");
		wire.answer({ id: wire.idOf(0), ok: false, error: "No command “/nope”" });
		await expect(asked).rejects.toThrow("/nope");
	});

	// A promise still waiting on a connection that has gone is a spinner that never stops, which is
	// worse than an error.
	it("fails everything in flight when the connection goes", async () => {
		const asked = plane.agents();
		wire.drop("the plane went");
		await expect(asked).rejects.toThrow("the plane went");
		expect(plane.connected).toBe(false);
	});
});

describe("keys", () => {
	it("reads the providers a plane could be given one for", async () => {
		const asking = plane.providers();
		const id = wire.idOf(0);
		wire.answer({
			id,
			ok: true,
			providers: [
				{ id: "deepseek", keyEnv: "DEEPSEEK_API_KEY", models: ["pi"], held: true, here: true },
				{ id: "groq", keyEnv: "GROQ_API_KEY", models: [], held: false, here: false },
			],
		});
		const rows = await asking;
		expect(rows.map((row) => row.keyEnv)).toEqual(["DEEPSEEK_API_KEY", "GROQ_API_KEY"]);
		expect(rows[0]?.held).toBe(true);
	});

	// A plane too old to know the operation answers without the field rather than with an error, and
	// a screen that read `.length` off that crashed where it should have shown an empty list.
	it("reads an answer that carries no providers as none", async () => {
		const asking = plane.providers();
		wire.answer({ id: wire.idOf(0), ok: true });
		expect(await asking).toEqual([]);
	});

	it("sends the key and nothing comes back but the name", async () => {
		const setting = plane.setKey("OPENAI_API_KEY", "sk-secret");
		const sent = JSON.parse(wire.sent[0] ?? "{}") as Record<string, unknown>;
		expect(sent.op).toBe("key");
		expect(sent.keyEnv).toBe("OPENAI_API_KEY");
		expect(sent.value).toBe("sk-secret");
		// The plane answers with which key it set, never with what it set, and this resolves on that.
		wire.answer({ id: wire.idOf(0), ok: true, text: "OPENAI_API_KEY" });
		await expect(setting).resolves.toBeUndefined();
	});

	// Emptying the box is how a key is taken back, so an empty string has to reach the plane rather
	// than be read here as nothing to do.
	it("carries an empty value, which is the way a key is removed", async () => {
		const setting = plane.setKey("OPENAI_API_KEY", "");
		expect((JSON.parse(wire.sent[0] ?? "{}") as { value?: string }).value).toBe("");
		wire.answer({ id: wire.idOf(0), ok: true, text: "OPENAI_API_KEY" });
		await setting;
	});
});

describe("a gap in the connection", () => {
	// The bug: the transport reconnects by itself and nothing above it could tell, so a screen told
	// only about the start of a gap said the plane was gone for as long as the page stayed open —
	// over a console that had been answering again since a second later.
	it("says when it comes back, not only when it goes", async () => {
		const wire = new FakeWire();
		const client = new Plane(wire);
		const heard: string[] = [];
		client.onDown((why) => heard.push(`down: ${why.message}`));
		client.onUp(() => heard.push("up"));
		await client.connect();

		wire.drop("the plane went");
		expect(heard).toEqual(["down: the plane went"]);

		wire.back();
		expect(heard).toEqual(["down: the plane went", "up"]);
	});
});
