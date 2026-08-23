import { describe, expect, it } from "vitest";
import { demultiplex, FrameSplitter, STDERR, STDOUT } from "../src/frames.ts";

function frame(stream: number, text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	const header = Buffer.alloc(8);
	header[0] = stream;
	header.writeUInt32BE(payload.byteLength, 4);
	return Buffer.concat([header, payload]);
}

describe("FrameSplitter", () => {
	it("splits several frames delivered in one chunk", () => {
		const frames = new FrameSplitter().push(
			Buffer.concat([frame(STDOUT, "one"), frame(STDERR, "two")]),
		);
		expect(frames).toHaveLength(2);
		expect(frames[0]?.stream).toBe(STDOUT);
		expect(frames[0]?.payload.toString()).toBe("one");
		expect(frames[1]?.stream).toBe(STDERR);
		expect(frames[1]?.payload.toString()).toBe("two");
	});

	it("holds back a header split across chunks", () => {
		const splitter = new FrameSplitter();
		const complete = frame(STDOUT, "hello");

		expect(splitter.push(complete.subarray(0, 3))).toEqual([]);
		expect(splitter.push(complete.subarray(3))).toMatchObject([{ stream: STDOUT }]);
		expect(splitter.pendingBytes).toBe(0);
	});

	it("holds back a payload split across chunks", () => {
		const splitter = new FrameSplitter();
		const complete = frame(STDOUT, "hello world");

		expect(splitter.push(complete.subarray(0, 10))).toEqual([]);
		expect(splitter.pendingBytes).toBeGreaterThan(0);

		const frames = splitter.push(complete.subarray(10));
		expect(frames[0]?.payload.toString()).toBe("hello world");
		expect(splitter.pendingBytes).toBe(0);
	});

	it("reassembles a stream delivered one byte at a time", () => {
		const splitter = new FrameSplitter();
		const stream = Buffer.concat([frame(STDOUT, "abc"), frame(STDOUT, "de")]);
		const payloads: string[] = [];

		for (const byte of stream) {
			for (const parsed of splitter.push(Buffer.from([byte]))) {
				payloads.push(parsed.payload.toString());
			}
		}

		expect(payloads).toEqual(["abc", "de"]);
	});

	it("reports pending bytes when the stream is truncated mid-payload", () => {
		const splitter = new FrameSplitter();
		splitter.push(frame(STDOUT, "hello").subarray(0, 9));
		expect(splitter.pendingBytes).toBe(9);
	});

	it("treats a zero-length payload as a complete frame", () => {
		const frames = new FrameSplitter().push(frame(STDOUT, ""));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload.byteLength).toBe(0);
	});
});

describe("demultiplex", () => {
	it("separates the two channels of a buffered stream", () => {
		const result = demultiplex(
			Buffer.concat([frame(STDOUT, "out1"), frame(STDERR, "err"), frame(STDOUT, "out2")]),
		);
		expect(result.stdout).toBe("out1out2");
		expect(result.stderr).toBe("err");
	});

	it("returns empty channels for an empty stream", () => {
		expect(demultiplex(Buffer.alloc(0))).toEqual({ stdout: "", stderr: "" });
	});
});
