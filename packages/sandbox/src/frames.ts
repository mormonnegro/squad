/** Docker's stream identifiers in a multiplexed attach frame header. */
export const STDOUT = 1;
export const STDERR = 2;

export interface StreamFrame {
	readonly stream: number;
	readonly payload: Buffer;
}

const HEADER_BYTES = 8;

/**
 * Incremental parser for Docker's multiplexed attach protocol. Each frame is an 8-byte header
 * whose first byte is the stream id and whose last four are the payload length, big endian.
 *
 * A buffered parser is not enough for a live attach: a single TCP read can end mid-header or
 * mid-payload, so the remainder has to survive until the next chunk arrives.
 */
export class FrameSplitter {
	#pending: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): StreamFrame[] {
		this.#pending = this.#pending.byteLength === 0 ? chunk : Buffer.concat([this.#pending, chunk]);

		const frames: StreamFrame[] = [];
		let offset = 0;

		while (offset + HEADER_BYTES <= this.#pending.byteLength) {
			const length = this.#pending.readUInt32BE(offset + 4);
			const start = offset + HEADER_BYTES;
			if (start + length > this.#pending.byteLength) break;
			frames.push({
				stream: this.#pending[offset] ?? STDOUT,
				payload: this.#pending.subarray(start, start + length),
			});
			offset = start + length;
		}

		// subarray aliases the concatenated buffer, so the emitted payloads stay valid.
		this.#pending = this.#pending.subarray(offset);
		return frames;
	}

	/** Bytes held back waiting for the rest of their frame. Non-zero at close means truncation. */
	get pendingBytes(): number {
		return this.#pending.byteLength;
	}
}

/** Splits a complete, already-buffered multiplexed stream into its two channels. */
export function demultiplex(buffer: Buffer): {
	stdout: string;
	stderr: string;
} {
	const frames = new FrameSplitter().push(buffer);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	for (const frame of frames) {
		if (frame.stream === STDERR) stderr.push(frame.payload);
		else stdout.push(frame.payload);
	}
	return {
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8"),
	};
}
