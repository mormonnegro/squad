/**
 * What a tool call is, said the way somebody who is not its operator would say it.
 *
 * The steps under a turn are the only answer to "what is it doing", and they answered it in the
 * agent's own terms: a tool name, and the argument it was called with, which is a shell line with
 * three pipes in it as often as not. That is the right thing to keep in the feed — a log that
 * paraphrases is a log nobody can debug from — and the wrong thing to put under a name in a
 * conversation, where the person reading is waiting for an answer rather than auditing a process.
 *
 * So the technical line stays exactly as it was and this is said beside it. Written here, from the
 * arguments as the tool was actually called with them, rather than in the browser from the line the
 * feed prints: that line is one field cut to 300 characters, and a phrase built out of a truncation
 * is wrong precisely when the call was interesting.
 *
 * Everything here is a guess about a tool nobody promised the shape of, so every guess falls back to
 * something true but dull rather than to nothing: "running a command" says less than the command
 * did, and still says more than a blank line.
 */

export interface InWords {
	/** One line, in a person's words, about what is happening. Never empty. */
	readonly say: string;
	/** The pages this step read, as URLs. What a reader is shown the marks of. */
	readonly sources: readonly string[];
}

/** A quoted phrase is a fragment of a line, and a whole search query is not. */
const MOST_QUOTED = 60;

/** Enough to say who was read without the row becoming the list. */
const MOST_SOURCES = 8;

const ADDRESS = /https?:\/\/[^\s"'`<>|)\\]+/g;

/** What the agent is doing, by the tool it is doing it with. */
export function plainly(action: string, args: unknown): InWords {
	const has = fields(args);
	const path = text(has, "path") || text(has, "file_path") || text(has, "filename");
	const url = text(has, "url");

	switch (action) {
		case "bash":
		case "shell":
		case "run_command":
			return shell(text(has, "command"));
		case "read":
		case "view":
			return { say: `reading ${leaf(path) || "a file"}`, sources: [] };
		case "write":
		case "create":
			return { say: `writing ${leaf(path) || "a file"}`, sources: [] };
		case "edit":
		case "multiedit":
		case "str_replace":
		case "apply_patch":
			return { say: `editing ${leaf(path) || "a file"}`, sources: [] };
		case "grep":
		case "search_files":
			return { say: looking(text(has, "pattern"), path), sources: [] };
		case "glob":
		case "find":
		case "ls":
		case "list":
			return { say: `looking through ${leaf(path) || "the files"}`, sources: [] };
		/*
		 * The browser, which is the one set of tools where the words are the whole of what a person
		 * watching can see. A turn on a booking site is twenty of these in a row, and until now every
		 * one of them read "using screen click" — three identical lines under an agent that had just
		 * filled in a form, chosen a flight and opened a checkout.
		 *
		 * The click and the field say which way the agent worked: a phrase is a thing it named and
		 * something small and fast found for it, and a number is a page it read and counted through.
		 * Nothing here says "pointing" — the difference is visible in what the line says, which is
		 * the only place a person was going to look for it.
		 */
		case "screen_open":
			return url.startsWith("http")
				? { say: `opening ${named([url])}`, sources: [url] }
				: { say: "opening a page", sources: [] };
		case "screen_read":
			return { say: "reading the page", sources: [] };
		case "screen_look":
			return { say: "looking at the page", sources: [] };
		case "screen_click":
			return {
				say: on(has, "clicking", "clicking something on the page"),
				sources: [],
			};
		case "screen_type": {
			const typed = text(has, "text");
			const into = on(has, "typing into", "typing on the page");
			return {
				say: typed.length === 0 ? into : `${into}: ${quoted(typed)}`,
				sources: [],
			};
		}
		case "screen_key":
			return { say: `pressing ${text(has, "key") || "a key"}`, sources: [] };
		case "screen_scroll":
			return { say: `scrolling ${text(has, "to") || "the page"}`, sources: [] };
		case "screen_back":
			return { say: "going back a page", sources: [] };
		case "screen_tab_open":
			return url.startsWith("http")
				? { say: `opening ${named([url])} in another tab`, sources: [url] }
				: { say: "opening another tab", sources: [] };
		case "screen_tabs":
			return { say: "looking at its tabs", sources: [] };
		case "screen_tab":
			return { say: "going back to another tab", sources: [] };
		case "screen_tab_close":
			return { say: "closing a tab", sources: [] };
		/*
		 * The one line here worth reading twice, which is why it names the site.
		 *
		 * Everything else on this list is an agent moving around a page. This is an account of the
		 * operator\'s being used, and a person scrolling past it should be able to tell at a glance
		 * which one — an unexpected host on this line is the whole of what watching is for.
		 */
		case "screen_login": {
			// The site as the agent said it when it is not an address: this tool takes a host, and a
			// host is the half of a URL that `named` is built to throw the rest of away.
			const site = hostOf(url) || url.trim();
			return {
				say:
					site === ""
						? "signing into this page from your vault"
						: `signing into ${site} from your vault`,
				sources: [],
			};
		}
		case "screen_ask":
			return { say: "asking you to take the keyboard", sources: [] };
		case "web_search":
			return { say: `searching the web for ${quoted(text(has, "query"))}`, sources: [] };
		case "remember":
			return { say: "writing down something it worked out", sources: [] };
		case "wake_me":
			return { say: `asking for another turn ${when(has.afterSeconds)}`, sources: [] };
		case "cancel_wake":
			return { say: "dropping the turn it had asked for", sources: [] };
		case "send_to":
			return { say: `writing to ${text(has, "to") || "another agent"}`, sources: [] };
		// The line it wants typed at the console, which is the whole of what it is asking for.
		case "console_command":
			return {
				say: `asking for ${text(has, "line").split(" ").slice(0, 2).join(" ")}`,
				sources: [],
			};
		// Not a tool: what the plane calls a provider that refused the turn. It is the one step whose
		// detail is the whole story, so this says only that the story is there.
		case "model":
			return { say: "the model would not answer", sources: [] };
		default:
			// A URL in any tool nobody here has heard of is still a page being read, and an MCP tool is
			// named `server_tool` — underscores are the only thing between that and a readable phrase.
			if (url.startsWith("http")) return { say: `reading ${named([url])}`, sources: [url] };
			return { say: `using ${action.replace(/[_-]+/g, " ").trim() || "a tool"}`, sources: [] };
	}
}

/**
 * The pages an answer was written from, out of the answer itself.
 *
 * The search tool hands back prose with its sources in it — sometimes as a list under the text,
 * sometimes as links inside it — and that is the only place the URLs exist: the plane sees the
 * question that was asked and, until this, nothing about where the answer came from.
 */
export function sourcesIn(answer: string): readonly string[] {
	const found: string[] = [];
	for (const one of answer.match(ADDRESS) ?? []) {
		// A URL at the end of a sentence takes the full stop with it, and one inside a markdown link
		// takes the bracket. Neither is part of the address, and both are a broken mark on screen.
		const url = one.replace(/[).,;:\]]+$/, "");
		if (url.length > 0 && !found.includes(url)) found.push(url);
		if (found.length === MOST_SOURCES) break;
	}
	return found;
}

/** Who those pages were, as one phrase. */
export function named(urls: readonly string[]): string {
	const hosts: string[] = [];
	for (const url of urls) {
		const host = hostOf(url);
		if (host.length > 0 && !hosts.includes(host)) hosts.push(host);
	}
	const [first, second] = hosts;
	if (first === undefined) return "a page";
	if (second === undefined) return first;
	if (hosts.length === 2) return `${first} and ${second}`;
	return `${first} and ${hosts.length - 1} others`;
}

/** The site, without the part of it that is never read aloud. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * A shell line, which is the hardest of these and the one that matters most: it is what an agent
 * does when no tool fits, so it is where the interesting half of a turn happens.
 *
 * Read as: is it fetching something, and if not, what is the command at the front of it. Fetching
 * is asked first because a `for u in …; do curl "$u"; done` is a loop by shape and a page being read
 * by intent, and the intent is what somebody watching wants to be told.
 */
function shell(command: string): InWords {
	const line = command.replace(/\s+/g, " ").trim();
	if (line.length === 0) return { say: "running a command", sources: [] };

	const fetched = fetching(line);
	if (fetched !== undefined) return fetched;

	switch (front(line)) {
		case "cat":
		case "head":
		case "tail":
		case "less":
		case "bat":
		case "sed":
			return { say: `reading ${leaf(fileIn(line)) || "a file"}`, sources: [] };
		case "ls":
		case "tree":
		case "find":
		case "fd":
		case "stat":
		case "du":
			return { say: `looking through ${leaf(fileIn(line)) || "the files"}`, sources: [] };
		case "grep":
		case "rg":
		case "ag":
			return { say: looking(subject(line), ""), sources: [] };
		case "node":
		case "python":
		case "python3":
		case "bun":
		case "deno":
		case "ruby":
		case "perl":
			return { say: "running a script", sources: [] };
		case "npm":
		case "pnpm":
		case "yarn":
		case "npx":
			return { say: packages(line), sources: [] };
		case "git":
			return { say: repository(line), sources: [] };
		case "mkdir":
		case "cp":
		case "mv":
		case "rm":
		case "touch":
		case "chmod":
		case "ln":
			return { say: "moving files about", sources: [] };
		case "echo":
		case "printf":
		case "tee":
			return { say: line.includes(">") ? "writing a file" : "running a command", sources: [] };
		default:
			return { say: "running a command", sources: [] };
	}
}

/** A line that reaches out to the web, and who it reaches. */
function fetching(line: string): InWords | undefined {
	if (!/(^|[\s;|&(])(curl|wget|xh|http)\s/.test(line)) return undefined;
	const urls = (line.match(ADDRESS) ?? []).slice(0, MOST_SOURCES);
	if (urls.length === 0) return undefined;
	return { say: `reading ${named(urls)}`, sources: urls };
}

/**
 * The command a line actually runs, past everything written in front of it.
 *
 * `cd /tmp && node …` is a turn spent running node, and a phrase that said "changing directory"
 * would be the one true thing on the row and also the only useless one.
 */
function front(line: string): string {
	let rest = line;
	for (;;) {
		const past = rest
			.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "")
			.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "")
			.replace(/^(?:sudo|time|nohup|exec|command)\s+/, "")
			.replace(/^(?:for|while|do|then|if)\s+.*?;\s*(?:do|then)\s+/, "");
		if (past === rest) break;
		rest = past;
	}
	return (rest.split(/[\s;|&(]/)[0] ?? "").toLowerCase();
}

/** What a command was given, which is its first argument that is not a switch. */
function subject(line: string): string {
	for (const word of args(line)) return word;
	return "";
}

/**
 * The file a command was pointed at, which is not always the first thing it was given.
 *
 * `sed -n '1,50p' notes.md` is a turn spent reading notes.md, and a row that said "reading
 * 1,50p" would be a row that had found an argument rather than read a command.
 */
function fileIn(line: string): string {
	const rest = args(line);
	for (const word of rest) {
		if (word.includes("/") || /\.[A-Za-z0-9]+$/.test(word)) return word;
	}
	return rest[0] ?? "";
}

/** Everything a command was given that is not a switch, unquoted. */
function args(line: string): readonly string[] {
	const [, ...rest] = line.split(" ");
	return rest
		.filter((word) => word.length > 0 && !word.startsWith("-"))
		.map((word) => word.replace(/^["']|["']$/g, ""));
}

function looking(pattern: string, path: string): string {
	if (pattern.length === 0) return "searching the files";
	const where = leaf(path);
	return `looking for ${quoted(pattern)}${where.length > 0 ? ` in ${where}` : ""}`;
}

function packages(line: string): string {
	if (/\b(test|vitest|jest)\b/.test(line)) return "running the tests";
	if (/\b(install|add|ci)\b/.test(line)) return "installing packages";
	if (/\bbuild\b/.test(line)) return "building the project";
	if (/\b(lint|biome|eslint|typecheck|tsc)\b/.test(line)) return "checking its own work";
	return "running a build command";
}

function repository(line: string): string {
	if (/\bclone\b/.test(line)) return "cloning a repository";
	if (/\bcommit\b/.test(line)) return "saving its work";
	if (/\bpush\b/.test(line)) return "pushing what it saved";
	if (/\b(pull|fetch)\b/.test(line)) return "catching up with the repository";
	return "checking the repository";
}

/** How far off a wakeup is, in the units somebody would have said it in. */
function when(seconds: unknown): string {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "later";
	if (seconds < 90) return "in a minute";
	if (seconds < 5400) return `in ${Math.round(seconds / 60)} minutes`;
	if (seconds < 129600) return `in ${Math.round(seconds / 3600)} hours`;
	return `in ${Math.round(seconds / 86400)} days`;
}

function leaf(path: string): string {
	const parts = path.split("/").filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? "";
}

/**
 * What a call to the browser is about: the thing it named, or the number it counted to.
 *
 * The one place in here where the words say which of two ways the agent worked, and they say it by
 * being different rather than by explaining. `clicking “the Continue button”` is a description the
 * agent handed over and something else turned into an element; `clicking [7]` is a page it read and
 * a row it picked out itself.
 */
function on(has: Record<string, unknown>, doing: string, otherwise: string): string {
	const what = text(has, "what").trim();
	if (what.length > 0) return `${doing} ${quoted(what)}`;
	const ref = has.ref;
	return typeof ref === "number" ? `${doing} [${ref}]` : otherwise;
}

function quoted(said: string): string {
	const flat = said.replace(/\s+/g, " ").trim();
	const short = flat.length > MOST_QUOTED ? `${flat.slice(0, MOST_QUOTED - 1)}…` : flat;
	return `“${short}”`;
}

function fields(args: unknown): Record<string, unknown> {
	return args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function text(has: Record<string, unknown>, key: string): string {
	const value = has[key];
	return typeof value === "string" ? value : "";
}
