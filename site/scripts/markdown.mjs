// The same documentation, as markdown, for whoever is reading it without a browser.
//
// This runs after `next build` and converts the exported pages rather than a second copy of their
// text, so there is still one source for every sentence and the markdown cannot quietly fall a
// version behind the HTML. The converter knows the exact set of elements the docs pages use and
// throws on anything else: a page that grows a new kind of block breaks the build here instead of
// silently losing a paragraph in the version nobody looks at.
//
// It writes:
//   /llms.txt            the index, in the convention agents look for
//   /llms-full.txt       every page in one file, for handing over whole
//   /docs/<page>.md      one page, for following a link out of either of the above

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_PAGES, DOCS, markdownOf } from "../lib/docs.ts";
import { REPO, SITE, TAGLINE, TITLE } from "../lib/site.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

// ---------- the page list ----------

// `markdownOf` is the site's own rule for where a page's markdown lives, so the file this writes and
// the address the page's head advertises are the same string by construction.
const PAGES = DOC_PAGES.map((page) => ({ ...page, at: markdownOf(page.href) }));
const MD = new Map(PAGES.map((page) => [page.href, `${SITE}${page.at}`]));

// ---------- html in ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'", nbsp: " " };

function decode(text) {
	return text.replace(
		/&(#x27|#39|amp|quot|nbsp|lt|gt);/g,
		(whole, name) => ENTITIES[name] ?? whole,
	);
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);
const TAG = /<(\/?)([a-z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>/g;

/** A tree of `{ tag, cls, kids }`, where a text node is `{ tag: "#text", text }`. */
function parse(html, where) {
	const root = { tag: "#root", cls: "", kids: [] };
	const stack = [root];
	const text = (raw) => {
		if (raw !== "") stack[stack.length - 1].kids.push({ tag: "#text", text: decode(raw) });
	};

	let at = 0;
	TAG.lastIndex = 0;
	for (let m = TAG.exec(html); m !== null; m = TAG.exec(html)) {
		text(html.slice(at, m.index));
		at = TAG.lastIndex;
		const [, closing, tag, attrs, selfClosing] = m;

		if (closing !== "") {
			const open = stack.pop();
			if (open === undefined || open.tag !== tag) {
				throw new Error(`${where}: </${tag}> closes <${open?.tag ?? "nothing"}>`);
			}
			continue;
		}

		const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
		const href = /href="([^"]*)"/.exec(attrs)?.[1];
		const node = { tag, cls, href, kids: [] };
		stack[stack.length - 1].kids.push(node);
		if (selfClosing === "" && !VOID.has(tag)) stack.push(node);
	}
	text(html.slice(at));

	if (stack.length !== 1)
		throw new Error(`${where}: <${stack[stack.length - 1].tag}> is never closed`);
	return root;
}

/** The body of a docs page: what is between the header and the two links at the foot. */
function bodyOf(html, where) {
	const opens = '<article class="docs-body">';
	const from = html.indexOf(opens);
	const to = html.indexOf('<div class="docs-walk">');
	if (from < 0 || to < 0) throw new Error(`${where}: no docs body in it`);
	return parse(html.slice(from + opens.length, to).replace(/<!--.*?-->/gs, ""), where);
}

// ---------- markdown out ----------

/** Every element the docs pages use, keyed the way the converter tests them. */
function keyOf(node) {
	return node.cls === "" ? node.tag : `${node.tag}.${node.cls.split(" ").join(".")}`;
}

/** The flat text of a subtree, which is all a fenced block or a heading can hold. */
function flatten(node) {
	if (node.tag === "#text") return node.text;
	return node.kids.map(flatten).join("");
}

/** The inline markup inside a paragraph or a table cell, which is all either of them may hold. */
function run(node, where) {
	return node.kids.map((kid) => inline(kid, where)).join("");
}

/** One piece of that run. */
function inline(node, where) {
	if (node.tag === "#text") return node.text;

	const kids = () => run(node, where);
	switch (keyOf(node)) {
		case "strong":
			return `**${kids()}**`;
		case "em":
			return `*${kids()}*`;
		case "code":
			return `\`${kids()}\``;
		case "a":
			return `[${kids()}](${absolute(node.href)})`;
		case "span":
			return kids();
		default:
			throw new Error(`${where}: nothing says what <${keyOf(node)}> is in a line of prose`);
	}
}

/** A link as it should read to someone who is holding the markdown rather than the site. */
function absolute(href) {
	if (href === undefined) throw new Error("a link with no href");
	if (!href.startsWith("/")) return href;
	// A page is a directory and the export writes it with a trailing slash; a file is not.
	const page = href.endsWith("/") || /\.[a-z0-9]+$/.test(href) ? href : `${href}/`;
	return MD.get(page) ?? `${SITE}${page}`;
}

function fence(body, language = "") {
	return `\`\`\`${language}\n${body.replace(/\s+$/, "")}\n\`\`\``;
}

/** A two-column table, which is what every table on the site is, read as a list of pairs. */
function pairs(node, where, mono) {
	const rows = node.kids.flatMap((kid) => (kid.tag === "tbody" ? kid.kids : [kid]));
	return rows
		.map((row) => {
			if (row.tag !== "tr") throw new Error(`${where}: <${row.tag}> in a table is not a row`);
			const [term, meaning] = row.kids;
			if (row.kids.length !== 2) throw new Error(`${where}: a row of ${row.kids.length} cells`);
			const head = mono ? `\`${flatten(term)}\`` : `**${run(term, where).trim()}**`;
			return `- ${head} — ${run(meaning, where).trim()}`;
		})
		.join("\n");
}

/** One block: a heading, a paragraph, a table, a capture, or a container of those. */
function block(node, where) {
	if (node.tag === "#text") return node.text.trim() === "" ? [] : [node.text.trim()];

	const kids = () => node.kids.flatMap((kid) => block(kid, where));
	switch (keyOf(node)) {
		case "#root":
			return kids();
		// The eyebrow is the topic and the h2 is the claim it makes, and a heading that keeps only one
		// of the two loses either what the section is about or what it says.
		case "section": {
			const eyebrow = node.kids.find((kid) => kid.cls === "eyebrow");
			const heading = node.kids.find((kid) => kid.tag === "h2");
			const rest = node.kids.filter((kid) => kid !== eyebrow && kid !== heading);
			const title = [eyebrow, heading]
				.filter((part) => part !== undefined)
				.map((part) => flatten(part).trim())
				.join(" — ");
			const body = rest.flatMap((kid) => block(kid, where));
			return title === "" ? body : [`## ${title}`, ...body];
		}
		case "header.docs-head":
			return kids();
		// Which part of the menu the page is under. That is where it sits among the others rather than
		// anything the page says, and llms.txt already lists it under that heading.
		case "span.docs-crumb":
			return [];
		case "div.docs-map":
			return kids();
		case "h1":
			return [`# ${flatten(node).trim()}`];
		case "h2":
			return [`## ${flatten(node).trim()}`];
		case "h3":
			return [`### ${flatten(node).trim()}`];
		case "p":
		case "p.lede":
		case "p.small.muted":
			return [run(node, where).replace(/\s+/g, " ").trim()];
		case "table.table":
			return [pairs(node, where, false)];
		case "table.table.table-cmd":
			return [pairs(node, where, true)];
		case "div.note":
		case "div.note.warn":
			return kids().map((part) => part.replace(/^/gm, "> "));
		// A capture of the console: a picture of something that already happened, so it is fenced
		// without a language rather than offered as a thing to run.
		case "div.terminal":
			return [fence(flatten(node).replace(/^\n+/, ""))];
		case "div.code": {
			const label = flatten(node.kids.find((kid) => kid.cls === "code-head"))
				.replace(/cop(y|ied)$/, "")
				.trim();
			const body = flatten(node.kids.find((kid) => kid.tag === "pre")).replace(/^\n+/, "");
			// The label says where to run it as often as it says what it is, so the fence is tagged from
			// the block itself and the label is kept as the caption it was.
			const language = /\.ya?ml$/.test(label) ? "yaml" : /^\s*\$ /m.test(body) ? "sh" : "";
			const caption = label === "sh" ? [] : [`*${label}*`];
			return [...caption, fence(body, language)];
		}
		default:
			throw new Error(`${where}: nothing says what a <${keyOf(node)}> block becomes in markdown`);
	}
}

// ---------- the files ----------

function pageToMarkdown(page) {
	const where = page.href;
	const dir = page.href.replace(/^\/docs\//, "").replace(/\/$/, "");
	const html = readFileSync(join(OUT, "docs", dir, "index.html"), "utf8");
	return block(bodyOf(html, where), where).join("\n\n");
}

const written = PAGES.map((page) => {
	const body = pageToMarkdown(page);
	writeFileSync(join(OUT, page.at), `${body}\n`);
	return { ...page, body };
});

const HOW = [
	"Every page below is the markdown of the page at the same address on the site, converted from it",
	"at build time — so none of this is a summary written separately, and none of it can be a version",
	`behind what the site says. To hand over the whole thing at once rather than a page at a time,`,
	`give ${SITE}/llms-full.txt instead.`,
].join("\n");

const index = [
	`# ${TITLE}`,
	"",
	`> ${TAGLINE}`,
	"",
	HOW,
	"",
	...DOCS.flatMap((group) => [
		`## ${group.name.en}`,
		"",
		...group.pages.map((page) => `- [${page.title.en}](${MD.get(page.href)}): ${page.blurb.en}`),
		"",
	]),
	"## Elsewhere",
	"",
	`- [Everything in one file](${SITE}/llms-full.txt): all ${written.length} pages, concatenated`,
	`- [Installing](${SITE}/install/): the console, the plane, and the same thing done by hand`,
	`- [Source](${REPO}): MIT`,
	"",
].join("\n");

writeFileSync(join(OUT, "llms.txt"), index);

const full = [
	`# ${TITLE} — the whole documentation`,
	"",
	`> ${TAGLINE}`,
	"",
	`All ${written.length} pages, in the order the menu reads, converted from ${SITE}/docs/ at build time.`,
	"",
	...written.map((page) => `---\n\n${page.body}\n\nSource: ${SITE}${page.href}\n`),
].join("\n");

writeFileSync(join(OUT, "llms-full.txt"), full);

console.log(`markdown: ${written.length} pages, llms.txt, llms-full.txt`);
