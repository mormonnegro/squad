import { hostOf, type McpServer } from "./mcp.ts";

/**
 * A plugin as somebody looks for one, which is by the name of the company rather than by a URL.
 *
 * The shelf underneath this is a list of servers: a name, a transport and an address that somebody
 * had to go and find in a README. That is the right thing to store and the wrong thing to ask for.
 * Nobody sets out to add `https://mcp.stripe.com`; they set out to give an agent their Stripe, and
 * the address is a detail of how that is done.
 *
 * So this is the shelf as a shop: what each one is for, which company it belongs to — so its own
 * mark can be drawn beside it — and whether reaching it means opening an account. Everything here
 * is a fact about a third party that can change without telling us, which is why `account` is a
 * hint for the screen and never a gate: what actually decides is the server's own refusal, asked
 * for at the moment of connecting.
 */
export interface Plugin {
	readonly id: string;
	readonly title: string;
	/** What it is for, in the words somebody would use to decide whether they want it. */
	readonly does: string;
	/** Which group it is found under, because twenty of these unsorted is a list nobody reads. */
	readonly shelf: Shelf;
	/** The company's own domain. Its mark is asked of it there, rather than of a favicon service. */
	readonly mark: string;
	readonly transport: "http" | "sse";
	readonly url: string;
	/** What it wants before it answers: a browser trip, or nothing at all. */
	readonly account: "oauth" | "open";
	/**
	 * A plugin that is a process rather than a place, started inside the sandbox.
	 *
	 * The shelf has always taken these — `/plugins add files mcp-files /tmp` — and they have always
	 * been somebody else's program. These are ours, and they exist for the one thing a remote server
	 * cannot do: reach an API that has no MCP anybody can use, with a credential the agent never
	 * sees, because what goes out is bare and the proxy writes the token onto it.
	 */
	readonly runs?: readonly string[];
	/**
	 * The host such a plugin reaches, and how far into it.
	 *
	 * This is the grant it earns, and it is earned only while an agent holds the plugin and the
	 * account behind it is open. Written as narrow as the tools are: Gmail's is `GET` and one path,
	 * so the token that reaches it cannot send, delete, or read anything else in that account.
	 */
	readonly reaches?: {
		readonly host: string;
		readonly pathPrefix?: string;
		readonly methods?: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
	};
	/**
	 * Where to authorize, for a provider that is not an MCP server and advertises nothing.
	 *
	 * `makeAt` is the page where the operator makes the app this uses. It is theirs and not ours on
	 * purpose: reading a mailbox is a restricted scope at Google, an application asking for one is
	 * audited before it may ask anybody, and an unaudited one is limited to users it names one by
	 * one. A client id shipped here would be an application only its author could use.
	 */
	readonly oauth?: {
		readonly authorizationUrl: string;
		readonly tokenUrl: string;
		readonly scopes: readonly string[];
		/** What the authorization needs beyond the standard for a refresh token to come back. */
		readonly extra?: Readonly<Record<string, string>>;
		/** Whether the token endpoint refuses without the other half of the app. */
		readonly wantsSecret: boolean;
		readonly makeAt: string;
		/** Said on the screen, because the clicking is somebody else's and it has an order. */
		readonly steps: readonly string[];
	};
}

export type Shelf = "money" | "work" | "code" | "runs" | "data" | "read";

/** The groups, in the order a screen shows them: what you pay with, then what you work in. */
export const SHELVES: readonly (readonly [Shelf, string])[] = [
	["money", "Money"],
	["work", "Work"],
	["code", "Code"],
	["runs", "Where it runs"],
	["data", "Data"],
	["read", "Reading"],
];

/**
 * The plugins offered on the first screen, each one reached and answering as of this writing.
 *
 * A curated list rather than a registry: a registry is a thing to maintain and a search box to
 * stare at, and the honest shape of "what can I connect" for one person is two dozen names they
 * already recognise. Anything not here is still one paste away — the screen takes a URL, and so
 * does `/plugins add`.
 *
 * Every address was verified by speaking MCP to it: a `401` is the right answer, and it is the
 * answer these give, because a server that hands its tools to an unauthenticated stranger is one
 * nobody should be connecting an agent to.
 */
export const PLUGINS: readonly Plugin[] = [
	{
		id: "stripe",
		title: "Stripe",
		does: "Payments, customers, subscriptions and the invoices behind them.",
		shelf: "money",
		mark: "stripe.com",
		transport: "http",
		url: "https://mcp.stripe.com",
		account: "oauth",
	},
	{
		id: "paypal",
		title: "PayPal",
		does: "Orders, payouts and disputes on a PayPal business account.",
		shelf: "money",
		mark: "paypal.com",
		transport: "http",
		url: "https://mcp.paypal.com/mcp",
		account: "oauth",
	},
	{
		id: "square",
		title: "Square",
		does: "Catalogue, orders and payments for a Square seller.",
		shelf: "money",
		mark: "squareup.com",
		transport: "sse",
		url: "https://mcp.squareup.com/sse",
		account: "oauth",
	},
	{
		id: "linear",
		title: "Linear",
		does: "Issues, projects and cycles, read and written.",
		shelf: "work",
		mark: "linear.app",
		transport: "http",
		url: "https://mcp.linear.app/mcp",
		account: "oauth",
	},
	{
		id: "atlassian",
		title: "Atlassian",
		does: "Jira issues and Confluence pages on one account.",
		shelf: "work",
		mark: "atlassian.com",
		transport: "sse",
		url: "https://mcp.atlassian.com/v1/sse",
		account: "oauth",
	},
	{
		id: "asana",
		title: "Asana",
		does: "Tasks, projects and their status across a workspace.",
		shelf: "work",
		mark: "asana.com",
		transport: "sse",
		url: "https://mcp.asana.com/sse",
		account: "oauth",
	},
	{
		id: "slack",
		title: "Slack",
		does: "Channels, messages and the search over them.",
		shelf: "work",
		mark: "slack.com",
		transport: "http",
		url: "https://mcp.slack.com/mcp",
		account: "oauth",
	},
	{
		id: "intercom",
		title: "Intercom",
		does: "Conversations, contacts and what support has already been told.",
		shelf: "work",
		mark: "intercom.com",
		transport: "http",
		url: "https://mcp.intercom.com/mcp",
		account: "oauth",
	},
	{
		id: "hubspot",
		title: "HubSpot",
		does: "Contacts, companies and deals in a CRM.",
		shelf: "work",
		mark: "hubspot.com",
		transport: "http",
		url: "https://mcp.hubspot.com/anthropic",
		account: "oauth",
	},
	{
		id: "notion",
		title: "Notion",
		does: "Pages and databases, searched and edited.",
		shelf: "work",
		mark: "notion.so",
		transport: "http",
		url: "https://mcp.notion.com/mcp",
		account: "oauth",
	},
	{
		id: "github",
		title: "GitHub",
		does: "Repositories, issues, pull requests and the code in them.",
		shelf: "code",
		mark: "github.com",
		transport: "http",
		url: "https://api.githubcopilot.com/mcp/",
		account: "oauth",
	},
	{
		id: "sentry",
		title: "Sentry",
		does: "Errors as they happen, with the stack that threw them.",
		shelf: "code",
		mark: "sentry.io",
		transport: "http",
		url: "https://mcp.sentry.dev/mcp",
		account: "oauth",
	},
	{
		id: "semgrep",
		title: "Semgrep",
		does: "Scans code for the bugs a pattern can find.",
		shelf: "code",
		mark: "semgrep.dev",
		transport: "http",
		url: "https://mcp.semgrep.ai/mcp",
		account: "oauth",
	},
	{
		id: "vercel",
		title: "Vercel",
		does: "Projects, deployments and the logs of a build that failed.",
		shelf: "runs",
		mark: "vercel.com",
		transport: "http",
		url: "https://mcp.vercel.com",
		account: "oauth",
	},
	{
		id: "cloudflare",
		title: "Cloudflare",
		does: "Workers, DNS and what the edge did with a request.",
		shelf: "runs",
		mark: "cloudflare.com",
		transport: "http",
		url: "https://mcp.cloudflare.com/mcp",
		account: "oauth",
	},
	{
		id: "supabase",
		title: "Supabase",
		does: "A Postgres project: tables, rows, and the SQL over them.",
		shelf: "data",
		mark: "supabase.com",
		transport: "http",
		url: "https://mcp.supabase.com/mcp",
		account: "oauth",
	},
	{
		id: "neon",
		title: "Neon",
		does: "Postgres branches, and queries against any of them.",
		shelf: "data",
		mark: "neon.tech",
		transport: "http",
		url: "https://mcp.neon.tech/mcp",
		account: "oauth",
	},
	{
		id: "airtable",
		title: "Airtable",
		does: "Bases, tables and records.",
		shelf: "data",
		mark: "airtable.com",
		transport: "http",
		url: "https://mcp.airtable.com/mcp",
		account: "oauth",
	},
	{
		id: "ahrefs",
		title: "Ahrefs",
		does: "Backlinks, keywords and what a domain ranks for.",
		shelf: "data",
		mark: "ahrefs.com",
		transport: "http",
		url: "https://api.ahrefs.com/mcp/mcp",
		account: "oauth",
	},
	{
		id: "canva",
		title: "Canva",
		does: "Designs, brand templates and exports of them.",
		shelf: "work",
		mark: "canva.com",
		transport: "http",
		url: "https://mcp.canva.com/mcp",
		account: "oauth",
	},
	{
		id: "figma",
		title: "Figma",
		does: "Files and frames, and the design tokens inside them.",
		shelf: "work",
		mark: "figma.com",
		transport: "http",
		url: "https://mcp.figma.com/mcp",
		account: "oauth",
	},
	{
		id: "gmail",
		title: "Gmail",
		does: "Reads your mail: search it, and read a message it found.",
		shelf: "work",
		mark: "google.com",
		/*
		 * Your mail, through an app of your own.
		 *
		 * Google hands nobody a key to somebody else's mailbox without an audit, so the application
		 * here is yours: a client id and a secret you make once, in your own project, and consent to
		 * once in a browser. There is no shorter road and no third party in the middle — what holds
		 * the token afterwards is this plane, and what reaches Gmail is a process in the sandbox that
		 * carries nothing at all.
		 */
		transport: "http",
		url: "https://gmail.googleapis.com/gmail/v1/users/me/",
		runs: ["squad-gmail"],
		reaches: {
			host: "gmail.googleapis.com",
			pathPrefix: "/gmail/v1/users/me/",
			methods: ["GET"],
		},
		account: "oauth",
		oauth: {
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			// Reading and nothing else. There is no tool here that sends, and the grant under it is
			// `GET` on one path, so neither could there be.
			scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
			// Without the first there is no refresh token at all, and without the second there is one
			// only on the very first consent — a login that stops working within the hour.
			extra: { access_type: "offline", prompt: "consent" },
			wantsSecret: true,
			makeAt: "https://console.cloud.google.com/apis/credentials",
			steps: [
				"In a Google Cloud project, enable the Gmail API.",
				"On the OAuth consent screen add the scope gmail.readonly and publish the app — in Testing, Google expires the refresh token every seven days.",
				"Make an OAuth client of type Desktop app, and paste its id and secret here.",
				"Google will warn you that the app is unverified. It is yours and you are its only user: Advanced, then go to it anyway.",
			],
		},
	},
	{
		id: "context7",
		title: "Context7",
		does: "Up-to-date documentation for a library, by version.",
		shelf: "read",
		mark: "context7.com",
		transport: "http",
		url: "https://mcp.context7.com/mcp",
		account: "open",
	},
	{
		id: "deepwiki",
		title: "DeepWiki",
		does: "A read of any public repository, asked in sentences.",
		shelf: "read",
		mark: "deepwiki.com",
		transport: "http",
		url: "https://mcp.deepwiki.com/mcp",
		account: "open",
	},
	{
		id: "huggingface",
		title: "Hugging Face",
		does: "Models, datasets and spaces, searched.",
		shelf: "read",
		mark: "huggingface.co",
		transport: "http",
		url: "https://huggingface.co/mcp",
		account: "open",
	},
];

export function pluginOf(id: string): Plugin | undefined {
	return PLUGINS.find((one) => one.id === id);
}

/**
 * Which plugin an address is, for a connection that never said.
 *
 * Everything connected from the catalogue knows what it is a copy of, and everything connected
 * before there was a catalogue — or typed in by hand, which is the same thing — does not. The
 * address is enough to say: a connection to `api.ahrefs.com` is an Ahrefs whoever typed it thought
 * of it that way or not, and a row that draws its mark and its name is one that reads like the rest
 * of the list instead of like the one thing on the screen that went wrong.
 *
 * By host rather than by the whole URL, because a trailing slash is not a different company.
 */
export function pluginAt(server: McpServer): string | undefined {
	const host = hostOf(server);
	if (host === undefined) return undefined;
	return PLUGINS.find((one) => one.runs === undefined && hostOf(serverOf(one)) === host)?.id;
}

/**
 * The plugin as the shelf underneath stores one.
 *
 * A place for the ones that are a place, and a process for the ones that run in the sandbox — the
 * shelf has taken both since before any of this, which is why a plugin of ours can be either
 * without the shelf learning a new shape.
 */
export function serverOf(plugin: Plugin): McpServer {
	if (plugin.runs !== undefined) {
		const [command = "", ...args] = plugin.runs;
		return { transport: "stdio", command, args };
	}
	return { transport: plugin.transport, url: plugin.url };
}

/**
 * A name for one more copy of the same plugin.
 *
 * One plugin is not one connection. A person with a Stripe account for the company and another for
 * the side project wants both, on different agents, with different tokens — and since the account
 * is opened against the name, two names is exactly what two accounts are. The first copy gets the
 * plain name because that is the one that will be typed; the rest are numbered, which is honest
 * about being a second one and leaves them free to be renamed into `stripe-live` later.
 */
export function nameFor(id: string, taken: readonly string[]): string {
	if (!taken.includes(id)) return id;
	for (let next = 2; next < 100; next++) {
		const tried = `${id}-${next}`;
		if (!taken.includes(tried)) return tried;
	}
	return `${id}-${Date.now().toString(36)}`;
}
