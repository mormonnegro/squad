import type { ReactNode } from "react";
import { FileLink, folderSaid, linkedPath, pathOf, paths, useBox } from "./box.tsx";
import { coloured, grammarOf } from "./code.tsx";
import { SERVED_IN_TEXT, ServedLink } from "./served.tsx";
import { drawsTree, fenced } from "./tree.tsx";

/**
 * What the model wrote, as what it meant.
 *
 * Written here rather than pulled in, for the reason everything else on this side is: the plane's
 * own renderer paints ANSI for a terminal, and a markdown library is a dependency the size of the
 * rest of this package to read six kinds of mark. These six are what agents actually write —
 * emphasis, code, fences, lists, headings and links — and anything else falls through as the text
 * it already was, which is what it looked like before this existed.
 *
 * React nodes, never HTML: nothing here is handed to `dangerouslySetInnerHTML`, so a message cannot
 * carry markup into this page however it is written. The one place that is not automatic is a link's
 * address, which is checked below.
 */

/** Addresses a link may point at. Anything else is drawn as the text it was, and goes nowhere. */
const SAFE = /^(https?:|mailto:)/i;

/**
 * An address written as itself, which is how an address actually arrives.
 *
 * `[text](url)` is what markdown is for and it is not what gets written when an agent hands over a
 * login URL: it writes the address, on a line of its own, the way it would say it. Every terminal
 * turns that into something clickable without being asked, so a console that leaves it as characters
 * is the one surface the link cannot be followed from. The schemes are the ones `SAFE` admits, which
 * is that rule written as a scanner rather than as a check.
 */
const BARE = /^(?:https?:\/\/|mailto:)[^\s<>"]+/i;
/** What a sentence puts after an address rather than inside one. */
const AFTER = /[.,;:!?"'\u2026]/;
/** Brackets, which sit inside an address exactly as often as they sit around one. */
const SHUT: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

interface Fence {
	readonly kind: "fence";
	readonly language: string;
	readonly code: string;
}
interface Heading {
	readonly kind: "heading";
	readonly depth: number;
	readonly text: string;
}
interface List {
	readonly kind: "list";
	readonly ordered: boolean;
	readonly items: readonly string[];
}
interface Quote {
	readonly kind: "quote";
	readonly text: string;
}
interface Para {
	readonly kind: "para";
	readonly text: string;
}
interface Table {
	readonly kind: "table";
	readonly head: readonly string[];
	readonly rows: readonly (readonly string[])[];
	/** Which way each column is read, one per column of the squared table. */
	readonly leans: readonly Lean[];
}

type Lean = "left" | "right" | "center";

type Block = Fence | Heading | List | Quote | Para | Table;

/** A line that opens with a pipe opens a table, and nothing else opens with one. */
const ROW = /^\s*\|/;
/** `---`, `:--`, `--:` or `:-:`: the row that says a table is a table, and how it leans. */
const LEAN = /^(:?)-+(:?)$/;
/** A figure, which belongs against the column it is compared down. Currencies and percents included. */
const FIGURE = /^[-+]?[$€£]?\d[\d.,\s]*%?$/;

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/**
 * The text, cut into the things it is made of.
 *
 * A fence swallows everything to its closing line, including blank lines and things that would
 * otherwise be headings — inside a fence they are the code, and treating them as marks is how a
 * shell script becomes six headings.
 */
export function blocks(text: string): readonly Block[] {
	const lines = text.split("\n");
	const out: Block[] = [];
	let para: string[] = [];

	const flush = (): void => {
		if (para.length > 0) out.push({ kind: "para", text: para.join("\n") });
		para = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		const fence = /^\s*```(.*)$/.exec(line);
		if (fence !== null) {
			flush();
			const code: string[] = [];
			i++;
			// An unclosed fence runs to the end, which is what it looks like while one is still
			// arriving a piece at a time.
			for (; i < lines.length && !/^\s*```/.test(lines[i] ?? ""); i++) code.push(lines[i] ?? "");
			out.push({ kind: "fence", language: (fence[1] ?? "").trim(), code: code.join("\n") });
			continue;
		}

		if (line.trim().length === 0) {
			flush();
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading !== null) {
			flush();
			out.push({ kind: "heading", depth: (heading[1] ?? "#").length, text: heading[2] ?? "" });
			continue;
		}

		const quote = QUOTE.exec(line);
		if (quote !== null) {
			flush();
			const said: string[] = [quote[1] ?? ""];
			while (i + 1 < lines.length && QUOTE.test(lines[i + 1] ?? "")) {
				i++;
				said.push(QUOTE.exec(lines[i] ?? "")?.[1] ?? "");
			}
			out.push({ kind: "quote", text: said.join("\n") });
			continue;
		}

		if (ROW.test(line)) {
			const rows: string[] = [line];
			while (i + 1 < lines.length && ROW.test(lines[i + 1] ?? "")) {
				i++;
				rows.push(lines[i] ?? "");
			}
			// Two rows make a table. One is a line of prose that happens to start with a pipe — which is
			// how the terminal reads the same text, and the two surfaces disagreeing about what a
			// message says would be worse than whichever rule is wrong.
			if (rows.length > 1) {
				flush();
				out.push(tabled(rows));
				continue;
			}
			para.push(line);
			continue;
		}

		const bullet = BULLET.exec(line);
		const number = NUMBER.exec(line);
		if (bullet !== null || number !== null) {
			flush();
			const ordered = number !== null;
			const items: string[] = [bullet?.[1] ?? number?.[1] ?? ""];
			while (i + 1 < lines.length) {
				const next = lines[i + 1] ?? "";
				const more = ordered ? NUMBER.exec(next) : BULLET.exec(next);
				if (more === null) break;
				i++;
				items.push(more[1] ?? "");
			}
			out.push({ kind: "list", ordered, items });
			continue;
		}

		para.push(line);
	}

	flush();
	return out;
}

/**
 * The rows of a table, squared off and told which way they lean.
 *
 * Written the way the terminal's renderer writes it, down to the leaning: the lean row is optional
 * because plenty of agents skip it, and a column of figures then says which way it is read itself —
 * a comparison is read down the last digit, and a column of numbers ragged on the right is a table
 * whose one job has not been done.
 */
function tabled(lines: readonly string[]): Table {
	const parsed = lines.map(cells);
	// The lean row carries no data: it is spent on knowing how each column is read.
	const leaning = parsed[1]?.every((cell) => LEAN.test(cell)) === true ? parsed[1] : undefined;
	const head = parsed[0] ?? [];
	const body = parsed.slice(leaning === undefined ? 1 : 2);
	const count = Math.max(head.length, ...body.map((row) => row.length), 1);
	const square = (row: readonly string[]): readonly string[] =>
		Array.from({ length: count }, (_, index) => row[index] ?? "");

	return {
		kind: "table",
		head: square(head),
		rows: body.map(square),
		leans: Array.from({ length: count }, (_, index) => leanOf(leaning?.[index], body, index)),
	};
}

function leanOf(said: string | undefined, body: readonly (readonly string[])[], at: number): Lean {
	const lean = LEAN.exec(said ?? "");
	if (lean?.[2] === ":") return lean[1] === ":" ? "center" : "right";
	if (lean !== null && lean[1] === ":") return "left";
	// Nothing said, so the column says it. Anything that is not a figure, even one cell of it, is
	// prose, and prose starts at the left.
	const column = body.map((row) => row[at] ?? "").filter((cell) => cell !== "");
	return column.length > 0 && column.every((cell) => FIGURE.test(cell)) ? "right" : "left";
}

/**
 * One row's cells, with the pipes that bound them spent.
 *
 * The outer pipes are optional in the markdown and meaningless either way, so a row that has them
 * and a row that does not have to come out with the same number of cells — otherwise the header
 * sits one column off its own body.
 */
function cells(line: string): readonly string[] {
	let inner = line.trim();
	if (inner.startsWith("|")) inner = inner.slice(1);
	if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);
	return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * The address inside a run of characters that has no spaces in it.
 *
 * The run is where an address stops being obvious. One at the end of a sentence is followed by the
 * full stop that ended the sentence, and one inside brackets by the bracket that shut them: neither
 * is part of the address and both are inside the run, so they come off the end. Except a bracket the
 * address opened itself, which is how a good deal of Wikipedia is addressed and which is a 404
 * without it.
 */
/**
 * Whether an underscore here is inside a word, where it is an underscore and not an emphasis.
 *
 * `evt_real_1` and `customer_id` are not italics, and a JSON payload from Stripe is most of a
 * screen of them. The rule is CommonMark's and for its reason: `*` is punctuation nobody puts in
 * an identifier and `_` is punctuation everybody does, so only `_` has to look at the letter to
 * its left before deciding it is a mark.
 */
function inWord(text: string, at: number): boolean {
	const before = text[at - 1];
	return before !== undefined && /[\p{L}\p{N}]/u.test(before);
}

function addressOf(run: string): string {
	let url = run;
	while (url.length > 0) {
		const last = url.slice(-1);
		const opener = SHUT[last];
		const outside = opener === undefined ? AFTER.test(last) : !opened(url, opener, last);
		if (!outside) break;
		url = url.slice(0, -1);
	}
	return url;
}

/** Whether the address opened the bracket it ends with, or a sentence around it did. */
function opened(url: string, open: string, shut: string): boolean {
	const count = (mark: string): number => url.split(mark).length - 1;
	return count(open) >= count(shut);
}

/**
 * The marks inside a line, in one pass.
 *
 * Code first and always: a backtick run is opaque, so `**` inside one is two asterisks and not the
 * start of anything. Everything after that is scanned for the earliest mark rather than applied in
 * layers, which is what keeps `*` in prose from becoming emphasis three words later.
 */
export function inline(text: string, base?: string | undefined): ReactNode[] {
	const out: ReactNode[] = [];
	let plain = "";
	let key = 0;

	// What is left once the marks are out of it is prose, and a path an agent wrote is in there
	// somewhere. Read here rather than in a pass of its own, because the two would disagree about
	// the `_` in a filename: everything below has already decided what is a mark and what is a name.
	const keep = (): void => {
		if (plain.length > 0) out.push(...paths(plain, base, key++));
		plain = "";
	};

	for (let i = 0; i < text.length; ) {
		const rest = text.slice(i);

		const code = /^`([^`]+)`/.exec(rest);
		if (code !== null) {
			keep();
			const said = code[1] ?? "";
			// Backticks are where an agent puts a path more often than not, and what is between a pair
			// of them is the whole of it. It keeps the box they draw and becomes a thing to press.
			const path = pathOf(said, base);
			out.push(
				path === undefined ? (
					<code className="md-code" key={key++}>
						{said}
					</code>
				) : (
					<FileLink key={key++} path={path} chip>
						{said}
					</FileLink>
				),
			);
			i += code[0].length;
			continue;
		}

		const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
		if (link !== null) {
			keep();
			const href = link[2] ?? "";
			const label = link[1] ?? "";
			// An address this page will not open is drawn as what it was. The agent wrote it; that does
			// not make it a thing to hand a browser. Unless it is not an address at all but a file in
			// the box, which is the one thing written here that this page can open itself.
			const file = SAFE.test(href) ? undefined : linkedPath(href, base);
			out.push(
				SAFE.test(href) ? (
					<a href={href} target="_blank" rel="noreferrer noopener" key={key++}>
						{label}
					</a>
				) : file !== undefined ? (
					<FileLink key={key++} path={file}>
						{label}
					</FileLink>
				) : (
					<span key={key++}>{link[0]}</span>
				),
			);
			i += link[0].length;
			continue;
		}

		/*
		 * A port an agent opened, which arrives as a path rather than as an address.
		 *
		 * `/serve` answers with `/at/dev/3101/` and it has to: the plane cannot know which address
		 * this console is being read at. This end can — it is the address this page came from — so
		 * the path is drawn as the link it means, the same one the chip beside the agent draws, and
		 * the reader gets something to click rather than something to retype.
		 */
		const port = SERVED_IN_TEXT.exec(rest);
		if (port !== null) {
			keep();
			out.push(
				<ServedLink key={key++} agentId={port[1] ?? ""} port={Number(port[2])}>
					{port[0]}
				</ServedLink>,
			);
			i += port[0].length;
			continue;
		}

		// Taken whole, and before the marks below: that ordering is also what keeps a query string
		// intact, because the `_` in `client_id` is an underscore and not the opening of an emphasis
		// that closes somewhere further down the address.
		const loose = BARE.exec(rest);
		const bare = loose === null ? "" : addressOf(loose[0]);
		if (BARE.test(bare)) {
			keep();
			out.push(
				<a href={bare} target="_blank" rel="noreferrer noopener" key={key++}>
					{bare}
				</a>,
			);
			i += bare.length;
			continue;
		}

		const strong =
			/^\*\*([^\n]+?)\*\*/.exec(rest) ?? (inWord(text, i) ? null : /^__([^\n]+?)__/.exec(rest));
		if (strong !== null) {
			keep();
			out.push(<strong key={key++}>{inline(strong[1] ?? "", base)}</strong>);
			i += strong[0].length;
			continue;
		}

		// One star, and not the first of two: `**` is handled above, so a lone one that reaches here
		// is emphasis or it is punctuation, and punctuation is what it stays if nothing closes it.
		const em =
			/^\*([^*\n]+?)\*/.exec(rest) ?? (inWord(text, i) ? null : /^_([^_\n]+?)_/.exec(rest));
		if (em !== null) {
			keep();
			out.push(<em key={key++}>{inline(em[1] ?? "", base)}</em>);
			i += em[0].length;
			continue;
		}

		plain += text[i];
		i++;
	}

	keep();
	return out;
}

/** One agent's message, drawn as what it wrote rather than as the characters it typed. */
export function Markdown({ text }: { text: string }) {
	const box = useBox();
	return (
		<div className="md">
			{placed(blocks(text), box?.base).map(([block, base], index) => (
				// Blocks have no identity of their own and the list is rebuilt whole on every change.
				// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
				<Drawn key={index} block={block} base={base} />
			))}
		</div>
	);
}

/**
 * Each block with the folder the message had named by the time it reached it.
 *
 * Which is the whole of how a drawing of a workspace becomes the workspace. "Esto es lo que hay en
 * `/home/agent/workspace`:" and then a tree of a dozen names, not one of which says where it is —
 * because the sentence above it already did, and a person reads the two together. So the message is
 * walked in order and what it has said so far is carried forward into what it says next. A message
 * that has named nowhere carries nothing, and every bare name in it stays the name it was.
 */
export function placed(
	said: readonly Block[],
	from: string | undefined,
): readonly (readonly [Block, string | undefined])[] {
	let base = from;
	const out: (readonly [Block, string | undefined])[] = [];
	for (const block of said) {
		out.push([block, base]);
		base = folderSaid(saying(block), base) ?? base;
	}
	return out;
}

/** The prose of a block, which is where a message says where it is. Nothing, for the rest. */
function saying(block: Block): string {
	switch (block.kind) {
		case "para":
		case "quote":
		case "heading":
			return block.text;
		case "list":
			return block.items.join("\n");
		default:
			// A fence is what the sentence above it was about, and a table is columns of figures.
			// Neither is a place saying where it is.
			return "";
	}
}

/**
 * What is inside a fence, read by whoever should be reading it.
 *
 * A fence that said what it was written in gets read as that, the way it would anywhere else code is
 * shown. A fence that said nothing is the half of them that is not code at all — a tree, a shell
 * session, the tail of a log — and those stay exactly as they were: the language was never the
 * question there, the files named in them were.
 */
function lit(code: string, language: string, base: string | undefined): ReactNode[] {
	if (grammarOf(language) === undefined || drawsTree(code)) return fenced(code, base);
	return coloured(code, language, base);
}

function Drawn({ block, base }: { block: Block; base: string | undefined }) {
	switch (block.kind) {
		case "fence":
			return (
				<pre className="md-fence" data-language={block.language || undefined}>
					<code>{lit(block.code, block.language, base)}</code>
				</pre>
			);
		case "heading": {
			// Depth is a fact about the text and not a size: inside a message every heading is the same
			// small bold line, because a message is not a page and an `#` in one is a label.
			return (
				<div className="md-heading" data-depth={block.depth}>
					{inline(block.text, base)}
				</div>
			);
		}
		case "quote":
			return <blockquote className="md-quote">{inline(block.text, base)}</blockquote>;
		case "list":
			return block.ordered ? (
				<ol className="md-list">
					{block.items.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
						<li key={index}>{inline(item, base)}</li>
					))}
				</ol>
			) : (
				<ul className="md-list">
					{block.items.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
						<li key={index}>{inline(item, base)}</li>
					))}
				</ul>
			);
		case "table":
			// In a scroller of its own: a table with six columns of figures is wider than a pane and
			// must not be what decides the width of the conversation around it.
			return (
				<div className="md-scroll">
					<table className="md-table">
						<thead>
							<tr>
								{block.head.map((cell, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
									<th key={index} data-lean={block.leans[index]}>
										{inline(cell, base)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, line) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
								<tr key={line}>
									{row.map((cell, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
										<td key={index} data-lean={block.leans[index]}>
											{inline(cell, base)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "para":
			return <p className="md-para">{inline(block.text, base)}</p>;
	}
}
