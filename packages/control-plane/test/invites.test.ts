import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Invites } from "../src/invites.ts";

let dir = "";
let invites: Invites;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "squad-invites-"));
	invites = new Invites(join(dir, "invites.json"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * The thing that did not exist before: a way in that is for somebody, runs out, and can be called
 * off on its own. What it replaces is handing out the plane's own key, which does none of the three.
 */
describe("a way in, handed to one person", () => {
	it("hands the secret over once and never writes it down", async () => {
		const { invite, secret } = await invites.issue({ label: "for Nico" });

		expect(secret.length).toBeGreaterThan(20);
		expect(invite.label).toBe("for Nico");
		expect(invite.left).toBe(1);
		expect(invite.admitted).toEqual([]);

		// The list a screen reads carries no hash, and the file carries no secret.
		expect(JSON.stringify(await invites.all())).not.toContain("hash");
		const written = await readFile(join(dir, "invites.json"), "utf8");
		expect(written).not.toContain(secret);
		expect(written).toContain("hash");
	});

	it("recognises the one it handed out, and nothing else", async () => {
		const { invite, secret } = await invites.issue({ label: "for Nico" });

		expect((await invites.spend(secret))?.id).toBe(invite.id);
		expect(await invites.spend("not-a-secret")).toBeUndefined();
		expect(await invites.spend("")).toBeUndefined();
		expect(await invites.spend(undefined)).toBeUndefined();
	});

	// The whole point of one use: a link that has been used is a link that has stopped working, so
	// somebody who forwards it on has forwarded nothing.
	it("stops admitting anybody once it has been spent", async () => {
		const { invite, secret } = await invites.issue({ label: "for Nico" });

		await invites.spent(invite.id, "device-1");

		expect(await invites.spend(secret)).toBeUndefined();
		const [only] = await invites.all();
		expect(only?.left).toBe(0);
		expect(only?.admitted).toEqual(["device-1"]);
	});

	it("lets one made for several be spent several times, and not once more", async () => {
		const { invite, secret } = await invites.issue({ label: "the team", uses: 2 });

		await invites.spent(invite.id, "one");
		expect(await invites.spend(secret)).toBeDefined();
		await invites.spent(invite.id, "two");

		expect(await invites.spend(secret)).toBeUndefined();
		expect((await invites.all())[0]?.admitted).toEqual(["one", "two"]);
	});

	it("always runs out: the choice is how soon, never whether", async () => {
		await invites.issue({ label: "for Nico", lasts: "hour" });
		const [only] = await invites.all();

		const lasts = Date.parse(only?.expiresAt ?? "") - Date.parse(only?.createdAt ?? "");
		expect(lasts).toBe(60 * 60_000);
	});

	// The clock, tested the only way a clock can be without one: the same store, with the expiry
	// written into the past, which is what it will read tomorrow.
	it("refuses one whose hour has passed", async () => {
		const { secret } = await invites.issue({ label: "for Nico", lasts: "hour" });

		const path = join(dir, "invites.json");
		const held = JSON.parse(await readFile(path, "utf8")) as { expiresAt: string }[];
		const first = held[0];
		if (first !== undefined) first.expiresAt = new Date(Date.now() - 60_000).toISOString();
		await writeFile(path, JSON.stringify(held), "utf8");

		expect(await new Invites(path).spend(secret)).toBeUndefined();
	});

	/**
	 * Calling one off stops the next person, not the one already in.
	 *
	 * Those are browsers, they are in the device list under their own names, and taking one out is
	 * what that list is for — an invitation that dragged its devices out with it would be one act
	 * doing two things, and the second one silently.
	 */
	it("calls one off without touching what it already let in", async () => {
		const { invite, secret } = await invites.issue({ label: "for Nico", uses: 5 });
		await invites.spent(invite.id, "device-1");

		expect(await invites.revoke(invite.id)).toBe(true);

		expect(await invites.spend(secret)).toBeUndefined();
		expect(await invites.all()).toEqual([]);
		expect(await invites.revoke(invite.id)).toBe(false);
	});

	it("keeps a spent one on the list, because somebody is about to ask what just happened", async () => {
		const { invite } = await invites.issue({ label: "for Nico" });
		await invites.spent(invite.id, "device-1");

		await invites.tidy();

		expect((await invites.all()).map((one) => one.label)).toEqual(["for Nico"]);
	});
});
