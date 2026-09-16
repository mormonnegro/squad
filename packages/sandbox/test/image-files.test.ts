import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every file an extension imports has to be named in the Dockerfile.
 *
 * Docker offers a list and nothing else — no globs that would survive a `.dockerignore`, no way to
 * say "and whatever this imports" — so a module added beside an extension is a module that is not in
 * the image until somebody remembers a second line. What makes that worth a test rather than care is
 * how it fails: an import that resolves to nothing does not degrade the one feature it was written
 * for, it takes the whole extension down, and an extension is where all of the agent's screen tools
 * live. The agent comes up with no browser at all and says nothing about why.
 *
 * Caught once, by hand, with the sandbox already rebuilt and everything else about the feature
 * working. This is the check that would have caught it in a second.
 */

const IMAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "image");

/** Every `.ts` the Dockerfile puts in the image, by the name it is copied from. */
function copied(): ReadonlySet<string> {
	const dockerfile = readFileSync(join(IMAGE, "Dockerfile"), "utf8");
	const names = new Set<string>();
	for (const line of dockerfile.split("\n")) {
		const found = /^COPY\s+(\S+\.ts)\s/.exec(line.trim());
		if (found?.[1] !== undefined) names.add(found[1]);
	}
	return names;
}

/** What one of them imports from beside it, which is the only kind of import that can be missing. */
function imports(name: string): readonly string[] {
	const source = readFileSync(join(IMAGE, name), "utf8");
	const found = source.matchAll(/from\s+"\.\/([\w.-]+\.ts)"/g);
	return [...found].map((one) => one[1] ?? "");
}

describe("what the sandbox image is built out of", () => {
	it("copies every file its extensions import", () => {
		const inside = copied();
		expect(inside.size).toBeGreaterThan(10);

		const missing: string[] = [];
		for (const name of inside) {
			for (const imported of imports(name)) {
				if (!inside.has(imported)) missing.push(`${name} imports ${imported}`);
			}
		}

		// Named rather than counted: what a person needs from this failure is the COPY line to write.
		expect(missing).toEqual([]);
	});
});
