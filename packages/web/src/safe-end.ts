/** A whole link, which is the one mark whose opening and closing are not the same characters. */
const LINK = /^\[([^\]]*)\]\(([^)]*)\)/;

/**
 * How far into a line it is safe to draw before the rest of it has arrived.
 *
 * A `**` is not bold until its closing `**` shows up, so everything from an unclosed marker onwards
 * has to be held back: drawing it eagerly puts a literal `**` on screen that no later delta can take
 * away. What comes before that marker is already settled and goes out now, which is the difference
 * between an answer that moves and one that appears a line at a time.
 *
 * Copied from the plane's own renderer, which paints ANSI and cannot come into a browser bundle. The
 * test holds both and fails the day they disagree.
 */
export function safeEnd(text: string): number {
	let index = 0;
	let safe = 0;

	while (index < text.length) {
		const char = text[index];
		if (char === "`") {
			const close = text.indexOf("`", index + 1);
			if (close === -1) return safe;
			index = close + 1;
		} else if (char === "*") {
			const marker = text.startsWith("**", index) ? "**" : "*";
			const close = text.indexOf(marker, index + marker.length);
			if (close === -1) return safe;
			index = close + marker.length;
		} else if (char === "[") {
			const link = LINK.exec(text.slice(index));
			if (link === null) return safe;
			index += link[0].length;
		} else index++;
		safe = index;
	}
	return safe;
}
