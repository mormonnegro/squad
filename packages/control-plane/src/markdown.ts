const BOLD = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";
const DIM = "\u001b[2m";
const DIM_OFF = "\u001b[22m";
const ITALIC = "\u001b[3m";
const ITALIC_OFF = "\u001b[23m";
const UNDERLINE = "\u001b[4m";
const UNDERLINE_OFF = "\u001b[24m";
const CODE = "\u001b[36m";
const CODE_OFF = "\u001b[39m";

const LINK = /^\[([^\]]*)\]\(([^)]*)\)/;

/**
 * How far into a line it is safe to render before the rest of it has arrived.
 *
 * A `**` is not bold until its closing `**` shows up, so everything from an unclosed marker onwards
 * has to be held back: printing it eagerly puts a literal `**` on screen that no later delta can
 * take away. What comes before that marker is already settled and goes out now, which is the
 * difference between an answer that moves and one that appears a line at a time.
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

/**
 * Renders the inline markdown in one line's worth of text.
 *
 * `_` is left alone on purpose: markdown reads it as emphasis and every identifier reads it as a
 * word boundary, and an agent answering about `session_id` should not have half of it italicised.
 */
export function renderInline(text: string): string {
	let out = "";
	let index = 0;

	while (index < text.length) {
		const char = text[index];
		if (char === "`") {
			const close = text.indexOf("`", index + 1);
			if (close !== -1) {
				out += CODE + text.slice(index + 1, close) + CODE_OFF;
				index = close + 1;
				continue;
			}
		} else if (char === "*") {
			const marker = text.startsWith("**", index) ? "**" : "*";
			const close = text.indexOf(marker, index + marker.length);
			if (close !== -1) {
				const on = marker === "**" ? BOLD : ITALIC;
				const off = marker === "**" ? BOLD_OFF : ITALIC_OFF;
				out += on + renderInline(text.slice(index + marker.length, close)) + off;
				index = close + marker.length;
				continue;
			}
		} else if (char === "[") {
			const link = LINK.exec(text.slice(index));
			if (link !== null) {
				out += `${UNDERLINE}${link[1]}${UNDERLINE_OFF}${DIM} ${link[2]}${DIM_OFF}`;
				index += link[0].length;
				continue;
			}
		}
		out += char;
		index++;
	}
	return out;
}

interface Block {
	/** Written once, when the line is classified. */
	readonly prefix: string;
	/** Written at the end of the line, to close whatever the prefix opened. */
	readonly suffix: string;
	/** Where the content starts, once the marker that named the block is spent. */
	readonly bodyFrom: number;
	/** Code is shown as typed; everything else has its inline markers rendered. */
	readonly verbatim: boolean;
	/** A fence marker is scaffolding rather than content, and leaves no line behind. */
	readonly silent: boolean;
}

const ORDERED = /^\d{1,9}[.)]$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^#{1,6}$/;

export interface MarkdownStreamOptions {
	readonly write: (text: string) => void;
	/**
	 * Whether the destination is a terminal.
	 *
	 * Without it the text goes through exactly as the agent wrote it, because the reader is a file or
	 * another program and markdown is the format they already asked for.
	 */
	readonly color: boolean;
}

/**
 * Renders markdown to a terminal as it arrives.
 *
 * The unit of decision is the line, because the line is where markdown decides what something is:
 * `#` is a heading only at the start of one, and a fence only closes at the start of one. So a line
 * is held until its first whitespace — one word, never more — and from there its content streams as
 * fast as the inline markers in it finish being written.
 */
export class MarkdownStream {
	readonly #write: (text: string) => void;
	readonly #color: boolean;

	#line = "";
	#block: Block | undefined;
	#shown = "";
	#fenced = false;
	#tail = "";

	constructor(options: MarkdownStreamOptions) {
		this.#write = options.write;
		this.#color = options.color;
	}

	push(text: string): void {
		if (!this.#color) {
			if (text.length > 0) this.#tail = text.slice(-1);
			this.#write(text);
			return;
		}

		this.#line += text;
		for (;;) {
			const newline = this.#line.indexOf("\n");
			if (newline === -1) break;
			const line = this.#line.slice(0, newline);
			this.#line = this.#line.slice(newline + 1);
			this.#render(line, true);
			this.#endLine();
		}
		this.#render(this.#line, false);
	}

	/**
	 * Closes the line in hand, which on a stream that stopped mid-line is the last of the answer.
	 *
	 * Either way the output ends on a newline, so the shell prompt that follows starts where prompts
	 * start rather than tacked onto the agent's last sentence.
	 */
	end(): void {
		if (!this.#color) {
			if (this.#tail.length > 0 && this.#tail !== "\n") this.#write("\n");
			this.#tail = "";
			return;
		}
		if (this.#line.length === 0) return;
		this.#render(this.#line, true);
		this.#endLine();
		this.#line = "";
	}

	#endLine(): void {
		if (this.#block?.silent !== true) this.#write(`${this.#block?.suffix ?? ""}\n`);
		this.#block = undefined;
		this.#shown = "";
	}

	#render(line: string, complete: boolean): void {
		if (this.#block === undefined) {
			// Held until whitespace ends the marker, or the line turns out to be a single word. Every
			// block marker is punctuation followed by a space, so that space is the earliest moment a
			// heading can be told from a paragraph that merely opens with a `#`.
			const indent = line.length - line.trimStart().length;
			const rest = line.slice(indent);
			const space = rest.search(/\s/);
			if (space === -1 && !complete) return;

			this.#block = this.#classify(
				space === -1 ? rest : rest.slice(0, space),
				indent,
				space !== -1,
			);
			this.#write(this.#block.prefix);
		}

		if (this.#block.silent) return;

		const body = line.slice(this.#block.bodyFrom);
		const settled = this.#block.verbatim || complete ? body.length : safeEnd(body);
		const rendered = this.#block.verbatim
			? body.slice(0, settled)
			: renderInline(body.slice(0, settled));
		// Rendering a prefix that ends outside every span yields a prefix of the finished line, so
		// nothing already on screen ever has to be taken back.
		if (rendered.length > this.#shown.length) this.#write(rendered.slice(this.#shown.length));
		this.#shown = rendered;
	}

	/**
	 * What kind of line this is, from its first word.
	 *
	 * A fence is answered before anything else, since inside one a `#` is a comment rather than a
	 * heading — the whole point of the fence is that its contents are not markdown.
	 */
	#classify(marker: string, indent: number, spaced: boolean): Block {
		const plain = { bodyFrom: 0, verbatim: false, silent: false, prefix: "", suffix: "" };
		if (marker.startsWith("```") || marker.startsWith("~~~")) {
			this.#fenced = !this.#fenced;
			return { ...plain, silent: true };
		}
		// Indented by the fence rather than by the prefix, so the code keeps its own indentation.
		if (this.#fenced) return { ...plain, prefix: `${DIM}  `, suffix: DIM_OFF, verbatim: true };

		const after = indent + marker.length + (spaced ? 1 : 0);
		if (RULE.test(marker)) {
			return { ...plain, prefix: `${DIM}────────${DIM_OFF}`, bodyFrom: after, verbatim: true };
		}
		if (HEADING.test(marker)) {
			return { ...plain, prefix: BOLD, suffix: BOLD_OFF, bodyFrom: after };
		}
		if (marker === "-" || marker === "*" || marker === "+") {
			return { ...plain, prefix: `${" ".repeat(indent)}  • `, bodyFrom: after };
		}
		if (ORDERED.test(marker)) {
			return { ...plain, prefix: `${" ".repeat(indent)}  ${marker} `, bodyFrom: after };
		}
		if (marker === ">") {
			return { ...plain, prefix: `${DIM}│ `, suffix: DIM_OFF, bodyFrom: after };
		}
		return plain;
	}
}
