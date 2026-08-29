import {
	Children,
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useEffect,
	useState,
} from "react";

/**
 * A section's own address on the page, taken from its eyebrow.
 *
 * The eyebrow is already the short name of what the section is about — the heading beside it is the
 * claim the section makes, which is a sentence and not a label. So the thing the page was written
 * with is the thing the rail lists and the thing the URL says, and there is no third name to keep.
 */
export function anchorOf(eyebrow: string): string {
	return (
		eyebrow
			.toLowerCase()
			// An accent is a spelling, not a letter of its own, so it comes off rather than becoming a
			// dash: an address is a thing people retype, and `qué` is `que` to everyone who would.
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
	);
}

export type Anchor = { readonly id: string; readonly label: string };

/** All the text under a node, which is all an eyebrow ever holds. */
function textOf(node: ReactNode): string {
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

function eyebrowOf(section: ReactElement<{ children?: ReactNode }>): string | undefined {
	const found = Children.toArray(section.props.children).find(
		(kid) => isValidElement<{ className?: string }>(kid) && kid.props.className === "eyebrow",
	);
	if (found === undefined) return undefined;
	const label = textOf(found).trim();
	return label === "" ? undefined : label;
}

/**
 * The page with every section given the id its eyebrow spells, and the list of them for the rail.
 *
 * Done to the tree the page already wrote rather than asked of each page, so the sixteen of them say
 * nothing about anchors and a section cannot be listed in the rail under one name and linked under
 * another. A section with no eyebrow is left alone: it has no name to be listed by.
 */
export function anchored(children: ReactNode): {
	readonly body: ReactNode;
	readonly anchors: readonly Anchor[];
} {
	const anchors: Anchor[] = [];
	const body = Children.map(children, (child) => {
		if (!isValidElement<{ children?: ReactNode }>(child) || child.type !== "section") return child;
		const label = eyebrowOf(child);
		if (label === undefined) return child;
		const id = anchorOf(label);
		anchors.push({ id, label });
		return cloneElement(child as ReactElement<{ id?: string }>, { id });
	});
	return { body, anchors };
}

/** How far down the window a section has to be before it counts as the one being read. */
const LINE = 140;

/**
 * Which section the reader is in: the last one whose top has passed under the nav.
 *
 * Read off the scroll rather than an IntersectionObserver, because the question is not which
 * sections are visible — near the foot of a long page several are — but which one you are inside,
 * and that is the last one you scrolled past.
 */
export function useReading(ids: readonly string[]): string | undefined {
	const [here, setHere] = useState<string | undefined>(undefined);
	// The ids are slugs, so joining them is a value the effect can be keyed on — the array itself is
	// built fresh on every render and would restart the effect each time.
	const key = ids.join(" ");

	useEffect(() => {
		if (key === "") return;
		const all = key.split(" ");
		let waiting = false;

		const look = () => {
			waiting = false;
			// The foot of the page cannot scroll far enough to put the last section under the line, so
			// arriving at the bottom is taken as being in it.
			const atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 2;
			if (atEnd) {
				setHere(all[all.length - 1]);
				return;
			}
			const passed = all.filter((id) => {
				const top = document.getElementById(id)?.getBoundingClientRect().top;
				return top !== undefined && top <= LINE;
			});
			setHere(passed[passed.length - 1] ?? all[0]);
		};

		const onScroll = () => {
			if (waiting) return;
			waiting = true;
			requestAnimationFrame(look);
		};

		look();
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll, { passive: true });
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
		};
	}, [key]);

	return here;
}
