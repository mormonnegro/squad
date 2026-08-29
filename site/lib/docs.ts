// Every docs page, once. Three things read this list: the menu on the left of every page, the map on
// /docs, and the row at the foot of each page that says what comes next — so a page added here is a
// page all three of them know about, and a page reachable from only one of the three is a page most
// of its readers never find.
//
// A page is named twice because the site is written in two languages, but it is one entry: the order
// of the menu and the set of pages are decided here and cannot come out different in Spanish.

import type { Lang, Text } from "./lang";

export type DocPage = {
	/** With the trailing slash the export writes, and with no language on it. */
	readonly href: string;
	readonly title: Text;
	/** What the page answers, in the one line the map and the menu both show. */
	readonly blurb: Text;
};

export type DocGroup = {
	readonly name: Text;
	readonly pages: readonly DocPage[];
};

export const DOCS: readonly DocGroup[] = [
	{
		name: { en: "Start", es: "Empezar" },
		pages: [
			{
				href: "/docs/",
				title: { en: "Overview", es: "Resumen" },
				blurb: {
					en: "the two halves, and what an agent turns out to be",
					es: "las dos mitades, y en qué acaba consistiendo un agente",
				},
			},
			{
				href: "/docs/server/",
				title: { en: "A server", es: "Un servidor" },
				blurb: {
					en: "renting the cheapest one on any list, and getting in with a key or a password",
					es: "alquilar el más barato de cualquier lista, y entrar con una clave o una contraseña",
				},
			},
			{
				href: "/docs/console/",
				title: { en: "The console", es: "La consola" },
				blurb: {
					en: "the screen, the keys, and every command there is",
					es: "la pantalla, las teclas, y todos los comandos que hay",
				},
			},
			{
				href: "/docs/agents/",
				title: { en: "Agents", es: "Agentes" },
				blurb: {
					en: "making one, what it is made of, and taking it away",
					es: "crear uno, de qué está hecho, y quitarlo",
				},
			},
		],
	},
	{
		name: { en: "Being reached", es: "Cómo se le llega" },
		pages: [
			{
				href: "/docs/telegram/",
				title: { en: "Telegram", es: "Telegram" },
				blurb: {
					en: "a bot per agent, paired to you by a phrase",
					es: "un bot por agente, emparejado contigo por una frase",
				},
			},
			{
				href: "/docs/email/",
				title: { en: "Email", es: "Correo" },
				blurb: {
					en: "one mailbox for the whole plane, and a list of who may write to it",
					es: "un buzón para todo el plano, y una lista de quién puede escribirle",
				},
			},
			{
				href: "/docs/webhooks/",
				title: { en: "Webhooks", es: "Webhooks" },
				blurb: {
					en: "the one published port, and what a signature proves",
					es: "el único puerto publicado, y qué demuestra una firma",
				},
			},
			{
				href: "/docs/schedules/",
				title: { en: "Schedules", es: "Horarios" },
				blurb: {
					en: "cron you wrote, and the turn an agent books for itself",
					es: "el cron que escribiste, y el turno que un agente se reserva solo",
				},
			},
		],
	},
	{
		name: { en: "What an agent can do", es: "Lo que puede hacer un agente" },
		pages: [
			{
				href: "/docs/models/",
				title: { en: "Models", es: "Modelos" },
				blurb: {
					en: "what it thinks with, and where the key goes",
					es: "con qué piensa, y dónde va la clave",
				},
			},
			{
				href: "/docs/mcp/",
				title: { en: "MCP servers", es: "Servidores MCP" },
				blurb: {
					en: "tools that live somewhere else, on a shelf the plane keeps",
					es: "herramientas que viven en otro sitio, en un estante que guarda el plano",
				},
			},
			{
				href: "/docs/search/",
				title: { en: "Web search", es: "Búsqueda web" },
				blurb: {
					en: "one granted endpoint, and the reading done on the far side of it",
					es: "un solo destino concedido, y la lectura hecha del otro lado",
				},
			},
			{
				href: "/docs/serve/",
				title: { en: "Serving a port", es: "Publicar un puerto" },
				blurb: {
					en: "opening what an agent built on the machine your browser is on",
					es: "abrir lo que un agente construyó, en la máquina donde está tu navegador",
				},
			},
		],
	},
	{
		name: { en: "Bounds", es: "Límites" },
		pages: [
			{
				href: "/docs/trust/",
				title: { en: "Trust", es: "Confianza" },
				blurb: {
					en: "who may instruct, and who is only ever quoted",
					es: "quién puede dar instrucciones, y a quién solo se le cita",
				},
			},
			{
				href: "/docs/grants/",
				title: { en: "Reach", es: "Alcance" },
				blurb: {
					en: "the proxy, the grants, and the credential the agent never holds",
					es: "el proxy, las concesiones, y la credencial que el agente nunca tiene",
				},
			},
			{
				href: "/docs/limits/",
				title: { en: "Spending", es: "Gasto" },
				blurb: {
					en: "dollars a day, and what happens at the ceiling",
					es: "dólares por día, y qué pasa al llegar al techo",
				},
			},
			{
				href: "/docs/config/",
				title: { en: "config.yaml", es: "config.yaml" },
				blurb: {
					en: "the file that is yours, and the store beside it that is the console's",
					es: "el archivo que es tuyo, y el almacén de al lado que es de la consola",
				},
			},
		],
	},
];

/** The menu read top to bottom, which is the order the foot of each page walks. */
export const DOC_PAGES: readonly DocPage[] = DOCS.flatMap((group) => group.pages);

/**
 * The same page written for a reader without a browser: `/docs/server/` is `/docs/server.md`, and
 * `/docs/` is `/docs/index.md`.
 *
 * The build writes those files and every page's head points at its own, so this is the one place
 * that decides the address. Two copies of that rule is one of them being wrong the day a page moves.
 *
 * Only English has them: what they are for is being handed to something that reads rather than
 * browses, and there is one of those files per page, not one per page per language.
 */
export function markdownOf(href: string, lang: Lang = "en"): string | undefined {
	if (lang !== "en") return undefined;
	const slug = href.replace(/^\/docs\//, "").replace(/\/$/, "");
	return `/docs/${slug === "" ? "index" : slug}.md`;
}

/** Which part of the menu a page is under, for the line above its title. */
export function docsGroupOf(href: string, lang: Lang): string | undefined {
	return DOCS.find((group) => group.pages.some((page) => page.href === href))?.name[lang];
}

export function docsAround(href: string): {
	readonly previous: DocPage | undefined;
	readonly next: DocPage | undefined;
} {
	const at = DOC_PAGES.findIndex((page) => page.href === href);
	return { previous: DOC_PAGES[at - 1], next: DOC_PAGES[at + 1] };
}
