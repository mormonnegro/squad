import { describe, expect, it } from "vitest";
import {
	boxScript,
	OUTLINE_SCRIPT,
	pageBriefly,
	pageForAgent,
	readOutline,
} from "../image/reading.ts";

describe("reading a page back", () => {
	it("takes what the page said about itself", () => {
		const outline = readOutline(
			JSON.stringify({
				url: "https://example.com/",
				title: "Example",
				rows: ['[1] button "Sign in"'],
				text: "Hello",
			}),
		);
		expect(outline?.title).toBe("Example");
		expect(outline?.rows).toEqual(['[1] button "Sign in"']);
	});

	it("survives a page that answers with nonsense", () => {
		// The script runs inside somebody else's page. A site that has replaced JSON.stringify should
		// cost the agent one refusal, not a crash in the screen everyone else is sharing.
		expect(readOutline("not json")).toBeUndefined();
		expect(readOutline(undefined)).toBeUndefined();
		expect(readOutline(JSON.stringify({ url: 4, rows: [1, "[1] a"] }))?.rows).toEqual(["[1] a"]);
	});
});

describe("what the agent is handed", () => {
	const outline = {
		url: "https://example.com/",
		title: "Example",
		rows: ['[1] button "Sign in"'],
		text: "Welcome",
	};

	it("puts what can be acted on before what is merely said", () => {
		const page = pageForAgent(outline);
		expect(page.indexOf("Sign in")).toBeLessThan(page.indexOf("Welcome"));
	});

	it("says every time that the numbers belong to this read", () => {
		// The one thing an agent gets wrong here is holding a ref across a click, so the reminder is
		// on every page rather than in the tool description alone.
		expect(pageForAgent(outline)).toContain("Refs belong to this read");
	});

	it("says so plainly when there is nothing to click", () => {
		expect(pageForAgent({ ...outline, rows: [] })).toContain("Nothing on this page");
	});
});

describe("finding a numbered element", () => {
	it("asks the page for the one it numbered, counting from zero as the array does", () => {
		expect(boxScript(1)).toContain("__squadRefs || [])[0]");
		expect(boxScript(7)).toContain("__squadRefs || [])[6]");
	});

	it("scrolls it into view first, because an element off screen has no place to be clicked", () => {
		expect(boxScript(1)).toContain("scrollIntoView");
	});
});

/*
 * The script itself, run against a page.
 *
 * Worth the stub because this is the one piece of the screen whose correctness is not a matter of
 * shape: what ends up in the list is what the agent can do to the page, and everything that is not
 * in it is work handed back. The DOM here is only what the script actually touches — enough to tell
 * a card from the span inside it, which is the whole of the rule.
 */
interface Fake {
	readonly tag: string;
	readonly cursor?: string;
	readonly href?: string;
	readonly role?: string;
	readonly text?: string;
	readonly kids?: readonly Fake[];
	readonly hidden?: boolean;
}

interface Node {
	tagName: string;
	parentElement: Node | null;
	innerText: string;
	kids: Node[];
	cursor: string;
	hidden: boolean;
	href?: string;
	role?: string;
	getAttribute(name: string): string | null;
	getBoundingClientRect(): { width: number; height: number };
	closest(selector: string): Node | null;
	querySelector(selector: string): Node | null;
	querySelectorAll(selector: string): Node[];
}

/** Only the two shapes WANTED actually asks about in these tests: a link, and anything with a role. */
function declared(node: Node): boolean {
	return (node.href !== undefined && node.tagName === "A") || node.role === "button";
}

function build(spec: Fake, parent: Node | null): Node {
	const node: Node = {
		tagName: spec.tag.toUpperCase(),
		parentElement: parent,
		innerText: spec.text ?? "",
		kids: [],
		cursor: spec.cursor ?? "default",
		hidden: spec.hidden === true,
		...(spec.href === undefined ? {} : { href: spec.href }),
		...(spec.role === undefined ? {} : { role: spec.role }),
		getAttribute: () => null,
		getBoundingClientRect: () =>
			spec.hidden === true ? { width: 0, height: 0 } : { width: 80, height: 20 },
		closest(): Node | null {
			for (let up = node.parentElement; up !== null; up = up.parentElement) {
				if (declared(up)) return up;
			}
			return null;
		},
		querySelector(): Node | null {
			return node.querySelectorAll("").find((one) => one !== node && declared(one)) ?? null;
		},
		querySelectorAll(): Node[] {
			const all: Node[] = [];
			const walk = (one: Node): void => {
				all.push(one);
				for (const kid of one.kids) walk(kid);
			};
			walk(node);
			return all;
		},
	};
	node.kids = (spec.kids ?? []).map((kid) => build(kid, node));
	// The cursor is inherited, which is the fact the rule turns on.
	if (spec.cursor === undefined && parent !== null) node.cursor = parent.cursor;
	return node;
}

function outlineOf(spec: Fake): { rows: string[] } {
	const root = build(spec, null);
	const all = root.querySelectorAll("*").slice(1);
	const context = {
		window: {} as Record<string, unknown>,
		document: {
			title: "T",
			body: { innerText: "" },
			querySelectorAll: (selector: string) =>
				selector === "*" ? all : all.filter((one) => declared(one)),
		},
		location: { href: "https://example.com/" },
		getComputedStyle: (node: Node) => ({
			cursor: node.cursor,
			visibility: node.hidden ? "hidden" : "visible",
			display: "block",
			opacity: "1",
		}),
		JSON,
		String,
		Number,
		Set,
	};
	// The script is a string because it is sent over CDP to run in somebody else's page. Running it
	// here is the only way to test what it actually does rather than what it looks like.
	const run = new Function(...Object.keys(context), `return ${OUTLINE_SCRIPT};`);
	return JSON.parse(run(...Object.values(context)) as string) as { rows: string[] };
}

describe("what the page offers the agent", () => {
	it("still names the things a page declares", () => {
		const { rows } = outlineOf({
			tag: "body",
			kids: [{ tag: "a", href: "/in", text: "Sign in" }],
		});

		expect(rows).toEqual(['[1] a "Sign in"']);
	});

	/*
	 * The one this was rewritten for. A ticketing site's sector rows are bare divs with the handler
	 * bound in script — nothing in the markup says they can be pressed, and the only thing that does
	 * is the hand the browser is drawing over them.
	 */
	it("names a card that says nothing but is drawn under a hand", () => {
		const { rows } = outlineOf({
			tag: "body",
			kids: [{ tag: "div", cursor: "pointer", text: "CAMPO GENERAL Desde $ 95.000" }],
		});

		expect(rows).toEqual(['[1] div "CAMPO GENERAL Desde $ 95.000"']);
	});

	it("names the card and not the four pieces of it", () => {
		// The cursor is inherited, so every span inside the card has the hand too. Offering them all
		// would be the same row four times at four sizes.
		const { rows } = outlineOf({
			tag: "body",
			kids: [
				{
					tag: "div",
					cursor: "pointer",
					text: "CAMPO GENERAL Desde $ 95.000",
					kids: [
						{ tag: "h5", text: "CAMPO GENERAL" },
						{ tag: "span", text: "Desde $ 95.000" },
					],
				},
			],
		});

		expect(rows).toEqual(['[1] div "CAMPO GENERAL Desde $ 95.000"']);
	});

	it("keeps the link rather than the box painted around it", () => {
		// Both are pressable and they do the same thing. The declared one is the better name, and two
		// rows for one target is a list that reads as two targets.
		const { rows } = outlineOf({
			tag: "body",
			kids: [
				{
					tag: "div",
					cursor: "pointer",
					text: "Read more",
					kids: [{ tag: "a", href: "/post", text: "Read more" }],
				},
			],
		});

		expect(rows).toEqual(['[1] a "Read more"']);
	});

	it("keeps them in the order they are on the page", () => {
		const { rows } = outlineOf({
			tag: "body",
			kids: [
				{ tag: "a", href: "/top", text: "Skip" },
				{ tag: "div", cursor: "pointer", text: "PIT" },
				{ tag: "a", href: "/foot", text: "Privacidad" },
			],
		});

		expect(rows).toEqual(['[1] a "Skip"', '[2] div "PIT"', '[3] a "Privacidad"']);
	});

	it("leaves out what nobody can see, hand or no hand", () => {
		const { rows } = outlineOf({
			tag: "body",
			kids: [{ tag: "div", cursor: "pointer", text: "hidden thing", hidden: true }],
		});

		expect(rows).toEqual([]);
	});

	it("leaves out the ordinary page, which is drawn under an arrow", () => {
		const { rows } = outlineOf({
			tag: "body",
			kids: [{ tag: "p", text: "just some words", kids: [{ tag: "span", text: "more words" }] }],
		});

		expect(rows).toEqual([]);
	});
});

/**
 * The page as an agent that names things is handed it.
 *
 * Only ever answered to an agent whose plane points, which is an agent that cannot send a ref at
 * all: the numbers are left out because they cost the most and buy it nothing, and nothing here may
 * offer them — a sentence saying the list is one read away would be a door that does not open.
 */
describe("the page without its numbers", () => {
	const outline = {
		title: "Inicio",
		url: "http://192.168.112.5:3009/",
		text: "hola. Esta es la página de inicio.",
		rows: ["[1] link Sobre", "[2] link Servicios", "[3] link Contacto"],
	};

	it("says where it is and what it says", () => {
		const said = pageBriefly(outline);

		expect(said).toContain("Inicio");
		expect(said).toContain("hola. Esta es la página de inicio.");
	});

	it("carries none of the rows, which is the whole saving", () => {
		const said = pageBriefly(outline);

		expect(said).not.toContain("[1]");
		expect(said).not.toContain("link Sobre");
		expect(said).toContain("3 things on it");
	});

	it("offers no numbers, because there is nothing left that would take one", () => {
		expect(pageBriefly(outline)).not.toContain("numbers");
		expect(pageBriefly(outline)).toContain("Name the one you want");
	});

	// The other page is still the other page: an agent on a plane with no classifier acts by number
	// and is handed them, and this is the line that keeps the two from drifting into one.
	it("is not the page an agent that counts is handed", () => {
		expect(pageForAgent(outline)).toContain("[1] link Sobre");
	});
});
