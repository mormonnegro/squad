import { describe, expect, it } from "vitest";
import { PiOutput } from "../src/pi-output.ts";

const event = (assistantMessageEvent: Record<string, unknown>): string =>
	`${JSON.stringify({ assistantMessageEvent })}\n`;

describe("PiOutput", () => {
	it("says each delta as it arrives", () => {
		const said: string[] = [];
		const out = new PiOutput((text) => said.push(text));

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
		const out = new PiOutput((text) => said.push(text));

		out.push(event({ type: "text_start" }));
		out.push(event({ type: "text_end", content: "todo de una vez" }));

		expect(said).toEqual(["todo de una vez"]);
		expect(out.text).toBe("todo de una vez");
	});

	it("does not say twice what the deltas already delivered", () => {
		const said: string[] = [];
		const out = new PiOutput((text) => said.push(text));

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
		const out = new PiOutput((text) => said.push(text));
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
});
