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
	/**
	 * What to add to the request so this provider answers rather than thinks out loud.
	 *
	 * The one field here that came out of a stopwatch. The walk asks this model one question — which
	 * link leads towards the goal — and a reasoning model treats that as an invitation: measured on
	 * this plane, deepseek-flash spent fifteen thousand tokens of reasoning and between fifty and
	 * ninety seconds on it, inside a loop whose other steps cost half a second. Told not to, the same
	 * model answered the same question in one second, and answered it better: it said there is no such
	 * link on this page, where the reasoning runs had talked themselves into naming one.
	 *
	 * Per provider because the spelling is, and absent for the ones where reasoning is opt-in anyway.
	 */
	readonly quietly?: Readonly<Record<string, unknown>>;
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
	Record<
		string,
		{
			readonly path: string;
			readonly shape: Thinking["shape"];
			readonly quietly?: Readonly<Record<string, unknown>>;
		}
	>
> = {
	openai: { path: "/v1/chat/completions", shape: "chat" },
	anthropic: { path: "/v1/messages", shape: "messages" },
	deepseek: { path: "/chat/completions", shape: "chat", quietly: { thinking: { type: "disabled" } } },
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
		...(how.quietly === undefined ? {} : { quietly: how.quietly }),
		// Anthropic refuses a request without it, and the header is the same one the plane sends.
		...(model.provider === "anthropic" ? { headers: { "anthropic-version": "2023-06-01" } } : {}),
	};
}
