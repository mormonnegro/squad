import { parse as parseYaml } from "yaml";

/**
 * A capability the agent asks for. This is a request, never a grant.
 *
 * The agent commits to its own repository, so anything stored here is agent-writable and
 * cannot be trusted to authorize itself. Actual grants live in the control plane and are
 * approved by a human; this manifest only declares what the agent would like, so an operator
 * has something concrete to approve.
 */
export interface CapabilityRequest {
	readonly host: string;
	readonly pathPrefix?: string;
	readonly methods?: readonly string[];
	/** Shown to the operator during approval. */
	readonly reason?: string;
}

export interface AgentManifest {
	readonly name: string;
	readonly description?: string;
	/** Provider-qualified model id, e.g. "anthropic/claude-opus-4-7". */
	readonly model?: string;
	readonly requests: readonly CapabilityRequest[];
}

export class ManifestError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid agent manifest:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
		this.name = "ManifestError";
		this.issues = issues;
	}
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(raw: unknown, index: number, issues: string[]): CapabilityRequest | undefined {
	const label = `requests[${index}]`;
	if (!isRecord(raw)) {
		issues.push(`${label} must be a mapping`);
		return undefined;
	}

	const { host, pathPrefix, methods, reason } = raw;
	if (typeof host !== "string" || host.trim() === "") {
		issues.push(`${label}.host is required`);
		return undefined;
	}
	if (pathPrefix !== undefined && typeof pathPrefix !== "string") {
		issues.push(`${label}.pathPrefix must be a string`);
		return undefined;
	}
	if (pathPrefix !== undefined && !pathPrefix.startsWith("/")) {
		issues.push(`${label}.pathPrefix must start with "/"`);
		return undefined;
	}
	if (reason !== undefined && typeof reason !== "string") {
		issues.push(`${label}.reason must be a string`);
		return undefined;
	}

	let parsedMethods: string[] | undefined;
	if (methods !== undefined) {
		if (!Array.isArray(methods) || methods.some((method) => typeof method !== "string")) {
			issues.push(`${label}.methods must be a list of strings`);
			return undefined;
		}
		parsedMethods = methods.map((method) => (method as string).toUpperCase());
		const unknown = parsedMethods.filter((method) => !KNOWN_METHODS.has(method));
		if (unknown.length > 0) {
			issues.push(`${label}.methods has unknown methods: ${unknown.join(", ")}`);
			return undefined;
		}
	}

	return {
		host: host.trim().toLowerCase(),
		...(pathPrefix !== undefined ? { pathPrefix } : {}),
		...(parsedMethods !== undefined ? { methods: parsedMethods } : {}),
		...(reason !== undefined ? { reason } : {}),
	};
}

export function parseManifest(source: string): AgentManifest {
	const issues: string[] = [];

	let raw: unknown;
	try {
		raw = parseYaml(source);
	} catch (error) {
		throw new ManifestError([`could not parse YAML: ${(error as Error).message}`]);
	}

	if (!isRecord(raw)) throw new ManifestError(["manifest must be a YAML mapping"]);

	const { name, description, model, requests } = raw;

	if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
		issues.push('name is required and must be lowercase alphanumeric with dashes, e.g. "support-emma"');
	}
	if (description !== undefined && typeof description !== "string") {
		issues.push("description must be a string");
	}
	if (model !== undefined && typeof model !== "string") {
		issues.push("model must be a string");
	}

	const parsedRequests: CapabilityRequest[] = [];
	if (requests !== undefined) {
		if (!Array.isArray(requests)) {
			issues.push("requests must be a list");
		} else {
			requests.forEach((entry, index) => {
				const parsed = parseRequest(entry, index, issues);
				if (parsed !== undefined) parsedRequests.push(parsed);
			});
		}
	}

	if (issues.length > 0) throw new ManifestError(issues);

	return {
		name: name as string,
		...(typeof description === "string" ? { description } : {}),
		...(typeof model === "string" ? { model } : {}),
		requests: parsedRequests,
	};
}
