import { randomUUID } from "node:crypto";
import { isTrustLevel, type TrustLevel } from "./trust.ts";

/** Where an event entered the system. Determines routing, never authority. */
export type EventSource = "channel" | "schedule" | "webhook" | "system";

export const EVENT_SOURCES: readonly EventSource[] = ["channel", "schedule", "webhook", "system"];

export interface EventActor {
	/** Stable identifier within the channel, e.g. a Slack user id. */
	readonly id: string;
	readonly displayName?: string;
}

export interface AgentEvent {
	readonly id: string;
	readonly agentId: string;
	readonly source: EventSource;
	readonly trust: TrustLevel;
	/** Channel the event arrived on, e.g. "webhook:github" or "slack:C0123". */
	readonly channel: string;
	readonly actor?: EventActor;
	readonly subject?: string;
	readonly body: string;
	readonly receivedAt: string;
	/** Opaque routing hints. Never rendered as instructions. */
	readonly metadata?: Readonly<Record<string, string>>;
	/** Set by the channel adapter so a reply can be routed back to where the event came from. */
	readonly replyTo?: string;
}

export type NewAgentEvent = Omit<AgentEvent, "id" | "receivedAt"> &
	Partial<Pick<AgentEvent, "id" | "receivedAt">>;

export class EventError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid event: ${issues.join("; ")}`);
		this.name = "EventError";
		this.issues = issues;
	}
}

/**
 * Normalizes an inbound event, assigning identity and arrival time.
 *
 * Trust is required rather than defaulted: a default would silently pick a side the caller did
 * not think about, and the safe default is the one that makes every integration look broken.
 */
export function createEvent(input: NewAgentEvent): AgentEvent {
	const issues: string[] = [];

	if (typeof input.agentId !== "string" || input.agentId.length === 0) {
		issues.push("agentId is required");
	}
	if (!EVENT_SOURCES.includes(input.source)) {
		issues.push(`source must be one of ${EVENT_SOURCES.join(", ")}`);
	}
	if (!isTrustLevel(input.trust)) issues.push("trust must be operator, participant or public");
	if (typeof input.channel !== "string" || input.channel.length === 0) {
		issues.push("channel is required");
	}
	if (typeof input.body !== "string") issues.push("body must be a string");
	if (issues.length > 0) throw new EventError(issues);

	return {
		id: input.id ?? randomUUID(),
		agentId: input.agentId,
		source: input.source,
		trust: input.trust,
		channel: input.channel,
		body: input.body,
		receivedAt: input.receivedAt ?? new Date().toISOString(),
		...(input.actor !== undefined ? { actor: input.actor } : {}),
		...(input.subject !== undefined ? { subject: input.subject } : {}),
		...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
		...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
	};
}
