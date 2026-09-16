/**
 * Asking a model that can see what is on a screenshot, and getting words back.
 *
 * Its own file for the reason the answer reader is: this is the part worth testing without a
 * browser, a network or a provider — three shapes of request, three places the answer hides, and
 * three ways of counting what it cost.
 *
 * Why words and not the picture: an agent thinks with whatever it thinks with, which for most of
 * them is a small model that cannot see at all. Handing such an agent an image is a silent no-op —
 * it goes out, nothing reads it, and the agent believes it has looked. And an image in a tool
 * result is sent again with every later call in that turn, so one screenshot early in a long turn
 * is paid for a dozen times. A paragraph is paid for once.
 */

/** How a provider takes an image. The one thing the three of them disagree about. */
export type Shape = "responses" | "messages" | "chat";

export interface Looking {
	readonly endpoint: string;
	readonly model: string;
	readonly shape: Shape;
	readonly rate: { readonly input: number; readonly output: number };
}

export function readLooking(raw: string): Looking | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<Looking>;
		if (typeof parsed.endpoint !== "string" || typeof parsed.model !== "string") return undefined;
		const shape: Shape =
			parsed.shape === "messages" ? "messages" : parsed.shape === "chat" ? "chat" : "responses";
		return {
			endpoint: parsed.endpoint,
			model: parsed.model,
			shape,
			rate: parsed.rate ?? { input: 0, output: 0 },
		};
	} catch {
		return undefined;
	}
}

/** What is actually asked, when the agent did not say — which is most of the time. */
export const WHAT_IS_ON_IT =
	"Describe what is on this screen, in a few sentences. Say what kind of page it is, what it is showing, and anything that would stop somebody using it: an error, a captcha, a cookie wall, a spinner, an empty result. Be concrete about numbers and labels you can read.";

/** The request, which is the same picture and the same question in three different envelopes. */
export function askedOf(looking: Looking, about: string, png: string): string {
	const question = about.trim().length > 0 ? about.trim() : WHAT_IS_ON_IT;
	const url = `data:image/png;base64,${png}`;

	if (looking.shape === "messages") {
		return JSON.stringify({
			model: looking.model,
			// Anthropic wants a ceiling on every request and has no default. Enough for a description
			// and not enough for an essay: what this is for is a few sentences about a page.
			max_tokens: 700,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: question },
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: png },
						},
					],
				},
			],
		});
	}

	if (looking.shape === "chat") {
		return JSON.stringify({
			model: looking.model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: question },
						{ type: "image_url", image_url: { url } },
					],
				},
			],
		});
	}

	return JSON.stringify({
		model: looking.model,
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: question },
					{ type: "input_image", image_url: url },
				],
			},
		],
	});
}

interface Answered {
	readonly output?: readonly {
		readonly type: string;
		readonly content?: readonly { readonly type: string; readonly text?: string }[];
	}[];
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
		readonly prompt_tokens?: number;
		readonly completion_tokens?: number;
	};
	readonly error?: { readonly message?: string } | null;
}

/** What it said, from wherever that provider keeps it. */
export function saidBy(looking: Looking, answer: unknown): string {
	const said = answer as Answered;
	if (looking.shape === "messages") {
		return (said.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("")
			.trim();
	}
	if (looking.shape === "chat") return (said.choices?.[0]?.message?.content ?? "").trim();
	const message = said.output?.find((part) => part.type === "message");
	return (message?.content ?? [])
		.filter((part) => part.type === "output_text")
		.map((part) => part.text ?? "")
		.join("")
		.trim();
}

/** Whatever the provider said went wrong, for a status that was not a success. */
export function refusedBy(answer: unknown, body: string): string {
	const said = answer as Answered;
	return said?.error?.message ?? body.slice(0, 400);
}

/** What pi carries a cost in, written out here because the type of it lives two packages away. */
export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/**
 * What the look cost, counted here because here is the only place that knows.
 *
 * On the search tool's terms: a call to another provider, on another account, that the model driving
 * the turn never sees a token of. Unreported, it would be the second thing an agent could do that
 * costs money and appears in no total — and a picture is not cheap.
 */
export function spentOn(looking: Looking, answer: unknown): Usage {
	const said = answer as Answered;
	const input = said.usage?.input_tokens ?? said.usage?.prompt_tokens ?? 0;
	const output = said.usage?.output_tokens ?? said.usage?.completion_tokens ?? 0;
	const read = (input * looking.rate.input) / 1e6;
	const written = (output * looking.rate.output) / 1e6;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: read, output: written, cacheRead: 0, cacheWrite: 0, total: read + written },
	};
}
