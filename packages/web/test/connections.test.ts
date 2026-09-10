import { describe, expect, it } from "vitest";
import { makeCode, nameFor, readAddress } from "../src/connections.ts";

const ONE = { name: "A server", origin: "https://plane.example.com", token: "a-long-secret" };

describe("a code", () => {
	it("reads back as the two facts it carries", () => {
		expect(readAddress(makeCode(ONE))).toEqual({ origin: ONE.origin, token: ONE.token });
	});

	it("survives being pasted with whitespace around it", () => {
		expect(readAddress(`\n  ${makeCode(ONE)}  \n`)).toEqual({
			origin: ONE.origin,
			token: ONE.token,
		});
	});

	// A chat window is where one of these travels, and a chat window is where things get truncated.
	it("says so when it was cut short rather than half-connecting", () => {
		const cut = makeCode(ONE).slice(0, 14);
		expect(typeof readAddress(cut)).toBe("string");
	});

	it("has nothing in it that a chat window would turn into a link", () => {
		expect(makeCode(ONE)).toMatch(/^squad_[A-Za-z0-9\-_]+$/);
	});
});

describe("an address", () => {
	it("is taken apart into where and what opens it", () => {
		expect(readAddress("http://127.0.0.1:8789/?t=abc")).toEqual({
			origin: "http://127.0.0.1:8789",
			token: "abc",
		});
	});

	// Refusing whichever one is in somebody's clipboard is refusing them for being right the other way.
	it("takes an address as readily as a code", () => {
		expect(readAddress("https://plane.example.com/?t=k")).toEqual({
			origin: "https://plane.example.com",
			token: "k",
		});
	});

	it("refuses an address carrying no key, and says what is missing", () => {
		expect(readAddress("http://127.0.0.1:8789/")).toMatch(/key/);
	});

	it("refuses a scheme a browser would not open", () => {
		expect(readAddress("file:///etc/passwd?t=x")).toMatch(/http/);
	});

	it("refuses something that is neither", () => {
		expect(readAddress("hola")).toMatch(/squad_/);
	});
});

describe("what to call it before anybody names it", () => {
	it("calls a loopback plane by its port, since the host says nothing", () => {
		expect(nameFor("http://127.0.0.1:8789")).toBe("Port 8789");
	});

	it("calls anything else by its machine", () => {
		expect(nameFor("https://plane.example.com")).toBe("plane.example.com");
	});
});
