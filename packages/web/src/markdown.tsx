import type { ReactNode } from "react";

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

type Block = Fence | Heading | List | Quote | Para;

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
 * The marks inside a line, in one pass.
 *
 * Code first and always: a backtick run is opaque, so `**` inside one is two asterisks and not the
 * start of anything. Everything after that is scanned for the earliest mark rather than applied in
 * layers, which is what keeps `*` in prose from becoming emphasis three words later.
 */
export function inline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let plain = "";
	let key = 0;

	const keep = (): void => {
		if (plain.length > 0) out.push(plain);
		plain = "";
	};

	for (let i = 0; i < text.length; ) {
		const rest = text.slice(i);

		const code = /^`([^`]+)`/.exec(rest);
		if (code !== null) {
			keep();
			out.push(
				<code className="md-code" key={key++}>
					{code[1]}
				</code>,
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
			// not make it a thing to hand a browser.
			out.push(
				SAFE.test(href) ? (
					<a href={href} target="_blank" rel="noreferrer noopener" key={key++}>
						{label}
					</a>
				) : (
					<span key={key++}>{link[0]}</span>
				),
			);
			i += link[0].length;
			continue;
		}

		const strong = /^\*\*([^\n]+?)\*\*/.exec(rest) ?? /^__([^\n]+?)__/.exec(rest);
		if (strong !== null) {
			keep();
			out.push(<strong key={key++}>{inline(strong[1] ?? "")}</strong>);
			i += strong[0].length;
			continue;
		}

		// One star, and not the first of two: `**` is handled above, so a lone one that reaches here
		// is emphasis or it is punctuation, and punctuation is what it stays if nothing closes it.
		const em = /^\*([^*\n]+?)\*/.exec(rest) ?? /^_([^_\n]+?)_/.exec(rest);
		if (em !== null) {
			keep();
			out.push(<em key={key++}>{inline(em[1] ?? "")}</em>);
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
	return (
		<div className="md">
			{blocks(text).map((block, index) => (
				// Blocks have no identity of their own and the list is rebuilt whole on every change.
				// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
				<Drawn key={index} block={block} />
			))}
		</div>
	);
}

function Drawn({ block }: { block: Block }) {
	switch (block.kind) {
		case "fence":
			return (
				<pre className="md-fence" data-language={block.language || undefined}>
					<code>{block.code}</code>
				</pre>
			);
		case "heading": {
			// Depth is a fact about the text and not a size: inside a message every heading is the same
			// small bold line, because a message is not a page and an `#` in one is a label.
			return (
				<div className="md-heading" data-depth={block.depth}>
					{inline(block.text)}
				</div>
			);
		}
		case "quote":
			return <blockquote className="md-quote">{inline(block.text)}</blockquote>;
		case "list":
			return block.ordered ? (
				<ol className="md-list">
					{block.items.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
						<li key={index}>{inline(item)}</li>
					))}
				</ol>
			) : (
				<ul className="md-list">
					{block.items.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
						<li key={index}>{inline(item)}</li>
					))}
				</ul>
			);
		case "para":
			return <p className="md-para">{inline(block.text)}</p>;
	}
}
