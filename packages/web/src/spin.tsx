/**
 * Something turning, for the one thing a screen cannot say in words: that it has not stopped.
 *
 * "working…" is a sentence, and a sentence sits still. A turn takes minutes — a search, a page
 * fetched, a model thinking — and a still line through all of it reads exactly like a line left
 * behind by something that died, which is the difference between waiting and wondering whether to
 * reload. Nothing here says what is happening; the row beside it already does.
 *
 * A light going around a ring of nine squares, which is the shape a terminal spinner has had since
 * braille ones: eight cells lit one at a time with the one behind it half lit, and a dark middle.
 * Written as eight delays on one animation rather than as a motion library, because that is what it
 * is — the same keyframes, started a step apart.
 */
export function Spin({
	size = "0.95em",
	className,
}: {
	/**
	 * How big, and in `em` by default: it sits beside text, so what it should match is that text.
	 * A number of pixels was a guess made at every call site, and the guesses disagreed — which is
	 * what "not aligned" was: a fourteen-pixel square against an eleven-pixel line.
	 */
	size?: number | string;
	className?: string;
}) {
	return (
		<span
			className={className === undefined ? "orbit" : `orbit ${className}`}
			style={{ width: size, height: size }}
			aria-hidden="true"
		>
			{/* Nine, and the eight that are not the middle carry the light around. */}
			{Array.from({ length: 9 }, (_, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: nine cells of a fixed grid
				<i key={at} />
			))}
		</span>
	);
}
