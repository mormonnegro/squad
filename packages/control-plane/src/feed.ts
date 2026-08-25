import type { AuditEntry } from "@agent-dive/proxy";
import { money } from "./commands.ts";
import type { PlaneEvent } from "./control-plane.ts";
import type { AgentStep } from "./pi-output.ts";
import type { TurnResult } from "./turn.ts";

/** Wide enough for the names people actually give agents; a longer one pushes its own line out. */
const AGENT_WIDTH = 8;
const ACTION_WIDTH = 8;

/** What a line reports went wrong, in the one column an eye can scan down. */
const FAILED = "✗";

/**
 * The sixteen-colour palette and nothing else, so the terminal's own theme decides what these look
 * like. A feed that picked its own greens is one that is unreadable on somebody's background.
 */
const paint = (code: number, off: number, text: string): string =>
	`\u001b[${code}m${text}\u001b[${off}m`;

/** What the action column says is the fastest thing to scan down, so it is what carries the colour. */
function hue(action: string): number {
	if (action === "error" || action === "egress") return 31;
	if (action === "answer") return 32;
	if (action === "spent") return 33;
	return 34;
}

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
	readonly #colour: boolean;
	readonly #reached = new Map<string, Map<string, number>>();

	constructor(write: (line: string) => void, options: { readonly color?: boolean } = {}) {
		this.#write = write;
		this.#colour = options.color ?? false;
	}

	push(event: PlaneEvent): void {
		// Half a sentence at a time is for whoever is waiting on the answer. A feed gets the turn
		// whole, once, which is what keeps it readable with several agents talking at the same time.
		if (event.kind === "say") return;
		// The conversation, which this feed reports as turns and errors already. Both would be here.
		if (event.kind === "said") return;
		// A feed is read after the fact, where a turn that started is a turn that also ended.
		if (event.kind === "thinking") return;
		// A page to open is for whoever is at a console with a browser, and this is neither.
		if (event.kind === "open") return;
		// For a pane holding the conversation, which a feed is not: this is the record of what happened
		// and clearing one is a thing that happened, reported as the note that comes with it.
		if (event.kind === "cleared") return;
		if (event.kind === "step") this.#step(event.agentId, event.step);
		else if (event.kind === "audit") this.#egress(event.entry);
		else if (event.kind === "error") this.#error(event.context, event.message);
		else if (event.kind === "note") this.note(event.who, event.action, event.detail);
		else this.#turn(event.agentId, event.result);
	}

	/**
	 * Something the console itself did, in the columns everything the plane did is already in.
	 *
	 * The ports a console opens are the one part of this the plane never sees: it records what should
	 * be reachable, and whether a listener came up on somebody's laptop is news that only exists on
	 * that laptop. It still belongs in the same feed — an operator looking for why a link will not
	 * open should not have to know which half of the system to look in.
	 */
	note(who: string, action: string, detail: string, failed = false): void {
		this.#line(now(), who, action, failed ? FAILED : "", detail);
	}

	/** How long it ran leads, because what it printed can be three hundred characters of build log. */
	#step(agentId: string, step: AgentStep): void {
		if (step.failed !== true) {
			this.#line(now(), agentId, step.action, "", step.detail);
			return;
		}
		const took = duration(step.ms);
		const after = took !== undefined ? `after ${took}: ` : "";
		this.#line(now(), agentId, step.action, FAILED, `${after}${step.detail}`);
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
		const spent = this.#spent(agentId, result);
		if (spent.length > 0) this.#line(at, agentId, "spent", "", spent);
	}

	/**
	 * What the turn took, and what it talked to while taking it.
	 *
	 * Every part is left out when it is not known. The CLI runs on the host against a plane in a
	 * container, so the two are separately deployed and routinely a build apart, and a feed that
	 * printed `NaNmNaNs` for a plane that predates the measurement is worse than one that says
	 * nothing about it.
	 */
	#spent(agentId: string, result: TurnResult): string {
		const parts: string[] = [];
		const took = duration(result.ms);
		if (took !== undefined) parts.push(took);
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
		const when = at;
		const agent = who.padEnd(AGENT_WIDTH);
		const what = action.padEnd(ACTION_WIDTH);
		const failed = mark.padEnd(1);
		// Padded first and painted after: an escape sequence is characters that occupy no columns, so
		// a column padded once it is coloured is padded to the wrong width and the feed stops lining up.
		const head = this.#colour
			? `${paint(2, 22, when)}  ${paint(36, 39, agent)}  ${paint(hue(action), 39, what)}  ${paint(31, 39, failed)} `
			: `${when}  ${agent}  ${what}  ${failed} `;
		const indent = " ".repeat(`${when}  ${agent}  ${what}  ${failed} `.length);
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

function duration(ms: number | undefined): string | undefined {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function thousands(count: number): string {
	return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}
