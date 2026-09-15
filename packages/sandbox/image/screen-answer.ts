/**
 * What the agent's screen said, turned into what a tool result is made of.
 *
 * Its own file because it is the only part of the screen tools worth testing on its own: the rest
 * of the extension is one request and nine descriptions, and this is the piece that decides whether
 * a refusal reads as something the agent can act on or as nothing at all.
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

function said(text: string): readonly Block[] {
	return [{ type: "text", text }];
}

/**
 * The screen's answer as content blocks.
 *
 * The status is read before the body, and that is not fussiness — it is the whole lesson of the
 * first afternoon this ran. An earlier version of this looked only for the fields it hoped for and
 * said "Done." when it found none, so a 403 from the egress proxy — a perfectly good JSON object
 * with `error` in it and no `text` — arrived at the model as success with nothing in it. Two agents
 * spent a turn each reporting that their browser opened pages and showed them nothing, which is a
 * sentence with no failure in it anywhere.
 *
 * So anything that is not a 2xx is a refusal, whatever shape it came in, and it is quoted rather
 * than summarised: whoever reads it next knows more about that body than this function does.
 */
export function answerOf(status: number, raw: string): readonly Block[] {
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return said(
			`The screen answered ${status} with something that was not JSON: ${raw.slice(0, 400)}`,
		);
	}

	const refused = isRecord(body) && typeof body.refused === "string" ? body.refused : undefined;
	if (status < 200 || status >= 300) {
		return said(refused ?? `The screen refused this with ${status}: ${raw.slice(0, 400)}`);
	}
	if (refused !== undefined) return said(refused);
	if (!isRecord(body)) return said(`The screen answered with ${raw.slice(0, 400)}`);

	const blocks: Block[] = [];
	if (typeof body.text === "string" && body.text !== "") {
		blocks.push({ type: "text", text: body.text });
	}
	// A picture only ever arrives from `look`, and it arrives beside a line of text rather than
	// alone: an image with no words says nothing in a transcript read back later, and the line is
	// where the page's address goes.
	if (typeof body.image === "string" && body.image !== "") {
		blocks.push({ type: "image", data: body.image, mimeType: "image/png" });
	}
	// Never silently. An empty answer from a verb that should have described a page is a bug
	// somewhere, and the agent is the one who finds out — so it is told that, rather than "Done."
	if (blocks.length === 0)
		return said(`The screen answered ${status} and said nothing: ${raw.slice(0, 400)}`);
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
