import type { AuditEntry } from "@agent-dive/proxy";
import type { PlaneEvent } from "./control-plane.ts";
import type { AgentStep } from "./pi-output.ts";
import type { TurnResult } from "./turn.ts";

/** Wide enough for the names people actually give agents; a longer one pushes its own line out. */
const AGENT_WIDTH = 8;
const ACTION_WIDTH = 8;

/** What a line reports went wrong, in the one column an eye can scan down. */
const FAILED = "✗";

/**
 * Turns what the plane does into a feed a person can read while it is happening.
 *
 * The two things worth knowing about a running agent are what it is doing inside its sandbox and
 * why the last thing it tried did not work, and neither used to appear anywhere: the feed was one
 * identical line per model round-trip — allowed POST api.anthropic.com — around a final paragraph
 * of answer. Hundreds of lines that never differ are not a log, they are what a log has to be read
 * through, so those are counted here and reported once, with the turn that made them. What replaces
 * them is the commands, the failures with what they printed, and what the turn cost.
 *
 * Stateful because of that folding, and because the count belongs to the turn rather than to any
 * one request in it.
 */
export class LogFeed {
	readonly #write: (line: string) => void;
	readonly #reached = new Map<string, Map<string, number>>();

	constructor(write: (line: string) => void) {
		this.#write = write;
	}

	push(event: PlaneEvent): void {
		// Half a sentence at a time is for whoever is waiting on the answer. A feed gets the turn
		// whole, once, which is what keeps it readable with several agents talking at the same time.
		if (event.kind === "say") return;
		if (event.kind === "step") this.#step(event.agentId, event.step);
		else if (event.kind === "audit") this.#egress(event.entry);
		else if (event.kind === "error") this.#error(event.context, event.message);
		else this.#turn(event.agentId, event.result);
	}

	/** How long it ran leads, because what it printed can be three hundred characters of build log. */
	#step(agentId: string, step: AgentStep): void {
		if (step.failed !== true) {
			this.#line(now(), agentId, step.action, "", step.detail);
			return;
		}
		const took = step.ms !== undefined ? `after ${duration(step.ms)}: ` : "";
		this.#line(now(), agentId, step.action, FAILED, `${took}${step.detail}`);
	}

	#error(context: string, message: string): void {
		this.#line(now(), context, "error", FAILED, message);
		// A turn that threw never arrives as a turn, so this is the last chance to say what the agent
		// reached on the way — and the only thing stopping that count following it into its next turn.
		const reached = this.#flush(context);
		if (reached !== undefined) this.#line(now(), context, "spent", "", reached);
	}

	/**
	 * A request that was allowed and worked is not news on its own, and a hundred of them bury the
	 * three that are. Those are counted; everything else — a denial, a 401, a 429, a proxy that could
	 * not find the secret — is said at once, because it is the reason the agent is about to misbehave.
	 */
	#egress(entry: AuditEntry): void {
		const agentId = entry.agentId ?? "-";
		if (entry.outcome === "allowed" && (entry.status ?? 0) < 400) {
			const hosts = this.#reached.get(agentId) ?? new Map<string, number>();
			hosts.set(entry.host, (hosts.get(entry.host) ?? 0) + 1);
			this.#reached.set(agentId, hosts);
			return;
		}

		const status = entry.status !== undefined ? ` ${entry.status}` : "";
		const why = entry.reason !== undefined ? ` — ${entry.reason}` : "";
		const what = `${entry.outcome}${status} ${entry.method} ${entry.host}${entry.path}${why}`;
		this.#line(time(entry.at), agentId, "egress", FAILED, what);
	}

	#turn(agentId: string, result: TurnResult): void {
		const at = now();
		if (result.text.length > 0) this.#line(at, agentId, "answer", "", result.text);
		this.#line(at, agentId, "spent", "", this.#spent(agentId, result));
	}

	/** What the turn took, and what it talked to while taking it. */
	#spent(agentId: string, result: TurnResult): string {
		const parts = [duration(result.ms)];
		if (result.tokens > 0) parts.push(`${thousands(result.tokens)} tokens`);
		if (result.costUsd > 0) parts.push(money(result.costUsd));

		const reached = this.#flush(agentId);
		if (reached !== undefined) parts.push(reached);
		return parts.join(" · ");
	}

	/** The requests counted for an agent since its last turn, and the end of counting them. */
	#flush(agentId: string): string | undefined {
		const hosts = this.#reached.get(agentId);
		if (hosts === undefined) return undefined;
		this.#reached.delete(agentId);
		return [...hosts].map(([host, count]) => (count > 1 ? `${host} ×${count}` : host)).join(", ");
	}

	/**
	 * One event, in columns, however many lines its detail runs to.
	 *
	 * An answer is prose and arrives with its own paragraphs; indenting them under the column keeps
	 * the left edge scannable, which is the whole reason for having columns in the first place.
	 */
	#line(at: string, who: string, action: string, mark: string, detail: string): void {
		const head = `${at}  ${who.padEnd(AGENT_WIDTH)}  ${action.padEnd(ACTION_WIDTH)}  ${mark.padEnd(1)} `;
		const indent = " ".repeat(head.length);
		const [first = "", ...rest] = detail.split("\n");
		this.#write(`${(head + first).trimEnd()}\n`);
		for (const line of rest) this.#write(`${(indent + line).trimEnd()}\n`);
	}
}

/** Local time, to the second. The date is the same on every line of a feed being watched. */
function time(at: string): string {
	return new Date(at).toTimeString().slice(0, 8);
}

function now(): string {
	return time(new Date().toISOString());
}

function duration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function thousands(count: number): string {
	return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/** Two decimals hide the price of most single turns, which is the price worth watching add up. */
function money(usd: number): string {
	return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
