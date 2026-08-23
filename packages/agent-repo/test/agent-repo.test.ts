import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestError, parseManifest } from "../src/manifest.ts";
import { AgentRepoError, initAgentRepo, loadAgentRepo, MANIFEST_FILE } from "../src/repo.ts";

describe("parseManifest", () => {
	it("parses a minimal manifest", () => {
		const manifest = parseManifest("name: emma\n");
		expect(manifest).toEqual({ name: "emma", requests: [] });
	});

	it("normalizes request hosts and methods", () => {
		const manifest = parseManifest(`
name: emma
requests:
  - host: API.GitHub.com
    pathPrefix: /repos
    methods: [get, post]
    reason: read issue threads
`);
		expect(manifest.requests[0]).toEqual({
			host: "api.github.com",
			pathPrefix: "/repos",
			methods: ["GET", "POST"],
			reason: "read issue threads",
		});
	});

	it("rejects a name that is not a slug", () => {
		expect(() => parseManifest("name: Emma The Agent\n")).toThrow(ManifestError);
	});

	it("requires a name", () => {
		expect(() => parseManifest("description: no name here\n")).toThrow(ManifestError);
	});

	it("rejects a pathPrefix that is not absolute", () => {
		expect(() =>
			parseManifest("name: emma\nrequests:\n  - host: a.com\n    pathPrefix: repos\n"),
		).toThrow(ManifestError);
	});

	it("rejects unknown methods", () => {
		expect(() =>
			parseManifest("name: emma\nrequests:\n  - host: a.com\n    methods: [YEET]\n"),
		).toThrow(ManifestError);
	});

	it("reports every issue at once", () => {
		try {
			parseManifest("name: Bad Name\ndescription: 12\nmodel: 7\n");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ManifestError);
			expect((error as ManifestError).issues).toHaveLength(3);
		}
	});

	it("rejects a non-mapping document", () => {
		expect(() => parseManifest("- just\n- a list\n")).toThrow(ManifestError);
	});
});

describe("agent repository", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agent-dive-repo-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("scaffolds a repository that loads back", async () => {
		const created = await initAgentRepo(root, {
			name: "emma",
			description: "Customer support agent",
			model: "anthropic/claude-opus-4-7",
		});

		expect(created.manifest.name).toBe("emma");
		expect(created.manifest.model).toBe("anthropic/claude-opus-4-7");
		expect(created.soul).toContain("emma");

		const reloaded = await loadAgentRepo(root);
		expect(reloaded.manifest).toEqual(created.manifest);
	});

	it("scaffolds with no capability requests, so a new agent can reach nothing", async () => {
		const created = await initAgentRepo(root, { name: "emma" });
		expect(created.manifest.requests).toEqual([]);
	});

	it("writes a manifest that documents requests as unapproved", async () => {
		await initAgentRepo(root, { name: "emma" });
		const source = await readFile(join(root, MANIFEST_FILE), "utf8");
		expect(source).toContain("requests, not grants");
	});

	it("treats a missing soul.md as empty rather than failing", async () => {
		await writeFile(join(root, MANIFEST_FILE), "name: emma\n", "utf8");
		const definition = await loadAgentRepo(root);
		expect(definition.soul).toBe("");
	});

	it("fails when the manifest is absent", async () => {
		await expect(loadAgentRepo(root)).rejects.toBeInstanceOf(AgentRepoError);
	});

	it("surfaces the manifest path when the manifest is invalid", async () => {
		await writeFile(join(root, MANIFEST_FILE), "name: NOT A SLUG\n", "utf8");
		await expect(loadAgentRepo(root)).rejects.toThrow(MANIFEST_FILE);
	});
});
