import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { folderSaid, homely, linkedPath, pathOf, paths } from "../src/box.tsx";
import { blocks, placed } from "../src/markdown.tsx";
import { fenced } from "../src/tree.tsx";

/** Where each piece of a drawn run leads, or nothing for the pieces that stayed text. */
const leads = (nodes: readonly ReactNode[]): (string | undefined)[] =>
	nodes.map((one) =>
		isValidElement<{ path?: string }>(one) ? (one.props.path ?? "node") : undefined,
	);

/** What was drawn, put back together, so nothing can be dropped on its way to a link. */
const whole = (nodes: readonly ReactNode[]): string =>
	nodes
		.map((one) =>
			typeof one === "string"
				? one
				: isValidElement<{ children?: ReactNode }>(one)
					? String(one.props.children ?? "")
					: "",
		)
		.join("");

describe("a path, read as somewhere inside the box", () => {
	it("reads the home the agent is told to write", () => {
		expect(homely("/home/agent/workspace/noticias/README.md")).toBe("workspace/noticias/README.md");
		expect(homely("/home/agent")).toBe("");
	});

	it("reads the same place written short", () => {
		expect(homely("~/workspace/inbox")).toBe("workspace/inbox");
		expect(homely("~")).toBe("");
	});

	it("reads a name against the folder something said it was in", () => {
		expect(homely("data/latest.md", "workspace/noticias")).toBe(
			"workspace/noticias/data/latest.md",
		);
		expect(homely("../fetch.mjs", "workspace/noticias/data")).toBe("workspace/noticias/fetch.mjs");
	});

	// Not because it is dangerous — the operator has a shell in there — but because the box is the
	// whole of what this screen shows, and a link out of it is a link to a screen that does not exist.
	it("refuses somewhere that is not in the box", () => {
		expect(homely("/etc/passwd")).toBeUndefined();
		expect(homely("../../etc/passwd", "workspace")).toBeUndefined();
	});
});

describe("a path found in a sentence", () => {
	it("finds the one the house rules taught the agent to write", () => {
		const drawn = paths(
			"Está en /home/agent/workspace/noticias/index.md, ya lo escribí.",
			undefined,
		);
		expect(leads(drawn)).toEqual([undefined, "workspace/noticias/index.md", undefined]);
		expect(whole(drawn)).toBe("Está en /home/agent/workspace/noticias/index.md, ya lo escribí.");
	});

	it("leaves the full stop that ended the sentence outside it", () => {
		const [, link] = paths("mirá ~/workspace/inbox.", undefined);
		expect(leads([link])).toEqual(["workspace/inbox"]);
	});

	it("takes a folder at the top of the box without being told the home", () => {
		expect(leads(paths("workspace/noticias/daemon.mjs", undefined))).toEqual([
			"workspace/noticias/daemon.mjs",
		]);
	});

	// The half of this that has to stay off. A name with no folder in front of it is a path only
	// where something said which folder, and in a conversation nothing has.
	it("leaves a name with nothing in front of it alone", () => {
		expect(leads(paths("actualicé index.md y data/latest.md", undefined))).toEqual([undefined]);
		expect(leads(paths("dos veces por semana, martes y/o jueves", "workspace"))).toEqual([
			undefined,
		]);
	});

	it("reads one against the folder a message already named", () => {
		expect(leads(paths("actualicé data/latest.md", "workspace/noticias"))).toEqual([
			undefined,
			"workspace/noticias/data/latest.md",
		]);
	});

	it("says nothing about somewhere else on the machine", () => {
		expect(leads(paths("está en /etc/hosts y en /usr/lib", undefined))).toEqual([undefined]);
	});
});

describe("a path written inside backticks, which is where an agent writes one", () => {
	it("is the whole of what is between them", () => {
		expect(pathOf("/home/agent/workspace", undefined)).toBe("workspace");
		expect(pathOf("~/.self/skills", undefined)).toBe(".self/skills");
	});

	it("is not a word that happens to be in there", () => {
		expect(pathOf("inbox", undefined)).toBeUndefined();
		expect(pathOf("npm run dev", undefined)).toBeUndefined();
	});
});

describe("what a message said about where it is", () => {
	it("is the last folder it named", () => {
		expect(folderSaid("Esto es lo que hay en /home/agent/workspace:", undefined)).toBe("workspace");
	});

	// A sentence about a file is a sentence from where that file is: what comes after it is about
	// the things beside it rather than inside it.
	it("is the folder of the last file it named", () => {
		expect(folderSaid("escribí ~/workspace/noticias/README.md", undefined)).toBe(
			"workspace/noticias",
		);
	});

	// What the paragraph above a drawing actually looks like: the path is inside backticks, and the
	// backtick is against the last letter of it.
	it("is the folder inside the marks it was written with", () => {
		expect(folderSaid("Esto es lo que hay en `/home/agent/workspace`:", undefined)).toBe(
			"workspace",
		);
		expect(folderSaid("está en **~/workspace/noticias**", undefined)).toBe("workspace/noticias");
	});

	it("is nothing at all when it named none", () => {
		expect(folderSaid("ya está listo", undefined)).toBeUndefined();
	});
});

describe("a path written as a mark", () => {
	it("is read when it points into the box", () => {
		expect(linkedPath("/home/agent/workspace/x.md", undefined)).toBe("workspace/x.md");
		expect(linkedPath("noticias.log", "workspace/proyecto/.keep")).toBe(
			"workspace/proyecto/.keep/noticias.log",
		);
	});

	it("is left alone when it is not a path", () => {
		expect(linkedPath("#arriba", undefined)).toBeUndefined();
		expect(linkedPath("mailto:hola@squad.dev", undefined)).toBeUndefined();
		expect(linkedPath("archivo", undefined)).toBeUndefined();
	});
});

/** The message this was built for, word for word: a sentence that says where, and a drawing. */
const MESSAGE = [
	"The operator asks to check what files are in the workspace. Let me list them.",
	"",
	"Esto es lo que hay en `/home/agent/workspace`:",
	"",
	"```",
	"noticias-argentina/",
	"├── README.md",
	"└── data/",
	"    └── 2026-09-12.md",
	"```",
	"",
	"Solo está el proyecto de noticias, nada más.",
].join("\n");

describe("what the message had said by the time it drew the tree", () => {
	it("carries the folder the sentence named into the drawing under it", () => {
		const drawing = placed(blocks(MESSAGE), undefined).find(([block]) => block.kind === "fence");
		expect(drawing?.[1]).toBe("workspace");
	});

	it("carries nothing into a drawing no sentence placed", () => {
		const alone = placed(blocks("Mirá:\n\n```\nproyecto/\n└── uno.md\n```"), undefined).find(
			([block]) => block.kind === "fence",
		);
		expect(alone?.[1]).toBeUndefined();
	});
});

/** The listing an agent draws when it is asked what it has, down to the comments beside it. */
const TREE = [
	"noticias-argentina/",
	"├── README.md",
	"├── daemon.mjs              (proceso que corre a diario)",
	"├── data/",
	"│   ├── 2026-09-12.md",
	"│   └── 2026-09-14.md",
	"└── .keep/",
	"    └── noticias.log",
].join("\n");

describe("the tree an agent drew of what it built", () => {
	it("hangs every name off the folder the message was talking about", () => {
		const drawn = fenced(TREE, "workspace");
		expect(leads(drawn).filter((one) => one !== undefined)).toEqual([
			"workspace/noticias-argentina",
			"workspace/noticias-argentina/README.md",
			"workspace/noticias-argentina/daemon.mjs",
			"workspace/noticias-argentina/data",
			"workspace/noticias-argentina/data/2026-09-12.md",
			"workspace/noticias-argentina/data/2026-09-14.md",
			"workspace/noticias-argentina/.keep",
			"workspace/noticias-argentina/.keep/noticias.log",
		]);
	});

	it("draws the picture it was given, to the character", () => {
		expect(whole(fenced(TREE, "workspace"))).toBe(TREE);
	});

	// Nobody said where it is. A screen that guessed would hand out eight links into a folder the
	// agent never claimed to have.
	it("leaves a tree nothing has placed as the drawing it is", () => {
		expect(leads(fenced(TREE, undefined)).filter((one) => one !== undefined)).toEqual([]);
	});

	it("reads the tree's own top line when that says where it is", () => {
		const drawn = fenced("/home/agent/workspace/x/\n└── uno.md", undefined);
		expect(leads(drawn).filter((one) => one !== undefined)).toEqual([
			"workspace/x",
			"workspace/x/uno.md",
		]);
	});

	it("reads the ASCII spelling of the same drawing", () => {
		const drawn = fenced("proyecto/\n|-- uno.md\n`-- dos.md", "workspace");
		expect(leads(drawn).filter((one) => one !== undefined)).toEqual([
			"workspace/proyecto",
			"workspace/proyecto/uno.md",
			"workspace/proyecto/dos.md",
		]);
	});

	it("leaves a fence that is not a drawing to what it says itself", () => {
		const drawn = fenced("$ cat /home/agent/workspace/notas.md\nhola", undefined);
		expect(leads(drawn).filter((one) => one !== undefined)).toEqual(["workspace/notas.md"]);
	});
});
