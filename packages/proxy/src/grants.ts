export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/**
 * A reference to a secret, resolved by the SecretStore at request time.
 * Grants are safe to serialize, log and show in a UI; secret values are not.
 */
export type SecretRef = { readonly ref: string };

/**
 * A value written into the grant itself, for the half of a credential that is not one.
 *
 * Basic auth carries two things and only one of them is ever secret: GitHub reads a token out of the
 * password and asks that the username be `x-access-token`, which is a fact about GitHub rather than
 * anything of the operator's. A grant should be able to say so without an environment variable being
 * made up to hold a constant.
 */
export type Literal = { readonly literal: string };

export type Injection =
	| { readonly kind: "none" }
	| { readonly kind: "bearer"; readonly token: SecretRef }
	| {
			readonly kind: "header";
			readonly name: string;
			readonly value: SecretRef;
	  }
	| { readonly kind: "query"; readonly name: string; readonly value: SecretRef }
	| {
			readonly kind: "basic";
			readonly username: SecretRef | Literal;
			readonly password: SecretRef;
	  };

/**
 * What a grant on a git repository lets through of a push.
 *
 * The path under the grant is the repository, and everything git does to one over HTTP is a GET and a
 * POST under it — so the method cannot say whether the agent may write, and a plain grant on a repo
 * host is a grant to push anywhere on it. This is the half the method could not carry: the branches,
 * named the way a refspec names them, `scout/*` for the ones under that prefix and nothing for a
 * repository the agent may only read.
 */
export interface GitScope {
	/** Refs the agent may push. A bare name is under `refs/heads/`; `*` matches anything, slashes too. */
	readonly push: readonly string[];
}

export interface Grant {
	readonly id: string;
	/** Exact ("api.github.com"), single-label wildcard ("*.slack.com"), or {@link ANY_HOST}. */
	readonly host: string;
	/** Only requests whose normalized path is at or below this prefix match. Defaults to "/". */
	readonly pathPrefix?: string;
	/** Allowed methods. Omitted means all methods. */
	readonly methods?: readonly HttpMethod[];
	readonly injection: Injection;
	/**
	 * Set when the path is a git repository, which makes two things true of the grant: it answers with
	 * `.git` on the end of the path as well as without, because both are the same repository and the
	 * agent will type whichever the clone box showed it; and a push through it is read before it is
	 * passed, and passed only to the refs listed.
	 */
	readonly git?: GitScope;
	/**
	 * Set when this host is to be tunnelled rather than opened.
	 *
	 * Everything else here goes through a certificate this plane issues for the host it was asked
	 * for: the proxy terminates the TLS, reads the request, writes a credential onto it and passes it
	 * on. That is what makes an audit line possible and what makes injection possible, and it is why
	 * a sandbox never gets raw TCP to anywhere.
	 *
	 * It is also what a browser cannot survive on some of the web. The handshake a site sees then is
	 * this proxy's and not the browser's, while the user agent says a browser — and the systems that
	 * decide whether a connection is a person compare exactly those two things. A real Chrome behind
	 * this looks, to them, like a script wearing Chrome's name.
	 *
	 * So a host can be marked for a straight tunnel: the grant is still checked, the connection is
	 * still audited as having been opened, and from the 200 onwards the bytes are the browser's own.
	 * What is given up is the rest of that audit line — the plane knows the host and not the path —
	 * and any injection on it, which is why it is never the default and never derived: an operator
	 * says it, host by host, about hosts they are only ever reading.
	 */
	readonly tunnel?: boolean;
}

export type GrantDecision =
	| { readonly allow: true; readonly grant: Grant }
	| { readonly allow: false; readonly reason: DenyReason };

export type DenyReason =
	| "no_matching_host"
	| "path_not_granted"
	| "method_not_granted"
	/** A push to a ref the grant does not list. */
	| "ref_not_granted"
	/** A push whose commands the proxy could not read, and so would not pass. */
	| "push_unreadable";

export interface RequestDescriptor {
	readonly host: string;
	readonly method: string;
	readonly path: string;
}

const WILDCARD_PREFIX = "*.";

/**
 * Anywhere — the road rather than the keys to it.
 *
 * What an agent needs to build software is a package registry, and a registry is never one host: npm
 * is a registry and a CDN, PyPI is an index and a file server, a `git clone` is three names before it
 * is a checkout. A list of them is a list that is wrong by one, and being wrong by one looks exactly
 * like the agent in that transcript — reading the deny as "the internet is down", then writing the
 * page it was asked to build as a paragraph about not being able to build it.
 *
 * This widens what an agent can *reach*, and nothing at all about what it can *spend*: a grant on
 * this host may inject no credential, which is checked where the config is read. The boundary that
 * was ever load-bearing is the one around the secrets, and it is exactly where it was.
 */
export const ANY_HOST = "*";

export function normalizeHost(host: string): string {
	const withoutPort = host.replace(/:\d+$/, "");
	const withoutBrackets = withoutPort.replace(/^\[|\]$/g, "");
	return withoutBrackets.trim().toLowerCase().replace(/\.$/, "");
}

function hostMatches(pattern: string, host: string): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
	if (normalizedPattern === ANY_HOST) return true;
	if (!normalizedPattern.startsWith(WILDCARD_PREFIX)) {
		return normalizedPattern === host;
	}
	const suffix = normalizedPattern.slice(WILDCARD_PREFIX.length);
	if (!host.endsWith(`.${suffix}`)) return false;
	// A single-label wildcard must not span dots: *.slack.com matches a.slack.com, not a.b.slack.com.
	const label = host.slice(0, host.length - suffix.length - 1);
	return label.length > 0 && !label.includes(".");
}

/**
 * Resolves "/a/../b" and percent-encoded separators before prefix matching, so a
 * path-scoped grant cannot be escaped with traversal or encoding tricks.
 */
export function normalizePath(rawPath: string): string {
	const [pathOnly = ""] = rawPath.split(/[?#]/, 1);
	let decoded = pathOnly;
	for (let i = 0; i < 3; i++) {
		let next: string;
		try {
			next = decodeURIComponent(decoded);
		} catch {
			break;
		}
		if (next === decoded) break;
		decoded = next;
	}
	const segments = decoded.split("/");
	const resolved: string[] = [];
	for (const segment of segments) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			resolved.pop();
			continue;
		}
		resolved.push(segment);
	}
	return `/${resolved.join("/")}`;
}

function under(prefix: string, path: string): boolean {
	if (path === prefix) return true;
	return path.startsWith(`${prefix}/`);
}

function pathMatches(grant: Grant, path: string): boolean {
	const normalizedPrefix = normalizePath(grant.pathPrefix ?? "/");
	if (normalizedPrefix === "/") return true;
	if (under(normalizedPrefix, path)) return true;
	// A repository is reached under its name and under its name with `.git` on the end, and a grant
	// that covered one of the two would be a grant that works until the agent pastes the other.
	return grant.git !== undefined && under(`${normalizedPrefix}.git`, path);
}

/** Whether this request is the one that writes to a repository, which is the one a push scope reads. */
export function isPush(method: string, normalizedPath: string): boolean {
	return method.toUpperCase() === "POST" && normalizedPath.endsWith("/git-receive-pack");
}

/**
 * A named host beats a wildcard beats anywhere, before path length is looked at.
 *
 * The failure this is here for: an open grant and the model's grant both sit at `/`, the open one is
 * written first because the operator's own grants come before the generated ones, and a tie decided
 * by position would hand every request to the one carrying no key — the agent would stop being able
 * to think, and the audit log would show each call allowed. Specificity has to include the host, or
 * "most specific wins" is only true of paths.
 */
function specificity(grant: Grant): readonly [number, number] {
	const host = grant.host.trim().toLowerCase();
	const rank = host === ANY_HOST ? 0 : host.startsWith(WILDCARD_PREFIX) ? 1 : 2;
	return [rank, normalizePath(grant.pathPrefix ?? "/").length];
}

function beats(candidate: Grant, best: Grant): boolean {
	const [candidateHost, candidatePath] = specificity(candidate);
	const [bestHost, bestPath] = specificity(best);
	if (candidateHost !== bestHost) return candidateHost > bestHost;
	return candidatePath > bestPath;
}

/** Deny-by-default set of grants for a single agent. */
export class GrantSet {
	private readonly grants: readonly Grant[];

	constructor(grants: readonly Grant[]) {
		this.grants = grants;
	}

	/** Hosts the agent may open a tunnel to at all. Checked before TLS interception. */
	allowsHost(host: string): boolean {
		const normalized = normalizeHost(host);
		return this.grants.some((grant) => hostMatches(grant.host, normalized));
	}

	/**
	 * Whether this host is piped rather than read: asked for by one grant, and refused by none.
	 *
	 * One asking is enough, because the thing that makes a host tunnelled is an operator naming it —
	 * and a plane with a blanket `*` open would otherwise never tunnel anything, since that grant
	 * matches every host and asks for nothing. That was the first rule here and it was wrong in the
	 * only configuration anybody has.
	 *
	 * What does veto it is a credential. A grant that exists to have a key written onto requests for
	 * that host cannot be satisfied by a pipe — nothing can be written onto bytes nobody reads — so a
	 * host carrying one is never tunnelled, whatever else is said about it. Which is the rule worth
	 * having: the cost of piping is the audit, and the thing that must not be quietly lost is a
	 * credential that stops being attached.
	 */
	tunnels(host: string): boolean {
		const normalized = normalizeHost(host);
		const matched = this.grants.filter((grant) => hostMatches(grant.host, normalized));
		if (matched.length === 0) return false;
		if (matched.some((grant) => grant.injection.kind !== "none")) return false;
		return matched.some((grant) => grant.tunnel === true);
	}

	resolve(request: RequestDescriptor): GrantDecision {
		const host = normalizeHost(request.host);
		const path = normalizePath(request.path);
		const method = request.method.toUpperCase();

		const hostMatched = this.grants.filter((grant) => hostMatches(grant.host, host));
		if (hostMatched.length === 0) return { allow: false, reason: "no_matching_host" };

		const pathMatched = hostMatched.filter((grant) => pathMatches(grant, path));
		if (pathMatched.length === 0) return { allow: false, reason: "path_not_granted" };

		const methodMatched = pathMatched.filter(
			(grant) => grant.methods === undefined || grant.methods.some((m) => m === method),
		);
		if (methodMatched.length === 0) return { allow: false, reason: "method_not_granted" };

		// Most specific grant wins, so a narrow grant can override a broad one on the same host.
		const chosen = methodMatched.reduce((best, candidate) =>
			beats(candidate, best) ? candidate : best,
		);
		return { allow: true, grant: chosen };
	}
}
