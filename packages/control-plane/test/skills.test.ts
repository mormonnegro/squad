import { describe, expect, it } from "vitest";
import { describedIn, nameRefused, readSkills, skillPath } from "../src/skills.ts";

describe("a skill, as the plane reads it", () => {
	it("takes the line that says when it applies out of the front matter", () => {
		expect(
			describedIn(
				[
					"---",
					"name: weekly-report",
					"description: Asked for the week's numbers",
					"---",
					"",
					"1. …",
				].join("\n"),
			),
		).toBe("Asked for the week's numbers");
	});

	it("does not mind quotes, and does not mind their absence", () => {
		expect(describedIn(["---", 'description: "Asked for the numbers"', "---"].join("\n"))).toBe(
			"Asked for the numbers",
		);
	});

	// A skill with exotic front matter is still a skill. It lists without a sentence rather than
	// bringing a YAML parser into the control plane for one field.
	it("says nothing rather than guessing when there is no front matter", () => {
		expect(describedIn("# Weekly report\n\nAsk for the numbers.")).toBe("");
	});

	it("reads a listing back into names, sentences and sizes", () => {
		const printed = [
			"weekly-report<<squad-skill>>",
			"---",
			"description: Asked for the week's numbers",
			"---",
			"Do the thing.",
			"<<squad-skill>>",
			"triage-mail<<squad-skill>>",
			"# Triage",
			"<<squad-skill>>",
		].join("\n");
		expect(readSkills(printed)).toEqual([
			{ name: "weekly-report", does: "Asked for the week's numbers", lines: 4 },
			{ name: "triage-mail", does: "", lines: 1 },
		]);
	});

	it("reads nothing out of nothing", () => {
		expect(readSkills("")).toEqual([]);
	});

	it("is named like the folder it is, because that is what it is", () => {
		expect(nameRefused("weekly-report")).toBeUndefined();
		expect(nameRefused("")).toBeDefined();
		expect(nameRefused("Weekly Report")).toBeDefined();
		expect(nameRefused("../escape")).toBeDefined();
	});

	it("lives in the agent's own repository", () => {
		expect(skillPath("weekly-report", "/home/agent/self")).toBe(
			"/home/agent/self/skills/weekly-report",
		);
	});
});
