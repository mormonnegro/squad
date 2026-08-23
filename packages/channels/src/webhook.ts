import http from "node:http";
import type { AddressInfo } from "node:net";
import type { NewAgentEvent, TrustLevel } from "@agent-dive/events";
import { type Channel, ChannelError, type Reply } from "./channel.ts";
import { isFresh, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER, verify } from "./signature.ts";

export interface Hook {
	/** Path segment the sender posts to, and the suffix of the channel name. */
	readonly id: string;
	readonly agentId: string;
	/** Shared secret for the request signature. */
	readonly secret: string;
	/** Defaults to public. Operator is refused; see {@link WebhookChannel}. */
	readonly trust?: TrustLevel;
	/** Where replies are posted. Configuration only, never taken from the payload. */
	readonly replyUrl?: string;
}

export interface WebhookPublisher {
	publish(event: NewAgentEvent): Promise<unknown>;
}

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
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_TOLERANCE_SECONDS = 300;

function header(request: http.IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
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
		this.#server = http.createServer((request, response) => {
			void this.#handle(request, response);
		});
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
				[TIMESTAMP_HEADER]: timestamp,
				[SIGNATURE_HEADER]: sign(hook.secret, timestamp, body),
			},
			body,
		});
		if (!response.ok) {
			throw new ChannelError(`Reply to hook "${hookId}" failed with ${response.status}`);
		}
	}

	async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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
		const timestamp = header(request, TIMESTAMP_HEADER);
		const signature = header(request, SIGNATURE_HEADER);

		const { text: body, tooLarge } = await readBody(request, this.#maxBodyBytes);
		if (tooLarge) return { status: 413, payload: { error: "body_too_large" } };

		// An unknown hook is rejected like a bad signature so the endpoint cannot be probed for
		// which hooks exist, and only after the body was read so the shape of the reply is the same.
		if (!hook || timestamp === undefined || signature === undefined) {
			return { status: 401, payload: { error: "unauthorized" } };
		}
		if (!isFresh(timestamp, this.#now(), this.#toleranceSeconds)) {
			return { status: 401, payload: { error: "unauthorized" } };
		}
		if (!verify(hook.secret, timestamp, body, signature)) {
			return { status: 401, payload: { error: "unauthorized" } };
		}

		await this.#publisher.publish({
			agentId: hook.agentId,
			source: "webhook",
			trust: hook.trust ?? "public",
			channel: `${this.name}:${hook.id}`,
			subject: `Webhook ${hook.id}`,
			body,
			replyTo: hook.id,
		});

		return { status: 202, payload: { status: "accepted" } };
	}
}
