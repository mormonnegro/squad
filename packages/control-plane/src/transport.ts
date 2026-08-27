import type { Duplex } from "node:stream";
import { FrameSplitter, STDERR } from "@squad/sandbox";

/**
 * pi's client transport contract, restated structurally.
 *
 * pi-protocol is transport-neutral framed CBOR, and TypeScript matches these by shape, so an
 * adapter written against this interface is accepted by PiClient without this package taking a
 * dependency on pi itself. That keeps the runtime installable without the harness present.
 */
export interface ByteTransport {
	send(chunk: Uint8Array): Promise<void>;
	close(): void;
}

export interface ByteTransportHandlers {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

export type ByteTransportFactory = (
	handlers: ByteTransportHandlers,
) => ByteTransport | Promise<ByteTransport>;

export interface AttachedStream {
	readonly socket: Duplex;
	readonly head: Buffer;
}

/** How much unflushed data may queue before send rejects rather than growing without bound. */
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;

export interface ExecTransportOptions {
	/** Opens a command in the sandbox with stdin attached, returning the hijacked duplex. */
	attach: () => Promise<AttachedStream>;
	maxPendingBytes?: number;
	/** Receives whatever the attached process writes to stderr, which is where relays report faults. */
	onStderr?: (text: string) => void;
}

/**
 * Bridges pi's byte transport onto a Docker exec attach stream.
 *
 * The alternatives do not survive the sandbox's own containment: a host-run control plane cannot
 * reach an internal Docker network over TCP, and attaching a second, non-internal network would
 * hand the agent back the internet route the sandbox exists to remove. Bind-mounted unix sockets
 * work on Linux but are unreliable over Docker Desktop's file sharing. An exec stream needs no
 * ports, no shared filesystem, and behaves identically on both.
 */
export function createExecTransportFactory(options: ExecTransportOptions): ByteTransportFactory {
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;

	return async (handlers) => {
		const { socket, head } = await options.attach();
		return new ExecByteTransport(socket, head, handlers, maxPendingBytes, options.onStderr);
	};
}

class ExecByteTransport implements ByteTransport {
	readonly #socket: Duplex;
	readonly #handlers: ByteTransportHandlers;
	readonly #splitter = new FrameSplitter();
	readonly #maxPendingBytes: number;
	readonly #onStderr: ((text: string) => void) | undefined;
	#closed = false;
	#terminal = false;
	#pendingBytes = 0;

	constructor(
		socket: Duplex,
		head: Buffer,
		handlers: ByteTransportHandlers,
		maxPendingBytes: number,
		onStderr: ((text: string) => void) | undefined,
	) {
		this.#socket = socket;
		this.#handlers = handlers;
		this.#maxPendingBytes = maxPendingBytes;
		this.#onStderr = onStderr;

		socket.on("data", (chunk: Buffer) => this.#consume(chunk));
		socket.once("end", () => this.#finish());
		socket.once("close", () => this.#finish());
		socket.once("error", (error: Error) => {
			if (this.#terminal) return;
			this.#terminal = true;
			socket.destroy();
			this.#handlers.onError(error);
		});

		// Docker may already have buffered frames by the time the upgrade completed; these bytes
		// precede anything the socket will emit and are lost if not parsed first.
		if (head.byteLength > 0) this.#consume(head);
	}

	send(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Exec transport is closed"));
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("Exec transport exceeded its pending byte limit"));
		}

		// The attached process reads stdin unframed; only the reply direction is multiplexed.
		const bytes = Buffer.from(chunk.slice());
		this.#pendingBytes += bytes.byteLength;

		return new Promise<void>((resolve, reject) => {
			this.#socket.write(bytes, (error) => {
				this.#pendingBytes -= bytes.byteLength;
				if (error) reject(error);
				else resolve();
			});
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.destroy();
	}

	#consume(chunk: Buffer): void {
		if (this.#terminal) return;
		for (const frame of this.#splitter.push(chunk)) {
			if (frame.stream === STDERR) this.#onStderr?.(frame.payload.toString("utf8"));
			else if (frame.payload.byteLength > 0) this.#handlers.onData(new Uint8Array(frame.payload));
		}
	}

	#finish(): void {
		if (this.#terminal) return;
		this.#terminal = true;
		if (this.#splitter.pendingBytes > 0) {
			this.#handlers.onError(new Error("Exec transport closed mid-frame"));
			return;
		}
		this.#handlers.onClose();
	}
}
