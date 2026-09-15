import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DockerEngine } from "@squad/sandbox";

/**
 * Building the browser image here, on the machine that will run it, the first time somebody asks
 * for a screen.
 *
 * The alternative was an install that builds it for everybody: a gigabyte of Chromium downloaded
 * onto every plane, most of which will never open a page, and several minutes added to the one
 * command this project promises works on its own. The other alternative was an error telling the
 * operator to go and run `docker build` on the server, which for a plane on a Raspberry Pi behind a
 * console on a laptop means an ssh session to do something the plane is already able to do.
 *
 * So: nothing is built until a screen is turned on, and then it is built here, and the console says
 * what is happening while it takes its minutes.
 */

const BLOCK = 512;

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/**
 * One file's 512-byte ustar header.
 *
 * Written out rather than depending on something, for the reason the Docker client is: this needs
 * to describe a dozen small files in one directory, and every field it does not use is a field it
 * does not have to be right about.
 */
function header(name: string, size: number, mode: number, mtime: number): Buffer {
	const block = Buffer.alloc(BLOCK);
	block.write(name, 0, 100, "utf8");
	block.write(octal(mode, 8), 100, 8, "ascii");
	block.write(octal(0, 8), 108, 8, "ascii");
	block.write(octal(0, 8), 116, 8, "ascii");
	block.write(octal(size, 12), 124, 12, "ascii");
	block.write(octal(Math.floor(mtime / 1000), 12), 136, 12, "ascii");
	// The checksum is computed over a header whose checksum field is spaces, which is the one part
	// of this format that cannot be written in the order the fields are in.
	block.write("        ", 148, 8, "ascii");
	block.write("0", 156, 1, "ascii");
	block.write("ustar\0", 257, 6, "ascii");
	block.write("00", 263, 2, "ascii");

	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return block;
}

function padding(size: number): Buffer {
	const over = size % BLOCK;
	return over === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - over);
}

/**
 * The build context as a tar, which is the only way Docker takes one.
 *
 * Flat on purpose: the image directory has no subdirectories and is not going to, and a recursive
 * walk would be code that exists to handle a case this repository would have to invent.
 */
export async function tarball(dir: string): Promise<Buffer> {
	const parts: Buffer[] = [];
	for (const name of (await readdir(dir)).sort()) {
		const path = join(dir, name);
		const stats = await stat(path);
		if (!stats.isFile()) continue;
		const content = await readFile(path);
		// The mode matters for exactly one file: the entrypoint, which the image runs. A build that
		// dropped its executable bit would produce an image that starts and immediately stops.
		parts.push(header(name, content.byteLength, stats.mode & 0o777, stats.mtimeMs));
		parts.push(content);
		parts.push(padding(content.byteLength));
	}
	// Two empty blocks are how a tar says it is over. Without them Docker waits for more.
	parts.push(Buffer.alloc(BLOCK * 2));
	return Buffer.concat(parts);
}

/** One line of Docker's build narration, which arrives as a stream of JSON objects and not as JSON. */
export function buildLines(chunk: string): string[] {
	const said: string[] = [];
	for (const line of chunk.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as { stream?: unknown; error?: unknown };
			if (typeof parsed.error === "string") throw new Error(parsed.error);
			if (typeof parsed.stream === "string" && parsed.stream.trim() !== "") {
				said.push(parsed.stream.trim());
			}
		} catch (error) {
			// A line that is not JSON is Docker being unusual, and a line that is JSON and carries an
			// error is a build that failed. Only the second is worth stopping for.
			if (error instanceof SyntaxError) continue;
			throw error;
		}
	}
	return said;
}

export interface BuildingScreen {
	readonly engine: DockerEngine;
	readonly image: string;
	/** The directory holding the Dockerfile and everything it copies. */
	readonly dir: string;
	/** Called with whatever the build says, so the wait has something to show for itself. */
	readonly say: (line: string) => void;
}

export async function buildScreenImage(building: BuildingScreen): Promise<void> {
	const context = await tarball(building.dir);
	const query = new URLSearchParams({
		t: building.image,
		dockerfile: "Dockerfile",
		// Intermediate containers removed on success and left on failure, which is Docker's own
		// default and the one that leaves something to look at when a build goes wrong.
		rm: "1",
	});
	let failure: Error | undefined;
	await building.engine.stream(
		"POST",
		`/build?${query.toString()}`,
		context,
		"application/x-tar",
		(chunk) => {
			// Thrown from inside a stream handler would be unhandled, so the failure is carried out.
			if (failure !== undefined) return;
			try {
				for (const line of buildLines(chunk)) building.say(line);
			} catch (error) {
				failure = error as Error;
			}
		},
	);
	if (failure !== undefined) throw failure;
}
