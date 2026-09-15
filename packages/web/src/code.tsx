import type { ReactNode } from "react";
import { paths } from "./box.tsx";

/**
 * Code, read as code, because a file an agent wrote is read the way a person reads code.
 *
 * The files screen was drawing a source file as one grey block of characters, which is what a
 * terminal does to a file it has no opinion about — and nobody reads a program that way. What the
 * eye is actually doing on a screen of code is telling four things apart before it reads a word of
 * it: what is a note somebody left, what is a piece of text, what is the language's own scaffolding,
 * and what is a name. Colour is how that is said everywhere code is shown, and GitHub is the one
 * everybody has already learnt.
 *
 * So it is said here, in this console's own five colours rather than GitHub's: a comment is quiet, a
 * string is green, a keyword is the coral, a number or a constant is amber, a name being called is
 * blue. Cyan is the one hue left out on purpose — on this console cyan is what you may press, and a
 * fence is already full of paths that are — which is the whole colour budget of the screen spent
 * without a sixth thing to invent.
 *
 * This is a reader rather than a compiler. It knows nothing about scope, it will call a word in a
 * broken file a keyword, and it does not care: it is drawing texture for a person who is looking at
 * a file, not checking one. Everything it cannot recognise falls through as the text it was, which
 * is how a language it has never heard of still comes out as the file it is.
 */

/** What a run of a file turned out to be, which is all the colour there is. */
export type Kind = "plain" | "comment" | "string" | "word" | "number" | "name";

/** One run of a file, and what it turned out to be. */
export interface Piece {
	readonly kind: Kind;
	readonly text: string;
}

/**
 * How much of a file gets read this closely.
 *
 * Past this it is not a file somebody is reading, it is a file somebody landed in — a bundle, a
 * dump, a log with a day in it — and a span per token over a megabyte of that is a tab that stops
 * answering. Those come out the way they always did, as the text they are.
 */
const COLOUR_CAP = 128 * 1024;

/** A rule: what a run means, and the pattern that finds it. No capturing groups — see `made`. */
type Rule = readonly [Kind, string];

/** A language, as the one pass that reads it and what each of its groups meant. */
interface Grammar {
	readonly kinds: readonly Kind[];
	readonly scan: RegExp;
}

/*
 * The pieces every language is written out of, spelt once.
 *
 * A string is the one that has to be right: it eats its own escapes, because a `"` that was escaped
 * inside a string is not the end of it, and the rest of a file read from the wrong side of a quote
 * is a screen of green.
 */
const BLOCK = String.raw`/\*[\s\S]*?\*/`;
const LINE = String.raw`//[^\n]*`;
const HASH = String.raw`#[^\n]*`;
const DOUBLE = String.raw`"(?:\\.|[^"\\\n])*"`;
const SINGLE = String.raw`'(?:\\.|[^'\\\n])*'`;
const BACK = "`(?:\\\\.|[^`\\\\])*`";
const NUMBER = String.raw`\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b`;

/**
 * A name with a bracket after it, which is the one name worth a colour of its own.
 *
 * Colouring every identifier is how a file becomes a rainbow nobody can read the shape of. A call is
 * the exception: it is where the work happens, and it is the thing an eye scanning a function is
 * looking for. Keywords are matched before this, so `if (` stays the word it is.
 */
const CALL = String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`;

/** A list of words, as the pattern that matches any one of them whole. */
function words(said: string): string {
	return String.raw`\b(?:${said.trim().split(/\s+/).join("|")})\b`;
}

/**
 * The rules of a language, as one regular expression read once.
 *
 * Rule by rule down the text would be a pass per rule; this is a pass full stop, and which group
 * came back says which rule it was. The order of the rules is their priority — a `//` inside a
 * string has to be found as the string first — so the list reads top to bottom like a grammar.
 */
function made(rules: readonly Rule[], flags = "gm"): Grammar {
	return {
		kinds: rules.map(([kind]) => kind),
		scan: new RegExp(rules.map(([, source]) => `(${source})`).join("|"), flags),
	};
}

/**
 * The shape of every language with braces in it: comments, strings, its words, its calls.
 *
 * The words differ and almost nothing else does, so the difference is the only thing written down
 * per language.
 */
function braces(keywords: string, constants: string, extra: readonly Rule[] = []): readonly Rule[] {
	return [
		// The first line of a file that is also a program. The languages whose comments start with a
		// hash read it without being told; these have to be.
		["comment", String.raw`^#![^\n]*`],
		["comment", BLOCK],
		["comment", LINE],
		["string", BACK],
		["string", DOUBLE],
		["string", SINGLE],
		...extra,
		["word", words(keywords)],
		["number", words(constants)],
		["number", NUMBER],
		["name", CALL],
	];
}

const GRAMMARS: Readonly<Record<string, Grammar>> = {
	js: made(
		braces(
			`import export from as default const let var function class extends implements new delete
			 typeof instanceof in of void return if else switch case break continue for while do try
			 catch finally throw yield await async static get set this super interface type enum
			 namespace declare abstract public private protected readonly satisfies keyof infer`,
			"true false null undefined NaN Infinity",
		),
	),

	py: made([
		["comment", HASH],
		// The triple-quoted one first, or the two quotes that open it close each other and the
		// docstring under them is read as code.
		["string", String.raw`[rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?''')`],
		["string", `[rRbBuUfF]{0,2}(?:${DOUBLE}|${SINGLE})`],
		[
			"word",
			words(`def class lambda return yield if elif else for while break continue pass raise try
				except finally with as import from global nonlocal assert del in is not and or async
				await match case self cls`),
		],
		["number", words("None True False")],
		["number", NUMBER],
		// A decorator is a name being applied, which is near enough a call to be drawn as one.
		["name", String.raw`@[A-Za-z_][\w.]*`],
		["name", CALL],
	]),

	sh: made([
		["comment", HASH],
		// Shell strings run over lines, and the single-quoted one has no escapes at all: inside it a
		// backslash is a backslash.
		["string", String.raw`"(?:\\.|[^"\\])*"`],
		["string", `'[^']*'`],
		[
			"word",
			words(`if then elif else fi for in do done while until case esac function return break
				continue local export readonly declare source eval exec set unset shift trap exit`),
		],
		["name", String.raw`\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?!$-]`],
		["number", NUMBER],
	]),

	json: made([
		// A key is a string in the place where a name goes, and that place is what it is drawn as.
		["name", `${DOUBLE}(?=\\s*:)`],
		["string", DOUBLE],
		["number", words("true false null")],
		["number", NUMBER],
	]),

	yaml: made([
		["comment", HASH],
		// The word a line hangs a value off. The dash of a list item is not part of it: it says the
		// shape of the file rather than the name of anything.
		["name", String.raw`(?<=^[ \t]*(?:-[ \t]+)*)[\w.$][\w.$ /-]*(?=[ \t]*:(?:[ \t]|$))`],
		["string", DOUBLE],
		["string", SINGLE],
		["number", words("true false yes no on off null True False Yes No Null")],
		["number", NUMBER],
	]),

	toml: made([
		["comment", String.raw`[#;][^\n]*`],
		["name", String.raw`^[ \t]*\[[^\]\n]*\]`],
		["name", String.raw`^[ \t]*[\w.$"'-]+(?=[ \t]*=)`],
		["string", String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''`],
		["string", DOUBLE],
		["string", SINGLE],
		["number", words("true false")],
		["number", NUMBER],
	]),

	css: made([
		["comment", BLOCK],
		["word", String.raw`@[-\w]+`],
		// A property is the word a declaration opens with — after the brace, after the semicolon of
		// the one before it, or at the top of its own line. Anywhere else a word with a colon after
		// it is `a:hover`, which is a selector and not a property.
		["name", String.raw`(?:^|(?<=[{;]))[ \t]*-?[-\w]+(?=[ \t]*:)`],
		["string", DOUBLE],
		["string", SINGLE],
		["number", String.raw`#[0-9a-fA-F]{3,8}\b`],
		// Its own number, without the boundary the others end on: a length is digits with letters
		// stuck to them, and `\b` between the `0` and the `p` of `10px` is a boundary that is not
		// there.
		["number", String.raw`\b\d[\d_]*(?:\.\d+)?(?:px|r?em|%|vh|vw|vmin|vmax|fr|deg|m?s|ch|pt)?`],
	]),

	html: made([
		["comment", String.raw`<!--[\s\S]*?-->`],
		["word", String.raw`</?[A-Za-z][\w:.-]*|/?>`],
		["name", String.raw`[A-Za-z_:][-\w:.]*(?=[ \t]*=)`],
		["string", DOUBLE],
		["string", SINGLE],
	]),

	// The one language whose words are shouted as often as they are whispered, so it is read either
	// way. A string in it doubles its own quote to escape it, which nothing else here does.
	sql: made(
		[
			["comment", String.raw`--[^\n]*`],
			["comment", BLOCK],
			["string", `'(?:''|[^'])*'`],
			[
				"word",
				words(`select from where insert into values update set delete create table view drop
					alter add column primary key foreign references index unique constraint check
					default join left right full inner outer cross on using group by order having
					limit offset distinct as and or not in between like ilike is case when then else
					end asc desc union all exists with returning begin commit rollback`),
			],
			["number", words("null true false")],
			["number", NUMBER],
		],
		"gmi",
	),

	go: made(
		braces(
			`package import func var const type struct interface map chan go defer select switch case
			 default if else for range return break continue fallthrough goto`,
			"true false nil iota",
		),
	),

	rust: made(
		braces(
			`fn let mut const static struct enum impl trait for in while loop match if else return
			 break continue use mod pub crate self super as where type dyn ref move async await
			 unsafe extern`,
			"true false None Some Ok Err",
		),
	),

	ruby: made([
		["comment", HASH],
		["string", DOUBLE],
		["string", SINGLE],
		[
			"word",
			words(`def end class module if elsif else unless while until for in do then begin rescue
				ensure retry raise return yield next break case when require require_relative include
				extend attr_accessor attr_reader attr_writer self lambda proc new`),
		],
		["number", words("true false nil")],
		// A symbol is a name that is only ever itself.
		["name", String.raw`:[A-Za-z_]\w*[?!]?`],
		["number", NUMBER],
		["name", CALL],
	]),

	/*
	 * Everything else with braces in it, under one set of words.
	 *
	 * C, Java, C#, Swift, Kotlin, PHP and the rest differ in ways that matter to a compiler and in
	 * almost none that matter to an eye scanning a file: the comments are the same, the strings are
	 * the same, and what is left is a list of words. One list covering all of them colours a word
	 * that the language it is in does not have — which costs a reader nothing, and is the trade that
	 * keeps this file a screen long instead of a folder.
	 */
	braces: made(
		braces(
			`if else for while do switch case break continue return goto struct union enum class
			 record interface protocol extension namespace using package import include define
			 public private protected internal static final const readonly abstract override virtual
			 sealed partial extends implements inherits new delete try catch finally throw throws
			 typedef template typename operator sizeof func fun def val var let this self super
			 void int uint long short float double char bool boolean byte string object`,
			"true false null nil none NULL YES NO",
		),
	),

	docker: made([
		["comment", HASH],
		[
			"word",
			String.raw`^[ \t]*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b`,
		],
		["word", String.raw`\bAS\b`],
		["string", DOUBLE],
		["string", SINGLE],
		["name", String.raw`\$\{[^}\n]*\}|\$[A-Za-z_]\w*`],
		["number", NUMBER],
	]),
};

/**
 * What a file or a fence is written in, by the name it was given.
 *
 * Both names arrive at the same question. A file says it with an extension and a fence says it with
 * the word after its backticks, and `mjs` and `javascript` are one language, so both are looked up
 * in one table. A whole name first, because `Dockerfile` has no extension to give and is the
 * language.
 */
const SPOKEN: Readonly<Record<string, keyof typeof GRAMMARS>> = {
	js: "js",
	mjs: "js",
	cjs: "js",
	jsx: "js",
	javascript: "js",
	node: "js",
	ts: "js",
	tsx: "js",
	mts: "js",
	cts: "js",
	typescript: "js",
	py: "py",
	pyi: "py",
	python: "py",
	sh: "sh",
	bash: "sh",
	zsh: "sh",
	shell: "sh",
	console: "sh",
	json: "json",
	jsonc: "json",
	json5: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	ini: "toml",
	cfg: "toml",
	conf: "toml",
	env: "toml",
	properties: "toml",
	css: "css",
	scss: "css",
	sass: "css",
	less: "css",
	html: "html",
	htm: "html",
	xml: "html",
	svg: "html",
	vue: "html",
	svelte: "html",
	sql: "sql",
	go: "go",
	golang: "go",
	rs: "rust",
	rust: "rust",
	rb: "ruby",
	ruby: "ruby",
	gemfile: "ruby",
	rake: "ruby",
	c: "braces",
	h: "braces",
	cc: "braces",
	cpp: "braces",
	hpp: "braces",
	cs: "braces",
	csharp: "braces",
	java: "braces",
	kt: "braces",
	kts: "braces",
	kotlin: "braces",
	swift: "braces",
	php: "braces",
	dart: "braces",
	scala: "braces",
	groovy: "braces",
	proto: "braces",
	dockerfile: "docker",
	docker: "docker",
	containerfile: "docker",
};

/** The language something is written in, or nothing for the files that are just text. */
export function grammarOf(hint: string): Grammar | undefined {
	const bare = (hint.split("/").pop() ?? "").trim().toLowerCase();
	if (bare === "") return undefined;
	const whole = SPOKEN[bare.startsWith(".") ? bare.slice(1) : bare];
	if (whole !== undefined) return GRAMMARS[whole];
	const dot = bare.lastIndexOf(".");
	const said = dot === -1 ? undefined : SPOKEN[bare.slice(dot + 1)];
	return said === undefined ? undefined : GRAMMARS[said];
}

/**
 * A file, cut into the runs it is made of.
 *
 * What the grammar did not recognise comes back whole rather than a character at a time — the gaps
 * between the matches are pieces of their own. That is not only tidier: a path is found afterwards
 * by reading a run of text, and a run chopped into single characters has no paths left in it.
 */
export function pieces(text: string, grammar: Grammar): readonly Piece[] {
	const out: Piece[] = [];
	const scan = grammar.scan;
	scan.lastIndex = 0;
	let cut = 0;
	for (let found = scan.exec(text); found !== null; found = scan.exec(text)) {
		// A rule that can match nothing would sit here forever, so an empty match steps over one
		// character and the scan goes on.
		if (found[0] === "") {
			scan.lastIndex++;
			continue;
		}
		let kind: Kind = "plain";
		for (let at = 0; at < grammar.kinds.length; at++) {
			if (found[at + 1] !== undefined) {
				kind = grammar.kinds[at] ?? "plain";
				break;
			}
		}
		if (found.index > cut) out.push({ kind: "plain", text: text.slice(cut, found.index) });
		out.push({ kind, text: found[0] });
		cut = found.index + found[0].length;
	}
	if (cut < text.length) out.push({ kind: "plain", text: text.slice(cut) });
	return out;
}

/**
 * A file, drawn as the code it is, with the paths in it still somewhere to go.
 *
 * The two readings are not rivals: colour says what a run is, and a path inside a comment or a
 * string is still a file in the box and still opens. Only the language's own words are left out of
 * that second reading — a keyword is never a path, and a number is never anywhere.
 */
export function coloured(text: string, hint: string, base: string | undefined): ReactNode[] {
	const grammar = grammarOf(hint);
	if (grammar === undefined || text.length > COLOUR_CAP) return paths(text, base);

	const out: ReactNode[] = [];
	let key = 0;
	for (const piece of pieces(text, grammar)) {
		if (piece.kind === "plain") {
			out.push(...paths(piece.text, base, key++));
			continue;
		}
		const said =
			piece.kind === "word" || piece.kind === "number"
				? piece.text
				: paths(piece.text, base, key++);
		out.push(
			<span className={`code-${piece.kind}`} key={`c${key++}`}>
				{said}
			</span>,
		);
	}
	return out;
}
