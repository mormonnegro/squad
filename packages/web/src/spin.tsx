/**
 * Something turning, for the one thing a screen cannot say in words: that it has not stopped.
 *
 * "working…" is a sentence, and a sentence sits still. A turn takes minutes — a search, a page
 * fetched, a model thinking — and a still line through all of it reads exactly like a line left
 * behind by something that died, which is the difference between waiting and wondering whether to
 * reload. Nothing here says what is happening; the row above it already does.
 *
 * Amber, because that is what working is everywhere else on this plane: in the terminal console, in
 * the marks down the agents column, in the site. One palette, three windows.
 */
export function Spin({ size = 11 }: { size?: number }) {
	return <span className="spin" style={{ width: size, height: size }} aria-hidden="true" />;
}
