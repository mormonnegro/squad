import { describe, expect, it } from "vitest";
import { type Grant, GrantSet, normalizeHost, normalizePath } from "../src/grants.ts";

const bearer = (ref: string) => ({ kind: "bearer", token: { ref } }) as const;

describe("normalizeHost", () => {
	it("strips port, case and trailing dot", () => {
		expect(normalizeHost("API.GitHub.com:443")).toBe("api.github.com");
		expect(normalizeHost("api.github.com.")).toBe("api.github.com");
	});
});

describe("normalizePath", () => {
	it("resolves traversal segments", () => {
		expect(normalizePath("/repos/../admin")).toBe("/admin");
		expect(normalizePath("/repos/./foo")).toBe("/repos/foo");
		expect(normalizePath("/repos//foo")).toBe("/repos/foo");
	});

	it("resolves percent-encoded traversal", () => {
		expect(normalizePath("/repos/%2e%2e/admin")).toBe("/admin");
		expect(normalizePath("/repos/%252e%252e/admin")).toBe("/admin");
	});

	it("drops the query string", () => {
		expect(normalizePath("/repos/foo?a=1#x")).toBe("/repos/foo");
	});
});

describe("GrantSet host matching", () => {
	const grants = new GrantSet([
		{ id: "gh", host: "api.github.com", injection: bearer("GH") },
		{ id: "slack", host: "*.slack.com", injection: bearer("SLACK") },
	]);

	it("matches exact hosts", () => {
		expect(grants.allowsHost("api.github.com")).toBe(true);
		expect(grants.allowsHost("github.com")).toBe(false);
	});

	it("matches a single wildcard label only", () => {
		expect(grants.allowsHost("hooks.slack.com")).toBe(true);
		expect(grants.allowsHost("a.b.slack.com")).toBe(false);
		expect(grants.allowsHost("slack.com")).toBe(false);
	});

	it("does not match a suffix that is not a label boundary", () => {
		expect(grants.allowsHost("evilslack.com")).toBe(false);
		expect(grants.allowsHost("api.github.com.evil.com")).toBe(false);
	});

	it("denies unknown hosts by default", () => {
		expect(grants.resolve({ host: "evil.com", method: "GET", path: "/" })).toEqual({
			allow: false,
			reason: "no_matching_host",
		});
	});
});

describe("GrantSet path scoping", () => {
	const grants = new GrantSet([
		{ id: "repos", host: "api.github.com", pathPrefix: "/repos", injection: bearer("GH") },
	]);

	it("allows paths at or below the prefix", () => {
		expect(grants.resolve({ host: "api.github.com", method: "GET", path: "/repos" }).allow).toBe(true);
		expect(grants.resolve({ host: "api.github.com", method: "GET", path: "/repos/a/b" }).allow).toBe(true);
	});

	it("denies sibling paths that share a string prefix", () => {
		const decision = grants.resolve({ host: "api.github.com", method: "GET", path: "/repositories" });
		expect(decision).toEqual({ allow: false, reason: "path_not_granted" });
	});

	it("cannot be escaped with traversal", () => {
		const decision = grants.resolve({ host: "api.github.com", method: "GET", path: "/repos/../user/keys" });
		expect(decision).toEqual({ allow: false, reason: "path_not_granted" });
	});

	it("cannot be escaped with encoded traversal", () => {
		const decision = grants.resolve({ host: "api.github.com", method: "GET", path: "/repos/%2e%2e/user/keys" });
		expect(decision).toEqual({ allow: false, reason: "path_not_granted" });
	});
});

describe("GrantSet method scoping", () => {
	const grants = new GrantSet([
		{ id: "ro", host: "api.github.com", methods: ["GET", "HEAD"], injection: bearer("GH") },
	]);

	it("allows granted methods case-insensitively", () => {
		expect(grants.resolve({ host: "api.github.com", method: "get", path: "/x" }).allow).toBe(true);
	});

	it("denies ungranted methods", () => {
		expect(grants.resolve({ host: "api.github.com", method: "DELETE", path: "/x" })).toEqual({
			allow: false,
			reason: "method_not_granted",
		});
	});
});

describe("GrantSet specificity", () => {
	const broad: Grant = { id: "broad", host: "api.github.com", injection: bearer("READ_ONLY") };
	const narrow: Grant = {
		id: "narrow",
		host: "api.github.com",
		pathPrefix: "/repos/acme",
		injection: bearer("WRITE"),
	};

	it("picks the most specific grant regardless of declaration order", () => {
		for (const grants of [new GrantSet([broad, narrow]), new GrantSet([narrow, broad])]) {
			const decision = grants.resolve({ host: "api.github.com", method: "GET", path: "/repos/acme/x" });
			expect(decision.allow && decision.grant.id).toBe("narrow");
		}
	});

	it("falls back to the broad grant elsewhere", () => {
		const grants = new GrantSet([broad, narrow]);
		const decision = grants.resolve({ host: "api.github.com", method: "GET", path: "/user" });
		expect(decision.allow && decision.grant.id).toBe("broad");
	});
});
