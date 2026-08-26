import { describe, expect, it } from "vitest";
import { copied, KEEPERS, osc52 } from "../src/clipboard.ts";

/**
 * Copying out of a screen the terminal did not draw, which it will not do for us: an app that has
 * asked to be told about the mouse is an app whose text the terminal no longer selects.
 */
describe("osc52", () => {
	// The one path that works from the far end of an `ssh`, where the clipboard worth landing on is
	// the one in front of the person and `pbcopy` would write to the machine they logged in to.
	it("hands the terminal the text base64'd, and ends the sequence", () => {
		const written = osc52("hola");

		expect(written).toBe(`\u001b]52;c;${Buffer.from("hola").toString("base64")}\u0007`);
	});

	// A conversation is not ASCII, and half of this one is not English.
	it("survives the accents and the box drawing it was copied out of", () => {
		const text = "¿qué tal? ─ ✓";

		expect(Buffer.from(osc52(text).slice(7, -1), "base64").toString("utf8")).toBe(text);
	});
});

describe("copied", () => {
	// Wayland before X, because a Wayland session usually still has `xclip` installed and `xclip` on
	// a Wayland session copies into a selection nothing will ever paste from.
	it("tries Wayland before X", () => {
		const linux = (KEEPERS.linux ?? []).map(([program]) => program);

		expect(linux.indexOf("wl-copy")).toBeLessThan(linux.indexOf("xclip"));
	});

	// Whoever this is, they get the escape sequence instead — which is the whole reason this says
	// whether a program took it rather than swallowing the question.
	it("says so rather than throwing when the machine has no clipboard program", async () => {
		expect(await copied("hola", "sunos")).toBe(false);
	});
});
