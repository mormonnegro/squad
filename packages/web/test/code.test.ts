import { describe, expect, it } from "vitest";
import { grammarOf, pieces } from "../src/code.tsx";

/** What a run of code turned out to be, said as the colours in the order they arrive. */
const read = (text: string, hint: string): string[] => {
	const grammar = grammarOf(hint);
	if (grammar === undefined) throw new Error(`nothing reads ${hint}`);
	return pieces(text, grammar)
		.filter((piece) => piece.kind !== "plain" && piece.text.trim() !== "")
		.map((piece) => `${piece.kind}:${piece.text.trim()}`);
};

/** Whether every character of the file is still there once it has been cut up. */
const whole = (text: string, hint: string): string => {
	const grammar = grammarOf(hint);
	if (grammar === undefined) throw new Error(`nothing reads ${hint}`);
	return pieces(text, grammar)
		.map((piece) => piece.text)
		.join("");
};

describe("what a file is written in", () => {
	it("reads it off the extension, whichever way it was spelt", () => {
		expect(grammarOf("fetch-news.mjs")).toBe(grammarOf("index.ts"));
		expect(grammarOf("javascript")).toBe(grammarOf("app.jsx"));
	});

	it("reads a whole name that is the language", () => {
		expect(grammarOf("Dockerfile")).toBeDefined();
		expect(grammarOf("workspace/noticias/Dockerfile")).toBe(grammarOf("dockerfile"));
	});

	// Which is what keeps a log, a CSV and a language nobody here has heard of as the text they are.
	it("says nothing about a file that is only text", () => {
		expect(grammarOf("salida.log")).toBeUndefined();
		expect(grammarOf("datos.csv")).toBeUndefined();
		expect(grammarOf("")).toBeUndefined();
	});
});

describe("a file, cut into what it is made of", () => {
	it("tells a comment, a string, a word and a number apart", () => {
		expect(read("const ART_OFFSET_MIN = -180; // UTC-3", "fetch.mjs")).toEqual([
			"word:const",
			"number:180",
			"comment:// UTC-3",
		]);
	});

	it("draws the name of what is being called", () => {
		expect(read("const DATA = path.join(ROOT, 'data');", "fetch.mjs")).toEqual([
			"word:const",
			"name:join",
			"string:'data'",
		]);
	});

	// The one that decides whether the rest of the file is readable: a `//` inside an address is not
	// the start of a comment, and a file read from the wrong side of a quote is a screen of green.
	it("keeps an address inside a string a string", () => {
		expect(read("fetch('https://infobae.com/rss');", "fetch.mjs")).toEqual([
			"name:fetch",
			"string:'https://infobae.com/rss'",
		]);
	});

	it("lets a string hold the quote it escaped", () => {
		expect(read('const said = "she said \\"hola\\"";', "app.ts")).toEqual([
			"word:const",
			'string:"she said \\"hola\\""',
		]);
	});

	it("reads a docstring before it reads two empty strings", () => {
		expect(read('"""baja titulares"""\nimport os', "fetch.py")).toEqual([
			'string:"""baja titulares"""',
			"word:import",
		]);
	});

	it("reads a key as the name it is", () => {
		expect(read('{ "name": "squad", "private": true }', "package.json")).toEqual([
			'name:"name"',
			'string:"squad"',
			'name:"private"',
			"number:true",
		]);
	});

	it("reads what a shell says and what it is holding", () => {
		expect(read('if [ -f "$HOME/.env" ]; then echo hola; fi', "run.sh")).toEqual([
			"word:if",
			'string:"$HOME/.env"',
			"word:then",
			"word:fi",
		]);
	});

	it("reads a length as the number it is, unit and all", () => {
		expect(read(".rail { width: 17rem; color: #79c6dd; }", "styles.css")).toEqual([
			"name:width",
			"number:17rem",
			"name:color",
			"number:#79c6dd",
		]);
	});

	it("shouts or whispers the same words in SQL", () => {
		expect(read("select * from agents where name = 'uno'", "q.sql")).toEqual([
			"word:select",
			"word:from",
			"word:where",
			"string:'uno'",
		]);
	});

	it("never drops a character on the way through", () => {
		const source = [
			"#!/usr/bin/env node",
			"// baja titulares y los guarda en data/YYYY-MM-DD.md",
			"import fs from 'node:fs';",
			"",
			"const FEEDS = [['Política', 'https://infobae.com/rss/politica/']];",
			"function arg(name, def) { return process.argv.indexOf(name) > -1 ? def : undefined; }",
		].join("\n");
		expect(whole(source, "fetch-news.mjs")).toBe(source);
	});
});
