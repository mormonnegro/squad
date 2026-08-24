import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Searching is something the agent asks for rather than something it does, and that is the shape of
 * the sandbox rather than a preference: an agent that read the web itself would need every domain a
 * result might live on granted in advance, and nobody can write that list. The searching and the
 * reading happen on the other side of one granted host, and what comes back is prose with its
 * sources in it.
 */
const ENDPOINT = "https://api.openai.com/v1/responses";

/** The call is billed per search and dwarfs its own tokens, so the model driving it may be a small one. */
const MODEL = process.env.AGENT_DIVE_SEARCH_MODEL ?? "gpt-5-mini";

/** A few pages get read on the other side of this, and none of it arrives until all of it has. */
const TIMEOUT_MS = 120_000;

interface Answered {
	readonly output?: readonly {
		readonly type: string;
		readonly content?: readonly { readonly type: string; readonly text?: string }[];
	}[];
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
function post(body: string): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const curl = execFile(
			"curl",
			[
				"-sS",
				ENDPOINT,
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

/** The answer, which is one part of an output that also carries the model's reasoning and its search. */
function said(answer: Answered): string {
	const message = answer.output?.find((part) => part.type === "message");
	return (message?.content ?? [])
		.filter((part) => part.type === "output_text")
		.map((part) => part.text ?? "")
		.join("")
		.trim();
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

			const { status, body } = await post(
				JSON.stringify({ model: MODEL, tools: [{ type: "web_search" }], input: query }),
			);

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

			const text = said(answer);
			if (text.length === 0) {
				throw new Error("The search came back with nothing to say. Try asking it differently.");
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
