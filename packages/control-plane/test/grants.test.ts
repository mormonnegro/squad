import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AddedGrants, carriedBy, originOf, reachGrant, reachId, readHost } from "../src/grants.ts";

/** What `readHost` said, flattened, so a test reads as the one word it cares about. */
function host(said: string): string | undefined {
	const read = readHost(said);
	return "host" in read ? read.host : undefined;
}

function refusal(said: string): string | undefined {
	const read = readHost(said);
	return "refused" in read ? read.refused : undefined;
}

describe("readHost", () => {
	it("takes a host typed as a host", () => {
		expect(host("api.chess.com")).toBe("api.chess.com");
	});

	/**
	 * The failure this exists for: an agent is refused at `https://api.chess.com/pub/player/x`, and the
	 * person who saw that pastes back the thing they were looking at. Reading it is a line of code.
	 */
	it("takes the host out of a URL, because a URL is what a refusal shows", () => {
		expect(host("https://api.chess.com/pub/player/x?full=1#top")).toBe("api.chess.com");
	});

	it("drops the port, the trailing dot, and the credentials a URL can carry", () => {
		expect(host("http://someone:secret@API.Chess.com.:8443/")).toBe("api.chess.com");
	});

	it("takes a wildcard for one label, and the star that stands for the web", () => {
		expect(host("*.chess.com")).toBe("*.chess.com");
		expect(host("*")).toBe("*");
	});

	it("asks for a host rather than refusing an empty line", () => {
		expect(refusal("   ")).toContain("a host to allow");
	});

	// A sentence typed into the box is a person answering a different question, and telling them a
	// host is one word is more use than telling them the regular expression it failed.
	it("says a host is one word when more than one was typed", () => {
		expect(refusal("api.chess.com and the rest")).toContain("more than one word");
	});

	it("refuses what is not a host, with the shapes that would have worked", () => {
		expect(refusal("chess!")).toContain("try api.chess.com, *.chess.com, or *");
	});

	// A star in the middle looks like it matches something and matches nothing, which is the worst of
	// the two: a grant that is on the screen and never applies.
	it("refuses a wildcard anywhere but its own label at the front", () => {
		expect(refusal("api.*.com")).toContain("*.chess.com");
		expect(refusal("*chess.com")).toContain("*.chess.com");
	});
});

describe("reachGrant", () => {
	/**
	 * The whole of why the console is allowed to write grants at all. A grant is somewhere to go and
	 * something to go with, and only the second half was ever dangerous.
	 */
	it("opens a host and carries nothing to it", () => {
		expect(reachGrant("api.chess.com")).toEqual({
			id: "reach:api.chess.com",
			host: "api.chess.com",
			injection: { kind: "none" },
		});
	});

	it("namespaces its id, so nothing typed here lands on a derived one", () => {
		expect(reachId("api.chess.com")).toBe("reach:api.chess.com");
	});
});

describe("originOf", () => {
	// One of these rows is changed by editing the file, another by opening the section above it. The
	// id is the only thing that tells them apart by the time the screen asks.
	it("tells a grant the file declares from one a model or a search brought", () => {
		expect(originOf("model:sonnet")).toBe("model");
		expect(originOf("search:brave")).toBe("search");
		expect(originOf("company-api")).toBe("file");
	});

	// A `reach:` id in the defaults came out of the file, whatever this console would have written.
	// Calling it ours would put a ⌫ on a row that has nothing here to take back.
	it("leaves a reach id declared in the file to the file", () => {
		expect(originOf("reach:api.chess.com")).toBe("file");
	});
});

describe("carriedBy", () => {
	it("names the secret rather than counting it, because the rest of the console names it", () => {
		expect(carriedBy({ kind: "bearer", token: { ref: "ANTHROPIC_API_KEY" } })).toBe(
			"ANTHROPIC_API_KEY",
		);
		expect(carriedBy({ kind: "header", name: "x-api-key", value: { ref: "BRAVE_API_KEY" } })).toBe(
			"BRAVE_API_KEY",
		);
		expect(
			carriedBy({
				kind: "basic",
				username: { ref: "MAIL_USER" },
				password: { ref: "MAIL_PASSWORD" },
			}),
		).toBe("MAIL_USER MAIL_PASSWORD");
	});

	it("says nothing rides along when nothing does", () => {
		expect(carriedBy({ kind: "none" })).toBeUndefined();
	});
});

describe("AddedGrants", () => {
	let dir = "";
	let added: AddedGrants;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "grants-"));
		added = new AddedGrants(join(dir, "added-grants.json"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("opens nothing until somebody opens something", async () => {
		expect(await added.hosts()).toEqual([]);
	});

	it("keeps a host that was opened here", async () => {
		await added.add("api.chess.com");

		expect(await added.hosts()).toEqual(["api.chess.com"]);
	});

	it("hands them out as grants that carry nothing", async () => {
		await added.add("api.chess.com");

		expect(await added.all()).toEqual([reachGrant("api.chess.com")]);
	});

	it("holds one host once, however many times it is opened", async () => {
		await added.add("api.chess.com");
		await added.add("api.chess.com");

		expect(await added.hosts()).toEqual(["api.chess.com"]);
	});

	/**
	 * A store that could hold a credential is a store somebody would put one in. Hosts are all there
	 * is to keep, so hosts are all the file has room for.
	 */
	it("writes hosts, with nowhere on the disk to put a key", async () => {
		await added.add("api.chess.com");

		expect(JSON.parse(await readFile(join(dir, "added-grants.json"), "utf8"))).toEqual([
			"api.chess.com",
		]);
	});

	it("closes a host, and says there was one to close", async () => {
		await added.add("api.chess.com");

		expect(await added.drop("api.chess.com")).toBe(true);
		expect(await added.hosts()).toEqual([]);
	});

	// The console shows the answer, so a typo and a host that is already gone have to look different.
	it("says nothing was closed when the host was never open", async () => {
		expect(await added.drop("api.chess.com")).toBe(false);
	});

	// A plane restarts more often than a host stops being wanted, so hosts kept in memory would put
	// every agent back behind the file's grants at the next deploy.
	it("survives the plane it was opened on", async () => {
		await added.add("api.chess.com");

		expect(await new AddedGrants(join(dir, "added-grants.json")).hosts()).toEqual([
			"api.chess.com",
		]);
	});

	// Read-modify-write is not atomic, and two hosts opened at once would otherwise leave whichever
	// wrote last as the only one that happened.
	it("keeps hosts opened at the same moment", async () => {
		await Promise.all([added.add("api.chess.com"), added.add("api.github.com")]);

		expect([...(await added.hosts())].sort()).toEqual(["api.chess.com", "api.github.com"]);
	});

	// The file is beside the operator's config, where a hand can reach it. Refusing to start over a
	// line somebody mistyped there would cost more than ignoring it.
	it("opens nothing rather than failing on a file that is not a list of hosts", async () => {
		await writeFile(join(dir, "added-grants.json"), "{ not json at all", "utf8");

		expect(await added.hosts()).toEqual([]);
	});
});
