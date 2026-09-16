/**
 * How a page is turned into something an agent can read without looking at it.
 *
 * A screenshot of a page is about thirteen hundred tokens and says nothing a model can act on
 * precisely: it has to guess at coordinates, and a guess that lands two pixels into the wrong div is
 * a click on nothing that reports success. The same page as a numbered list of the things you can
 * click is a tenth of that and is exact — the agent names a number, and the number is an element the
 * browser already has a handle on.
 *
 * So looking is the escalation and reading is the habit. `look` exists for the pages this cannot
 * describe — a canvas, a map, a chart, an image somebody asked about — and costs what it costs.
 *
 * What the list is built from is the other half, and it was wrong in a way that had nothing to do
 * with looking. A whitelist of semantic elements — links, buttons, anything with a role — is a list
 * of what a page *declares* is interactive, and half the web declares nothing. A ticketing site put
 * its seven sector rows in bare divs: no href, no role, no tabindex, not even an onclick attribute,
 * the handler bound in script. They were the only things on the page worth pressing and they were
 * the only things not on the list, so the agent read the page, found nothing to click, tried the URL
 * directly, found an app that answers every address with the same page, and handed the work back.
 */

/**
 * The script that numbers a page.
 *
 * The numbers are kept on the page itself, in an array the next read replaces. That is why a ref is
 * only good until the next read: the array is rebuilt, and an agent holding a number from before it
 * was is holding a number for whatever happens to be in that slot now. The tool says so, and this
 * is the reason it has to.
 */
export const OUTLINE_SCRIPT = `(() => {
	const refs = [];
	window.__squadRefs = refs;
	const rows = [];
	const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, 120);
	const named = (el) =>
		clean(
			el.getAttribute("aria-label") ||
				el.placeholder ||
				el.innerText ||
				el.alt ||
				el.title ||
				el.name ||
				"",
		);
	// What is in a field, kept apart from what the field is called. The two used to be one, with the
	// placeholder winning — so a box an agent had just typed into read exactly as it had before, and
	// the only way to find out whether the typing landed was to take a picture of it.
	//
	// A password is reported as present and never as itself. The agent is told never to type one, and
	// the person who came and typed one should not find it in the agent's transcript afterwards.
	const filled = (el) => {
		if (typeof el.value !== "string" || el.value === "") return "";
		if (el.type === "password") return "\u2022\u2022\u2022";
		return clean(el.value);
	};
	const shown = (el, style) => {
		const box = el.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) return false;
		return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
	};
	const WANTED = [
		"a[href]",
		"button",
		"input:not([type=hidden])",
		"select",
		"textarea",
		"summary",
		"[contenteditable=true]",
		"[role=button]",
		"[role=link]",
		"[role=tab]",
		"[role=menuitem]",
		"[role=checkbox]",
		"[role=radio]",
		"[role=textbox]",
		"[role=combobox]",
	].join(",");
	const declared = new Set(document.querySelectorAll(WANTED));
	// Every element the browser is drawing a hand over, filled in as the walk goes. The walk is in
	// document order, so a parent is always in here before its children are asked about.
	const hands = new Set();
	for (const el of document.querySelectorAll("*")) {
		const style = getComputedStyle(el);
		const hand = style.cursor === "pointer";
		if (hand) hands.add(el);
		if (!declared.has(el)) {
			// Nothing about this element says press me, in markup or in paint.
			if (!hand) continue;
			// The cursor is inherited, so everything inside a clickable card also has the hand. The
			// outermost one is the thing that was built to be pressed; its parts are not four more
			// buttons, and offering them as four would be the list saying the same thing four times.
			if (hands.has(el.parentElement)) continue;
			// Inside a link or a button, or wrapped around one. Either way the declared element is the
			// better thing to name, and naming both is the same row twice at two sizes.
			if (el.closest(WANTED) !== null) continue;
			if (el.querySelector(WANTED) !== null) continue;
		}
		if (el.disabled === true || !shown(el, style)) continue;
		refs.push(el);
		const tag = el.tagName.toLowerCase();
		const kind = tag === "input" ? "input " + (el.type || "text") : tag;
		const label = named(el);
		const has = filled(el);
		rows.push(
			"[" +
				refs.length +
				"] " +
				kind +
				(label === "" ? "" : " " + JSON.stringify(label)) +
				(has === "" ? "" : " = " + JSON.stringify(has)),
		);
		if (refs.length >= 200) break;
	}
	const text = (document.body ? document.body.innerText : "")
		.replace(/[ \\t]+/g, " ")
		.replace(/\\n{3,}/g, "\\n\\n")
		.trim()
		.slice(0, 6000);
	return JSON.stringify({ url: location.href, title: document.title, rows, text });
})()`;

/** Where a numbered element is on the screen right now, after putting it on the screen. */
export function boxScript(ref: number): string {
	return `(() => {
		const el = (window.__squadRefs || [])[${ref - 1}];
		if (!el) return "null";
		el.scrollIntoView({ block: "center", inline: "center" });
		const box = el.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) return "null";
		return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
	})()`;
}

export interface Outline {
	readonly url: string;
	readonly title: string;
	readonly rows: readonly string[];
	readonly text: string;
}

export function readOutline(raw: unknown): Outline | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { url, title, rows, text } = parsed as Record<string, unknown>;
		return {
			url: typeof url === "string" ? url : "",
			title: typeof title === "string" ? title : "",
			rows: Array.isArray(rows) ? rows.filter((row): row is string => typeof row === "string") : [],
			text: typeof text === "string" ? text : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * The page as the agent reads it: where it is, what it can click, and what it says.
 *
 * In that order, and the order is the point. What an agent does with a page is act on it, so the
 * things it can act on come before the prose — an agent that has to read four thousand words of
 * article to find out there is a "Sign in" button will usually stop reading first.
 */
export function pageForAgent(outline: Outline): string {
	return [
		`${outline.title || "(untitled)"} — ${outline.url}`,
		"",
		outline.rows.length === 0
			? "Nothing on this page can be clicked or typed into."
			: ["What you can act on, by ref:", ...outline.rows].join("\n"),
		"",
		outline.text === "" ? "The page has no text." : ["What it says:", outline.text].join("\n"),
		"",
		"Refs belong to this read. Read again after anything that changes the page, and use the new numbers.",
	].join("\n");
}

/**
 * The page for an agent that named what it wanted rather than numbering it.
 *
 * The same page without the list of refs, which is the whole saving. A reading is mostly that list
 * — two hundred rows of button, link, input — and it is in the transcript for the rest of the turn,
 * sent again with every later call. An agent that acts by naming the thing never uses a number, so
 * every one of those rows is a token spent on an answer to a question it is not going to ask.
 *
 * What is left is where it is and what it says, which is what the next sentence of the work is
 * written from. The numbers are one `read` away and said to be.
 */
export function pageBriefly(outline: Outline): string {
	return [
		`${outline.title || "(untitled)"} — ${outline.url}`,
		"",
		outline.text === "" ? "The page has no text." : ["What it says:", outline.text].join("\n"),
		"",
		outline.rows.length === 0
			? "Nothing on this page can be clicked or typed into."
			: `${outline.rows.length} things on it can be clicked or typed into. Name the one you want, or read the page to get their numbers.`,
	].join("\n");
}
