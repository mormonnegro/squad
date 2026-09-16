import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every file this program imports has to be named in the Dockerfile.
 *
 * The same check the sandbox image has, and it is here because the same thing happened here: a
 * module added beside the server, imported by it, and not on the COPY line. What that looks like is
 * not a feature missing — node fails the import, the container exits on the spot, and the console
 * shows a screen that will not come up and no reason anywhere.
 *
 * The integration test in this package catches it too, by building the image and waiting for the
 * browser. It takes two minutes and a Docker daemon; this takes no time and no daemon.
 */

const IMAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "image");

/** Every `.ts` the Dockerfile puts in the image, including the ones on a continued line. */
function copied(): ReadonlySet<string> {
	const dockerfile = readFileSync(join(IMAGE, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
	const names = new Set<string>();
	for (const line of dockerfile.split("\n")) {
		if (!line.trimStart().startsWith("COPY ")) continue;
		for (const word of line.trim().split(/\s+/).slice(1)) {
			if (word.endsWith(".ts")) names.add(word);
		}
	}
	return names;
}

function imports(name: string): readonly string[] {
	const source = readFileSync(join(IMAGE, name), "utf8");
	return [...source.matchAll(/from\s+"\.\/([\w.-]+\.ts)"/g)].map((one) => one[1] ?? "");
}

describe("what the screen image is built out of", () => {
	it("copies every file the program imports", () => {
		const inside = copied();
		expect(inside.size).toBeGreaterThan(5);

		const missing: string[] = [];
		for (const name of inside) {
			for (const imported of imports(name)) {
				if (!inside.has(imported)) missing.push(`${name} imports ${imported}`);
			}
		}

		// Named rather than counted: what a person needs from this failure is the line to write.
		expect(missing).toEqual([]);
	});
});
