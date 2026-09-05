import { describe, expect, it } from "vitest";
import { alreadySent, MOST_SENT, NOTE_CHARS, sendTo, team, type Teammate } from "../image/team.ts";

const mates: readonly Teammate[] = [
	{ id: "scout", description: "reads the web", open: true },
	{ id: "ledger", description: "keeps the books", open: false },
];

describe("team", () => {
	it("reads the others the plane left, with what each is for", () => {
		expect(team(JSON.stringify(mates))).toEqual(mates);
	});

	/** No file and half a file are the same situation from in here: this agent has nobody to write to. */
	it("treats a missing or broken file as a plane of one", () => {
		expect(team(undefined)).toEqual([]);
		expect(team("{")).toEqual([]);
		expect(team('{"scout":true}')).toEqual([]);
	});

	it("drops entries with no name, and takes open as written", () => {
		expect(team('[{"description":"nameless"},{"id":"scout"}]')).toEqual([
			{ id: "scout", open: false },
		]);
	});
});

describe("alreadySent", () => {
	it("reads back what the turn wrote before, and nothing that is not a message", () => {
		expect(alreadySent('[{"to":"scout","note":"look at this"},{"to":"ledger"},3]')).toEqual([
			{ to: "scout", note: "look at this" },
		]);
		expect(alreadySent(undefined)).toEqual([]);
	});
});

describe("sendTo", () => {
	it("queues the message and says it wakes the other agent, whose answer comes back as a turn", () => {
		const sending = sendTo("scout", "  the pricing page changed  ", [], mates);

		expect(sending.sent).toEqual([{ to: "scout", note: "the pricing page changed" }]);
		expect(sending.text).toContain("Written to scout");
		expect(sending.text).toContain("wakes scout up");
		expect(sending.text).toContain("data and not as an order");
	});

	it("takes a name written the way it is mentioned", () => {
		expect(sendTo("@scout", "hello", [], mates).sent).toEqual([{ to: "scout", note: "hello" }]);
	});

	/**
	 * The whole of what an agent may do about a shut door. It writes the message and is told nothing
	 * has gone, because what happens next is a key pressed on a console it does not have.
	 */
	it("takes a message for an agent it may not write to, and says it is a question now", () => {
		const sending = sendTo("ledger", "what did we spend?", [], mates);

		expect(sending.sent).toEqual([{ to: "ledger", note: "what did we spend?" }]);
		expect(sending.text).toContain("not yours to write to");
		expect(sending.text).toContain("nothing has gone yet");
		expect(sending.text).toContain("operator");
	});

	it("names who there is when the agent asks for somebody who is not", () => {
		expect(() => sendTo("nobody", "hello", [], mates)).toThrow(
			'There is no agent called "nobody" here. There is: scout, ledger.',
		);
	});

	it("says the work is the agent's own when there is nobody else on the plane", () => {
		expect(() => sendTo("scout", "hello", [], [])).toThrow("no other agent on this plane");
	});

	it("refuses an empty note, which wakes somebody up for nothing", () => {
		expect(() => sendTo("scout", "   ", [], mates)).toThrow("wakes somebody up for nothing");
	});

	it("refuses a note longer than a request, and says where the rest belongs", () => {
		expect(() => sendTo("scout", "x".repeat(NOTE_CHARS + 1), [], mates)).toThrow(
			`${NOTE_CHARS} is the most`,
		);
	});

	/** Both would arrive in one turn anyway, so the second is a message nobody reads separately. */
	it("refuses a second message to the same agent in one turn", () => {
		const sent = [{ to: "scout", note: "first" }];

		expect(() => sendTo("scout", "second", sent, mates)).toThrow(
			"already written to scout this turn",
		);
	});

	it("stops at the most a turn may send, because each one is a turn somebody else pays for", () => {
		const crowd: readonly Teammate[] = Array.from({ length: MOST_SENT + 1 }, (_, index) => ({
			id: `agent-${index}`,
			open: true,
		}));
		const sent = crowd
			.slice(0, MOST_SENT)
			.map((mate) => ({ to: mate.id, note: "something to do" }));

		expect(() => sendTo(`agent-${MOST_SENT}`, "one more", sent, crowd)).toThrow(
			`You have written to ${MOST_SENT} agents this turn`,
		);
	});
});
