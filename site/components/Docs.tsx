import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactNode } from "react";
import { DOCS, docsAround, docsGroupOf, markdownOf } from "../lib/docs";
import { anchored, useReading } from "../lib/toc";
import { Layout } from "./Layout";

function Menu({ here }: { here: string }) {
	return (
		<>
			{DOCS.map((group) => (
				<div className="docs-group" key={group.name}>
					<span className="docs-group-name">{group.name}</span>
					{group.pages.map((page) => (
						<Link key={page.href} href={page.href} data-current={page.href === here}>
							{page.title}
						</Link>
					))}
				</div>
			))}
		</>
	);
}

/**
 * A docs page: the menu on the left, the page in the column beside it, and the two pages either side
 * of this one at the foot.
 *
 * The menu is written twice into the page and one of the two is always off. A phone has no room for
 * a column of sixteen links above every page, and the disclosure that answers that on a phone is
 * wrong on a desktop where the column is simply there — so each is the markup that is right where it
 * shows, rather than one of them being the other one bent by a media query. Both come off the same
 * list, so there is still one place a page is added.
 */
export function Docs({
	title,
	lede,
	description,
	children,
}: {
	title: string;
	/** The sentence under the title. */
	lede: ReactNode;
	/** For the tab and the search result, where the lede's markup cannot go. */
	description: string;
	children: ReactNode;
}) {
	// The router gives the route rather than the address, so it is the one without the trailing slash
	// the export writes. The menu is written with them, and this is where the two are made the same.
	const here = `${useRouter().pathname.replace(/\/$/, "")}/`;
	const { previous, next } = docsAround(here);
	const { body, anchors } = anchored(children);
	const reading = useReading(anchors.map((anchor) => anchor.id));

	return (
		<Layout title={title} description={description} markdown={markdownOf(here)}>
			<div className="docs">
				<details className="docs-menu">
					<summary>docs</summary>
					<nav className="docs-nav">
						<Menu here={here} />
					</nav>
				</details>

				<aside className="docs-side">
					<nav className="docs-nav">
						<Menu here={here} />
					</nav>
				</aside>

				<article className="docs-body">
					<header className="docs-head">
						<span className="docs-crumb">{docsGroupOf(here)}</span>
						<h1>{title}</h1>
						<p className="lede">{lede}</p>
					</header>

					{body}

					<div className="docs-walk">
						{previous === undefined ? (
							<span />
						) : (
							<Link href={previous.href} className="jump">
								← {previous.title}
							</Link>
						)}
						{next !== undefined && (
							<Link href={next.href} className="jump">
								{next.title} →
							</Link>
						)}
					</div>
				</article>

				{/* Outside the article on purpose: the markdown of each page is cut from `.docs-body` at
				    build time, and a list of the page's own sections is a way around it rather than part
				    of it. */}
				{anchors.length > 1 && (
					<aside className="docs-toc">
						<span className="docs-toc-name">On this page</span>
						<nav>
							{anchors.map((anchor) => (
								<a key={anchor.id} href={`#${anchor.id}`} data-current={anchor.id === reading}>
									{anchor.label}
								</a>
							))}
						</nav>
					</aside>
				)}
			</div>
		</Layout>
	);
}
