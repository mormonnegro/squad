/**
 * The smallest thing that can speak Chrome's debugging protocol: a socket, a counter, and a map of
 * promises waiting for their reply.
 *
 * Written rather than installed for the reason everything else here is: this container holds a
 * browser and an operator's signed-in session, and the list of code with an opinion about that
 * should be short enough to read. Node has had a WebSocket client built in since 22, so the
 * dependency this would have been buys one thing that is already in the runtime.
 */

export interface CdpEvent {
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly sessionId?: string;
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

export class CdpError extends Error {
	constructor(method: string, message: string) {
		super(`${method}: ${message}`);
		this.name = "CdpError";
	}
}

export class Cdp {
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<(event: CdpEvent) => void>();
	#nextId = 1;

	/** Not the way in: `open` is, because a socket has to be connected before it is useful. */
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", (message) => this.#received(String(message.data)));
		// A closed socket with calls still waiting is a browser that died mid-verb. Rejecting them is
		// what turns that into an error the agent reads, rather than a turn that stops saying anything.
		socket.addEventListener("close", () => {
			for (const [, waiting] of this.#pending) waiting.reject(new Error("the browser went away"));
			this.#pending.clear();
		});
	}

	static async open(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), {
				once: true,
			});
		});
		return new Cdp(socket);
	}

	#received(raw: string): void {
		let message: {
			id?: number;
			result?: Record<string, unknown>;
			error?: { message?: string };
			method?: string;
			params?: Record<string, unknown>;
			sessionId?: string;
		};
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		if (typeof message.id === "number") {
			const waiting = this.#pending.get(message.id);
			if (waiting === undefined) return;
			this.#pending.delete(message.id);
			if (message.error !== undefined) {
				waiting.reject(new Error(message.error.message ?? "refused"));
				return;
			}
			waiting.resolve(message.result ?? {});
			return;
		}

		if (typeof message.method !== "string") return;
		const event: CdpEvent = {
			method: message.method,
			params: message.params ?? {},
			...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
		};
		for (const listener of this.#listeners) listener(event);
	}

	on(listener: (event: CdpEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<T> {
		const id = this.#nextId++;
		const message = JSON.stringify({
			id,
			method,
			params,
			...(sessionId !== undefined ? { sessionId } : {}),
		});
		const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});
		this.#socket.send(message);
		try {
			return (await reply) as T;
		} catch (error) {
			throw new CdpError(method, (error as Error).message);
		}
	}

	close(): void {
		this.#socket.close();
	}
}
