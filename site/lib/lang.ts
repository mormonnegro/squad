// The site is written twice. English is at the addresses it always had and Spanish is the same tree
// under `/es`, because a static export has no server to negotiate a language with: the choice has to
// be an address, so that it survives a bookmark, a link somebody sends, and a search result.
//
// Every page in one tree has a counterpart in the other at the same path, which is what lets the
// button in the nav be a link to where you already are rather than a menu of the site's languages.

import { useRouter } from "next/router";

export type Lang = "en" | "es";

/** A phrase written once per language, for the few that live outside a page. */
export type Text = Readonly<Record<Lang, string>>;

export const LANGS: readonly Lang[] = ["en", "es"];

/** What each language calls itself, which is the only name a reader of it will recognise. */
export const LANG_NAME: Readonly<Record<Lang, string>> = { en: "english", es: "español" };

export function langOf(pathname: string): Lang {
	return pathname === "/es" || pathname.startsWith("/es/") ? "es" : "en";
}

/**
 * The path with no language on it, which is the address of the English page and the key both trees
 * are indexed by — `/es/docs/trust` and `/docs/trust` are one page, and this is its name.
 */
export function bare(pathname: string): string {
	const rest = pathname.replace(/^\/es(?=\/|$)/, "");
	// With the trailing slash the export writes, which the router's route does not carry: it is what
	// makes `/docs/` a prefix of `/docs/trust/` and not of nothing, and it is the real address.
	return rest === "" ? "/" : rest.replace(/\/?$/, "/");
}

/** That same page in a given language, as an address. */
export function inLang(href: string, lang: Lang): string {
	if (lang === "en") return href;
	return href === "/" ? "/es/" : `/es${href}`;
}

/** The language this page is in, and the tools to write a link that stays in it. */
export function useLang(): {
	readonly lang: Lang;
	readonly here: string;
	/** An address on this site, in the language being read. */
	readonly at: (href: string) => string;
} {
	const { pathname } = useRouter();
	const lang = langOf(pathname);
	return { lang, here: bare(pathname), at: (href) => inLang(href, lang) };
}
