import { timingSafeEqual } from "node:crypto";
import type { AgentDirectory } from "./broker.ts";
import { type Grant, GrantSet } from "./grants.ts";

export interface AgentRegistration {
	readonly agentId: string;
	/** Opaque token the sandbox receives as its proxy password. Identifies, does not authorize. */
	readonly proxyToken: string;
	readonly grants: readonly Grant[];
}

function constantTimeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/** In-memory directory. The control plane swaps this for a database-backed implementation. */
export class StaticAgentDirectory implements AgentDirectory {
	private readonly registrations = new Map<string, AgentRegistration>();
	private readonly grantSets = new Map<string, GrantSet>();

	constructor(registrations: readonly AgentRegistration[] = []) {
		for (const registration of registrations) this.register(registration);
	}

	register(registration: AgentRegistration): void {
		this.registrations.set(registration.agentId, registration);
		this.grantSets.set(registration.agentId, new GrantSet(registration.grants));
	}

	revoke(agentId: string): void {
		this.registrations.delete(agentId);
		this.grantSets.delete(agentId);
	}

	authenticate(username: string, password: string): string | undefined {
		const registration = this.registrations.get(username);
		if (registration === undefined) return undefined;
		if (!constantTimeEquals(registration.proxyToken, password)) return undefined;
		return registration.agentId;
	}

	grantsFor(agentId: string): GrantSet | undefined {
		return this.grantSets.get(agentId);
	}
}
