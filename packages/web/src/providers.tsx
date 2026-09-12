/**
 * What each provider is called, what it is for, where it hands out a key, and how it is drawn.
 *
 * The drawing is a monogram in the provider's own colour rather than its logo. Not an oversight: a
 * logo is a trademark with a shape somebody owns, and a shape redrawn from memory is both wrong and
 * somebody else's — which is worse than not drawing one. A letter in the right colour is honest
 * about being a label, and does the one job a mark has on a screen like this, which is to be found
 * without reading.
 *
 * The colours are the providers' own, used to tell one row from another. Dropping a real mark in is
 * a file in this repository and a line here; nothing else would have to move.
 */
export interface Look {
	readonly name: string;
	readonly says: string;
	readonly at?: string;
	/** The letters on the tile. Two at most, because three stop being a monogram. */
	readonly mark: string;
	readonly tint: string;
}

export const LOOK: Readonly<Record<string, Look>> = {
	deepseek: {
		name: "DeepSeek",
		says: "Cheap enough to leave an agent running. What the config starts on.",
		at: "https://platform.deepseek.com/api_keys",
		mark: "DS",
		tint: "#4d6bfe",
	},
	anthropic: {
		name: "Anthropic",
		says: "Claude. The strongest of these at long, careful work.",
		at: "https://console.anthropic.com/settings/keys",
		mark: "A",
		tint: "#d97757",
	},
	openai: {
		name: "OpenAI",
		says: "GPT, and the one endpoint an agent searches the web through.",
		at: "https://platform.openai.com/api-keys",
		mark: "AI",
		tint: "#10a37f",
	},
	google: {
		name: "Google",
		says: "Gemini.",
		at: "https://aistudio.google.com/apikey",
		mark: "G",
		tint: "#4285f4",
	},
	groq: {
		name: "Groq",
		says: "Open models, answered fast.",
		at: "https://console.groq.com/keys",
		mark: "GQ",
		tint: "#f55036",
	},
	mistral: {
		name: "Mistral",
		says: "European, and open-weight.",
		at: "https://console.mistral.ai/api-keys",
		mark: "M",
		tint: "#ff7000",
	},
	openrouter: {
		name: "OpenRouter",
		says: "One key, most of the others behind it.",
		at: "https://openrouter.ai/keys",
		mark: "OR",
		tint: "#8b8bf5",
	},
	xai: { name: "xAI", says: "Grok.", at: "https://console.x.ai", mark: "X", tint: "#c9cdd4" },
	zai: { name: "Z.ai", says: "GLM.", mark: "Z", tint: "#3fb6d3" },
};

/** What a provider nobody has a line for still gets, so a new one in the table is never faceless. */
export function lookOf(id: string): Look {
	return (
		LOOK[id] ?? {
			name: id,
			says: "A provider this plane knows how to reach.",
			mark: id.slice(0, 2).toUpperCase(),
			tint: "#9ba1a9",
		}
	);
}

/** The tile. Sized by the caller, because a card and a list row want different ones. */
export function Mark({ id, size = 36 }: { id: string; size?: number }) {
	const look = lookOf(id);
	return (
		<span
			aria-hidden="true"
			className="grid flex-none place-items-center rounded-lg border font-semibold"
			style={{
				width: size,
				height: size,
				// The colour three ways, which is what makes a flat tile read as an object: a wash of it
				// behind, more of it at the edge, and the letters at full strength.
				background: `${look.tint}1f`,
				borderColor: `${look.tint}59`,
				color: look.tint,
				fontSize: size * (look.mark.length > 1 ? 0.34 : 0.42),
				letterSpacing: "0.02em",
			}}
		>
			{look.mark}
		</span>
	);
}
