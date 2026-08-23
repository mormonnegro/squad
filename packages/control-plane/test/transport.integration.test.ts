import { DockerEngine, DockerSandboxManager } from "@agent-dive/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiSessionChannel, RELAY_PATH } from "../src/pi-session.ts";
import { type ByteTransportHandlers, createExecTransportFactory } from "../src/transport.ts";

const IMAGE = "agent-dive/sandbox:dev";
const AGENT_ID = "relay-itest";
/** Distinct per suite: test files run in parallel and tear their own network down. */
const TEST_NETWORK = "agent-dive-test-relay";
const SOCKET_PATH = "/home/agent/.run/echo.sock";

const engine = new DockerEngine();
const dockerUp = await engine.isAvailable();
const suite = dockerUp ? describe : describe.skip;

/**
 * Stands in for pi's server: a unix-socket server that upper-cases what it receives. The point of
 * the test is the byte channel, not the harness protocol.
 */
const ECHO_SERVER = `
import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
const socketPath = process.argv[2];
try { unlinkSync(socketPath); } catch {}
createServer((socket) => {
  socket.on("data", (chunk) => socket.write(chunk.toString("utf8").toUpperCase()));
}).listen(socketPath);
`;

function collect(): {
	handlers: ByteTransportHandlers;
	text: () => string;
	errors: Error[];
	waitFor: (needle: string) => Promise<void>;
} {
	const chunks: Buffer[] = [];
	const errors: Error[] = [];
	const text = (): string => Buffer.concat(chunks).toString("utf8");

	return {
		handlers: {
			onData: (chunk) => chunks.push(Buffer.from(chunk)),
			onClose: () => {},
			onError: (error) => errors.push(error),
		},
		text,
		errors,
		waitFor: async (needle) => {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (text().includes(needle)) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(
				`Timed out waiting for ${JSON.stringify(needle)}; saw ${JSON.stringify(text())}`,
			);
		},
	};
}

suite("exec transport against a live daemon", () => {
	const manager = new DockerSandboxManager(engine, TEST_NETWORK);

	beforeAll(async () => {
		await manager.destroy(AGENT_ID, { discardState: true });
		await manager.create({
			agentId: AGENT_ID,
			image: IMAGE,
			proxyUrl: "http://itest:token@egress:8080",
			caCertHostPath: "/dev/null",
		});
		await manager.start(AGENT_ID);

		await manager.exec(AGENT_ID, [
			"sh",
			"-c",
			`cat > /home/agent/.run/echo.mjs <<'SERVER'\n${ECHO_SERVER}\nSERVER`,
		]);
		await manager.exec(AGENT_ID, [
			"sh",
			"-c",
			`nohup node /home/agent/.run/echo.mjs ${SOCKET_PATH} >/home/agent/.run/echo.log 2>&1 &`,
		]);
	}, 120_000);

	afterAll(async () => {
		await manager.destroy(AGENT_ID, { discardState: true });
		await engine.request("DELETE", `/networks/${TEST_NETWORK}`).catch(() => {});
	}, 60_000);

	it("carries bytes to a socket inside the container and back", async () => {
		const sink = collect();
		const factory = createExecTransportFactory({
			attach: () => manager.attach(AGENT_ID, ["node", RELAY_PATH, SOCKET_PATH, "10000"]),
		});
		const transport = await factory(sink.handlers);

		await transport.send(new TextEncoder().encode("ping"));
		await sink.waitFor("PING");

		expect(sink.errors).toEqual([]);
		transport.close();
	}, 60_000);

	it("keeps message boundaries across many round trips", async () => {
		const sink = collect();
		const factory = createExecTransportFactory({
			attach: () => manager.attach(AGENT_ID, ["node", RELAY_PATH, SOCKET_PATH, "10000"]),
		});
		const transport = await factory(sink.handlers);

		for (let index = 0; index < 20; index += 1) {
			await transport.send(new TextEncoder().encode(`msg${index};`));
		}
		await sink.waitFor("MSG19;");

		const seen = sink.text();
		for (let index = 0; index < 20; index += 1) expect(seen).toContain(`MSG${index};`);
		transport.close();
	}, 60_000);

	it("carries a payload larger than a single socket read", async () => {
		const sink = collect();
		const factory = createExecTransportFactory({
			attach: () => manager.attach(AGENT_ID, ["node", RELAY_PATH, SOCKET_PATH, "10000"]),
		});
		const transport = await factory(sink.handlers);

		const payload = "x".repeat(256 * 1024);
		await transport.send(new TextEncoder().encode(`${payload}END`));
		await sink.waitFor("END");

		expect(sink.text().length).toBeGreaterThanOrEqual(payload.length);
		expect(sink.errors).toEqual([]);
		transport.close();
	}, 60_000);

	it("starts a hosted server once and bridges to it", async () => {
		const socketPath = "/home/agent/.run/hosted.sock";
		const channel = new PiSessionChannel({
			manager,
			agentId: AGENT_ID,
			socketPath,
			command: ["node", "/home/agent/.run/echo.mjs", socketPath],
		});

		expect(await channel.ensureServer()).toBe(true);
		// The socket appears asynchronously, so the relay's own retry is what closes the gap.
		expect(await channel.authToken()).toMatch(/^[0-9a-f]{64}$/);

		const sink = collect();
		const transport = await channel.transportFactory()(sink.handlers);
		await transport.send(new TextEncoder().encode("hosted"));
		await sink.waitFor("HOSTED");
		transport.close();

		expect(await channel.ensureServer()).toBe(false);
	}, 60_000);

	it("surfaces relay failure on stderr instead of hanging", async () => {
		const stderr: string[] = [];
		const sink = collect();
		const factory = createExecTransportFactory({
			attach: () =>
				manager.attach(AGENT_ID, ["node", RELAY_PATH, "/home/agent/.run/absent.sock", "300"]),
			onStderr: (text) => stderr.push(text),
		});
		const transport = await factory(sink.handlers);

		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && stderr.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		expect(stderr.join("")).toContain("timed out connecting");
		transport.close();
	}, 60_000);
});
