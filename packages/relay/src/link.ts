import { keyOf, Opener, roomOf, Sealer, type Secret } from "./seal.ts";

/**
 * One end of a relayed connection, as the two ends both see it.
 *
 * The protocol underneath is newline-delimited JSON and it does not know any of this is happening:
 * a line goes in one end and comes out the other, which is the same promise `squad relay` already
 * makes about an SSH connection. What is added here is the sealing, and the fact that both ends
 * dial outwards rather than one of them being dialled.
 */
export interface Link {
	/** Hand one protocol line to the far end. */
	send(line: string): Promise<void>;
	close(): void;
}

export interface LinkOptions {
	/** Where the rendezvous is, e.g. `https://relay.example.com`. */
	readonly origin: string;
	/** The plane's web token. Both ends have it; the relay never does. */
	readonly secret: Secret;
	/** Which end this is. The two sides of a room are named so neither hears itself. */
	readonly side: "plane" | "console";
	/** Every protocol line the far end sent, in order. */
	readonly onLine: (line: string) => void;
	/** The connection has gone. Whoever is waiting on an answer should be told. */
	readonly onDown: (why: Error) => void;
	/**
	 * A frame that would not open.
	 *
	 * Separate from onDown because it is a different event with a different meaning: the connection
	 * is fine and something arrived that this key does not authenticate — a replay, a stale frame
	 * from a previous session, or somebody posting into the room. None of them is a reason to tear
	 * down a working connection, and all of them are worth counting.
	 */
	readonly onRefused?: (why: Error) => void;
	/** For tests, and for a Node old enough to lack one. */
	readonly fetch?: typeof globalThis.fetch;
}

/**
 * Dial the rendezvous and stay there.
 *
 * The stream is read to its end and never reconnects here on purpose: what to do about a connection
 * that dropped is a question the two ends answer differently — a browser's EventSource reconnects
 * by itself, and a plane wants a backoff it controls — so this reports and the caller decides.
 */
export async function link(options: LinkOptions): Promise<Link> {
	const room = await roomOf(options.secret);
	const key = await keyOf(options.secret);
	const sealer = new Sealer(key, room);
	const opener = new Opener(key, room);
	const call = options.fetch ?? globalThis.fetch;
	const at = `${options.origin.replace(/\/+$/, "")}/r/${room}/${options.side}`;
	const stop = new AbortController();

	const stream = await call(at, {
		headers: { accept: "text/event-stream" },
		signal: stop.signal,
	});
	const body = stream.body;
	if (!stream.ok || body === null) {
		throw new Error(`The relay would not open that room: ${stream.status}`);
	}

	void (async () => {
		const reader = body.getReader();
		const decode = new TextDecoder();
		let buffered = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += decode.decode(value, { stream: true });
				let cut = buffered.indexOf("\n\n");
				while (cut !== -1) {
					const frame = buffered.slice(0, cut);
					buffered = buffered.slice(cut + 2);
					const data = /^data: (.*)$/m.exec(frame)?.[1];
					if (data !== undefined && data.length > 0) {
						try {
							options.onLine(await opener.open(data));
						} catch (error) {
							// Dropped, and said out loud to whoever wants to know. A frame that does not open
							// is not this connection's problem to have an opinion about.
							options.onRefused?.(error as Error);
						}
					}
					cut = buffered.indexOf("\n\n");
				}
			}
			options.onDown(new Error("The relay closed the connection."));
		} catch (error) {
			if (!stop.signal.aborted) options.onDown(error as Error);
		}
	})();

	return {
		async send(line: string): Promise<void> {
			const answer = await call(at, { method: "POST", body: await sealer.seal(line) });
			if (!answer.ok) throw new Error(`The relay refused that frame: ${answer.status}`);
		},
		close(): void {
			stop.abort();
		},
	};
}
