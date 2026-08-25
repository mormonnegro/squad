import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactNode } from "react";
import { REPO, TITLE } from "../lib/site";

export function Layout({
	children,
	title,
	description,
}: {
	children: ReactNode;
	title?: string;
	description: string;
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
				{/* The consoles arrive a row at a time once they are scrolled to, which is a thing only a
				    script can know. Without one they are simply there. */}
				<noscript>
					<style>{"body .feed-line,body .mock-in{opacity:1;transform:none}"}</style>
				</noscript>
			</Head>

			<nav className="nav">
				<Link href="/" className="nav-brand">
					agent-dive
				</Link>
				<div className="nav-links">
					<Link href="/" data-current={pathname === "/"}>
						overview
					</Link>
					<Link href="/install" data-current={pathname.startsWith("/install")}>
						install
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
					<span>agent-dive</span>
				</div>
			</footer>
		</div>
	);
}
