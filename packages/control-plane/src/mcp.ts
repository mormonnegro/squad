import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A server, in each of the ways there is to reach one.
 *
 * `stdio` is a process started inside the sandbox and spoken to down its own pipes. `http` is the
 * streamable transport remote servers are written against now, and `sse` is the one they were
 * written against before it, kept because the servers speaking it are still up.
 *
 * There is deliberately nowhere here to put a credential. A stdio server inherits the sandbox, whose
 * only route off the host is the proxy, and a remote one is reached through that same proxy — so
 * whatever key either of them needs is one the proxy already writes onto the request. A server that
 * carried its own key would be the one thing in this system that hands the agent a secret.
 */
export type McpServer =
	| { readonly transport: "stdio"; readonly command: string; readonly args: readonly string[] }
	| { readonly transport: "http" | "sse"; readonly url: string };

export interface NamedServer {
	readonly name: string;
	readonly server: McpServer;
}

/**
 * A server on the shelf as a screen showing all of them needs it: what it is, and who has it.
 *
 * The second half is the one a list of servers is otherwise missing. A server nobody was given does
 * nothing at all, and that is not visible from the URL — so it is said here rather than left to be
 * worked out by opening every agent in turn and reading its `/mcp`.
 */
export interface ServerStanding extends NamedServer {
	readonly agents: readonly string[];
	/** Whether an account was opened for it, for the servers that answer nothing without one. */
	readonly loggedIn: boolean;
}

/**
 * A name the model can spell, which is narrower than a name the operator can type.
 *
 * Every tool a server brings is offered as `<name>_<tool>`, so the name lands in the middle of an
 * identifier the model has to produce exactly. No underscore, so that separator stays the one thing
 * it is; nothing long, because it is paid for in the prompt once per tool.
 */
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A server read off a line, or the reason the line was not one. */
export type ReadServer = { readonly server: McpServer } | { readonly refused: string };

export function readName(name: string): string | undefined {
	return NAME.test(name) ? undefined : `"${name}" is not a name: lowercase letters, digits and -.`;
}

/**
 * A server as an operator types one, which is the shape of the thing rather than a form to fill in.
 *
 * A URL is a URL wherever it appears, so the common case needs no keyword at all, and anything that
 * is not one is the command to run. The keyword exists for the one thing a line cannot show by
 * itself: which of the two remote transports a URL is for, since they look identical written down.
 */
export function readServer(words: readonly string[]): ReadServer {
	const [first = "", ...rest] = words;
	if (first === "") {
		return { refused: "A server needs a URL to reach it at, or a command to start it with." };
	}

	if (first === "http" || first === "sse") {
		const [url = "", ...extra] = rest;
		if (extra.length > 0) return { refused: `"${first}" takes a URL and nothing after it.` };
		return remote(first, url);
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(first)) return remote("http", first);

	return { server: { transport: "stdio", command: first, args: rest } };
}

function remote(transport: "http" | "sse", url: string): ReadServer {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { refused: `"${url}" is not a URL.` };
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { refused: `"${url}" is not http or https, which are the two the proxy carries.` };
	}
	return { server: { transport, url } };
}

/** Where a server is reached, or nothing for one that is a process rather than a place. */
export function hostOf(server: McpServer): string | undefined {
	if (server.transport === "stdio") return undefined;
	try {
		return new URL(server.url).hostname;
	} catch {
		return undefined;
	}
}

/** A server as it reads back to whoever added it, short enough to sit in a list of them. */
export function written(server: McpServer): string {
	return server.transport === "stdio"
		? [server.command, ...server.args].join(" ")
		: `${server.transport === "sse" ? "sse " : ""}${server.url}`;
}

interface Shelf {
	readonly servers: Record<string, McpServer>;
	/** Agent id to the names it has been given. Names, not copies: forgetting one forgets it here too. */
	readonly attached: Record<string, string[]>;
}

/**
 * The servers the plane knows of, and which agents were given which.
 *
 * Kept apart from the agents on purpose. A server is a thing an operator went and found — a URL, a
 * command, the reading of somebody's README — and having done that once for one agent, doing it
 * again for the next is work the plane can remember instead. So adding is separate from attaching,
 * and the second agent needs only the name.
 *
 * Not the operator's config file, which is the operator's and which nothing here may write.
 */
export class McpShelf {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** Everything there is to attach, in the order it reads best: by name. */
	async servers(): Promise<readonly NamedServer[]> {
		const shelf = await this.#serialize(() => this.#read());
		return Object.entries(shelf.servers)
			.map(([name, server]) => ({ name, server }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Everything on the shelf with the agents holding each, which is one read rather than one per. */
	async holding(): Promise<readonly (NamedServer & { readonly agents: readonly string[] })[]> {
		const shelf = await this.#serialize(() => this.#read());
		return Object.entries(shelf.servers)
			.map(([name, server]) => ({
				name,
				server,
				agents: Object.entries(shelf.attached)
					.filter(([, names]) => names.includes(name))
					.map(([agentId]) => agentId)
					.sort((a, b) => a.localeCompare(b)),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async attached(agentId: string): Promise<readonly NamedServer[]> {
		const shelf = await this.#serialize(() => this.#read());
		return (shelf.attached[agentId] ?? [])
			.flatMap((name) => {
				const server = shelf.servers[name];
				return server === undefined ? [] : [{ name, server }];
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Puts a server on the shelf under a name, replacing whatever was there under it. */
	async add(name: string, server: McpServer): Promise<void> {
		await this.#change((shelf) => {
			shelf.servers[name] = server;
		});
	}

	async attach(agentId: string, name: string): Promise<void> {
		await this.#change((shelf) => {
			const has = shelf.attached[agentId] ?? [];
			if (!has.includes(name)) shelf.attached[agentId] = [...has, name];
		});
	}

	async detach(agentId: string, name: string): Promise<void> {
		await this.#change((shelf) => {
			shelf.attached[agentId] = (shelf.attached[agentId] ?? []).filter((held) => held !== name);
		});
	}

	/**
	 * Takes a server off the shelf, and off every agent holding it.
	 *
	 * Both together, because an attachment naming a server that is gone is not an attachment: the
	 * agent would go on listing something it cannot reach, and nobody would know where to take it off.
	 */
	async forget(name: string): Promise<void> {
		await this.#change((shelf) => {
			delete shelf.servers[name];
			for (const [agentId, names] of Object.entries(shelf.attached)) {
				shelf.attached[agentId] = names.filter((held) => held !== name);
			}
		});
	}

	/** Everything an agent held, for when the agent itself is gone. */
	async forgetAgent(agentId: string): Promise<void> {
		await this.#change((shelf) => {
			delete shelf.attached[agentId];
		});
	}

	async #change(edit: (shelf: Shelf) => void): Promise<void> {
		await this.#serialize(async () => {
			const shelf = await this.#read();
			edit(shelf);
			await this.#write(shelf);
		});
	}

	async #read(): Promise<Shelf> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return { servers: {}, attached: {} };
			}
			const { servers, attached } = parsed as Partial<Shelf>;
			return { servers: servers ?? {}, attached: attached ?? {} };
		} catch {
			return { servers: {}, attached: {} };
		}
	}

	async #write(shelf: Shelf): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the shelf it had rather
		// than half of one, which reads as an operator's whole afternoon of setting this up undone.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(shelf, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	// Read-modify-write is not atomic, and every agent on the plane shares this object.
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
