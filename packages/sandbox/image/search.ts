import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Searching is something the agent asks for rather than something it does, and that is the shape of
 * the sandbox rather than a preference: an agent that read the web itself would need every domain a
 * result might live on granted in advance, and nobody can write that list. The searching and the
 * reading happen on the other side of one granted host, and what comes back is prose with its
 * sources in it.
 */

/**
 * Which provider searches and what that costs, as the plane wrote it before the turn began.
 *
 * Read from a file rather than baked into this extension, because all three of these are the
 * operator's to choose at the config screen and a container's environment cannot be edited after it
 * starts. The prices come with it for the same reason they are the plane's: this file used to hold
 * its own list, which put the one number that decides whether a spending ceiling means anything two
 * packages away from the table that knows it.
 */
interface Chosen {
	readonly endpoint: string;
	readonly model: string;
	/** How the answer comes back: OpenAI's output list, or the message shape everyone else uses. */
	readonly shape: "responses" | "chat";
	readonly perSearchUsd: number;
	readonly rate: { readonly input: number; readonly output: number };
}

/**
 * What this searches with when the plane has said nothing, which is what it always did.
 *
 * Here rather than left as an error, because a turn that cannot read one file should be a turn with
 * a working search tool. A plane that has chosen writes over every field of this.
 */
const FALLBACK: Chosen = {
	endpoint: "https://api.openai.com/v1/responses",
	model: "gpt-5-mini",
	shape: "responses",
	perSearchUsd: 0.01,
	rate: { input: 0.25, output: 2 },
};

const CHOSEN_FILE = process.env.AGENT_DIVE_SEARCH_FILE ?? "";

async function chosen(): Promise<Chosen> {
	if (CHOSEN_FILE.length === 0) return FALLBACK;
	try {
		const parsed = JSON.parse(await readFile(CHOSEN_FILE, "utf8")) as Partial<Chosen>;
		// Field by field rather than wholesale, so a file written by an older plane is a file missing
		// one thing rather than a search that refuses.
		return {
			endpoint: parsed.endpoint ?? FALLBACK.endpoint,
			model: parsed.model ?? FALLBACK.model,
			shape: parsed.shape === "chat" ? "chat" : "responses",
			perSearchUsd: parsed.perSearchUsd ?? FALLBACK.perSearchUsd,
			rate: parsed.rate ?? FALLBACK.rate,
		};
	} catch {
		return FALLBACK;
	}
}

/** What pi carries a cost in, written out here because the type of it lives two packages away. */
interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/** A few pages get read on the other side of this, and none of it arrives until all of it has. */
const TIMEOUT_MS = 120_000;

interface Answered {
	readonly output?: readonly {
		readonly type: string;
		readonly content?: readonly { readonly type: string; readonly text?: string }[];
	}[];
	readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
	/** What a chat-shaped provider read to answer, which is the sources the prose refers to. */
	readonly citations?: readonly string[];
	readonly search_results?: readonly { readonly url?: string; readonly title?: string }[];
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
		readonly prompt_tokens?: number;
		readonly completion_tokens?: number;
	};
	readonly error?: { readonly message?: string } | null;
}

/**
 * curl rather than fetch, because the sandbox has no DNS and no route out except the egress proxy:
 * Node's fetch reads neither HTTPS_PROXY nor NODE_EXTRA_CA_CERTS and dies resolving the name, where
 * curl reads both and is already in the image. The body goes over stdin so that no part of a request
 * built from something the agent read is ever an argument.
 *
 * Nothing here sends an Authorization: the proxy writes one and strips whatever was sent, so an
 * agent that had a key could not use it and this one has none to send.
 */
function post(
	endpoint: string,
	body: string,
): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const curl = execFile(
			"curl",
			[
				"-sS",
				endpoint,
				"-H",
				"Content-Type: application/json",
				"--data-binary",
				"@-",
				"-w",
				"\n%{http_code}",
			],
			{ timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
			(failure, stdout, stderr) => {
				if (failure !== null) {
					reject(new Error(stderr.trim().length > 0 ? stderr.trim() : failure.message));
					return;
				}
				const cut = stdout.lastIndexOf("\n");
				resolve({ status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) });
			},
		);
		curl.stdin?.end(body);
	});
}

/** What to send, which is the one thing the two shapes disagree about beyond where the answer is. */
function asked(chosen: Chosen, query: string): string {
	return JSON.stringify(
		chosen.shape === "responses"
			? { model: chosen.model, tools: [{ type: "web_search" }], input: query }
			: { model: chosen.model, messages: [{ role: "user", content: query }] },
	);
}

/**
 * The answer, which for the responses shape is one part of an output that also carries the model's
 * reasoning and its searching.
 *
 * A chat-shaped provider answers in prose with numbered references in it and lists what those numbers
 * are separately, so the list is appended: prose citing `[1]` with no `[1]` under it is prose whose
 * sources the agent cannot pass on.
 */
function said(chosen: Chosen, answer: Answered): string {
	if (chosen.shape === "responses") {
		const message = answer.output?.find((part) => part.type === "message");
		return (message?.content ?? [])
			.filter((part) => part.type === "output_text")
			.map((part) => part.text ?? "")
			.join("")
			.trim();
	}

	const prose = (answer.choices?.[0]?.message?.content ?? "").trim();
	const sources =
		answer.search_results?.map((found) => found.url ?? "").filter((url) => url.length > 0) ??
		answer.citations ??
		[];
	if (prose.length === 0 || sources.length === 0) return prose;
	return `${prose}\n\nSources:\n${sources.map((url, index) => `[${index + 1}] ${url}`).join("\n")}`;
}

/**
 * What the search cost, counted here because here is the only place that knows.
 *
 * The plane bills an agent for what its turn spent, and until this was reported the searching was
 * the one thing an agent could do that cost money and appeared in no total: a call to another
 * provider, on another account, that the model driving the turn never sees a token of. An agent
 * could search all afternoon under a ceiling it never touched.
 *
 * The searches are counted from the answer where the provider says, and taken as one where it does
 * not. Cached input is cheaper and is not told apart, which rounds this the wrong way on purpose: of
 * the two ways to be wrong about a ceiling, stopping an agent a little early can be undone.
 */
function spent(chosen: Chosen, answer: Answered): Usage {
	const counted = (answer.output ?? []).filter((part) => part.type === "web_search_call").length;
	const searches = chosen.shape === "responses" ? counted : 1;
	const input = answer.usage?.input_tokens ?? answer.usage?.prompt_tokens ?? 0;
	const output = answer.usage?.output_tokens ?? answer.usage?.completion_tokens ?? 0;
	const read = (input * chosen.rate.input) / 1e6;
	const written = (output * chosen.rate.output) / 1e6;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: read,
			output: written,
			cacheRead: 0,
			cacheWrite: 0,
			// More than its own parts, and the only line here that is: the fee is charged for asking
			// rather than for anything read or written, so it belongs to the total and to neither half.
			total: read + written + searches * chosen.perSearchUsd,
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Search the web",
		description: [
			"Look something up on the web: anything that happened after you were trained, anything",
			"version-specific, anything you would otherwise be guessing at.",
			"",
			"What comes back is an answer written from the pages it found, with the sources linked in",
			"it — not a list of results to go and read. You have no other way to reach the web, so a",
			"URL you were given is also something to search for rather than something to fetch.",
			"",
			"Ask in a full sentence. The search is run by a model that reads what it finds and will",
			"search again on its own, so it does better with the actual question than with keywords.",
		].join("\n"),
		promptSnippet: "Look something up on the web and get back an answer with its sources",
		promptGuidelines: [
			"Use web_search rather than answering from memory when the answer could have changed since training, or when being wrong would be expensive.",
			"Each search is billed, so ask one full question rather than several keyword variations of it.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "What you want to know, as a question in a full sentence.",
			}),
		}),
		async execute(_toolCallId, params) {
			const { query } = params as { query: string };
			if (query.trim().length === 0) {
				throw new Error("A search needs something to search for.");
			}

			// Read per search rather than once when pi started: a turn is a process, but a long one, and
			// the file is written before every turn by the plane that owns the choice.
			const with_ = await chosen();
			const { status, body } = await post(with_.endpoint, asked(with_, query));

			let answer: Answered;
			try {
				answer = JSON.parse(body) as Answered;
			} catch {
				// A proxy that refused the host answers in its own words rather than in the API's, and
				// this is where that arrives: it is the reason the search did not happen.
				throw new Error(`The search failed (HTTP ${status}): ${body.slice(0, 400)}`);
			}
			if (status !== 200) {
				throw new Error(
					`The search failed (HTTP ${status}): ${answer.error?.message ?? body.slice(0, 400)}`,
				);
			}

			const text = said(with_, answer);
			if (text.length === 0) {
				throw new Error("The search came back with nothing to say. Try asking it differently.");
			}
			return { content: [{ type: "text", text }], details: {}, usage: spent(with_, answer) };
		},
	});
}
