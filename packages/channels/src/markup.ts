/**
 * What an agent writes, as a mail client will draw it.
 *
 * Agents write markdown because that is what they are: a model answering, in the shape it answers in.
 * Sent as it stands, an answer arrives as `**Chiste #1:**` and a row of dashes — the punctuation of a
 * format nobody asked to read. So the markdown is turned into the small piece of HTML it describes.
 *
 * Everything is escaped, always, and there is no way through this for markup the agent wrote itself.
 * That is the point of doing it here rather than handing the body to a parser that lets HTML through:
 * an agent reads its mail, and a mail can tell it to write anything. A message that could put a form
 * or a link of its choosing in front of the operator is one that has phished them with their own
 * agent's face on it.
 */

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

function escaped(text: string): string {
	return text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
}

/** The style is written on each element, because mail clients throw away a stylesheet. */
const STYLE = {
	body: "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5",
	code: "background:#f4f4f5;border-radius:3px;padding:1px 4px;font-size:13px",
	pre: "background:#f4f4f5;border-radius:4px;padding:10px;overflow:auto;font-size:13px",
	quote: "margin:0 0 12px;padding:0 0 0 12px;border-left:3px solid #d4d4d8;color:#52525b",
	cell: "border:1px solid #d4d4d8;padding:4px 8px;text-align:left",
} as const;

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])[\s]*(\1[\s]*){2,}$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
const QUOTED = /^\s*>\s?(.*)$/;
const ROW = /^\s*\|(.*)\|\s*$/;
const LEAN = /^:?-{2,}:?$/;

/**
 * The schemes a mail client should be willing to follow, and nothing else.
 *
 * A link is the one thing in a message that does something when read, and the text of this one came
 * out of a model. Anything else is shown as what it is rather than made clickable, which loses
 * nothing: the address is still there to be read.
 */
function link(label: string, href: string): string {
	return /^(https?:|mailto:)/i.test(href) ? `<a href="${href}">${label}</a>` : `${label} (${href})`;
}

function emphasis(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_whole, label: string, href: string) =>
			link(label, href),
		)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/~~([^~]+)~~/g, "<del>$1</del>")
		.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
		.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
}

/**
 * A line of text, marked up.
 *
 * Code is taken out first, and by splitting rather than by matching, because every other pattern here
 * would otherwise go looking inside a span whose whole purpose is to be read literally.
 */
function inline(text: string): string {
	return text
		.split(/(`[^`]+`)/)
		.map((part) =>
			part.length > 1 && part.startsWith("`") && part.endsWith("`")
				? `<code style="${STYLE.code}">${escaped(part.slice(1, -1))}</code>`
				: emphasis(escaped(part)),
		)
		.join("");
}

function cells(row: string): readonly string[] {
	return (ROW.exec(row)?.[1] ?? "").split("|").map((cell) => cell.trim());
}

export function asHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let at = 0;

	while (at < lines.length) {
		const line = lines[at] ?? "";

		if (line.trim() === "") {
			at += 1;
			continue;
		}

		if (line.trimStart().startsWith("```")) {
			const held: string[] = [];
			at += 1;
			while (at < lines.length && !(lines[at] ?? "").trimStart().startsWith("```")) {
				held.push(lines[at] ?? "");
				at += 1;
			}
			at += 1;
			out.push(`<pre style="${STYLE.pre}"><code>${escaped(held.join("\n"))}</code></pre>`);
			continue;
		}

		if (RULE.test(line)) {
			out.push('<hr style="border:none;border-top:1px solid #d4d4d8;margin:16px 0">');
			at += 1;
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const depth = (heading[1] ?? "#").length;
			out.push(`<h${depth} style="margin:16px 0 8px">${inline(heading[2] ?? "")}</h${depth}>`);
			at += 1;
			continue;
		}

		// A row on its own is a line with pipes in it, and a table is a row with a rule under it. The
		// rule is what tells them apart, so a sentence about `a | b` is not drawn as a spreadsheet.
		if (ROW.test(line) && ROW.test(lines[at + 1] ?? "")) {
			const lean = cells(lines[at + 1] ?? "");
			if (lean.length > 0 && lean.every((cell) => LEAN.test(cell))) {
				const head = cells(line);
				at += 2;
				const body: (readonly string[])[] = [];
				while (at < lines.length && ROW.test(lines[at] ?? "")) {
					body.push(cells(lines[at] ?? ""));
					at += 1;
				}
				const row = (given: readonly string[], tag: "th" | "td"): string =>
					`<tr>${given.map((cell) => `<${tag} style="${STYLE.cell}">${inline(cell)}</${tag}>`).join("")}</tr>`;
				out.push(
					`<table style="border-collapse:collapse;margin:0 0 12px"><thead>${row(head, "th")}</thead>` +
						`<tbody>${body.map((one) => row(one, "td")).join("")}</tbody></table>`,
				);
				continue;
			}
		}

		const listed = BULLET.exec(line) ? BULLET : NUMBERED.exec(line) ? NUMBERED : undefined;
		if (listed !== undefined) {
			const items: string[] = [];
			while (at < lines.length) {
				const item = listed.exec(lines[at] ?? "");
				if (item === null) break;
				items.push(`<li>${inline(item[1] ?? "")}</li>`);
				at += 1;
			}
			const tag = listed === BULLET ? "ul" : "ol";
			out.push(`<${tag} style="margin:0 0 12px;padding-left:22px">${items.join("")}</${tag}>`);
			continue;
		}

		if (QUOTED.test(line)) {
			const held: string[] = [];
			while (at < lines.length) {
				const quoted = QUOTED.exec(lines[at] ?? "");
				if (quoted === null) break;
				held.push(inline(quoted[1] ?? ""));
				at += 1;
			}
			out.push(`<blockquote style="${STYLE.quote}">${held.join("<br>")}</blockquote>`);
			continue;
		}

		// A paragraph is every line up to the next blank one, and the breaks inside it are kept. Mail is
		// not the web: an answer laid out in short lines was laid out that way on purpose.
		const held: string[] = [];
		while (at < lines.length) {
			const next = lines[at] ?? "";
			if (
				next.trim() === "" ||
				RULE.test(next) ||
				HEADING.test(next) ||
				BULLET.test(next) ||
				NUMBERED.test(next) ||
				QUOTED.test(next) ||
				next.trimStart().startsWith("```")
			) {
				break;
			}
			held.push(inline(next));
			at += 1;
		}
		out.push(`<p style="margin:0 0 12px">${held.join("<br>")}</p>`);
	}

	return `<div style="${STYLE.body}">${out.join("")}</div>`;
}
