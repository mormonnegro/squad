import net, { type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { AgentSummary } from "./control-plane.ts";
import { type Served, servedAt } from "./ports.ts";

/**
 * Both loopback addresses, and both every time.
 *
 * The link an agent is given says `<agent>.localhost`, and a browser resolving that gets `::1`
 * before `127.0.0.1` — that is the order the resolver answers in on macOS. A door bound only on the
 * IPv4 one is a link that opens onto nothing, and what that looks like from the outside is the
 * agent's server being broken.
 */
const LOOPBACK = ["127.0.0.1", "::1"] as const;

/** A port an agent is serving, and the agent whose sandbox it is inside. */
export interface Door {
	readonly agentId: string;
	readonly served: Served;
}

/** What the plane says should be open, out of what it says about the agents. */
export function wanted(agents: readonly AgentSummary[]): readonly Door[] {
	return agents.flatMap((agent) => agent.served.map((served) => ({ agentId: agent.id, served })));
}

function key(door: Door): string {
	return `${door.agentId}:${door.served.port}:${door.served.at}`;
}

/**
 * The operator's end of `/serve`: real listeners, on the machine a person is sitting at.
 *
 * This is the half of the plane that cannot live on the server. The server is where the agents run
 * and where the sandboxes are, and the sandbox network is unrouted on purpose — nothing is published
 * off it and nothing is going to be. So the console opens the port instead, on its own loopback, and
 * every byte crosses the control socket it was already talking over. What that buys is a link that
 * works from a laptop against a plane on a VPS without a port being opened on the VPS at all.
 */
export class LocalDoors {
	readonly #dial: (agentId: string, port: number) => Promise<Duplex>;
	readonly #say: (agentId: string, detail: string, failed?: boolean) => void;
	readonly #open = new Map<string, readonly Server[]>();
	readonly #complained = new Set<string>();
	#tail: Promise<void> = Promise.resolve();

	constructor(
		dial: (agentId: string, port: number) => Promise<Duplex>,
		say: (agentId: string, detail: string, failed?: boolean) => void,
	) {
		this.#dial = dial;
		this.#say = say;
	}

	/**
	 * Makes what is open match what is wanted.
	 *
	 * Called with every answer to `agents`, which is every couple of seconds, so it has to be cheap
	 * when nothing changed and it has to be serial: binding a port takes a tick, and two of these
	 * overlapping would both find it unbound and both try for it.
	 */
	reconcile(doors: readonly Door[]): Promise<void> {
		const next = this.#tail.then(() => this.#settle(doors));
		this.#tail = next.catch(() => {});
		return next;
	}

	close(): void {
		for (const servers of this.#open.values()) for (const server of servers) server.close();
		this.#open.clear();
		this.#complained.clear();
	}

	async #settle(doors: readonly Door[]): Promise<void> {
		const keys = new Set(doors.map(key));
		for (const [was, servers] of this.#open) {
			if (keys.has(was)) continue;
			this.#open.delete(was);
			this.#complained.delete(was);
			for (const server of servers) server.close();
		}

		for (const door of doors) {
			const id = key(door);
			if (this.#open.has(id)) continue;
			// Recorded before it is bound, and left recorded even when every address refused it: a port
			// something else on this machine holds is a port it will still hold in two seconds, and a
			// line about that every two seconds is not a log. Asking for the port again is what retries.
			this.#open.set(id, []);
			await this.#bind(id, door);
		}
	}

	async #bind(id: string, door: Door): Promise<void> {
		const bound: Server[] = [];
		const refused: string[] = [];
		for (const host of LOOPBACK) {
			const server = net.createServer((socket) => void this.#join(id, door, socket));
			try {
				await listen(server, host, door.served.at);
				bound.push(server);
			} catch (error) {
				server.close();
				refused.push(
					`${host} ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
				);
			}
		}

		if (bound.length === 0) {
			this.#say(
				door.agentId,
				`could not open ${door.served.at} here — ${refused.join(", ")}`,
				true,
			);
			return;
		}
		this.#open.set(id, bound);
		// A machine with no IPv6 refuses `::1` and nothing is wrong, so the half that worked is the news
		// and the half that did not is a parenthesis on the same line rather than a failure of its own.
		const half = refused.length > 0 ? ` (${refused.join(", ")})` : "";
		this.#say(door.agentId, `${servedAt(door.agentId, door.served)} → :${door.served.port}${half}`);
	}

	/** One connection: a stream through the plane into the sandbox, joined to the socket both ways. */
	async #join(id: string, door: Door, socket: Socket): Promise<void> {
		socket.on("error", () => socket.destroy());
		let stream: Duplex;
		try {
			stream = await this.#dial(door.agentId, door.served.port);
		} catch (error) {
			socket.destroy();
			// One page is six connections, so a port with nothing behind it would put six identical
			// lines in the feed for one click. The first one is the news; the rest are the same news.
			if (this.#complained.has(id)) return;
			this.#complained.add(id);
			this.#say(
				door.agentId,
				`${door.served.at} reached nothing — ${(error as Error).message}`,
				true,
			);
			return;
		}
		this.#complained.delete(id);
		const shut = (): void => {
			socket.destroy();
			stream.destroy();
		};
		socket.pipe(stream);
		stream.pipe(socket);
		socket.on("close", shut);
		stream.on("error", shut);
		stream.on("close", shut);
	}
}

function listen(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const refused = (error: Error): void => reject(error);
		server.once("error", refused);
		server.listen({ host, port }, () => {
			server.off("error", refused);
			resolve();
		});
	});
}
