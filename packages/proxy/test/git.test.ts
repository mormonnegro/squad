import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { pushRefusal, readPushCommands, readPushHead, refMatches, shortRef } from "../src/git.ts";

const ZERO = "0".repeat(40);
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

function pkt(payload: string): Buffer {
	const body = Buffer.from(payload, "utf8");
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

const FLUSH = Buffer.from("0000");

/** What git sends for `git push origin scout/fix`: one command with the capabilities on its tail. */
function push(refs: readonly string[], capabilities = "report-status side-band-64k"): Buffer {
	const [first = "", ...rest] = refs;
	return Buffer.concat([
		pkt(`${OLD} ${NEW} ${first}\0${capabilities}`),
		...rest.map((ref) => pkt(`${OLD} ${NEW} ${ref}`)),
		FLUSH,
	]);
}

const PACKFILE = Buffer.concat([Buffer.from("PACK"), Buffer.alloc(200, 7)]);

describe("readPushCommands", () => {
	it("reads every ref update and where the commands end", () => {
		const body = Buffer.concat([push(["refs/heads/scout/fix", "refs/heads/main"]), PACKFILE]);
		const read = readPushCommands(body);
		expect(read.kind).toBe("commands");
		if (read.kind !== "commands") return;
		expect(read.updates.map((update) => update.ref)).toEqual([
			"refs/heads/scout/fix",
			"refs/heads/main",
		]);
		expect(read.updates[0]).toEqual({ oldId: OLD, newId: NEW, ref: "refs/heads/scout/fix" });
		expect(read.capabilities.has("side-band-64k")).toBe(true);
		expect(body.subarray(read.end).equals(PACKFILE)).toBe(true);
	});

	it("asks for more until the flush arrives", () => {
		const body = push(["refs/heads/scout/fix"]);
		expect(readPushCommands(body.subarray(0, 2)).kind).toBe("incomplete");
		expect(readPushCommands(body.subarray(0, 30)).kind).toBe("incomplete");
		expect(readPushCommands(body.subarray(0, body.length - 4)).kind).toBe("incomplete");
		expect(readPushCommands(body).kind).toBe("commands");
	});

	it("reads a delete, which has no packfile after it", () => {
		const body = Buffer.concat([pkt(`${OLD} ${ZERO} refs/heads/scout/old\0report-status`), FLUSH]);
		const read = readPushCommands(body);
		expect(read.kind).toBe("commands");
		if (read.kind !== "commands") return;
		expect(read.updates[0]?.newId).toBe(ZERO);
		expect(read.end).toBe(body.length);
	});

	it("skips the shallow lines a shallow clone pushes first", () => {
		const body = Buffer.concat([
			pkt(`shallow ${OLD}`),
			pkt(`${OLD} ${NEW} refs/heads/scout/fix\0report-status`),
			FLUSH,
		]);
		const read = readPushCommands(body);
		expect(read.kind).toBe("commands");
		if (read.kind !== "commands") return;
		expect(read.updates.map((update) => update.ref)).toEqual(["refs/heads/scout/fix"]);
	});

	it("reads a sha256 repository's longer ids", () => {
		const body = Buffer.concat([pkt(`${"c".repeat(64)} ${"d".repeat(64)} refs/heads/x`), FLUSH]);
		expect(readPushCommands(body).kind).toBe("commands");
	});

	it("refuses what it cannot read rather than guessing", () => {
		expect(readPushCommands(Buffer.from("PACKxxxx"))).toMatchObject({ kind: "unreadable" });
		expect(readPushCommands(Buffer.concat([pkt("push-cert\0report-status"), FLUSH]))).toMatchObject(
			{
				kind: "unreadable",
				why: expect.stringContaining("signed"),
			},
		);
		expect(readPushCommands(Buffer.concat([pkt("command=push"), FLUSH]))).toMatchObject({
			kind: "unreadable",
		});
		expect(readPushCommands(Buffer.from("0001"))).toMatchObject({ kind: "unreadable" });
	});
});

describe("refMatches", () => {
	it("reads a bare name as a branch and a star as anything, slashes included", () => {
		expect(refMatches(["scout/*"], "refs/heads/scout/fix")).toBe(true);
		expect(refMatches(["scout/*"], "refs/heads/scout/a/b")).toBe(true);
		expect(refMatches(["scout/*"], "refs/heads/scout")).toBe(false);
		expect(refMatches(["scout/*"], "refs/heads/main")).toBe(false);
		expect(refMatches(["scout/*"], "refs/heads/scoutx/fix")).toBe(false);
		expect(refMatches(["scout/*"], "refs/tags/scout/fix")).toBe(false);
	});

	it("takes a full ref pattern as written", () => {
		expect(refMatches(["refs/tags/v*"], "refs/tags/v1.2")).toBe(true);
		expect(refMatches(["refs/tags/v*"], "refs/heads/v1.2")).toBe(false);
		expect(refMatches(["main"], "refs/heads/main")).toBe(true);
	});

	it("matches nothing when nothing is listed", () => {
		expect(refMatches([], "refs/heads/scout/fix")).toBe(false);
	});

	it("escapes what a branch name may contain", () => {
		expect(refMatches(["release-1.0"], "refs/heads/release-1x0")).toBe(false);
	});
});

describe("pushRefusal", () => {
	const updates = [
		{ oldId: OLD, newId: NEW, ref: "refs/heads/main" },
		{ oldId: OLD, newId: NEW, ref: "refs/heads/scout/fix" },
	];

	it("declines every ref the way a pre-receive hook does, naming the lane", () => {
		const report = pushRefusal(
			updates,
			new Set(["report-status"]),
			["refs/heads/main"],
			["scout/*"],
		).toString("utf8");
		expect(report).toContain("unpack ok\n");
		expect(report).toContain("ng refs/heads/main not granted: push scout/* here\n");
		expect(report).toContain("ng refs/heads/scout/fix held back with main\n");
		expect(report.endsWith("0000")).toBe(true);
		expect(report.startsWith("0000")).toBe(false);
	});

	it("wraps the report in a sideband when the client asked for one, with a line for the person", () => {
		const report = pushRefusal(
			updates,
			new Set(["report-status", "side-band-64k"]),
			["refs/heads/main"],
			["scout/*"],
		);
		// First packet is band 2: a notice git prints as `remote: ...`.
		const firstLength = Number.parseInt(report.subarray(0, 4).toString(), 16);
		expect(report[4]).toBe(2);
		expect(report.subarray(5, firstLength).toString("utf8")).toBe(
			"squad: main is not granted to this agent; push scout/* here\n",
		);
		// Second is band 1: the report itself, flush included, then the outer flush.
		expect(report[firstLength + 4]).toBe(1);
		const inner = report.subarray(
			firstLength + 5,
			firstLength + Number.parseInt(report.subarray(firstLength, firstLength + 4).toString(), 16),
		);
		expect(inner.toString("utf8")).toContain("ng refs/heads/main not granted");
		expect(inner.subarray(inner.length - 4).toString()).toBe("0000");
		expect(report.subarray(report.length - 4).toString()).toBe("0000");
	});

	it("says so when the grant lists nothing to push", () => {
		const report = pushRefusal(updates.slice(0, 1), new Set(), ["refs/heads/main"], []).toString(
			"utf8",
		);
		expect(report).toContain("not granted: nothing here may be pushed");
	});
});

describe("readPushHead", () => {
	it("stops at the flush and leaves the rest of the body to be piped", async () => {
		const body = new PassThrough();
		const head = push(["refs/heads/scout/fix"]);
		body.write(Buffer.concat([head, PACKFILE.subarray(0, 10)]));
		const read = await readPushHead(body);
		expect(read.commands.kind).toBe("commands");
		expect(read.ended).toBe(false);
		expect(read.bytes.length).toBe(head.length + 10);
		// What comes after is still there for the next reader.
		body.end(PACKFILE.subarray(10));
		const rest: Buffer[] = [];
		for await (const chunk of body) rest.push(chunk as Buffer);
		expect(Buffer.concat(rest).equals(PACKFILE.subarray(10))).toBe(true);
	});

	it("reads across chunks until the commands are whole", async () => {
		const body = new PassThrough();
		const head = push(["refs/heads/scout/fix", "refs/heads/scout/other"]);
		const pending = readPushHead(body);
		for (let at = 0; at < head.length; at += 7) body.write(head.subarray(at, at + 7));
		const read = await pending;
		expect(read.commands.kind).toBe("commands");
		expect(read.bytes.equals(head)).toBe(true);
	});

	it("reports a body that ended inside the commands", async () => {
		const body = new PassThrough();
		body.end(push(["refs/heads/scout/fix"]).subarray(0, 20));
		const read = await readPushHead(body);
		expect(read.ended).toBe(true);
		expect(read.commands).toMatchObject({ kind: "unreadable" });
	});

	it("says the body ended when a delete-only push has nothing after the flush", async () => {
		const body = new PassThrough();
		const head = Buffer.concat([pkt(`${OLD} ${ZERO} refs/heads/scout/old\0report-status`), FLUSH]);
		body.end(head);
		const read = await readPushHead(body);
		expect(read.commands.kind).toBe("commands");
		// The stream may settle on the data or on the end; both leave nothing to pipe.
		if (!read.ended) {
			const rest: Buffer[] = [];
			for await (const chunk of body) rest.push(chunk as Buffer);
			expect(Buffer.concat(rest).length).toBe(0);
		}
	});
});

describe("shortRef", () => {
	it("drops the heads prefix and nothing else", () => {
		expect(shortRef("refs/heads/scout/fix")).toBe("scout/fix");
		expect(shortRef("refs/tags/v1")).toBe("refs/tags/v1");
	});
});
