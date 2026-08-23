import type { Injection } from "./grants.ts";
import { requireSecret, type SecretStore } from "./secrets.ts";

export interface OutboundRequest {
	/** Origin-form request target, e.g. "/repos/foo?page=2". */
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
}

/** Hop-by-hop headers (RFC 9110 7.6.1) plus the proxy's own auth, never forwarded upstream. */
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/**
 * Header the injection will write. Stripping it stops the agent from shadowing the
 * injected credential with one of its own.
 */
function injectionTargetHeader(injection: Injection): string | undefined {
	switch (injection.kind) {
		case "bearer":
		case "basic":
			return "authorization";
		case "header":
			return injection.name.toLowerCase();
		case "query":
		case "none":
			return undefined;
	}
}

function sanitizeHeaders(
	headers: Readonly<Record<string, string>>,
	injection: Injection,
): Record<string, string> {
	const target = injectionTargetHeader(injection);
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower)) continue;
		if (target !== undefined && lower === target) continue;
		result[lower] = value;
	}
	return result;
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
	const index = value.indexOf(separator);
	if (index === -1) return [value, undefined];
	return [value.slice(0, index), value.slice(index + 1)];
}

function setQueryParam(path: string, name: string, value: string): string {
	const [target = "", fragment] = splitOnce(path, "#");
	const [pathname = "", query = ""] = splitOnce(target, "?");
	const params = new URLSearchParams(query);
	params.set(name, value);
	const rendered = params.toString();
	return `${pathname}${rendered ? `?${rendered}` : ""}${fragment ? `#${fragment}` : ""}`;
}

/**
 * Applies a grant's injection to an outbound request. The result carries the credential and
 * is only ever handed to the upstream socket, never back toward the agent.
 */
export async function applyInjection(
	injection: Injection,
	store: SecretStore,
	request: OutboundRequest,
): Promise<OutboundRequest> {
	const headers = sanitizeHeaders(request.headers, injection);

	switch (injection.kind) {
		case "none":
			return { path: request.path, headers };

		case "bearer": {
			const token = await requireSecret(store, injection.token);
			headers.authorization = `Bearer ${token}`;
			return { path: request.path, headers };
		}

		case "header": {
			const value = await requireSecret(store, injection.value);
			headers[injection.name.toLowerCase()] = value;
			return { path: request.path, headers };
		}

		case "basic": {
			const username = await requireSecret(store, injection.username);
			const password = await requireSecret(store, injection.password);
			const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
			headers.authorization = `Basic ${encoded}`;
			return { path: request.path, headers };
		}

		case "query": {
			const value = await requireSecret(store, injection.value);
			return {
				path: setQueryParam(request.path, injection.name, value),
				headers,
			};
		}
	}
}
