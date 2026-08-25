import net from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSummary } from "../src/control-plane.ts";
import { type Door, LocalDoors, wanted } from "../src/doors.ts";

const doors: LocalDoors[] = [];
const shutting: (() => void)[] = [];

afterEach(() => {
	for (const one of doors.splice(0)) one.close();
	for (const shut of shutting.splice(0)) shut();
});

function opened(
	dial: (agentId: string, port: number) => Promise<Duplex>,
	said: string[] = [],
): LocalDoors {
	const one = new LocalDoors(dial, (agentId, detail, failed) =>
		said.push(`${failed === true ? "✗ " : ""}${agentId} ${detail}`),
	);
	doors.push(one);
	return one;
}

/** A port nothing holds, found the only way a port can be: by holding it and letting go. */
async function free(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
	const { port } = server.address() as net.AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** Whatever comes back from one connection, which is what a door is for. */
function reach(host: string, port: number, send: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host, port }, () => socket.write(send));
		let heard = "";
		socket.on("data", (chunk: Buffer) => {
			heard += chunk.toString("utf8");
		});
		socket.on("end", () => resolve(heard));
		socket.on("error", reject);
	});
}

/** Stands in for the sandbox: a server that answers what it was asked, in capitals. */
async function shouting(): Promise<number> {
	const server = net.createServer((socket) => {
		socket.on("data", (chunk: Buffer) => socket.end(chunk.toString("utf8").toUpperCase()));
	});
	await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
	shutting.push(() => server.close());
	return (server.address() as net.AddressInfo).port;
}

const summary = (id: string, served: Door["served"][]): AgentSummary => ({
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
	served,
});

describe("wanted", () => {
	it("is every port of every agent, each knowing whose it is", () => {
		expect(
			wanted([
				summary("scout", [{ port: 3000, at: 3000 }]),
				summary("scribe", [
					{ port: 3000, at: 3001 },
					{ port: 8080, at: 8080 },
				]),
			]),
		).toEqual([
			{ agentId: "scout", served: { port: 3000, at: 3000 } },
			{ agentId: "scribe", served: { port: 3000, at: 3001 } },
			{ agentId: "scribe", served: { port: 8080, at: 8080 } },
		]);
	});

	it("is nothing at all when nobody asked for anything", () => {
		expect(wanted([summary("scout", [])])).toEqual([]);
	});
});

describe("LocalDoors", () => {
	it("carries bytes from the operator's machine to the port inside", async () => {
		const inside = await shouting();
		const at = await free();
		const said: string[] = [];
		await opened(
			async () => net.createConnection({ host: "127.0.0.1", port: inside }),
			said,
		).reconcile([{ agentId: "scout", served: { port: 3000, at } }]);

		expect(await reach("127.0.0.1", at, "hola")).toBe("HOLA");
		expect(said).toEqual([`scout http://scout.localhost:${at} → :3000`]);
	});

	/**
	 * The whole reason a door is two listeners. `scout.localhost` resolves to `::1` before
	 * `127.0.0.1` — that is the order the resolver answers in on macOS — so a door bound only on the
	 * IPv4 address is a link that opens onto nothing in the browser it was printed for.
	 */
	it("answers on ::1 as well, which is what the printed link resolves to first", async () => {
		const inside = await shouting();
		const at = await free();
		await opened(async () => net.createConnection({ host: "127.0.0.1", port: inside })).reconcile([
			{ agentId: "scout", served: { port: 3000, at } },
		]);

		expect(await reach("::1", at, "hola")).toBe("HOLA");
	});

	it("dials the port inside the sandbox rather than the one it is reached on", async () => {
		const asked: [string, number][] = [];
		const inside = await shouting();
		const at = await free();
		await opened(async (agentId, port) => {
			asked.push([agentId, port]);
			return net.createConnection({ host: "127.0.0.1", port: inside });
		}).reconcile([{ agentId: "scribe", served: { port: 3000, at } }]);

		await reach("127.0.0.1", at, "hola");
		expect(asked).toEqual([["scribe", 3000]]);
	});

	// Settling runs with every answer to `agents`, which is every couple of seconds. Binding again
	// would fail on the port it already holds and put the failure in front of the operator.
	it("leaves a door that is already open alone", async () => {
		const inside = await shouting();
		const at = await free();
		const said: string[] = [];
		const local = opened(
			async () => net.createConnection({ host: "127.0.0.1", port: inside }),
			said,
		);
		const door = [{ agentId: "scout", served: { port: 3000, at } }];

		await local.reconcile(door);
		await local.reconcile(door);
		await local.reconcile(door);

		expect(said).toHaveLength(1);
		expect(await reach("127.0.0.1", at, "hola")).toBe("HOLA");
	});

	it("takes down a door the plane no longer says should be open", async () => {
		const inside = await shouting();
		const at = await free();
		const local = opened(async () => net.createConnection({ host: "127.0.0.1", port: inside }));
		await local.reconcile([{ agentId: "scout", served: { port: 3000, at } }]);
		await local.reconcile([]);

		await expect(reach("127.0.0.1", at, "hola")).rejects.toMatchObject({ code: "ECONNREFUSED" });
	});

	// One page is six connections. A port with nothing behind it would put six identical lines in the
	// feed for one click, which is how a feed stops being something anybody reads.
	it("says a dead port reached nothing once, not once per connection", async () => {
		const at = await free();
		const said: string[] = [];
		await opened(async () => {
			throw new Error("no such port");
		}, said).reconcile([{ agentId: "scout", served: { port: 3000, at } }]);

		for (let n = 0; n < 6; n += 1) await reach("127.0.0.1", at, "hola").catch(() => {});
		expect(said.filter((line) => line.startsWith("✗"))).toEqual([
			`✗ scout ${at} reached nothing — no such port`,
		]);
	});

	/**
	 * Half a door is worse than none: a number one family refuses is a number something on this
	 * machine already answers on, and a link that works in one client and not the next is a worse
	 * afternoon than being told the number is taken. Said once, too — a port something else holds is
	 * a port it will still hold in two seconds, and a line about that every two seconds is not a log.
	 */
	it("gives back the half it did bind when the other half is taken, and says so once", async () => {
		const server = net.createServer();
		const at = await free();
		await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: at }, resolve));
		shutting.push(() => server.close());

		const said: string[] = [];
		const local = opened(async () => net.createConnection({ host: "127.0.0.1", port: at }), said);
		const door = [{ agentId: "scout", served: { port: 3000, at } }];
		await local.reconcile(door);
		await local.reconcile(door);

		expect(said).toHaveLength(1);
		expect(said[0]).toContain(`✗ scout could not open ${at} here — 127.0.0.1 in use`);
		await expect(reach("::1", at, "hola")).rejects.toMatchObject({ code: "ECONNREFUSED" });
	});

	/**
	 * The failure this was found by, and the one a bind will not report. A dev server on the wildcard
	 * address and a door on `127.0.0.1` are two sockets to the kernel, and BSD gives the connection
	 * to the more specific of them — so the bind succeeds, the operator's own work stops answering,
	 * and the reason is an agent they were not thinking about at the time.
	 */
	it("will not take a number from a server holding the wildcard address", async () => {
		const at = await free();
		const theirs = net.createServer((socket) => socket.end("THEIRS"));
		await new Promise<void>((resolve) => theirs.listen({ port: at }, resolve));
		shutting.push(() => theirs.close());

		const inside = await shouting();
		const said: string[] = [];
		await opened(
			async () => net.createConnection({ host: "127.0.0.1", port: inside }),
			said,
		).reconcile([{ agentId: "scout", served: { port: 3000, at } }]);

		expect(said[0]).toContain("already answers there");
		expect(await reach("127.0.0.1", at, "hola")).toBe("THEIRS");
	});

	// Asking for the port again is what retries it, so a door that was dropped must not be remembered
	// as one that failed.
	it("tries a refused port again once it has been asked for again", async () => {
		const server = net.createServer();
		const at = await free();
		await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: at }, resolve));

		const inside = await shouting();
		const said: string[] = [];
		const local = opened(
			async () => net.createConnection({ host: "127.0.0.1", port: inside }),
			said,
		);
		const door = [{ agentId: "scout", served: { port: 3000, at } }];
		await local.reconcile(door);
		await new Promise<void>((resolve) => server.close(() => resolve()));

		await local.reconcile([]);
		await local.reconcile(door);
		expect(said[1]).toBe(`scout http://scout.localhost:${at} → :3000`);
	});

	it("gives every port back when the console goes", async () => {
		const inside = await shouting();
		const at = await free();
		const local = opened(async () => net.createConnection({ host: "127.0.0.1", port: inside }));
		await local.reconcile([{ agentId: "scout", served: { port: 3000, at } }]);
		local.close();

		await expect(reach("127.0.0.1", at, "hola")).rejects.toMatchObject({ code: "ECONNREFUSED" });
	});
});
