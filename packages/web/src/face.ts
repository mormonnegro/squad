/**
 * A face for an agent that has not been given one.
 *
 * Identity belongs in the agent's own repository, where it travels with the agent — but nothing has
 * written one yet, and an agent with no picture should not be a blank square until somebody fills a
 * form in. So it is derived: the same name gets the same face on every machine that ever draws it,
 * which is the property that matters. A name the operator later gives it wins over all of this.
 */

/** The six the palette already has. Grey is not among them: it is what a stopped agent is drawn in. */
const ACCENTS = ["cyan", "green", "amber", "blue", "red"] as const;

export type Accent = (typeof ACCENTS)[number];

/**
 * Faces that read at a glance and mean nothing.
 *
 * Deliberately unlike the roles agents get given — an agent that watches deploys should not be
 * assigned a siren by a hash, because a picture that looks chosen and was not is worse than one that
 * obviously was not.
 */
const GLYPHS = [
	"◆",
	"●",
	"▲",
	"■",
	"◐",
	"◇",
	"○",
	"△",
	"□",
	"◑",
	"✦",
	"❖",
	"⬢",
	"⬣",
	"◈",
	"⧫",
] as const;

/** FNV-1a. Small, stable across machines, and nothing here needs it to be anything more. */
export function hash(text: string): number {
	let value = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		value ^= text.charCodeAt(i);
		value = Math.imul(value, 0x01000193);
	}
	return value >>> 0;
}

export interface Face {
	readonly glyph: string;
	readonly accent: Accent;
}

export function faceOf(agentId: string, given?: { emoji?: string; accent?: string }): Face {
	const spun = hash(agentId);
	const accent = (
		given?.accent !== undefined && (ACCENTS as readonly string[]).includes(given.accent)
			? given.accent
			: ACCENTS[spun % ACCENTS.length]
	) as Accent;
	return {
		glyph: given?.emoji ?? GLYPHS[(spun >>> 8) % GLYPHS.length] ?? "◆",
		accent,
	};
}

/** What to call it on screen, which is its own name until it has been given a nicer one. */
export function nameOf(agentId: string, display?: string): string {
	return display !== undefined && display.length > 0 ? display : agentId;
}
