import Head from "next/head";
import Link from "next/link";
import type { ReactNode } from "react";
import { inLang, LANG_NAME, type Lang, type Text, useLang } from "../lib/lang";
import { REPO, SITE, TITLE } from "../lib/site";
import { Mark } from "./Mark";

const NAV: readonly [string, Text][] = [
	["/", { en: "overview", es: "resumen" }],
	["/install/", { en: "install", es: "instalar" }],
	["/docs/", { en: "docs", es: "docs" }],
];

const SOURCE: Text = { en: "source", es: "código" };

const FOOT: Readonly<Record<Lang, ReactNode>> = {
	en: (
		<>
			MIT. One config file, one operator, one machine — see <a href={REPO}>the repository</a>.
		</>
	),
	es: (
		<>
			MIT. Un archivo de configuración, un operador, una máquina — mirá{" "}
			<a href={REPO}>el repositorio</a>.
		</>
	),
};

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
	const { lang, here, at } = useLang();
	const other: Lang = lang === "en" ? "es" : "en";
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
				{/* The same page in the other language, named so a search engine offers a reader the one
				    they can read rather than treating the two as a page duplicated. */}
				<link rel="alternate" hrefLang="en" href={`${SITE}${inLang(here, "en")}`} />
				<link rel="alternate" hrefLang="es" href={`${SITE}${inLang(here, "es")}`} />
				<link rel="alternate" hrefLang="x-default" href={`${SITE}${inLang(here, "en")}`} />
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
				{/* Beside the name rather than at the end of the row, because it is not a place on the site
				    but which site you are on — the same standing as the name itself, and the first thing a
				    reader who cannot read this page needs to find. */}
				<div className="nav-here">
					<Link href={at("/")} className="nav-brand">
						<Mark />
						squad
					</Link>
					{/* The same page, not the other language's front door: a reader who wants this page in
					    Spanish wants this page. It says the language it goes to, in that language, because
					    a reader looking for it will not be scanning for the name of the one they are in. */}
					<Link href={inLang(here, other)} className="nav-lang" hrefLang={other} lang={other}>
						{LANG_NAME[other]}
					</Link>
				</div>
				<div className="nav-links">
					{NAV.map(([href, label]) => (
						<Link
							key={href}
							href={at(href)}
							data-current={href === "/" ? here === "/" : here.startsWith(href)}
						>
							{label[lang]}
						</Link>
					))}
					<a href={REPO}>{SOURCE[lang]}</a>
				</div>
			</nav>

			<main>{children}</main>

			<footer>
				<div className="wrap footer-row">
					<span>{FOOT[lang]}</span>
					<span>squad</span>
				</div>
			</footer>
		</div>
	);
}
