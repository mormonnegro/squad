import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A public place where two ends that cannot be dialled find each other.
 *
 * The problem it exists for: a plane is on somebody's loopback or behind somebody's NAT, and a
 * browser is on somebody's laptop, and neither can open a connection to the other. Both of them can
 * open one outwards, so this is the place they both open one to.
 *
 * It is a switchboard and deliberately nothing else. It does not know what the protocol is, cannot
 * read a frame, and holds no credential of anybody's — what it is given is a room number, which is
 * derived one-way from a secret it is never told. Everything it could be tempted to do with the
 * traffic is foreclosed by not having the key, which is the only guarantee here worth making,
 * because it is the only one that does not rest on the operator's good behaviour.
 *
 * SSE down and POST up, rather than a socket, for the reason the plane's own browser door already
 * gives: reconnection is the hard half of a live connection and this is the transport where it is
 * already written. It also crosses every proxy that has ever been put in front of anything.
 */
export interface RendezvousOptions {
	readonly port?: number;
	readonly host?: string;
	/** The most a single frame may carry. A control frame is a line of JSON; this is generous. */
	readonly frameLimit?: number;
	/** How many frames to hold for an end that is not connected before dropping the oldest. */
	readonly queueLimit?: number;
	/** How many rooms may exist at once. The ceiling on what one relay costs to run. */
	readonly roomLimit?: number;
	/** How long a room with nobody in it survives before it is forgotten, in milliseconds. */
	readonly idleMs?: number;
}

const FRAME_LIMIT = 256 * 1024;
const QUEUE_LIMIT = 64;
const ROOM_LIMIT = 10_000;
const IDLE_MS = 60_000;
const ROOM = /^\/r\/([0-9a-f]{32})\/(plane|console)$/;

type Side = "plane" | "console";

/** One end of one room: where its frames are sent, and where they wait when it is not here. */
interface End {
	waiting: string[];
	/** Written out rather than optional, because leaving is assigning undefined to it. */
	response: ServerResponse | undefined;
}

interface Room {
	plane: End;
	console: End;
	idleSince: number;
}

export class Rendezvous {
	readonly #options: RendezvousOptions;
	readonly #rooms = new Map<string, Room>();
	readonly #server: Server;
	#sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(options: RendezvousOptions = {}) {
		this.#options = options;
		this.#server = createServer((request, response) => {
			void this.#handle(request, response).catch(() => {
				if (!response.headersSent) response.writeHead(500).end();
			});
		});
	}

	get rooms(): number {
		return this.#rooms.size;
	}

	listen(): Promise<number> {
		return new Promise((settle, fail) => {
			this.#server.once("error", fail);
			this.#server.listen(this.#options.port ?? 8790, this.#options.host, () => {
				const at = this.#server.address();
				// Paced by how long a room is allowed to sit empty rather than by a number of its own,
				// so that shortening the one does not leave rooms alive for the length of the other.
				const idle = this.#options.idleMs ?? IDLE_MS;
				this.#sweeper = setInterval(() => this.#sweep(), Math.min(10_000, Math.max(50, idle / 2)));
				// So a relay is not the reason a process cannot exit.
				this.#sweeper.unref?.();
				settle(typeof at === "object" && at !== null ? at.port : 0);
			});
		});
	}

	async close(): Promise<void> {
		if (this.#sweeper !== undefined) clearInterval(this.#sweeper);
		for (const room of this.#rooms.values()) {
			room.plane.response?.end();
			room.console.response?.end();
		}
		this.#rooms.clear();
		await new Promise<void>((settle) => this.#server.close(() => settle()));
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		if (path === "/health") {
			response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
			return;
		}

		// Anyone may knock, because a room number is the only credential in this system and a browser
		// on any page may hold one. What protects the traffic is that the relay cannot read it.
		if (request.method === "OPTIONS") {
			response.writeHead(204, cors()).end();
			return;
		}

		const matched = ROOM.exec(path);
		if (matched === null) {
			response.writeHead(404, cors()).end();
			return;
		}
		const [, id, side] = matched as unknown as [string, string, Side];

		if (request.method === "GET") {
			this.#listen(id, side, response);
			return;
		}
		if (request.method === "POST") {
			await this.#post(id, side, request, response);
			return;
		}
		response.writeHead(405, cors()).end();
	}

	/** One end taking up its place in a room, and everything that waited for it while it was gone. */
	#listen(id: string, side: Side, response: ServerResponse): void {
		const room = this.#room(id);
		if (room === undefined) {
			response.writeHead(503, cors()).end("This relay is full.");
			return;
		}
		const end = room[side];
		// A reconnection, which is what an EventSource does on its own. The old one is finished rather
		// than left holding a socket nobody reads.
		end.response?.end();
		end.response = response;
		room.idleSince = 0;

		response.writeHead(200, {
			...cors(),
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
			// Proxies that buffer would hold a console's answer until enough of them had accumulated.
			"x-accel-buffering": "no",
		});
		response.write(": open\n\n");

		const held = end.waiting;
		end.waiting = [];
		for (const frame of held) response.write(`data: ${frame}\n\n`);

		const beat = setInterval(() => response.write(": beat\n\n"), 25_000);
		beat.unref?.();
		const done = (): void => {
			clearInterval(beat);
			if (end.response === response) {
				end.response = undefined;
				room.idleSince = Date.now();
			}
		};
		response.on("close", done);
		response.on("error", done);
	}

	/** One end speaking. The frame is for the other one, and this end never sees its own. */
	async #post(
		id: string,
		side: Side,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const room = this.#room(id);
		if (room === undefined) {
			response.writeHead(503, cors()).end("This relay is full.");
			return;
		}
		const limit = this.#options.frameLimit ?? FRAME_LIMIT;
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			if (body.length > limit) {
				response.writeHead(413, cors()).end("That frame is too big.");
				request.destroy();
				return;
			}
		}
		const frame = body.trim();
		if (frame.length === 0) {
			response.writeHead(400, cors()).end("Nothing to carry.");
			return;
		}

		const far = room[side === "plane" ? "console" : "plane"];
		if (far.response !== undefined) {
			far.response.write(`data: ${frame}\n\n`);
		} else {
			// Kept, but not without end. A queue that grew for an end that never comes back is how a
			// switchboard becomes storage, and storage is a thing to be filled up by strangers.
			far.waiting.push(frame);
			while (far.waiting.length > (this.#options.queueLimit ?? QUEUE_LIMIT)) far.waiting.shift();
		}
		room.idleSince =
			far.response === undefined && room[side].response === undefined ? Date.now() : 0;
		response.writeHead(204, cors()).end();
	}

	#room(id: string): Room | undefined {
		const found = this.#rooms.get(id);
		if (found !== undefined) return found;
		if (this.#rooms.size >= (this.#options.roomLimit ?? ROOM_LIMIT)) return undefined;
		const made: Room = {
			plane: { waiting: [], response: undefined },
			console: { waiting: [], response: undefined },
			idleSince: Date.now(),
		};
		this.#rooms.set(id, made);
		return made;
	}

	/** Rooms nobody is in stop existing, so that what this holds is what is happening. */
	#sweep(): void {
		const idle = this.#options.idleMs ?? IDLE_MS;
		for (const [id, room] of this.#rooms) {
			const empty = room.plane.response === undefined && room.console.response === undefined;
			if (empty && room.idleSince !== 0 && Date.now() - room.idleSince > idle)
				this.#rooms.delete(id);
		}
	}
}

/**
 * Open to every origin, which is the right answer for this one thing.
 *
 * A console is a page somewhere — the one this project hosts, one an operator hosts, one served by
 * another plane — and which of them may use a relay is not a question a relay can answer, because
 * the room number is the whole of what it knows. Refusing an origin here would stop nobody: the
 * frames are sealed, and holding the room is already holding nothing.
 */
function cors(): Record<string, string> {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-max-age": "600",
	};
}
