import type { AuditEntry } from "@squad/proxy";
import { describe, expect, it } from "vitest";
import type { PlaneEvent } from "../src/control-plane.ts";
import { LogFeed } from "../src/feed.ts";
import type { TurnResult } from "../src/turn.ts";

const AT = "2026-08-23T20:39:10.545Z";

const allowed = (agentId: string, host: string, status = 200): PlaneEvent => ({
	kind: "audit",
	entry: {
		at: AT,
		agentId,
		host,
		method: "POST",
		path: "/v1/messages",
		outcome: "allowed",
		status,
	},
});

const turn = (agentId: string, text: string, over: Partial<Record<string, number>> = {}) =>
	({
		kind: "turn",
		agentId,
		result: {
			text,
			exitCode: 0,
			stderr: "",
			ms: over.ms ?? 41_000,
			tokens: over.tokens ?? 9100,
			costUsd: over.costUsd ?? 0.05,
		},
	}) satisfies PlaneEvent;

const feed = (): { readonly lines: string[]; readonly log: LogFeed } => {
	const written: string[] = [];
	return {
		lines: written,
		log: new LogFeed((line) => written.push(line.replace(/\n$/, ""))),
	};
};

describe("LogFeed", () => {
	it("shows the commands an agent runs inside its sandbox", () => {
		const { lines, log } = feed();

		log.push({ kind: "step", agentId: "maxi", step: { action: "bash", detail: "pnpm -r test" } });

		expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d {2}maxi {6}bash {6} {2}pnpm -r test$/);
	});

	it("marks a failed step and says what it printed", () => {
		const { lines, log } = feed();

		log.push({
			kind: "step",
			agentId: "maxi",
			step: { action: "bash", detail: "Command exited with code 3", failed: true, ms: 2100 },
		});

		expect(lines[0]).toContain("✗ after 2.1s: Command exited with code 3");
	});

	it("closes out a turn that threw, so its requests are not billed to the next one", () => {
		const { lines, log } = feed();

		log.push(allowed("scout", "api.anthropic.com"));
		log.push({ kind: "error", context: "scout", message: 'got no answer: 403 "egress_denied"' });
		log.push(turn("scout", "segunda vuelta"));

		expect(lines[1]).toContain("spent");
		expect(lines[1]).toContain("api.anthropic.com");
		expect(lines.at(-1)).not.toContain("api.anthropic.com");
	});

	it("says nothing about the model calls that worked", () => {
		// One identical line per round-trip was the whole of the old feed, and a hundred of them are
		// what the three lines that matter used to be buried in.
		const { lines, log } = feed();

		for (let i = 0; i < 12; i++) log.push(allowed("maxi", "api.anthropic.com"));

		expect(lines).toEqual([]);
	});

	it("counts them onto the turn that made them", () => {
		const { lines, log } = feed();

		for (let i = 0; i < 12; i++) log.push(allowed("maxi", "api.anthropic.com"));
		log.push(allowed("maxi", "api.github.com"));
		log.push(turn("maxi", "los tests pasan"));

		expect(lines.at(-1)).toContain(
			"41.0s · 9.1k tokens · $0.05 · api.anthropic.com ×12, api.github.com",
		);
	});

	it("does not bill one agent for another's requests", () => {
		const { lines, log } = feed();

		log.push(allowed("maxi", "api.anthropic.com"));
		log.push(allowed("scout", "api.github.com"));
		log.push(turn("maxi", "listo"));

		expect(lines.at(-1)).toContain("api.anthropic.com");
		expect(lines.at(-1)).not.toContain("api.github.com");
	});

	it("starts the count again on the next turn", () => {
		const { lines, log } = feed();

		log.push(allowed("maxi", "api.anthropic.com"));
		log.push(turn("maxi", "una"));
		log.push(turn("maxi", "otra"));

		expect(lines.at(-1)).not.toContain("api.anthropic.com");
	});

	it("says a denial at once, because it is the reason the agent is about to fail", () => {
		const { lines, log } = feed();
		const entry: AuditEntry = {
			at: AT,
			agentId: "maxi",
			host: "api.github.com",
			method: "GET",
			path: "/repos",
			outcome: "denied",
			reason: "no_matching_host",
		};

		log.push({ kind: "audit", entry });

		expect(lines[0]).toContain("✗ denied GET api.github.com/repos — no_matching_host");
	});

	it("says an allowed request that came back broken", () => {
		// A 429 or a 401 is allowed by the proxy and still the whole reason a turn went wrong, and
		// counting it in with the ones that worked is how it used to go unnoticed.
		const { lines, log } = feed();

		log.push(allowed("maxi", "api.anthropic.com", 429));

		expect(lines[0]).toContain("✗ allowed 429 POST api.anthropic.com/v1/messages");
	});

	it("puts an answer's own paragraphs under its column", () => {
		const { lines, log } = feed();

		log.push(turn("maxi", "lo arreglé.\n\ny corrí los tests"));

		expect(lines[0]).toMatch(/ {2}answer {6}lo arreglé\.$/);
		expect(lines[1]).toBe("");
		expect(lines[2]).toMatch(/^ +y corrí los tests$/);
	});

	it("reports a turn that said nothing, rather than printing nothing at all", () => {
		const { lines, log } = feed();

		log.push(turn("maxi", "", { tokens: 0, costUsd: 0, ms: 900 }));

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("spent");
		expect(lines[0]).toContain("900ms");
	});

	it("says nothing about what a plane a build behind never measured", () => {
		// The CLI runs on the host against a plane in a container, so the two are routinely a build
		// apart. A turn from before the measurement existed used to render as "NaNmNaNs".
		const { lines, log } = feed();
		const old = { text: "listo", exitCode: 0, stderr: "" } as unknown as TurnResult;

		log.push(allowed("maxi", "api.anthropic.com"));
		log.push({ kind: "turn", agentId: "maxi", result: old });

		expect(lines.join("\n")).not.toContain("NaN");
		expect(lines.at(-1)).toMatch(/spent {7}api\.anthropic\.com$/);
	});

	it("keeps the price of a cheap turn visible", () => {
		const { lines, log } = feed();

		log.push(turn("maxi", "ok", { costUsd: 0.0013 }));

		expect(lines.at(-1)).toContain("$0.0013");
	});

	it("leaves the pieces of an answer to whoever is waiting for them", () => {
		const { lines, log } = feed();

		log.push({ kind: "say", agentId: "maxi", text: "medio " });

		expect(lines).toEqual([]);
	});

	it("marks an error by what it was about", () => {
		const { lines, log } = feed();

		log.push({ kind: "error", context: "maxi -> webhook:deploys", message: "no reply URL" });

		expect(lines[0]).toContain("maxi -> webhook:deploys");
		expect(lines[0]).toContain("✗ no reply URL");
	});

	/**
	 * A feed on a terminal is scanned down the action column, so the columns are the feature and the
	 * colour is what makes them findable. Padding a column after painting it pads it to the wrong
	 * width — an escape sequence is characters that take up no space — and the columns stop lining up.
	 */
	it("paints the columns without moving them", () => {
		const written: string[] = [];
		const painted = new LogFeed((line) => written.push(line.replace(/\n$/, "")), { color: true });
		const { lines, log } = feed();
		const step = {
			kind: "step",
			agentId: "maxi",
			step: { action: "bash", detail: "pnpm -r test" },
		} satisfies PlaneEvent;

		painted.push(step);
		log.push(step);

		expect(written[0]).toContain("\u001b[36mmaxi");
		expect(plain(written[0] ?? "")).toBe(lines[0]);
	});
});

/** What the line says once the colour is taken off it, which is what has to be the same either way. */
function plain(line: string): string {
	return line
		.split("\u001b")
		.map((piece, index) => (index === 0 ? piece : piece.slice(piece.indexOf("m") + 1)))
		.join("");
}
