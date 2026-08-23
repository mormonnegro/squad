import http from "node:http";
import type { AddressInfo } from "node:net";
import { EventBus, type NewAgentEvent } from "@agent-dive/events";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelError, ChannelRouter } from "../src/channel.ts";
import { isFresh, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER, verify } from "../src/signature.ts";
import { WebhookChannel } from "../src/webhook.ts";

const SECRET = "hook-secret";

class RecordingPublisher {
	readonly published: NewAgentEvent[] = [];

	async publish(event: NewAgentEvent): Promise<void> {
		this.published.push(event);
	}
}

interface Posted {
	readonly status: number;
	readonly body: string;
}

async function post(
	port: number,
	path: string,
	body: string,
	headers: Record<string, string> = {},
): Promise<Posted> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
	return { status: response.status, body: await response.text() };
}

function signed(body: string, secret = SECRET, at = new Date()): Record<string, string> {
	const timestamp = Math.floor(at.getTime() / 1000).toString();
	return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: sign(secret, timestamp, body) };
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

async function start(channel: WebhookChannel): Promise<number> {
	closers.push(() => channel.close());
	return channel.listen();
}

describe("signature", () => {
	it("accepts a signature it produced", () => {
		expect(verify(SECRET, "1000", "payload", sign(SECRET, "1000", "payload"))).toBe(true);
	});

	it("rejects a signature made with another secret", () => {
		expect(verify(SECRET, "1000", "payload", sign("other", "1000", "payload"))).toBe(false);
	});

	it("rejects a signature lifted onto a different timestamp", () => {
		expect(verify(SECRET, "2000", "payload", sign(SECRET, "1000", "payload"))).toBe(false);
	});

	it("rejects a truncated signature instead of throwing", () => {
		expect(verify(SECRET, "1000", "payload", "sha256=")).toBe(false);
	});

	it("treats a timestamp outside the tolerance as stale", () => {
		const now = new Date("2026-03-01T00:10:00.000Z");
		expect(isFresh("1772323800", now, 300)).toBe(true);
		expect(isFresh("1772323200", now, 300)).toBe(false);
		expect(isFresh("not-a-time", now, 300)).toBe(false);
	});
});

describe("WebhookChannel", () => {
	const hook = { id: "deploys", agentId: "a1", secret: SECRET } as const;

	it("publishes a signed post as a webhook event", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(new WebhookChannel({ hooks: [hook], publisher }));

		const body = '{"status":"failed"}';
		const response = await post(port, "/hooks/deploys", body, signed(body));

		expect(response.status).toBe(202);
		expect(publisher.published[0]).toMatchObject({
			agentId: "a1",
			source: "webhook",
			trust: "public",
			channel: "webhook:deploys",
			body,
			replyTo: "deploys",
		});
	});

	it("honours the hook's configured trust level", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(
			new WebhookChannel({ hooks: [{ ...hook, trust: "participant" }], publisher }),
		);

		const body = "{}";
		await post(port, "/hooks/deploys", body, signed(body));

		expect(publisher.published[0]?.trust).toBe("participant");
	});

	it("refuses to configure a hook with operator trust", () => {
		expect(
			() =>
				new WebhookChannel({
					hooks: [{ ...hook, trust: "operator" }],
					publisher: new RecordingPublisher(),
				}),
		).toThrow(ChannelError);
	});

	it("rejects an unsigned post", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(new WebhookChannel({ hooks: [hook], publisher }));

		expect((await post(port, "/hooks/deploys", "{}")).status).toBe(401);
		expect(publisher.published).toEqual([]);
	});

	it("rejects a post signed with the wrong secret", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(new WebhookChannel({ hooks: [hook], publisher }));

		const body = "{}";
		expect((await post(port, "/hooks/deploys", body, signed(body, "guessed"))).status).toBe(401);
		expect(publisher.published).toEqual([]);
	});

	it("rejects a body that was altered after signing", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(new WebhookChannel({ hooks: [hook], publisher }));

		const headers = signed('{"status":"ok"}');
		expect((await post(port, "/hooks/deploys", '{"status":"failed"}', headers)).status).toBe(401);
		expect(publisher.published).toEqual([]);
	});

	it("rejects a replayed post once it is stale", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(
			new WebhookChannel({ hooks: [hook], publisher, toleranceSeconds: 60 }),
		);

		const body = "{}";
		const old = signed(body, SECRET, new Date(Date.now() - 3600_000));
		expect((await post(port, "/hooks/deploys", body, old)).status).toBe(401);
		expect(publisher.published).toEqual([]);
	});

	it("answers an unknown hook exactly like a bad signature", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(new WebhookChannel({ hooks: [hook], publisher }));

		const body = "{}";
		const unknown = await post(port, "/hooks/secret-project", body, signed(body));
		const bad = await post(port, "/hooks/deploys", body, signed(body, "guessed"));

		expect(unknown).toEqual(bad);
	});

	it("refuses a body past the limit", async () => {
		const publisher = new RecordingPublisher();
		const port = await start(new WebhookChannel({ hooks: [hook], publisher, maxBodyBytes: 64 }));

		const body = "x".repeat(1024);
		expect((await post(port, "/hooks/deploys", body, signed(body))).status).toBe(413);
		expect(publisher.published).toEqual([]);
	});

	it("rejects a path outside the hook prefix", async () => {
		const port = await start(
			new WebhookChannel({ hooks: [hook], publisher: new RecordingPublisher() }),
		);
		expect((await post(port, "/deploys", "{}")).status).toBe(404);
	});

	it("rejects a method other than POST", async () => {
		const port = await start(
			new WebhookChannel({ hooks: [hook], publisher: new RecordingPublisher() }),
		);
		const response = await fetch(`http://127.0.0.1:${port}/hooks/deploys`);
		expect(response.status).toBe(405);
	});
});

describe("replies", () => {
	const hook = {
		id: "deploys",
		agentId: "a1",
		secret: SECRET,
		replyUrl: "https://example.invalid/reply",
	} as const;

	it("posts the reply to the hook's configured URL, signed", async () => {
		const calls: Array<{ url: string; headers: Headers; body: string }> = [];
		const channel = new WebhookChannel({
			hooks: [hook],
			publisher: new RecordingPublisher(),
			fetch: async (url, init) => {
				const headers = new Headers(init?.headers);
				calls.push({ url: String(url), headers, body: String(init?.body) });
				return new Response(null, { status: 204 });
			},
		});

		await channel.send({ agentId: "a1", channel: "webhook:deploys", body: "restarted the job" });

		const call = calls[0];
		expect(call?.url).toBe("https://example.invalid/reply");
		expect(JSON.parse(call?.body ?? "{}")).toEqual({ agentId: "a1", body: "restarted the job" });
		expect(
			verify(
				SECRET,
				call?.headers.get(TIMESTAMP_HEADER) ?? "",
				call?.body ?? "",
				call?.headers.get(SIGNATURE_HEADER) ?? "",
			),
		).toBe(true);
	});

	it("ignores a reply address supplied in the payload", async () => {
		const urls: string[] = [];
		const channel = new WebhookChannel({
			hooks: [hook],
			publisher: new RecordingPublisher(),
			fetch: async (url) => {
				urls.push(String(url));
				return new Response(null, { status: 204 });
			},
		});

		// The destination is configuration. Honouring replyTo would turn any payload into an SSRF.
		await channel.send({
			agentId: "a1",
			channel: "webhook:deploys",
			body: "done",
			replyTo: "http://169.254.169.254/latest/meta-data/",
		});

		expect(urls).toEqual(["https://example.invalid/reply"]);
	});

	it("reports a hook with no reply URL", async () => {
		const channel = new WebhookChannel({
			hooks: [{ id: "deploys", agentId: "a1", secret: SECRET }],
			publisher: new RecordingPublisher(),
		});

		await expect(
			channel.send({ agentId: "a1", channel: "webhook:deploys", body: "done" }),
		).rejects.toThrow(/no reply URL/);
	});

	it("reports a refused reply", async () => {
		const channel = new WebhookChannel({
			hooks: [hook],
			publisher: new RecordingPublisher(),
			fetch: async () => new Response(null, { status: 500 }),
		});

		await expect(
			channel.send({ agentId: "a1", channel: "webhook:deploys", body: "done" }),
		).rejects.toThrow(/failed with 500/);
	});
});

describe("ChannelRouter", () => {
	it("routes a reply back to the adapter the event came from", async () => {
		const sent: string[] = [];
		const router = new ChannelRouter();
		router.register({
			name: "webhook",
			async send(reply) {
				sent.push(`webhook:${reply.body}`);
			},
		});
		router.register({
			name: "slack",
			async send(reply) {
				sent.push(`slack:${reply.body}`);
			},
		});

		await router.send({ agentId: "a1", channel: "webhook:deploys", body: "one" });
		await router.send({ agentId: "a1", channel: "slack:C1", body: "two" });

		expect(sent).toEqual(["webhook:one", "slack:two"]);
	});

	it("reports an unroutable reply instead of dropping it", async () => {
		const router = new ChannelRouter();
		await expect(
			router.send({ agentId: "a1", channel: "email:inbox", body: "hi" }),
		).rejects.toThrow(ChannelError);
	});
});

describe("end to end", () => {
	it("carries a signed post through a turn and back out as a signed reply", async () => {
		const replies: Array<{ body: string; verified: boolean }> = [];
		const replyServer = http.createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				const timestamp = String(request.headers[TIMESTAMP_HEADER]);
				const signature = String(request.headers[SIGNATURE_HEADER]);
				replies.push({ body, verified: verify(SECRET, timestamp, body, signature) });
				response.writeHead(204).end();
			});
		});
		await new Promise<void>((resolve) => replyServer.listen(0, "127.0.0.1", resolve));
		const replyPort = (replyServer.address() as AddressInfo).port;
		closers.push(() => new Promise<void>((resolve) => replyServer.close(() => resolve())));

		const bus = new EventBus();
		const channel = new WebhookChannel({
			hooks: [
				{
					id: "deploys",
					agentId: "a1",
					secret: SECRET,
					replyUrl: `http://127.0.0.1:${replyPort}/reply`,
				},
			],
			publisher: bus,
		});
		const port = await start(channel);

		const router = new ChannelRouter();
		router.register(channel);

		const prompts: string[] = [];
		await bus.register("a1", async ({ agentId, events, prompt }) => {
			prompts.push(prompt);
			for (const event of events) {
				await router.send({ agentId, channel: event.channel, body: `saw ${event.body}` });
			}
		});

		const body = '{"status":"failed"}';
		expect((await post(port, "/hooks/deploys", body, signed(body))).status).toBe(202);
		await bus.drain();

		// The payload reaches the agent fenced, because a hook proves the sender, not the content.
		expect(prompts[0]).toContain("<<<UNTRUSTED");
		expect(prompts[0]).toContain('{"status":"failed"}');
		expect(replies).toEqual([
			{ body: JSON.stringify({ agentId: "a1", body: `saw ${body}` }), verified: true },
		]);
	});
});
