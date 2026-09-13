import http from "node:http";
import type { AddressInfo } from "node:net";
import type { NewAgentEvent, TrustLevel } from "@squad/events";
import { type Channel, ChannelError, type Reply } from "./channel.ts";
import { asked, authentic, deliveryIn, type Signer, signedHeaders } from "./signer.ts";

export interface Hook {
	/** Path segment the sender posts to, and the suffix of the channel name. */
	readonly id: string;
	readonly agentId: string;
	/** Shared secret for the request signature. */
	readonly secret: string;
	/** Who is at the other end, which decides how the signature is read. Defaults to this plane's. */
	readonly from?: Signer;
	/**
	 * Which kinds of event are worth a turn. Empty, or absent, is all of them.
	 *
	 * The difference between a trigger and a firehose. Stripe sends every event on the account to
	 * every endpoint that will take one, and an agent woken by `invoice.paid` two hundred times a day
	 * to decide it is not interested is an agent spending its ceiling on deciding that.
	 */
	readonly only?: readonly string[];
	/** Defaults to public. Operator is refused; see {@link WebhookChannel}. */
	readonly trust?: TrustLevel;
	/** Where replies are posted. Configuration only, never taken from the payload. */
	readonly replyUrl?: string;
	/**
	 * How many turns a minute this hook may cause. Defaults to {@link DEFAULT_MOST_A_MINUTE}.
	 *
	 * A ceiling on the door rather than on the agent. Everything else here is about whether a
	 * delivery is genuine, and a genuine backlog of four hundred deliveries arriving at once is the
	 * shape most likely to spend a day's budget in a minute — so the hook stops accepting and the
	 * sender, which is built to retry, retries.
	 */
	readonly atMostPerMinute?: number;
}

export interface WebhookPublisher {
	publish(event: NewAgentEvent): Promise<unknown>;
}

/**
 * Whether this exact delivery has been handled before, by the sender's own id for it.
 *
 * Every one of these senders retries, and a retry is not a second event: Stripe re-sends until it
 * gets a 2xx and keeps trying for days, so an agent that wrote a report on a cancelled subscription
 * would write it again, and again. Asked of the caller rather than kept here because the answer has
 * to outlive a restart, and a map in this object does not.
 */
export type Seen = (hookId: string, deliveryId: string) => Promise<boolean> | boolean;

export interface WebhookChannelOptions {
	readonly hooks: readonly Hook[];
	readonly publisher: WebhookPublisher;
	/** Path the hooks live under. Defaults to "/hooks". */
	readonly basePath?: string;
	readonly maxBodyBytes?: number;
	readonly toleranceSeconds?: number;
	readonly now?: () => Date;
	readonly fetch?: typeof globalThis.fetch;
	readonly onError?: (error: Error) => void;
	/** Whether a delivery has been handled before. Without one, a retry is a second turn. */
	readonly seen?: Seen;
	/** Said when a delivery was authentic and went no further, for whoever is watching the plane. */
	readonly onDropped?: (hookId: string, why: "repeat" | "not asked for" | "too many") => void;
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_TOLERANCE_SECONDS = 300;

/** Turns a minute one hook may cause, when nothing else is said. Roughly one every second. */
export const DEFAULT_MOST_A_MINUTE = 60;

/** The headers as one flat object, since which of them matter is the signer's business. */
function headers(request: http.IncomingMessage): Record<string, string | undefined> {
	const flat: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(request.headers)) {
		flat[name] = Array.isArray(value) ? value[0] : value;
	}
	return flat;
}

interface Body {
	readonly text: string;
	readonly tooLarge: boolean;
}

function readBody(request: http.IncomingMessage, limit: number): Promise<Body> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;

		request.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			// Pausing rather than destroying: the sender should learn why it was refused, and
			// destroying the socket mid-upload reaches it as a connection reset instead.
			if (size > limit) {
				request.pause();
				resolve({ text: "", tooLarge: true });
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () =>
			resolve({ text: Buffer.concat(chunks).toString("utf8"), tooLarge: false }),
		);
		request.on("error", reject);
	});
}

/**
 * Turns signed HTTP posts into events, and posts replies back to the hook's configured URL.
 *
 * A hook may not carry operator trust. The secret proves which system sent the request, not that a
 * human meant what is inside it: a GitHub hook is authentic while relaying an issue body written by
 * a stranger. Treating the payload as data keeps "authenticated" from quietly becoming "trusted".
 */
export class WebhookChannel implements Channel {
	readonly name = "webhook";
	readonly #hooks = new Map<string, Hook>();
	readonly #publisher: WebhookPublisher;
	readonly #basePath: string;
	readonly #maxBodyBytes: number;
	readonly #toleranceSeconds: number;
	readonly #now: () => Date;
	readonly #fetch: typeof globalThis.fetch;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #seen: Seen | undefined;
	readonly #onDropped:
		| ((hookId: string, why: "repeat" | "not asked for" | "too many") => void)
		| undefined;
	/** When each hook last woke somebody, newest first, kept only as far back as the ceiling needs. */
	readonly #woke = new Map<string, number[]>();
	readonly #server: http.Server;

	constructor(options: WebhookChannelOptions) {
		for (const hook of options.hooks) {
			if (hook.trust === "operator") {
				throw new ChannelError(`Hook "${hook.id}" may not carry operator trust`);
			}
			this.#hooks.set(hook.id, hook);
		}

		this.#publisher = options.publisher;
		this.#basePath = options.basePath ?? "/hooks";
		this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		this.#toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
		this.#now = options.now ?? ((): Date => new Date());
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#onError = options.onError;
		this.#seen = options.seen;
		this.#onDropped = options.onDropped;
		this.#server = http.createServer((request, response) => {
			void this.handle(request, response);
		});
	}

	/**
	 * Puts a hook up, or replaces the one of that name.
	 *
	 * Hooks used to be only what the configuration file declared, which made a trigger a thing you
	 * could not add without editing a file and restarting the plane — and the file is the operator's
	 * document about what they agreed to, not a place for a console to write.
	 */
	hold(hook: Hook): void {
		if (hook.trust === "operator") {
			throw new ChannelError(`Hook "${hook.id}" may not carry operator trust`);
		}
		this.#hooks.set(hook.id, hook);
	}

	/** Takes one down. True when there was one to take down. */
	drop(id: string): boolean {
		this.#woke.delete(id);
		return this.#hooks.delete(id);
	}

	has(id: string): boolean {
		return this.#hooks.has(id);
	}

	async listen(port = 0, host = "127.0.0.1"): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(port, host, () => {
				this.#server.removeListener("error", reject);
				resolve();
			});
		});
		return (this.#server.address() as AddressInfo).port;
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	async send(reply: Reply): Promise<void> {
		const hookId = reply.channel.slice(`${this.name}:`.length);
		const hook = this.#hooks.get(hookId);
		if (!hook) throw new ChannelError(`Unknown hook "${hookId}"`);
		if (hook.replyUrl === undefined) {
			throw new ChannelError(`Hook "${hookId}" has no reply URL configured`);
		}

		const timestamp = Math.floor(this.#now().getTime() / 1000).toString();
		const body = JSON.stringify({ agentId: reply.agentId, body: reply.body });
		const response = await this.#fetch(hook.replyUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signedHeaders(hook.secret, timestamp, body),
			},
			body,
		});
		if (!response.ok) {
			throw new ChannelError(`Reply to hook "${hookId}" failed with ${response.status}`);
		}
	}

	/**
	 * Answers one delivery, on this channel's own server or on somebody else's.
	 *
	 * Public so a plane that already publishes a door to the internet can put the hooks behind that
	 * one instead of asking anybody to expose a second port. What guards this path is the signature
	 * and nothing else — the sender is Stripe, and Stripe has never heard of this plane's key.
	 */
	async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		try {
			const { status, payload } = await this.#route(request);
			const headers: http.OutgoingHttpHeaders = { "content-type": "application/json" };
			// The rest of a refused upload is never read, so the connection cannot be reused.
			if (status === 413) headers.connection = "close";
			response.writeHead(status, headers);
			response.end(JSON.stringify(payload));
		} catch (error) {
			this.#onError?.(error instanceof Error ? error : new Error(String(error)));
			if (response.headersSent) return;
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "internal_error" }));
		}
	}

	async #route(
		request: http.IncomingMessage,
	): Promise<{ status: number; payload: Record<string, string> }> {
		if (request.method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };

		const path = (request.url ?? "").split("?")[0] ?? "";
		if (!path.startsWith(`${this.#basePath}/`))
			return { status: 404, payload: { error: "not_found" } };

		const hook = this.#hooks.get(decodeURIComponent(path.slice(this.#basePath.length + 1)));

		const { text: body, tooLarge } = await readBody(request, this.#maxBodyBytes);
		if (tooLarge) return { status: 413, payload: { error: "body_too_large" } };

		// An unknown hook is rejected like a bad signature so the endpoint cannot be probed for
		// which hooks exist, and only after the body was read so the shape of the reply is the same.
		if (!hook) return { status: 401, payload: { error: "unauthorized" } };
		const from = hook.from ?? "squad";
		const authenticated = authentic(from, {
			headers: headers(request),
			body,
			secret: hook.secret,
			now: this.#now(),
			toleranceSeconds: this.#toleranceSeconds,
		});
		if (!authenticated) return { status: 401, payload: { error: "unauthorized" } };

		// Everything from here on is a genuine delivery that is not going to wake anybody, and each
		// one answers 2xx: a sender told anything else retries, and retrying is exactly what should
		// not happen to a delivery this plane has decided it does not want.
		const delivery = deliveryIn(from, headers(request), body);
		if (!asked(hook.only ?? [], delivery.kind)) {
			this.#onDropped?.(hook.id, "not asked for");
			return { status: 200, payload: { status: "ignored" } };
		}
		if (delivery.id !== undefined && this.#seen !== undefined) {
			if (await this.#seen(hook.id, delivery.id)) {
				this.#onDropped?.(hook.id, "repeat");
				return { status: 200, payload: { status: "already handled" } };
			}
		}
		if (!this.#under(hook)) {
			this.#onDropped?.(hook.id, "too many");
			// The one case that is answered with a refusal on purpose: the delivery is genuine and
			// wanted, and what this plane cannot do is take it right now. 429 is what a sender built
			// to retry reads as "again, in a moment".
			return { status: 429, payload: { error: "too_many_requests" } };
		}

		await this.#publisher.publish({
			agentId: hook.agentId,
			source: "webhook",
			trust: hook.trust ?? "public",
			channel: `${this.name}:${hook.id}`,
			subject: delivery.kind === undefined ? `Webhook ${hook.id}` : `${hook.id}: ${delivery.kind}`,
			body,
			replyTo: hook.id,
			...(delivery.id === undefined ? {} : { metadata: { delivery: delivery.id } }),
		});

		return { status: 202, payload: { status: "accepted" } };
	}

	/** Whether this hook has woken somebody fewer times in the last minute than it is allowed to. */
	#under(hook: Hook): boolean {
		const ceiling = hook.atMostPerMinute ?? DEFAULT_MOST_A_MINUTE;
		const now = this.#now().getTime();
		const recent = (this.#woke.get(hook.id) ?? []).filter((at) => now - at < 60_000);
		if (recent.length >= ceiling) {
			this.#woke.set(hook.id, recent);
			return false;
		}
		this.#woke.set(hook.id, [...recent, now]);
		return true;
	}
}
