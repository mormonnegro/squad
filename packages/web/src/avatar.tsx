import { faceOf, hash } from "./face.ts";

/**
 * A picture for an agent: a person, drawn from its name.
 *
 * What was here was three shapes turned by a hash — different from the one beside it, and nothing
 * else. Two of them together read as a pattern rather than as a roster, and a rail of patterns is a
 * rail you read by the names. A face is the one thing a person recognises before they have read
 * anything: it is why every program with a list of who is here draws one, and the list here is a
 * list of who is here.
 *
 * Drawn rather than fetched. Every service that hands out avatars is a service that would be told
 * the names of somebody's agents, on a plane whose whole point is that it is theirs, and every
 * library that draws one locally is a few hundred kilobytes for the arithmetic below. So: a bust,
 * from the same hash that already decides the agent's colour, and the colour is the one the terminal
 * console and the site already draw that agent in — the shirt and the ground it stands on.
 *
 * It has to survive sixteen pixels, which is where this is drawn in a channel's roster. At that size
 * an eye is half a pixel and the silhouette is the whole of the picture, so the head and the
 * shoulders carry it and everything else is texture that appears as the tile gets bigger.
 *
 * Nothing about a face means anything. An agent is not its hair, no more than it was the triangle it
 * used to be; the point is to be the same face on every machine that draws it, and a different one
 * from the agent underneath it in the list.
 */

/** Skin, the range of it. Picked by the hash, like everything else here. */
const SKIN = ["#f0d0b0", "#e3bb94", "#cd9d74", "#ad7c54", "#87583a", "#5c3927"] as const;

/** Hair, dark to fair and grey at the end of it. */
const HAIR = [
	// The dark ones twice, because most heads are dark-haired and a fleet drawn from an even palette
	// is a fleet of blondes. Fair hair on fair skin is also the one pair this drawing cannot say
	// apart — see `apart` — so the rarer it is the less often that has to be worked around.
	"#241d18",
	"#241d18",
	"#3d2a1e",
	"#3d2a1e",
	"#6a4429",
	"#6a4429",
	"#95602f",
	"#bf8845",
	"#d8b874",
	"#9d9892",
] as const;

/**
 * What is on the head: a dome behind the face, and whatever hangs off it.
 *
 * A dome rather than another circle. Two circles of nearly the same size leave a crescent that is
 * thick at the crown and vanishes at the ears, which is not a haircut — it is a receding hairline,
 * and drawn that way everybody had one. A dome is wider than the head and comes down the sides to
 * about the ear, which is where hair actually stops, and the difference between cropped and an afro
 * is how tall and how wide it is.
 */
interface Cut {
	/** Half its width, how far it stands above the face, and how far down the sides it comes. */
	readonly w: number;
	readonly h: number;
	readonly d: number;
	/** Down past the ears, and further than that. */
	readonly sides?: boolean;
	readonly long?: boolean;
	readonly knot?: boolean;
	readonly tail?: boolean;
}

const CUTS: readonly (Cut | undefined)[] = [
	{ w: 10, h: 11.2, d: 1 },
	{ w: 10.4, h: 12.2, d: 2 },
	{ w: 10, h: 10.6, d: 0.6 },
	{ w: 11.4, h: 13.4, d: 3.2 },
	{ w: 10.6, h: 11.8, d: 2.4, sides: true },
	{ w: 10.8, h: 12.2, d: 2.6, sides: true, long: true },
	{ w: 10, h: 11, d: 1.2, knot: true },
	{ w: 10, h: 11.2, d: 1.2, tail: true },
	// Bald, which is the absence of all of it and has to be one of the faces or nobody is.
	undefined,
];

/** Where the face sits in the tile, and how big it is. Everything else is drawn against these. */
const CX = 18;
const CY = 16.8;
const R = 8.1;

/** The dark that eyes and a mouth are drawn in. Never pure black: nothing on this screen is. */
const INK = "#15181c";

/**
 * The hair itself: a dome from one ear over the crown to the other.
 *
 * Closed along the bottom, which the face then covers — so what is left showing is the crown and
 * whatever comes down outside the head, which is what hair looks like from the front.
 */
function dome(cut: Cut): string {
	const bottom = CY + cut.d;
	const top = CY - cut.h;
	return `M ${CX - cut.w} ${bottom} Q ${CX - cut.w} ${top} ${CX} ${top} Q ${CX + cut.w} ${top} ${CX + cut.w} ${bottom} Z`;
}

/** How light a colour is, near enough. Used for one question: is this hair the colour of that skin. */
function light(hex: string): number {
	const at = (from: number): number => Number.parseInt(hex.slice(from, from + 2), 16) / 255;
	return 0.299 * at(1) + 0.587 * at(3) + 0.114 * at(5);
}

/** The next hair along, until it is not the colour of the skin under it. */
function apart(hair: string, skin: string): string {
	let at = HAIR.indexOf(hair as (typeof HAIR)[number]);
	for (let tried = 0; tried < HAIR.length; tried++) {
		const one = HAIR[at % HAIR.length] as string;
		if (Math.abs(light(one) - light(skin)) > 0.14) return one;
		at += 1;
	}
	return hair;
}

/**
 * The lower arc of the face, as a path: the chin, for a beard to sit on.
 *
 * Worked out rather than clipped, because a clip path needs an id of its own and there are a dozen
 * of these on a screen — and two elements with one id is a bug that looks like a drawing mistake.
 */
function chin(drop: number, radius = R + 0.2): string {
	const half = Math.sqrt(Math.max(0, radius * radius - drop * drop));
	return `M ${CX - half} ${CY + drop} A ${radius} ${radius} 0 0 0 ${CX + half} ${CY + drop} Z`;
}

/** Who the name turned out to be: everything the drawing below needs, and nothing about drawing. */
export interface Person {
	readonly skin: string;
	readonly hair: string;
	readonly cut: Cut | undefined;
	/** 0 and 1 are a beard, 2 is a moustache, and the rest is a shaved face. */
	readonly chinHair: number;
	readonly glasses: boolean;
	/** Which way the eyes and the shoulders lean, so two people with one haircut are still two. */
	readonly tilt: number;
}

/**
 * The same name, the same person, on every machine that ever draws it.
 *
 * Salted rather than sliced off one number: a name is short, and six things read out of one hash
 * move together — two agents whose names differ by a letter came out as the same person in a
 * different jumper. And the high bits, not the low ones: FNV's last few bits barely move for names
 * this short, and a third of a fleet came out with the same haircut because of it.
 */
export function personOf(id: string): Person {
	const pick = <T,>(salt: string, from: readonly T[]): T =>
		from[(hash(`${id}:${salt}`) >>> 11) % from.length] as T;
	const skin = pick("skin", SKIN);
	return {
		skin,
		// Hair that is not the colour of the head it is on: fair hair on fair skin drew a bald man
		// with a halo, which is a face the hash never chose and half the fair-haired ones came out as.
		hair: apart(pick("hair", HAIR), skin),
		cut: pick("cut", CUTS),
		// A beard on a third of them and a moustache on a sixth, which is a room rather than a rule.
		chinHair: (hash(`${id}:beard`) >>> 11) % 6,
		glasses: (hash(`${id}:glasses`) >>> 11) % 4 === 0,
		tilt: ((hash(id) >>> 13) % 5) - 2,
	};
}

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

	const accent = `var(--${faceOf(id).accent})`;
	const { skin, hair, cut, chinHair, glasses, tilt } = personOf(id);

	return (
		<svg
			className="avatar"
			style={{ width: size, height: size }}
			viewBox="0 0 36 36"
			role="presentation"
			aria-hidden="true"
		>
			<title>{id}</title>
			{/*
			 * Square, and rounded by the stylesheet.
			 *
			 * The corner is decided in one place or it is decided in two that disagree: the rule that
			 * draws the hairline around this tile rounds it by a fixed eight pixels, and a radius
			 * written in here is in viewBox units that scale with the drawing — so at thirty-four
			 * pixels the paint curved tighter than the ring around it and the corners showed daylight.
			 * It also has to be able to become a circle: a channel's roster crops these to round, with
			 * a radius this could not know about.
			 *
			 * Nothing escapes: an svg clips to its own viewport, which is this square.
			 */}
			<g>
				{/* The ground: the agent's own colour, dulled into the screen it sits on. A face wants
				    something behind it, and what belongs behind this one is the colour this agent is
				    everywhere else. */}
				<rect width="36" height="36" fill={`color-mix(in srgb, ${accent} 44%, var(--bg-code))`} />

				{/* Behind the head: what hangs off the hair. */}
				{cut?.sides === true && (
					<>
						<rect
							x={CX - 9.4}
							y={CY - 2.5}
							width="3.8"
							height={cut.long === true ? 16 : 11}
							rx="1.9"
							fill={hair}
						/>
						<rect
							x={CX + 5.6}
							y={CY - 2.5}
							width="3.8"
							height={cut.long === true ? 16 : 11}
							rx="1.9"
							fill={hair}
						/>
					</>
				)}
				{cut?.knot === true && <circle cx={CX} cy={CY - 11.4} r="3" fill={hair} />}
				{cut?.tail === true && <circle cx={CX + 8.6} cy={CY - 2} r="3.2" fill={hair} />}

				{/* The neck, then the shoulders over the bottom of it. */}
				<rect
					x={CX - 2.7}
					y={CY + 4.6}
					width="5.4"
					height="7"
					rx="2.2"
					fill={`color-mix(in srgb, ${skin} 84%, #000)`}
				/>
				<ellipse
					cx={CX + tilt * 0.3}
					cy="39.6"
					rx="13.6"
					ry="11"
					fill={`color-mix(in srgb, ${accent} 78%, var(--bg-code))`}
				/>
				{/* The collar, which is the one line that says the shoulders are a shirt. */}
				<path
					d={`M ${CX - 4.4} 29.4 Q ${CX} 32.6 ${CX + 4.4} 29.4`}
					fill="none"
					stroke={`color-mix(in srgb, ${accent} 42%, var(--bg-code))`}
					strokeWidth="1.1"
					strokeLinecap="round"
				/>

				{/* The hair, and the face over it: what is left showing at the top is the hairline. */}
				{cut !== undefined && <path d={dome(cut)} fill={hair} />}
				<circle cx={CX} cy={CY} r={R} fill={skin} />
				<circle cx={CX - R + 0.7} cy={CY + 1.6} r="1.15" fill={skin} />
				<circle cx={CX + R - 0.7} cy={CY + 1.6} r="1.15" fill={skin} />

				{/* The face. At sixteen pixels none of this is legible and all of it is texture; at
				    thirty-four it is a person looking at you. */}
				{chinHair < 2 && <path d={chin(4.2)} fill={hair} />}
				{chinHair === 2 && (
					<rect x={CX - 2.3} y={CY + 2.1} width="4.6" height="1.2" rx="0.6" fill={hair} />
				)}
				<circle cx={CX - 3} cy={CY + 0.2 + tilt * 0.1} r="1.05" fill={INK} />
				<circle cx={CX + 3} cy={CY + 0.2 - tilt * 0.1} r="1.05" fill={INK} />
				<path
					d={`M ${CX - 2.1} ${CY + 3.5} Q ${CX} ${CY + 4.9} ${CX + 2.1} ${CY + 3.5}`}
					fill="none"
					stroke={INK}
					strokeWidth="0.9"
					strokeLinecap="round"
					opacity="0.7"
				/>
				{glasses && (
					<g fill="none" stroke={INK} strokeWidth="0.75" opacity="0.8">
						<circle cx={CX - 3} cy={CY + 0.2} r="2.5" />
						<circle cx={CX + 3} cy={CY + 0.2} r="2.5" />
						<path d={`M ${CX - 0.5} ${CY + 0.2} h 1`} />
					</g>
				)}
			</g>
		</svg>
	);
}
