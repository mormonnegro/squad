import { describe, expect, it } from "vitest";
import { type AgentStep, PiOutput } from "../src/pi-output.ts";

const event = (assistantMessageEvent: Record<string, unknown>): string =>
	`${JSON.stringify({ assistantMessageEvent })}\n`;

/** A top-level stream event, in the shape pi 0.84.2 writes it. */
const emitted = (fields: Record<string, unknown>): string => `${JSON.stringify(fields)}\n`;

const stepping = (): { readonly steps: AgentStep[]; readonly out: PiOutput } => {
	const steps: AgentStep[] = [];
	return { steps, out: new PiOutput({ onStep: (step) => steps.push(step) }) };
};

describe("PiOutput", () => {
	it("says each delta as it arrives", () => {
		const said: string[] = [];
		const out = new PiOutput({ onText: (text) => said.push(text) });

		out.push(event({ type: "text_start" }));
		out.push(event({ type: "text_delta", delta: "un " }));
		out.push(event({ type: "text_delta", delta: "compilador" }));
		out.push(event({ type: "text_end", content: "un compilador" }));

		expect(said).toEqual(["un ", "compilador"]);
		expect(out.text).toBe("un compilador");
	});

	it("says the whole block when the provider streamed none of it", () => {
		// A provider that returns the message in one piece sends no deltas at all, and the answer has
		// to come from somewhere: `text_end` carries the block whether or not the deltas did.
		const said: string[] = [];
		const out = new PiOutput({ onText: (text) => said.push(text) });

		out.push(event({ type: "text_start" }));
		out.push(event({ type: "text_end", content: "todo de una vez" }));

		expect(said).toEqual(["todo de una vez"]);
		expect(out.text).toBe("todo de una vez");
	});

	it("does not say twice what the deltas already delivered", () => {
		const said: string[] = [];
		const out = new PiOutput({ onText: (text) => said.push(text) });

		out.push(event({ type: "text_start" }));
		out.push(event({ type: "text_delta", delta: "medio " }));
		out.push(event({ type: "text_end", content: "medio entero" }));

		expect(said).toEqual(["medio ", "entero"]);
		expect(out.text).toBe("medio entero");
	});

	it("keeps two blocks apart, because they are two things the agent chose to say", () => {
		const out = new PiOutput();

		out.push(event({ type: "text_start" }));
		out.push(event({ type: "text_end", content: "voy a mirar" }));
		out.push(event({ type: "toolcall_start", name: "read" }));
		out.push(event({ type: "text_start" }));
		out.push(event({ type: "text_end", content: "ya está" }));

		expect(out.text).toBe("voy a mirar\n\nya está");
	});

	it("reassembles events split across chunks", () => {
		// A frame boundary falls wherever the pipe decides, and half a JSON line is not an event yet.
		const said: string[] = [];
		const out = new PiOutput({ onText: (text) => said.push(text) });
		const stream = event({ type: "text_start" }) + event({ type: "text_delta", delta: "hola" });

		for (const char of stream) out.push(char);

		expect(said).toEqual(["hola"]);
	});

	it("ignores what is not an event, rather than failing the turn over it", () => {
		const out = new PiOutput();

		out.push("Warning: something on stdout that is not JSON\n");
		out.push("\n");
		out.push(event({ type: "text_end", content: "la respuesta" }));

		expect(out.text).toBe("la respuesta");
	});

	it("leaves out everything that is not the answer", () => {
		const out = new PiOutput();

		out.push(event({ type: "thinking_delta", delta: "hmm" }));
		out.push(event({ type: "toolcall_delta", delta: '{"path":' }));
		out.push(`${JSON.stringify({ turn_start: {} })}\n`);
		out.push(event({ type: "text_end", content: "la respuesta" }));

		expect(out.text).toBe("la respuesta");
	});

	it("reports each tool call by the one argument that says what it was", () => {
		const { steps, out } = stepping();

		out.push(
			emitted({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "pnpm -r test" },
			}),
		);
		out.push(
			emitted({
				type: "tool_execution_start",
				toolCallId: "call_2",
				toolName: "read",
				args: { path: "notes.md" },
			}),
		);

		expect(steps).toEqual([
			{ action: "bash", detail: "pnpm -r test" },
			{ action: "read", detail: "notes.md" },
		]);
	});

	it("says where a search looked, since the pattern alone is half the story", () => {
		const { steps, out } = stepping();

		out.push(
			emitted({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "grep",
				args: { pattern: "TurnError", path: "packages" },
			}),
		);

		expect(steps[0]?.detail).toBe("TurnError in packages");
	});

	it("reports what a tool printed when it failed, and how long it took to fail", () => {
		const { steps, out } = stepping();

		out.push(
			emitted({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "exit 3" },
			}),
		);
		out.push(
			emitted({
				type: "tool_execution_end",
				toolCallId: "call_1",
				isError: true,
				result: { content: [{ type: "text", text: "(no output)\n\nCommand exited with code 3" }] },
			}),
		);

		expect(steps[1]).toMatchObject({
			action: "bash",
			detail: "(no output) Command exited with code 3",
			failed: true,
		});
		expect(steps[1]?.ms).toBeTypeOf("number");
	});

	it("says nothing on its way out of a tool that worked", () => {
		// The start line already said what was going to happen. Repeating it to say "and it worked"
		// doubles a log whose whole problem was that it was too long to read.
		const { steps, out } = stepping();

		out.push(
			emitted({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "read",
				args: { path: "notes.md" },
			}),
		);
		out.push(
			emitted({
				type: "tool_execution_end",
				toolCallId: "call_1",
				isError: false,
				result: { content: [{ type: "text", text: "hi there\n" }] },
			}),
		);

		expect(steps).toHaveLength(1);
	});

	it("cuts a detail down to a log line, not a build failure", () => {
		const { steps, out } = stepping();

		out.push(
			emitted({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "x".repeat(5000) },
			}),
		);

		expect(steps[0]?.detail).toHaveLength(300);
		expect(steps[0]?.detail.endsWith("…")).toBe(true);
	});

	it("counts what the turn burned, across every message in it", () => {
		const out = new PiOutput();
		const spent = (totalTokens: number, total: number) =>
			emitted({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					usage: { totalTokens, cost: { total } },
				},
			});

		out.push(spent(600, 0.001));
		out.push(spent(648, 0.0003));

		expect(out.tokens).toBe(1248);
		expect(out.costUsd).toBeCloseTo(0.0013);
	});

	it("keeps a refused turn from passing for a silent one", () => {
		// A 403 from the proxy, an expired key, a rate limit: pi reports all of them inside the stream
		// and exits zero, so unnoticed they arrive as an agent that simply had nothing to say.
		const { steps, out } = stepping();

		out.push(
			emitted({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: '403 "egress_denied"' },
			}),
		);

		expect(out.failure).toBe('403 "egress_denied"');
		expect(steps).toEqual([{ action: "model", detail: '403 "egress_denied"', failed: true }]);
	});

	it("is not a failure just because a message ended", () => {
		const out = new PiOutput();

		out.push(emitted({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }));

		expect(out.failure).toBeUndefined();
	});
});
