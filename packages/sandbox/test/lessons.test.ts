import { describe, expect, it } from "vitest";
import { heldLessons, LESSON_CHARS, lessonsFile, MOST_LESSONS, record } from "../image/lessons.ts";

const WHERE = "/home/agent/.self/memory/lessons.md";

/** A full list, so the interesting case is easy to reach. */
const full = (): string[] =>
	Array.from({ length: MOST_LESSONS }, (_, index) => `lesson number ${index}`);

describe("record", () => {
	it("writes the lesson down and says how much room is left", () => {
		const recorded = record("Bind servers to 127.0.0.1, never to 0.0.0.0.", [], WHERE);

		expect(recorded.lessons).toEqual(["Bind servers to 127.0.0.1, never to 0.0.0.0."]);
		expect(recorded.changed).toBe(true);
		expect(recorded.text).toContain(`1 of ${MOST_LESSONS}`);
	});

	/** An agent that wrote a lesson with a newline in it meant the lesson, not the newline. */
	it("folds a lesson written over several lines onto one", () => {
		const recorded = record("apt-get needs an\n  update\tbefore an install here.", [], WHERE);

		expect(recorded.lessons).toEqual(["apt-get needs an update before an install here."]);
	});

	it("refuses a lesson too long to be read on every turn", () => {
		expect(() => record("x".repeat(LESSON_CHARS + 1), [], WHERE)).toThrow(/write the rule/);
	});

	it("refuses a lesson with nothing in it", () => {
		expect(() => record("   \n  ", [], WHERE)).toThrow(/teaches nothing/);
	});

	/**
	 * The same lesson twice is the same sentence with a different capital at the front, and two of
	 * them cost what two lessons cost while teaching what one does.
	 */
	it("changes nothing when the lesson was already held", () => {
		const holding = ["Bind servers to 127.0.0.1."];
		const recorded = record("bind servers to 127.0.0.1.", holding, WHERE);

		expect(recorded.lessons).toEqual(holding);
		expect(recorded.changed).toBe(false);
		expect(recorded.text).toContain("already");
	});

	/**
	 * The decision this whole file exists for. A ring buffer would never bother the agent and would
	 * quietly drop the lesson learned on the first day — which, being the first, is the one most
	 * likely to be about this machine rather than about yesterday's task.
	 */
	it("refuses once the list is full, and says where to go and what to do there", () => {
		expect(() => record("one more thing", full(), WHERE)).toThrow(WHERE);
		expect(() => record("one more thing", full(), WHERE)).toThrow(/merge|delete/);
	});

	it("still refuses a duplicate before it refuses a full list, so the agent is not sent to edit for nothing", () => {
		const holding = full();
		const recorded = record("LESSON NUMBER 0", holding, WHERE);

		expect(recorded.changed).toBe(false);
	});
});

describe("heldLessons", () => {
	it("reads back what was written", () => {
		const lessons = ["first thing", "second thing"];

		expect(heldLessons(lessonsFile(lessons))).toEqual(lessons);
	});

	it("has nothing to read when there is no file yet", () => {
		expect(heldLessons(undefined)).toEqual([]);
		expect(heldLessons("")).toEqual([]);
	});

	/**
	 * Consolidating a full list happens in an editor rather than through the tool, so whatever the
	 * agent leaves behind is what gets read next. A heading it added is not a lesson, and counting it
	 * as one would cost it a slot for the rest of its life.
	 */
	it("tolerates the file having been edited by hand", () => {
		const raw = "# Lessons\n\n* first thing\n-   second thing\n\nthird thing\n";

		expect(heldLessons(raw)).toEqual(["first thing", "second thing", "third thing"]);
	});
});
