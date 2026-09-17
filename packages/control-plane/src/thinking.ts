import type { Model } from "./models.ts";

/**
 * The model an agent thinks with, said in the shape a container can call it in.
 *
 * The agent's own model is the one thing the sandbox never had an address for. Pi holds it and
 * calls it, and everything the extensions could reach was the other two — the classifier that
 * points and the model that looks. Which was fine while the browser was driven a click at a time by
 * the agent itself, and is the missing piece the moment the loop drives: something that decides its
 * own steps needs somewhere to go when deciding is exactly what it cannot do.
 *
 * What is written down is an address and a shape, never a key. The request leaves the sandbox with
 * no credential and is given one at the proxy, against a grant this agent already holds — it is the
 * same model it has been thinking with all along, reached the same way.
 */
export interface Thinking {
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
	readonly shape: "chat" | "messages" | "responses";
	readonly keyEnv: string;
	readonly headers?: Readonly<Record<string, string>>;
}

/**
 * How to speak to each provider this plane knows, which is one path and one shape apiece.
 *
 * Kept here rather than folded into the providers table beside it, because that table is about
 * paying for a model and this is about the one call an extension makes to it. A provider missing
 * from here is a plane whose walk cannot ask for a second opinion — which is the walk there was
 * before this existed, not a failure.
 */
const SPOKEN_TO: Readonly<
	Record<string, { readonly path: string; readonly shape: Thinking["shape"] }>
> = {
	openai: { path: "/v1/chat/completions", shape: "chat" },
	anthropic: { path: "/v1/messages", shape: "messages" },
	deepseek: { path: "/chat/completions", shape: "chat" },
	google: { path: "/v1beta/openai/chat/completions", shape: "chat" },
	groq: { path: "/openai/v1/chat/completions", shape: "chat" },
	together: { path: "/v1/chat/completions", shape: "chat" },
	mistral: { path: "/v1/chat/completions", shape: "chat" },
	openrouter: { path: "/api/v1/chat/completions", shape: "chat" },
	xai: { path: "/v1/chat/completions", shape: "chat" },
};

/** The agent's model as an address, or nothing when this plane does not know how to speak to it. */
export function thinkingFor(model: Model | undefined): Thinking | undefined {
	if (model === undefined) return undefined;
	const how = SPOKEN_TO[model.provider];
	if (how === undefined) return undefined;
	return {
		provider: model.provider,
		model: model.model,
		endpoint: `https://${model.host}${how.path}`,
		shape: how.shape,
		keyEnv: model.keyEnv,
		// Anthropic refuses a request without it, and the header is the same one the plane sends.
		...(model.provider === "anthropic" ? { headers: { "anthropic-version": "2023-06-01" } } : {}),
	};
}
