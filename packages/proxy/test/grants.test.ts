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
		{
			id: "repos",
			host: "api.github.com",
			pathPrefix: "/repos",
			injection: bearer("GH"),
		},
	]);

	it("allows paths at or below the prefix", () => {
		expect(grants.resolve({ host: "api.github.com", method: "GET", path: "/repos" }).allow).toBe(
			true,
		);
		expect(
			grants.resolve({
				host: "api.github.com",
				method: "GET",
				path: "/repos/a/b",
			}).allow,
		).toBe(true);
	});

	it("denies sibling paths that share a string prefix", () => {
		const decision = grants.resolve({
			host: "api.github.com",
			method: "GET",
			path: "/repositories",
		});
		expect(decision).toEqual({ allow: false, reason: "path_not_granted" });
	});

	it("cannot be escaped with traversal", () => {
		const decision = grants.resolve({
			host: "api.github.com",
			method: "GET",
			path: "/repos/../user/keys",
		});
		expect(decision).toEqual({ allow: false, reason: "path_not_granted" });
	});

	it("cannot be escaped with encoded traversal", () => {
		const decision = grants.resolve({
			host: "api.github.com",
			method: "GET",
			path: "/repos/%2e%2e/user/keys",
		});
		expect(decision).toEqual({ allow: false, reason: "path_not_granted" });
	});
});

describe("GrantSet method scoping", () => {
	const grants = new GrantSet([
		{
			id: "ro",
			host: "api.github.com",
			methods: ["GET", "HEAD"],
			injection: bearer("GH"),
		},
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
	const broad: Grant = {
		id: "broad",
		host: "api.github.com",
		injection: bearer("READ_ONLY"),
	};
	const narrow: Grant = {
		id: "narrow",
		host: "api.github.com",
		pathPrefix: "/repos/acme",
		injection: bearer("WRITE"),
	};

	it("picks the most specific grant regardless of declaration order", () => {
		for (const grants of [new GrantSet([broad, narrow]), new GrantSet([narrow, broad])]) {
			const decision = grants.resolve({
				host: "api.github.com",
				method: "GET",
				path: "/repos/acme/x",
			});
			expect(decision.allow && decision.grant.id).toBe("narrow");
		}
	});

	it("falls back to the broad grant elsewhere", () => {
		const grants = new GrantSet([broad, narrow]);
		const decision = grants.resolve({
			host: "api.github.com",
			method: "GET",
			path: "/user",
		});
		expect(decision.allow && decision.grant.id).toBe("broad");
	});
});

describe("a grant on every host", () => {
	const web: Grant = { id: "web", host: "*", injection: { kind: "none" } };
	const model: Grant = { id: "model", host: "api.deepseek.com", injection: bearer("KEY") };

	it("is a way to anywhere that was not named", () => {
		const grants = new GrantSet([web]);
		expect(grants.allowsHost("registry.npmjs.org")).toBe(true);
		const decision = grants.resolve({ host: "registry.npmjs.org", method: "GET", path: "/next" });
		expect(decision.allow && decision.grant.id).toBe("web");
	});

	/**
	 * The failure the host had to enter specificity for. Both of these sit at `/`, and the open one is
	 * written first because an operator's own grants come before the generated ones — so a tie decided
	 * by position hands every model call to the grant carrying no key. The agent stops being able to
	 * think, and every line of the audit log says the request was allowed.
	 */
	it("never takes a request off a host that was named", () => {
		for (const grants of [new GrantSet([web, model]), new GrantSet([model, web])]) {
			const decision = grants.resolve({
				host: "api.deepseek.com",
				method: "POST",
				path: "/chat/completions",
			});
			expect(decision.allow && decision.grant.id).toBe("model");
		}
	});

	it("gives way to a wildcard label too, which is nearer than anywhere", () => {
		const docs: Grant = { id: "docs", host: "*.acme.com", injection: bearer("DOCS") };
		const grants = new GrantSet([web, docs]);
		const decision = grants.resolve({ host: "help.acme.com", method: "GET", path: "/" });
		expect(decision.allow && decision.grant.id).toBe("docs");
	});
});

/*
 * A host that is piped rather than opened.
 *
 * Everything else here goes through a certificate this plane issues, which is what makes an audit
 * line and an injected credential possible — and is also what a browser cannot survive on some of
 * the web: the handshake a site sees is then the proxy's while the user agent says a browser, and
 * the systems that decide whether a connection is a person compare exactly those two things.
 */
describe("hosts that are tunnelled rather than read", () => {
	const set = (...grants: Grant[]) => new GrantSet(grants);
	const plain = (host: string, tunnel?: boolean): Grant => ({
		id: host,
		host,
		injection: { kind: "none" },
		...(tunnel === undefined ? {} : { tunnel }),
	});

	it("is off unless the grant says so", () => {
		expect(set(plain("example.com")).tunnels("example.com")).toBe(false);
	});

	it("is on for a host whose grant asks for it", () => {
		expect(set(plain("example.com", true)).tunnels("example.com")).toBe(true);
	});

	it("follows a wildcard, because a site is not one host", () => {
		// The page is on one name and the script that decides whether you are a person is on another
		// under the same domain. Tunnelling only the first is tunnelling the half nobody measures.
		expect(set(plain("*.example.com", true)).tunnels("www.example.com")).toBe(true);
	});

	it("is not defeated by a blanket grant that asks for nothing", () => {
		// The rule was `every` first, and that was wrong in the only configuration anybody has: a plane
		// with `*` open matches every host with a grant that says nothing about tunnelling, so nothing
		// could ever be tunnelled. One grant asking is what makes a host tunnelled.
		expect(set(plain("*"), plain("*.example.com", true)).tunnels("www.example.com")).toBe(true);
	});

	it("refuses a host that is supposed to carry a credential", () => {
		// The one thing a pipe cannot do is have a key written onto it, and a credential that quietly
		// stops being attached is worse than an audit line that is coarse.
		const paid: Grant = {
			id: "paid",
			host: "example.com",
			injection: { kind: "bearer", token: { ref: "KEY" } },
		};
		expect(set(plain("example.com", true), paid).tunnels("example.com")).toBe(false);
	});

	it("is not something a host nobody granted can ask for", () => {
		expect(set(plain("example.com", true)).tunnels("elsewhere.com")).toBe(false);
	});
});
