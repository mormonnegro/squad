/**
 * What the agent's screen said, turned into what a tool result is made of.
 *
 * Its own file because it is the only part of the screen tools worth testing on its own: the rest
 * of the extension is a fetch and nine descriptions, and this is the piece that decides whether a
 * refusal reads as an error the agent can act on or as a stack trace it cannot.
 */

export interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface ImageBlock {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export type Block = TextBlock | ImageBlock;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The screen's answer as content blocks.
 *
 * A picture only ever arrives from `look`, and it arrives beside a line of text rather than alone:
 * an image with no words is a tool result that says nothing in a transcript being read back later,
 * and the line is where the page's address goes.
 */
export function answerOf(body: unknown): readonly Block[] {
	if (!isRecord(body)) {
		return [{ type: "text", text: "The screen answered with something that was not an answer." }];
	}
	if (typeof body.refused === "string") return [{ type: "text", text: body.refused }];

	const blocks: Block[] = [];
	if (typeof body.text === "string" && body.text !== "") {
		blocks.push({ type: "text", text: body.text });
	}
	if (typeof body.image === "string" && body.image !== "") {
		blocks.push({ type: "image", data: body.image, mimeType: "image/png" });
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: "Done." });
	return blocks;
}

/**
 * What the agent is told when the screen is not there at all.
 *
 * The likely causes are all the operator's rather than the agent's — a screen that was turned off,
 * a container still starting, an image that was never built — so the sentence says whose problem it
 * is and what asking would look like, instead of leaving a model to invent a diagnosis and retry
 * against a name that will not resolve for the rest of the turn.
 */
export function unreachable(agentId: string, reason: string): string {
	return [
		`No screen answered for ${agentId} (${reason}).`,
		"",
		"A screen is something the operator turns on for you, and it can be off, still starting, or",
		"gone. Do not retry this turn: say in your answer that you need the screen, and what for.",
		"They turn it on with /screen on, at the console, on this agent.",
	].join("\n");
}
