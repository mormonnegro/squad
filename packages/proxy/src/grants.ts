export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/**
 * A reference to a secret, resolved by the SecretStore at request time.
 * Grants are safe to serialize, log and show in a UI; secret values are not.
 */
export type SecretRef = { readonly ref: string };

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
			readonly username: SecretRef;
			readonly password: SecretRef;
	  };

export interface Grant {
	readonly id: string;
	/** Exact host ("api.github.com") or single-label wildcard ("*.slack.com"). */
	readonly host: string;
	/** Only requests whose normalized path is at or below this prefix match. Defaults to "/". */
	readonly pathPrefix?: string;
	/** Allowed methods. Omitted means all methods. */
	readonly methods?: readonly HttpMethod[];
	readonly injection: Injection;
}

export type GrantDecision =
	| { readonly allow: true; readonly grant: Grant }
	| { readonly allow: false; readonly reason: DenyReason };

export type DenyReason = "no_matching_host" | "path_not_granted" | "method_not_granted";

export interface RequestDescriptor {
	readonly host: string;
	readonly method: string;
	readonly path: string;
}

const WILDCARD_PREFIX = "*.";

export function normalizeHost(host: string): string {
	const withoutPort = host.replace(/:\d+$/, "");
	const withoutBrackets = withoutPort.replace(/^\[|\]$/g, "");
	return withoutBrackets.trim().toLowerCase().replace(/\.$/, "");
}

function hostMatches(pattern: string, host: string): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
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

function pathMatches(prefix: string, path: string): boolean {
	const normalizedPrefix = normalizePath(prefix);
	if (normalizedPrefix === "/") return true;
	if (path === normalizedPrefix) return true;
	return path.startsWith(`${normalizedPrefix}/`);
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

	resolve(request: RequestDescriptor): GrantDecision {
		const host = normalizeHost(request.host);
		const path = normalizePath(request.path);
		const method = request.method.toUpperCase();

		const hostMatched = this.grants.filter((grant) => hostMatches(grant.host, host));
		if (hostMatched.length === 0) return { allow: false, reason: "no_matching_host" };

		const pathMatched = hostMatched.filter((grant) => pathMatches(grant.pathPrefix ?? "/", path));
		if (pathMatched.length === 0) return { allow: false, reason: "path_not_granted" };

		const methodMatched = pathMatched.filter(
			(grant) => grant.methods === undefined || grant.methods.some((m) => m === method),
		);
		if (methodMatched.length === 0) return { allow: false, reason: "method_not_granted" };

		// Most specific grant wins, so a narrow grant can override a broad one on the same host.
		const chosen = methodMatched.reduce((best, candidate) =>
			normalizePath(candidate.pathPrefix ?? "/").length >
			normalizePath(best.pathPrefix ?? "/").length
				? candidate
				: best,
		);
		return { allow: true, grant: chosen };
	}
}
