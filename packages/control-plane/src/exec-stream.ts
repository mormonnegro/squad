import { Duplex } from "node:stream";
import { FrameSplitter, type HijackedStream, STDERR } from "@agent-dive/sandbox";

/**
 * A `docker exec` stream as an ordinary duplex, with the daemon's framing removed in the reading
 * direction only.
 *
 * Two things need this and they are the same thing twice: reaching the plane's own socket from
 * outside its container, and reaching a port inside an agent's sandbox. Both run a relay by exec,
 * both read a multiplexed stdout, and for both stderr is how the relay says it could not connect at
 * all — so anything on stderr ends the stream, since a relay that is talking is not relaying.
 */
export class ExecStream extends Duplex {
	readonly #stream: HijackedStream;
	readonly #splitter = new FrameSplitter();

	#done = false;

	constructor(stream: HijackedStream) {
		super();
		this.#stream = stream;

		stream.socket.on("data", (chunk: Buffer) => this.#consume(chunk));
		stream.socket.once("error", (error: Error) => this.#fail(error));
		stream.socket.once("close", () => this.#finish());
		if (stream.head.byteLength > 0) this.#consume(stream.head);
	}

	override _read(): void {}

	/** Ends the relay's stdin, so it exits and the daemon lets go of the connection. */
	override _final(callback: (error?: Error | null) => void): void {
		this.#stream.socket.end(() => callback());
	}

	override _write(
		chunk: Buffer,
		_encoding: string,
		callback: (error?: Error | null) => void,
	): void {
		// Only the reply direction is multiplexed; the relay reads its stdin unframed.
		this.#stream.socket.write(chunk, callback);
	}

	override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this.#stream.socket.destroy();
		callback(error);
	}

	#consume(chunk: Buffer): void {
		if (this.#done) return;
		for (const frame of this.#splitter.push(chunk)) {
			if (frame.stream === STDERR) this.#fail(new Error(frame.payload.toString("utf8")));
			else if (frame.payload.byteLength > 0) this.push(frame.payload);
		}
	}

	#fail(error: Error): void {
		if (this.#done) return;
		this.#done = true;
		this.destroy(error);
	}

	/**
	 * The relay exits when its socket closes, and the exec stream closes behind it. Whoever hung up
	 * first, an ended conversation is not a failure — the caller already has its answer.
	 */
	#finish(): void {
		if (this.#done) return;
		this.#done = true;
		this.push(null);
	}
}
