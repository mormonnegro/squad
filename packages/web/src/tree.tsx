import type { ReactNode } from "react";
import { FileLink, homely, paths, rooted } from "./box.tsx";

/**
 * The listing an agent drew, read back as the files it is a listing of.
 *
 * An agent asked what it has answers with a tree — the same tree `tree` prints, because that is the
 * shape of the answer and every model has seen a million of them. Every name in it is a file the
 * agent has, and until now it was the one place in a message where a file was named and could not be
 * opened: the names have no folders in front of them, the folders are in the drawing.
 *
 * So the drawing is read. The connectors say how deep a row is, the row above it at a shallower
 * depth is its folder, and the line at the top is what the whole thing hangs off — which is how a
 * person reads it too. What it hangs off has to be said somewhere: the tree's own top line if that
 * names a place inside the box, and otherwise the folder the message was talking about before it
 * drew this. A tree that hangs off nothing anybody named is left as the picture it is, because the
 * alternative is a screen full of links to files that were never claimed to be here.
 */

/**
 * One row of a drawn tree: the rails to its left, the elbow, and what it says.
 *
 * Both spellings, because both arrive: the box-drawing one every terminal prints now, and the ASCII
 * one that comes out of `tree --charset=ascii` and out of a model writing from memory.
 */
const BRANCH = /^([\s│|]*)([├└`+\\|][-─]{1,3}\s)(.*)$/u;

/** How deep a row hangs, and what its folder turned out to be. */
interface Held {
	readonly indent: number;
	readonly path: string;
}

/**
 * Whether what is in a fence is a drawing rather than code.
 *
 * Asked from outside because the answer decides who reads it: a tree is a picture of the box and is
 * read as one, and colouring its connectors as if they were a language is how a picture stops being
 * one.
 */
export function drawsTree(code: string): boolean {
	return code.split("\n").some((line) => BRANCH.test(line));
}

/**
 * A fence, with everything in it that names a file turned into somewhere to go.
 *
 * Both halves of what is written in fences: a tree is walked as a tree, and everything else — a
 * shell session, a log, a `find` that printed whole paths — is read the same way a sentence is.
 */
export function fenced(code: string, base: string | undefined): ReactNode[] {
	const lines = code.split("\n");
	if (!drawsTree(code)) return paths(code, base);

	const out: ReactNode[] = [];
	const stack: Held[] = [];
	/** What the rows hang off. The line at the top of the drawing may say, and then it is that. */
	let root = base;
	let key = 0;

	lines.forEach((line, index) => {
		if (index > 0) out.push("\n");
		const branch = BRANCH.exec(line);

		if (branch === null) {
			const lone = line.trim();
			// A name on its own at the left margin is the top of a tree — `tree` prints one, and so
			// does an agent writing the directory it is about to list. Anything with a space in it is
			// a sentence, a prompt, or `total 48`, and none of those is a folder.
			if (lone !== "" && !/\s/.test(lone) && !/^\s/.test(line)) {
				const at = base === undefined && !rooted(lone) ? undefined : homely(lone, base ?? "");
				root = at;
				stack.length = 0;
				out.push(
					at === undefined ? (
						lone
					) : (
						<FileLink key={key++} path={at}>
							{lone}
						</FileLink>
					),
					line.slice(lone.length),
				);
				return;
			}
			out.push(...paths(line, base, key++));
			return;
		}

		const prefix = branch[1] ?? "";
		const joint = branch[2] ?? "";
		const said = branch[3] ?? "";
		// Held by how far in it starts rather than by a count of four-space groups: the two drawings
		// this reads indent by four and by three, and one that indents by two is still a tree.
		while (stack.length > 0 && prefix.length <= (stack.at(-1)?.indent ?? 0)) stack.pop();
		const folder = stack.at(-1)?.path ?? root;
		const { name, after } = named(said);
		const path = name === "" || folder === undefined ? undefined : homely(name, folder);
		if (path !== undefined) stack.push({ indent: prefix.length, path });

		out.push(prefix, joint);
		out.push(
			path === undefined ? (
				name
			) : (
				<FileLink key={key++} path={path}>
					{name}
				</FileLink>
			),
		);
		if (after !== "") out.push(...paths(after, base, key++));
	});

	return out;
}

/**
 * What a row names, and what it says about it.
 *
 * A name runs to the two spaces somebody lined a comment up on, or to the arrow a symlink points
 * along, or to the end of the line. Two spaces rather than one because a name is allowed a space in
 * it — a folder called `Mis documentos` is a folder — and nobody columns a comment with one.
 */
function named(said: string): { name: string; after: string } {
	const cut = /\s{2,}|\s->\s/.exec(said);
	const name = (cut === null ? said : said.slice(0, cut.index)).trimEnd();
	return { name, after: said.slice(name.length) };
}
