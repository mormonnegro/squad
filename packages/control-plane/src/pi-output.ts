/** One thing an agent did while a turn ran, in the order it did it. */
export interface AgentStep {
	/** A tool name like "bash" or "read", or "model" when the provider refused to answer. */
	readonly action: string;
	/** The part worth reading: the command, the path, the reason it failed. */
	readonly detail: string;
	readonly failed?: boolean;
	/** How long the tool ran. Present on the line that reports a failure, which is where it matters. */
	readonly ms?: number;
}

export interface PiOutputOptions {
	/** A piece of the answer, as the agent writes it. */
	readonly onText?: (delta: string) => void;
	/** Something the agent just did, handed over while it does it rather than once the turn ends. */
	readonly onStep?: (step: AgentStep) => void;
}

/**
 * What pi says a thing burned and what it cost.
 *
 * On a message, and also on the result of a tool that spent something itself — pi has a place for
 * both, and deliberately keeps the second out of the first.
 */
interface PiUsage {
	readonly totalTokens?: number;
	readonly cost?: { readonly total?: number };
}

/** What pi's `--mode json` stream says, of the parts anyone outside the sandbox can use. */
interface PiEvent {
	readonly type?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
	readonly isError?: boolean;
	readonly result?: unknown;
	readonly message?: {
		readonly role?: string;
		readonly stopReason?: string;
		readonly errorMessage?: string;
		readonly usage?: PiUsage;
	};
	readonly assistantMessageEvent?: {
		readonly type: string;
		readonly delta?: string;
		readonly content?: string;
	};
}

/** A log line is not where a 50KB build failure belongs, so the cut is made here and not by a reader. */
const MAX_DETAIL = 300;

/**
 * The argument that says what a tool call was, most telling first.
 *
 * A search takes both a pattern and a path, and it is the pattern that says what was being looked
 * for, so it has to be asked about before the directory it was looked for in.
 */
const SUBJECTS = ["command", "pattern", "path", "file_path", "query", "url"] as const;

/**
 * Reads pi's JSON event stream and keeps the two things it is worth having: the answer, and what the
 * agent did to arrive at it.
 *
 * `--mode text` prints the answer once, at the end, which for a person waiting at a terminal is the
 * same as not printing it at all: a turn takes as long as it takes, and none of that time shows
 * anything. The JSON stream is the only mode that says the answer as it is written — and the only
 * one that says anything at all about the four minutes before it. Without the steps, an agent that
 * spent those minutes getting nowhere looked exactly like an agent that had nothing to say, and the
 * one question worth asking, what was it doing, had no answer anywhere.
 *
 * A block's `text_end` carries the whole of it, so anything the deltas did not deliver is said
 * there. That is what makes this correct against a provider that streams nothing at all rather than
 * merely lucky against the one that does.
 */
export class PiOutput {
	readonly #onText: (delta: string) => void;
	readonly #onStep: (step: AgentStep) => void;
	readonly #running = new Map<string, { readonly at: number; readonly action: string }>();
	#pending = "";
	#text = "";
	#block = "";
	#failure: string | undefined;
	#tokens = 0;
	#cost = 0;

	constructor(options: PiOutputOptions = {}) {
		this.#onText = options.onText ?? (() => {});
		this.#onStep = options.onStep ?? (() => {});
	}

	/** Everything the agent said, in the order it said it. */
	get text(): string {
		return this.#text.trim();
	}

	/**
	 * Why the turn is not an answer, if it is not one.
	 *
	 * A model that refuses — an expired key, a rate limit, a host the proxy would not let through —
	 * is reported inside the stream and leaves pi exiting zero. Unnoticed, a denied agent is one that
	 * said nothing, and the operator is left reading an empty reply for the reason.
	 */
	get failure(): string | undefined {
		return this.#failure;
	}

	get tokens(): number {
		return this.#tokens;
	}

	get costUsd(): number {
		return this.#cost;
	}

	push(chunk: string): void {
		this.#pending += chunk;
		for (;;) {
			const newline = this.#pending.indexOf("\n");
			if (newline === -1) break;
			const line = this.#pending.slice(0, newline);
			this.#pending = this.#pending.slice(newline + 1);
			this.#line(line);
		}
	}

	#line(line: string): void {
		if (line.trim().length === 0) return;

		let event: PiEvent;
		try {
			event = JSON.parse(line) as PiEvent;
		} catch {
			// Not an event. pi writes its diagnostics to stderr, so this is something the answer is
			// better off without rather than something to fail the turn over.
			return;
		}

		if (event.assistantMessageEvent !== undefined) this.#said(event.assistantMessageEvent);
		else if (event.type === "tool_execution_start") this.#toolStart(event);
		else if (event.type === "tool_execution_end") this.#toolEnd(event);
		else if (event.type === "message_end") this.#messageEnd(event.message);
	}

	#said(said: NonNullable<PiEvent["assistantMessageEvent"]>): void {
		if (said.type === "text_start") {
			// A second block is a second thing the agent chose to say, usually with a tool call in
			// between, and running them together would join two paragraphs into one sentence.
			if (this.#text.length > 0) this.#say("\n\n");
			this.#block = "";
		} else if (said.type === "text_delta") {
			this.#say(said.delta ?? "");
		} else if (said.type === "text_end") {
			this.#say((said.content ?? "").slice(this.#block.length));
		}
	}

	#say(text: string): void {
		if (text.length === 0) return;
		this.#text += text;
		this.#block += text;
		this.#onText(text);
	}

	#toolStart(event: PiEvent): void {
		const action = event.toolName ?? "tool";
		this.#running.set(event.toolCallId ?? "", { at: Date.now(), action });
		this.#step({ action, detail: subjectOf(event.args) });
	}

	/**
	 * Only failures are reported at the end.
	 *
	 * The start line already said what was going to happen, and repeating it on the way out doubles
	 * the log to say "and it worked". A tool that failed is different: what it printed is usually the
	 * whole reason the turn went the way it did.
	 */
	#toolEnd(event: PiEvent): void {
		const id = event.toolCallId ?? "";
		const started = this.#running.get(id);
		this.#running.delete(id);
		// Before the early return, because a tool that spent money spent it whether or not it also
		// worked, and this is the only place that spending is ever said.
		this.#billed(event.result);
		if (event.isError !== true) return;

		this.#step({
			action: started?.action ?? event.toolName ?? "tool",
			detail: textOf(event.result),
			failed: true,
			...(started !== undefined ? { ms: Date.now() - started.at } : {}),
		});
	}

	/**
	 * What a tool spent of its own, which pi hands over here and adds to nothing.
	 *
	 * Its message totals are about the model, and rightly so: a tool that runs a command or reads a
	 * file costs nobody anything. Searching is the exception — it is a call to another provider, on
	 * another account, billed by the search, and the model driving the turn never sees a token of it.
	 * Uncounted, the one tool that spends money outside the conversation was also the one spend that
	 * no ceiling could stop and no total would admit to.
	 */
	#billed(result: unknown): void {
		if (result === null || typeof result !== "object") return;
		const usage = (result as { usage?: PiUsage }).usage;
		this.#tokens += usage?.totalTokens ?? 0;
		this.#cost += usage?.cost?.total ?? 0;
	}

	#messageEnd(message: PiEvent["message"]): void {
		if (message?.role !== "assistant") return;
		this.#tokens += message.usage?.totalTokens ?? 0;
		this.#cost += message.usage?.cost?.total ?? 0;

		const stopReason = message.stopReason;
		if (stopReason !== "error" && stopReason !== "aborted") return;
		this.#failure = message.errorMessage ?? stopReason;
		this.#step({ action: "model", detail: this.#failure, failed: true });
	}

	#step(step: AgentStep): void {
		this.#onStep({ ...step, detail: shorten(step.detail) });
	}
}

/** The one argument that says what a tool call was about, since the rest is rarely worth a line. */
function subjectOf(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of SUBJECTS) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) {
			const where = record.path;
			// grep and find take a pattern and somewhere to look, and the pattern alone is half a line.
			return key === "pattern" && typeof where === "string" ? `${value} in ${where}` : value;
		}
	}
	return JSON.stringify(record);
}

/** A tool result is content blocks; a failure's text is the first thing worth reading in them. */
function textOf(result: unknown): string {
	if (result === null || typeof result !== "object") return String(result ?? "");
	const content = (result as { content?: readonly { type?: string; text?: string }[] }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join(" ")
		.trim();
}

function shorten(detail: string): string {
	const flat = detail.replace(/\s+/g, " ").trim();
	return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
}
