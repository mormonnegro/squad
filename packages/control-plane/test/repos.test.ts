import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkRepo,
	HeldRepos,
	looksLikeGithubToken,
	readPush,
	readRepo,
	repoGrants,
	reposPrompt,
	standingOf,
} from "../src/repos.ts";

describe("readRepo", () => {
	it("takes owner/name as typed", () => {
		expect(readRepo("acme/website")).toEqual({ repo: "acme/website" });
		expect(readRepo("  acme/web.site  ")).toEqual({ repo: "acme/web.site" });
	});

	// The clone box offers three spellings and a hand pastes whichever it was looking at.
	it("takes every spelling the clone box offers", () => {
		for (const said of [
			"https://github.com/acme/website",
			"https://github.com/acme/website.git",
			"https://github.com/acme/website/tree/main/src",
			"https://www.github.com/acme/website",
			"github.com/acme/website",
			"git@github.com:acme/website.git",
			"acme/website.git",
		]) {
			expect(readRepo(said)).toEqual({ repo: "acme/website" });
		}
	});

	it("refuses a host that is not GitHub, by name", () => {
		const read = readRepo("https://gitlab.com/acme/website");
		expect(read).toHaveProperty("refused");
		expect((read as { refused: string }).refused).toContain("gitlab.com");
	});

	it("says what it takes when given nothing, or half of one", () => {
		expect(readRepo("")).toEqual({ refused: "a repository, like acme/website" });
		expect(readRepo("acme")).toHaveProperty("refused");
		expect(readRepo("acme/")).toHaveProperty("refused");
		expect(readRepo("/website")).toHaveProperty("refused");
		expect(readRepo("acme website")).toHaveProperty("refused");
	});
});

describe("readPush", () => {
	it("takes branch patterns, with or without the refs/heads/ in front", () => {
		expect(readPush(["scout/*", "refs/heads/fix/*", "release-1.2", "*"])).toEqual({
			push: ["scout/*", "fix/*", "release-1.2", "*"],
		});
	});

	it("refuses what git would not have as a ref", () => {
		for (const bad of ["a..b", "-x", "/x", "x/", "x.lock", "a b", "ma^in"]) {
			expect(readPush([bad])).toHaveProperty("refused");
		}
	});
});

describe("repoGrants", () => {
	const grants = repoGrants("scout", { repo: "acme/website" });

	it("grants the repository with the agent's own lane to push, and the token it never sees", () => {
		expect(grants[0]).toEqual({
			id: "repo:acme/website",
			host: "github.com",
			pathPrefix: "/acme/website",
			injection: {
				kind: "basic",
				username: { literal: "x-access-token" },
				password: { ref: "GITHUB_TOKEN" },
			},
			git: { push: ["scout/*"] },
		});
	});

	// The API is where a branch scope could be walked around, so writing there is pull requests only.
	it("grants the API for reading, and for pull requests alone for writing", () => {
		expect(grants.slice(1)).toEqual([
			{
				id: "repo:acme/website:api",
				host: "api.github.com",
				pathPrefix: "/repos/acme/website",
				methods: ["GET"],
				injection: { kind: "bearer", token: { ref: "GITHUB_TOKEN" } },
			},
			{
				id: "repo:acme/website:pulls",
				host: "api.github.com",
				pathPrefix: "/repos/acme/website/pulls",
				methods: ["GET", "POST", "PATCH"],
				injection: { kind: "bearer", token: { ref: "GITHUB_TOKEN" } },
			},
		]);
	});

	it("pushes where it was told to when it was told", () => {
		const [own] = repoGrants("scout", { repo: "acme/website", push: ["fix/*", "docs"] });
		expect(own?.git).toEqual({ push: ["fix/*", "docs"] });
	});

	it("stands as what the console shows", () => {
		expect(standingOf("scout", { repo: "acme/website" }, "here")).toEqual({
			repo: "acme/website",
			url: "https://github.com/acme/website",
			push: ["scout/*"],
			origin: "here",
		});
	});
});

describe("looksLikeGithubToken", () => {
	it("knows the shapes GitHub issues and nothing else", () => {
		expect(looksLikeGithubToken(`ghp_${"a".repeat(36)}`)).toBe(true);
		expect(looksLikeGithubToken(`github_pat_${"A1_".repeat(30)}`)).toBe(true);
		expect(looksLikeGithubToken(`ghs_${"x".repeat(40)}`)).toBe(true);
		expect(looksLikeGithubToken("acme/website")).toBe(false);
		expect(looksLikeGithubToken("ghp_short")).toBe(false);
	});
});

describe("checkRepo", () => {
	const answering =
		(status: number, body: unknown = {}) =>
		async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://api.github.com/repos/acme/website");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghp_x");
			return new Response(JSON.stringify(body), { status });
		};

	it("reads whether the token may push, and the default branch", async () => {
		const ok = await checkRepo(
			"acme/website",
			"ghp_x",
			answering(200, { permissions: { push: true }, default_branch: "trunk" }),
		);
		expect(ok).toEqual({ kind: "ok", push: true, defaultBranch: "trunk" });
		const readOnly = await checkRepo("acme/website", "ghp_x", answering(200, { permissions: {} }));
		expect(readOnly).toEqual({ kind: "ok", push: false, defaultBranch: "main" });
	});

	it("says what GitHub said, in words that point at the fix", async () => {
		expect(await checkRepo("acme/website", "ghp_x", answering(401))).toEqual({
			kind: "refused",
			why: "GitHub does not know this token",
		});
		const missing = await checkRepo("acme/website", "ghp_x", answering(404));
		expect(missing.kind).toBe("refused");
		expect((missing as { why: string }).why).toContain("was not given it");
		expect(await checkRepo("acme/website", "ghp_x", answering(500))).toEqual({
			kind: "refused",
			why: "GitHub answered 500 for acme/website",
		});
	});

	it("says so when GitHub could not be reached at all", async () => {
		const down = await checkRepo("acme/website", "ghp_x", async () => {
			throw new Error("getaddrinfo ENOTFOUND api.github.com");
		});
		expect(down).toEqual({
			kind: "refused",
			why: "GitHub could not be reached: getaddrinfo ENOTFOUND api.github.com",
		});
	});
});

describe("reposPrompt", () => {
	it("is nothing at all when the agent holds nothing", () => {
		expect(reposPrompt([], "/home/agent/workspace")).toBeUndefined();
	});

	it("names each repository, where it goes, and what may be pushed", () => {
		const said = reposPrompt(
			[
				{
					repo: "acme/website",
					url: "https://github.com/acme/website",
					push: ["scout/*"],
					origin: "here",
				},
				{
					repo: "acme/api",
					url: "https://github.com/acme/api",
					push: ["fix/*", "docs"],
					origin: "file",
				},
			],
			"/home/agent/workspace",
		);
		expect(said).toContain(
			"https://github.com/acme/website, checked out under /home/agent/workspace/website",
		);
		expect(said).toContain("push to scout/* and to nothing else");
		expect(said).toContain("push to fix/*, docs and to nothing else");
		expect(said).toContain("pull request");
	});
});

describe("HeldRepos", () => {
	it("holds per agent, replaces by name, and drops by name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "squad-repos-"));
		const held = new HeldRepos(join(dir, "repos.json"));

		expect(await held.of("scout")).toEqual([]);
		await held.hold("scout", { repo: "acme/website" });
		await held.hold("scout", { repo: "acme/api", push: ["*"] });
		await held.hold("other", { repo: "acme/website", push: ["other/*"] });
		expect(await held.of("scout")).toEqual([
			{ repo: "acme/website" },
			{ repo: "acme/api", push: ["*"] },
		]);

		// A second hold of the same name is a change to it, not a second row.
		await held.hold("scout", { repo: "acme/website", push: ["scout/*", "fix/*"] });
		expect(await held.of("scout")).toEqual([
			{ repo: "acme/api", push: ["*"] },
			{ repo: "acme/website", push: ["scout/*", "fix/*"] },
		]);

		expect(await held.drop("scout", "acme/api")).toBe(true);
		expect(await held.drop("scout", "acme/api")).toBe(false);
		expect(await held.of("scout")).toEqual([{ repo: "acme/website", push: ["scout/*", "fix/*"] }]);
		expect(await held.of("other")).toEqual([{ repo: "acme/website", push: ["other/*"] }]);

		// Nothing secret is written: the file is what the token is spent on, never the token.
		expect(await readFile(join(dir, "repos.json"), "utf8")).not.toContain("ghp_");
	});

	it("reads a file that is not there, or not its shape, as nothing held", async () => {
		const dir = await mkdtemp(join(tmpdir(), "squad-repos-"));
		expect(await new HeldRepos(join(dir, "missing.json")).of("scout")).toEqual([]);
	});
});
