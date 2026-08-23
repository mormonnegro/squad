import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	type ByteTransport,
	type ByteTransportHandlers,
	createExecTransportFactory,
} from "../src/transport.ts";

function frame(stream: number, payload: Buffer | string): Buffer {
	const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	const header = Buffer.alloc(8);
	header[0] = stream;
	header.writeUInt32BE(bytes.byteLength, 4);
	return Buffer.concat([header, bytes]);
}

interface Harness {
	transport: ByteTransport;
	/** Stands in for the container end of the exec stream. */
	remote: PassThrough;
	received: Uint8Array[];
	stderr: string[];
	closes: number;
	errors: Error[];
}

async function harness(head: Buffer = Buffer.alloc(0)): Promise<Harness> {
	const remote = new PassThrough();
	const received: Uint8Array[] = [];
	const stderr: string[] = [];
	const errors: Error[] = [];
	let closes = 0;

	const handlers: ByteTransportHandlers = {
		onData: (chunk) => received.push(chunk),
		onClose: () => {
			closes += 1;
		},
		onError: (error) => errors.push(error),
	};

	const factory = createExecTransportFactory({
		attach: async () => ({ socket: remote, head }),
		onStderr: (text) => stderr.push(text),
	});

	const transport = await factory(handlers);
	return {
		transport,
		remote,
		received,
		stderr,
		errors,
		get closes() {
			return closes;
		},
	};
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("createExecTransportFactory", () => {
	it("delivers stdout frame payloads as raw bytes", async () => {
		const h = await harness();
		h.remote.write(frame(1, "hello"));
		await flush();

		expect(Buffer.concat(h.received.map((c) => Buffer.from(c))).toString()).toBe("hello");
	});

	it("parses bytes buffered before the upgrade completed", async () => {
		const h = await harness(frame(1, "early"));
		await flush();

		expect(Buffer.concat(h.received.map((c) => Buffer.from(c))).toString()).toBe("early");
	});

	it("reassembles a frame split across reads", async () => {
		const h = await harness();
		const complete = frame(1, "split payload");
		h.remote.write(complete.subarray(0, 5));
		await flush();
		expect(h.received).toHaveLength(0);

		h.remote.write(complete.subarray(5));
		await flush();
		expect(Buffer.concat(h.received.map((c) => Buffer.from(c))).toString()).toBe("split payload");
	});

	it("routes stderr frames away from the protocol stream", async () => {
		const h = await harness();
		h.remote.write(frame(2, "relay: connection refused"));
		h.remote.write(frame(1, "payload"));
		await flush();

		expect(h.stderr).toEqual(["relay: connection refused"]);
		expect(Buffer.concat(h.received.map((c) => Buffer.from(c))).toString()).toBe("payload");
	});

	it("writes sent chunks to the process stdin unframed", async () => {
		const h = await harness();
		const written: Buffer[] = [];
		h.remote.on("data", (chunk: Buffer) => written.push(chunk));

		await h.transport.send(new Uint8Array([1, 2, 3]));
		await flush();

		expect(Buffer.concat(written)).toEqual(Buffer.from([1, 2, 3]));
	});

	it("reports a clean close once the stream ends", async () => {
		const h = await harness();
		h.remote.end();
		await flush();

		expect(h.closes).toBe(1);
		expect(h.errors).toHaveLength(0);
	});

	it("reports an error when the stream ends mid-frame", async () => {
		const h = await harness();
		h.remote.write(frame(1, "truncated").subarray(0, 9));
		await flush();
		h.remote.end();
		await flush();

		expect(h.errors.map((error) => error.message)).toContain("Exec transport closed mid-frame");
		expect(h.closes).toBe(0);
	});

	it("rejects sends after close", async () => {
		const h = await harness();
		h.transport.close();

		await expect(h.transport.send(new Uint8Array([1]))).rejects.toThrow("closed");
	});

	it("rejects a send that would exceed the pending byte limit", async () => {
		const remote = new PassThrough();
		const factory = createExecTransportFactory({
			attach: async () => ({ socket: remote, head: Buffer.alloc(0) }),
			maxPendingBytes: 4,
		});
		const transport = await factory({
			onData: () => {},
			onClose: () => {},
			onError: () => {},
		});

		await expect(transport.send(new Uint8Array(8))).rejects.toThrow("pending byte limit");
	});

	it("copies the caller's buffer so later mutation cannot corrupt the frame", async () => {
		const h = await harness();
		const written: Buffer[] = [];
		h.remote.on("data", (chunk: Buffer) => written.push(chunk));

		const chunk = new Uint8Array([9, 9, 9]);
		const sent = h.transport.send(chunk);
		chunk.fill(0);
		await sent;
		await flush();

		expect(Buffer.concat(written)).toEqual(Buffer.from([9, 9, 9]));
	});
});
