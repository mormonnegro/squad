import { hash } from "./face.ts";

/**
 * A picture for an agent, drawn from its name.
 *
 * A glyph told two agents apart and never said anything else: sixteen shapes, five colours, and
 * every one of them something an agent might legitimately have been given on purpose. A mark a
 * person recognises before they have read the name is worth more than that, and the only thing this
 * has to be is different from the one beside it and the same on every machine that ever draws it.
 *
 * So: three shapes, placed and turned by the bits of the same hash that already chose a glyph,
 * clipped to the tile every other mark on this screen has. Written here rather than pulled in —
 * every library that does this is a few hundred kilobytes for forty lines of arithmetic, and the
 * palette is the one thing that must not come from somewhere else: these are the five colours the
 * terminal console and the site already draw agents in.
 */
const PALETTE = ["--cyan", "--green", "--amber", "--blue", "--red"] as const;

export function Avatar({
	id,
	size = 22,
	glyph,
}: {
	id: string;
	size?: number;
	/** What the agent was given, if it was given one. A picture somebody chose beats a derived one. */
	glyph?: string | undefined;
}) {
	if (glyph !== undefined && glyph !== "") {
		return (
			<span
				className="face"
				style={{ width: size, height: size, fontSize: size * 0.55 }}
				aria-hidden="true"
			>
				{glyph}
			</span>
		);
	}

	const spun = hash(id);
	const bit = (at: number, width: number): number => (spun >>> at) & ((1 << width) - 1);
	// Two colours that are not the same one, so a tile is always two things rather than sometimes one.
	const first = PALETTE[bit(0, 3) % PALETTE.length] ?? "--cyan";
	const second = PALETTE[(bit(3, 3) + 1) % PALETTE.length] ?? "--green";
	const tint = first === second ? (PALETTE[(bit(3, 3) + 2) % PALETTE.length] ?? "--blue") : second;

	return (
		<svg
			className="avatar"
			style={{ width: size, height: size }}
			viewBox="0 0 36 36"
			role="presentation"
			aria-hidden="true"
		>
			<title>{id}</title>
			{/* The ground, in the first colour at a whisper: what makes the tile read as an object. */}
			<rect width="36" height="36" rx="10" fill={`var(${first})`} opacity="0.22" />
			{/* Two shapes, turned and offset by the hash. Clipped by the tile, so a circle that falls
			    off the edge comes back as an arc — which is where most of the variety comes from. */}
			<g clipPath="url(#tile)">
				<circle
					cx={6 + bit(6, 5)}
					cy={4 + bit(11, 5)}
					r={12 + bit(16, 3)}
					fill={`var(${first})`}
					opacity="0.85"
				/>
				<rect
					x={10 + bit(19, 4)}
					y={12 + bit(23, 4)}
					width={16 + bit(27, 3)}
					height={16 + bit(19, 3)}
					rx={bit(23, 2) * 3}
					fill={`var(${tint})`}
					opacity="0.8"
					transform={`rotate(${bit(27, 5) * 3} 18 18)`}
				/>
			</g>
			<defs>
				<clipPath id="tile">
					<rect width="36" height="36" rx="10" />
				</clipPath>
			</defs>
		</svg>
	);
}
