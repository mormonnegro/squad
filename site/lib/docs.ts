// Every docs page, once. Three things read this list: the menu on the left of every page, the map on
// /docs, and the row at the foot of each page that says what comes next — so a page added here is a
// page all three of them know about, and a page reachable from only one of the three is a page most
// of its readers never find.

export type DocPage = {
	/** With the trailing slash the export writes, so the current-page test is a string compare. */
	readonly href: string;
	readonly title: string;
	/** What the page answers, in the one line the map and the menu both show. */
	readonly blurb: string;
};

export type DocGroup = {
	readonly name: string;
	readonly pages: readonly DocPage[];
};

export const DOCS: readonly DocGroup[] = [
	{
		name: "Start",
		pages: [
			{
				href: "/docs/",
				title: "Overview",
				blurb: "the two halves, and what an agent turns out to be",
			},
			{
				href: "/docs/server/",
				title: "A server",
				blurb: "renting the cheapest one on any list, and getting in with a key or a password",
			},
			{
				href: "/docs/console/",
				title: "The console",
				blurb: "the screen, the keys, and every command there is",
			},
			{
				href: "/docs/agents/",
				title: "Agents",
				blurb: "making one, what it is made of, and taking it away",
			},
		],
	},
	{
		name: "Being reached",
		pages: [
			{
				href: "/docs/telegram/",
				title: "Telegram",
				blurb: "a bot per agent, paired to you by a phrase",
			},
			{
				href: "/docs/email/",
				title: "Email",
				blurb: "one mailbox for the whole plane, and who carries the answer out",
			},
			{
				href: "/docs/webhooks/",
				title: "Webhooks",
				blurb: "the one published port, and what a signature proves",
			},
			{
				href: "/docs/schedules/",
				title: "Schedules",
				blurb: "cron you wrote, and the turn an agent books for itself",
			},
		],
	},
	{
		name: "What an agent can do",
		pages: [
			{
				href: "/docs/models/",
				title: "Models",
				blurb: "what it thinks with, and where the key goes",
			},
			{
				href: "/docs/mcp/",
				title: "MCP servers",
				blurb: "tools that live somewhere else, on a shelf the plane keeps",
			},
			{
				href: "/docs/search/",
				title: "Web search",
				blurb: "one granted endpoint, and the reading done on the far side of it",
			},
			{
				href: "/docs/serve/",
				title: "Serving a port",
				blurb: "opening what an agent built on the machine your browser is on",
			},
		],
	},
	{
		name: "Bounds",
		pages: [
			{
				href: "/docs/trust/",
				title: "Trust",
				blurb: "who may instruct, and who is only ever quoted",
			},
			{
				href: "/docs/grants/",
				title: "Reach",
				blurb: "the proxy, the grants, and the credential the agent never holds",
			},
			{
				href: "/docs/limits/",
				title: "Spending",
				blurb: "dollars a day, and what happens at the ceiling",
			},
			{
				href: "/docs/config/",
				title: "config.yaml",
				blurb: "the file that is yours, and the store beside it that is the console's",
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
 */
export function markdownOf(href: string): string {
	const slug = href.replace(/^\/docs\//, "").replace(/\/$/, "");
	return `/docs/${slug === "" ? "index" : slug}.md`;
}

export function docsAround(href: string): {
	readonly previous: DocPage | undefined;
	readonly next: DocPage | undefined;
} {
	const at = DOC_PAGES.findIndex((page) => page.href === href);
	return { previous: DOC_PAGES[at - 1], next: DOC_PAGES[at + 1] };
}
