import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactNode } from "react";
import { REPO, TITLE } from "../lib/site";
import { Mark } from "./Mark";

export function Layout({
	children,
	title,
	description,
	markdown,
}: {
	children: ReactNode;
	title?: string;
	description: string;
	/** This page written for a reader without a browser, where there is one. */
	markdown?: string;
}) {
	const { pathname } = useRouter();
	const full = title ? `${title} — ${TITLE}` : TITLE;

	return (
		<div className="page">
			<Head>
				<title>{full}</title>
				<meta name="description" content={description} />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="dark" />
				<meta property="og:title" content={full} />
				<meta property="og:description" content={description} />
				<meta property="og:type" content="website" />
				{/* Where the same thing is written for something that is not a browser. Every page points at
				    the index, and a docs page also points at its own markdown, so a reader who landed on one
				    page can be handed that page rather than the whole site. */}
				<link
					rel="alternate"
					type="text/markdown"
					title={`${TITLE}, as markdown`}
					href="/llms.txt"
				/>
				{markdown !== undefined && (
					<link rel="alternate" type="text/markdown" title={full} href={markdown} />
				)}
				{/* The consoles arrive a row at a time once they are scrolled to, and the chat pane prints
				    itself out, which are things only a script can do. Without one they are simply there. */}
				<noscript>
					<style>
						{
							"body .feed-line,body .mock-in{opacity:1;transform:none}body .mock-off{display:inline}body .mock-body [data-off]{display:block}"
						}
					</style>
				</noscript>
			</Head>

			<nav className="nav">
				<Link href="/" className="nav-brand">
					<Mark />
					squad
				</Link>
				<div className="nav-links">
					<Link href="/" data-current={pathname === "/"}>
						overview
					</Link>
					<Link href="/install" data-current={pathname.startsWith("/install")}>
						install
					</Link>
					<Link href="/docs" data-current={pathname.startsWith("/docs")}>
						docs
					</Link>
					<a href={REPO}>source</a>
				</div>
			</nav>

			<main>{children}</main>

			<footer>
				<div className="wrap footer-row">
					<span>
						MIT. One config file, one operator, one machine — see <a href={REPO}>the repository</a>.
					</span>
					<span>squad</span>
				</div>
			</footer>
		</div>
	);
}
