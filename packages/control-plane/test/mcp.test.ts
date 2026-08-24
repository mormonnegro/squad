import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostOf, McpShelf, readName, readServer, written } from "../src/mcp.ts";

let dir = "";
let shelf: McpShelf;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mcp-"));
	shelf = new McpShelf(join(dir, "mcp.json"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** The one place the operator's words become a thing, so every way of saying it has to land. */
describe("readServer", () => {
	it("takes a URL as the remote server it plainly is", () => {
		expect(readServer(["https://mcp.linear.app/mcp"])).toEqual({
			server: { transport: "http", url: "https://mcp.linear.app/mcp" },
		});
	});

	/**
	 * The two remote transports are written down identically, so this is the one thing about a server
	 * a line cannot show by itself and the one place a keyword earns its keep.
	 */
	it("takes the older transport when it is named, since a URL cannot say which it is", () => {
		expect(readServer(["sse", "https://example.com/sse"])).toEqual({
			server: { transport: "sse", url: "https://example.com/sse" },
		});
		expect(readServer(["http", "https://example.com/mcp"])).toEqual({
			server: { transport: "http", url: "https://example.com/mcp" },
		});
	});

	it("takes anything that is not a URL as the command to start one with", () => {
		expect(
			readServer(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/agent"]),
		).toEqual({
			server: {
				transport: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/agent"],
			},
		});
	});

	// A bare command is a server too: plenty of them take their configuration from where they are run.
	it("takes a command with nothing after it", () => {
		expect(readServer(["mcp-server-git"])).toEqual({
			server: { transport: "stdio", command: "mcp-server-git", args: [] },
		});
	});

	it("says what is missing rather than storing half a server", () => {
		expect(readServer([])).toEqual({
			refused: "A server needs a URL to reach it at, or a command to start it with.",
		});
		expect(readServer(["sse", "not a url"])).toEqual({ refused: '"not a url" is not a URL.' });
		expect(readServer(["http"])).toEqual({ refused: '"" is not a URL.' });
	});

	// Named, so the words after it are the operator meaning something this cannot do — not arguments.
	it("does not quietly drop what follows a URL it was given a keyword for", () => {
		expect(readServer(["http", "https://example.com/mcp", "--flag"])).toEqual({
			refused: '"http" takes a URL and nothing after it.',
		});
	});

	/** The sandbox reaches the world down one road, and the proxy is a proxy for two protocols. */
	it("refuses a scheme the proxy has no way to carry", () => {
		expect(readServer(["ws://example.com/mcp"])).toEqual({
			refused: '"ws://example.com/mcp" is not http or https, which are the two the proxy carries.',
		});
	});
});

/**
 * The name is not decoration: it is spliced into every tool name the model is offered, so a name it
 * cannot spell is a set of tools it cannot call.
 */
describe("readName", () => {
	it("passes a name that can sit inside an identifier", () => {
		expect(readName("linear")).toBeUndefined();
		expect(readName("server-2")).toBeUndefined();
	});

	it("refuses one that cannot", () => {
		// The separator between the server and its tool. A name carrying one makes the split ambiguous.
		expect(readName("my_server")).toContain("not a name");
		expect(readName("Linear")).toContain("not a name");
		expect(readName("2fast")).toContain("not a name");
		expect(readName("a".repeat(33))).toContain("not a name");
	});
});

describe("hostOf", () => {
	it("is the host a remote server is reached at, which is what a grant is about", () => {
		expect(hostOf({ transport: "http", url: "https://mcp.linear.app/mcp" })).toBe("mcp.linear.app");
	});

	// Nothing to grant: it never leaves the sandbox on its own account, and what it does leave for is
	// the sandbox's own road out.
	it("is nothing for a server that is a process rather than a place", () => {
		expect(hostOf({ transport: "stdio", command: "npx", args: [] })).toBeUndefined();
	});
});

describe("written", () => {
	it("reads a remote server back as the URL it was given", () => {
		expect(written({ transport: "http", url: "https://x.dev/mcp" })).toBe("https://x.dev/mcp");
		expect(written({ transport: "sse", url: "https://x.dev/sse" })).toBe("sse https://x.dev/sse");
	});

	it("reads a local one back as the line that starts it", () => {
		expect(written({ transport: "stdio", command: "npx", args: ["-y", "thing"] })).toBe(
			"npx -y thing",
		);
	});
});

describe("McpShelf", () => {
	const linear = { transport: "http", url: "https://mcp.linear.app/mcp" } as const;
	const files = { transport: "stdio", command: "mcp-files", args: ["/tmp"] } as const;

	it("has nothing on it, and no agent holding anything, to begin with", async () => {
		expect(await shelf.servers()).toEqual([]);
		expect(await shelf.attached("scout")).toEqual([]);
	});

	/** The whole point: found once, and from then on the next agent needs only the name. */
	it("keeps a server past the agent it was added for", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");
		await shelf.attach("scribe", "linear");

		expect(await shelf.attached("scribe")).toEqual([{ name: "linear", server: linear }]);
	});

	it("holds a server for the agents given it and not for the others", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");

		expect(await shelf.servers()).toEqual([{ name: "linear", server: linear }]);
		expect(await shelf.attached("scribe")).toEqual([]);
	});

	// A line typed twice is a line typed twice, not two of the same server on one agent.
	it("does not give an agent the same server twice", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");
		await shelf.attach("scout", "linear");

		expect(await shelf.attached("scout")).toHaveLength(1);
	});

	it("takes one off an agent without taking it off the shelf", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");
		await shelf.detach("scout", "linear");

		expect(await shelf.attached("scout")).toEqual([]);
		expect(await shelf.servers()).toHaveLength(1);
	});

	/**
	 * Both at once. An attachment naming a server that is gone is not an attachment: the agent would
	 * go on listing something nothing can reach, and there would be nowhere to take it off.
	 */
	it("takes a forgotten server off every agent holding it", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");
		await shelf.attach("scribe", "linear");
		await shelf.forget("linear");

		expect(await shelf.servers()).toEqual([]);
		expect(await shelf.attached("scout")).toEqual([]);
		expect(await shelf.attached("scribe")).toEqual([]);
	});

	it("re-adding a name replaces what was under it, for everyone holding it", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");
		await shelf.add("linear", files);

		expect(await shelf.attached("scout")).toEqual([{ name: "linear", server: files }]);
	});

	it("lets an agent go, and what it was holding with it", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");
		await shelf.forgetAgent("scout");

		expect(await shelf.attached("scout")).toEqual([]);
		expect(await shelf.servers()).toHaveLength(1);
	});

	// An operator sets this up once and expects to find it there. It is the reason it is on disk.
	it("is still there for a plane that has been restarted", async () => {
		await shelf.add("linear", linear);
		await shelf.attach("scout", "linear");

		const restarted = new McpShelf(join(dir, "mcp.json"));

		expect(await restarted.attached("scout")).toEqual([{ name: "linear", server: linear }]);
	});

	it("survives a file that is not one, rather than taking the plane down with it", async () => {
		const missing = new McpShelf(join(dir, "nowhere", "mcp.json"));

		expect(await missing.servers()).toEqual([]);
		await missing.add("linear", linear);
		expect(await missing.servers()).toHaveLength(1);
	});

	// Every agent on the plane shares this one object, and read-modify-write is not atomic.
	it("does not lose one of two servers added at the same moment", async () => {
		await Promise.all([shelf.add("linear", linear), shelf.add("files", files)]);

		expect((await shelf.servers()).map((each) => each.name)).toEqual(["files", "linear"]);
	});
});
