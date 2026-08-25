import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

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

/** Room enough for a table to be a table. Overridden by whoever knows the pane it is drawn into. */
const COLUMNS = 80;

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

/** `---`, `:--`, `--:` or `:-:`: the row that says a table is a table, and how it leans. */
const LEAN = /^(:?)-+(:?)$/;
/** A figure, which belongs against the column it is compared down. Currencies and percents included. */
const FIGURE = /^[-+]?[$€£]?\d[\d.,\s]*%?$/;

type Lean = "left" | "right" | "center";

/**
 * One row's cells, with the pipes that bound them spent.
 *
 * The outer pipes are optional in the markdown and meaningless either way, so a row that has them and
 * a row that does not have to come out with the same number of cells — otherwise the header sits one
 * column off its own body.
 */
function cells(line: string): readonly string[] {
	let inner = line.trim();
	if (inner.startsWith("|")) inner = inner.slice(1);
	if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);
	return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/** What the widths would be if nothing had to give: every cell whole, on one line. */
function natural(rows: readonly (readonly string[])[]): readonly number[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (const [index, cell] of row.entries()) {
			widths[index] = Math.max(widths[index] ?? 0, stringWidth(cell));
		}
	}
	return widths;
}

/**
 * The widths the table will actually be drawn at.
 *
 * What has to give gives from the widest column, one column at a time, because the widest column is
 * the prose one and prose is the only thing here that reads the same folded onto a second line. Take
 * it evenly instead and the number columns lose the digits that were the point of the table.
 */
function fit(widths: readonly number[], room: number): readonly number[] {
	const fitted = [...widths];
	let total = fitted.reduce((sum, width) => sum + width, 0);
	while (total > room) {
		let widest = 0;
		let most = 0;
		for (const [index, width] of fitted.entries()) {
			if (width > most) {
				most = width;
				widest = index;
			}
		}
		if (most <= 1) break;
		fitted[widest] = most - 1;
		total--;
	}
	return fitted;
}

function padded(text: string, width: number, lean: Lean): string {
	const room = width - stringWidth(text);
	if (room <= 0) return text;
	if (lean === "right") return " ".repeat(room) + text;
	if (lean === "left") return text + " ".repeat(room);
	const left = Math.floor(room / 2);
	return " ".repeat(left) + text + " ".repeat(room - left);
}

/**
 * A markdown table as the rows of a terminal.
 *
 * Alignment is the whole job. A table is a shape before it is words — the eye reads down a column to
 * compare, and pipes that do not line up are worse than no table at all, because the shape is there
 * promising something the numbers under it do not keep. So the cells are padded to a common width,
 * the prose in them is folded rather than let out past the pane, and the pipes become the one
 * vertical line per boundary that a reader can actually follow down the page.
 */
export function renderTable(lines: readonly string[], columns: number): readonly string[] {
	const parsed = lines.map(cells);
	// The lean row is markdown's, not the reader's: it carries no data and is spent on knowing which
	// way each column is read. Absent, the table is still a table — plenty of agents skip it.
	const leaning = parsed[1]?.every((cell) => LEAN.test(cell)) === true ? parsed[1] : undefined;
	const head = parsed[0] ?? [];
	const body = parsed.slice(leaning === undefined ? 1 : 2);

	const count = Math.max(head.length, ...body.map((row) => row.length), 1);
	const square = [head, ...body].map((row) =>
		Array.from({ length: count }, (_, index) => row[index] ?? ""),
	);

	const leans: readonly Lean[] = Array.from({ length: count }, (_, index) => {
		const said = LEAN.exec(leaning?.[index] ?? "");
		if (said?.[2] === ":") return said[1] === ":" ? "center" : "right";
		if (said !== null && said[1] === ":") return "left";
		// Nothing said, so the column says it: a column of figures is compared, and a comparison is read
		// down the last digit. Anything else, even one cell of it, is prose and starts at the left.
		const column = body.map((row) => row[index] ?? "").filter((cell) => cell !== "");
		return column.length > 0 && column.every((cell) => FIGURE.test(cell)) ? "right" : "left";
	});

	// Bold has one off switch and the cells may already have used it — `**Keyword**` closes the header's
	// bold along with its own — so every off inside a header cell is turned back on.
	const painted = square.map((row, index) =>
		row.map((cell) => {
			const inline = renderInline(cell);
			return index === 0 ? BOLD + inline.replaceAll(BOLD_OFF, BOLD) + BOLD_OFF : inline;
		}),
	);

	const gaps = 3 * (count - 1);
	const widths = fit(natural(painted), Math.max(count, columns - gaps));
	const bar = `${DIM}│${DIM_OFF}`;

	const out: string[] = [];
	for (const [index, row] of painted.entries()) {
		// Folded here rather than by the pane, which knows nothing of columns and would fold the whole
		// row into the left margin. A cell that takes two lines makes the row two lines tall.
		const folded = row.map((cell, column) =>
			wrapAnsi(cell, widths[column] ?? 1, { hard: true, trim: true }).split("\n"),
		);
		const tall = Math.max(...folded.map((cell) => cell.length));
		for (let line = 0; line < tall; line++) {
			const drawn = folded.map((cell, column) =>
				padded(cell[line] ?? "", widths[column] ?? 1, leans[column] ?? "left"),
			);
			out.push(drawn.join(` ${bar} `).trimEnd());
		}
		if (index === 0) {
			out.push(DIM + widths.map((width) => "─".repeat(width)).join("─┼─") + DIM_OFF);
		}
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
	/** A row of a table, which is held until the table it belongs to has ended. */
	readonly table: boolean;
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
	/**
	 * How many columns the text is being drawn into.
	 *
	 * Only a table asks. Everything else here is a line of prose, and prose is folded downstream by
	 * whoever owns the pane; a table has to be folded while its columns are still known.
	 */
	readonly width?: number;
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
	readonly #width: number;

	#line = "";
	#block: Block | undefined;
	#shown = "";
	#fenced = false;
	#tail = "";
	#rows: string[] = [];

	constructor(options: MarkdownStreamOptions) {
		this.#write = options.write;
		this.#color = options.color;
		this.#width = options.width ?? COLUMNS;
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
		if (this.#line.length > 0) {
			this.#render(this.#line, true);
			this.#endLine();
			this.#line = "";
		}
		this.#drawTable();
	}

	/**
	 * Draws the table that has been collecting, now that something other than a row has arrived.
	 *
	 * This is the one place the stream stops streaming, and it has to: the width of a column is not
	 * known until the last row that could widen it is in. A single row is not a table but a line that
	 * happens to start with a pipe, and it goes out as the prose it is.
	 */
	#drawTable(): void {
		const rows = this.#rows;
		this.#rows = [];
		if (rows.length === 0) return;
		if (rows.length < 2) {
			for (const row of rows) this.#write(`${renderInline(row)}\n`);
			return;
		}
		for (const line of renderTable(rows, this.#width)) this.#write(`${line}\n`);
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

			const block = this.#classify(
				space === -1 ? rest : rest.slice(0, space),
				indent,
				space !== -1,
			);
			// Anything that is not another row is the end of the table above it.
			if (!block.table) this.#drawTable();
			this.#block = block;
			this.#write(block.prefix);
		}

		if (this.#block.table) {
			if (complete) this.#rows.push(line);
			return;
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
		const plain = {
			bodyFrom: 0,
			verbatim: false,
			silent: false,
			table: false,
			prefix: "",
			suffix: "",
		};
		if (marker.startsWith("```") || marker.startsWith("~~~")) {
			this.#fenced = !this.#fenced;
			return { ...plain, silent: true };
		}
		// Indented by the fence rather than by the prefix, so the code keeps its own indentation.
		if (this.#fenced) return { ...plain, prefix: `${DIM}  `, suffix: DIM_OFF, verbatim: true };

		// A line that opens with a pipe opens a table, and nothing else opens with a pipe.
		if (marker.startsWith("|")) return { ...plain, silent: true, table: true };

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
