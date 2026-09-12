import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Devices, nameFromAgent } from "../src/devices.ts";

let where: string;
let devices: Devices;

beforeEach(async () => {
	where = await mkdtemp(join(tmpdir(), "squad-devices-"));
	devices = new Devices(join(where, "devices.json"));
});

afterEach(async () => {
	await rm(where, { recursive: true, force: true });
});

describe("letting a browser in", () => {
	it("hands the secret back once and recognises it after", async () => {
		const { device, secret } = await devices.issue("Chrome on a Mac");
		expect(secret.length).toBeGreaterThan(20);
		expect((await devices.whose(secret))?.id).toBe(device.id);
	});

	it("does not know a secret it never issued", async () => {
		await devices.issue("Chrome on a Mac");
		expect(await devices.whose("not a secret")).toBeUndefined();
		expect(await devices.whose("")).toBeUndefined();
		expect(await devices.whose(undefined)).toBeUndefined();
	});

	// The point of a list over a secret: a file somebody reads is a list of things that were let in,
	// not a list of ways in.
	it("writes down a hash and never the secret", async () => {
		const { secret } = await devices.issue("Chrome on a Mac");
		const written = await readFile(join(where, "devices.json"), "utf8");
		expect(written).not.toContain(secret);
		expect(JSON.parse(written)[0].hash).toHaveLength(64);
	});

	it("keeps them apart", async () => {
		const one = await devices.issue("one");
		const other = await devices.issue("other");
		expect((await devices.whose(one.secret))?.id).toBe(one.device.id);
		expect((await devices.whose(other.secret))?.id).toBe(other.device.id);
		expect(one.device.id).not.toBe(other.device.id);
	});
});

describe("taking one out", () => {
	// The whole difference between a list and a secret, and the reason for all of this.
	it("stops that one and leaves the rest alone", async () => {
		const one = await devices.issue("one");
		const other = await devices.issue("other");
		expect(await devices.revoke(one.device.id)).toBe(true);
		expect(await devices.whose(one.secret)).toBeUndefined();
		expect((await devices.whose(other.secret))?.id).toBe(other.device.id);
	});

	it("says so when there was nothing to take out", async () => {
		expect(await devices.revoke("nobody")).toBe(false);
	});
});

describe("the list", () => {
	it("carries no hashes into anything that might print it", async () => {
		await devices.issue("one");
		const [only] = await devices.all();
		expect(only).toBeDefined();
		expect(Object.keys(only as object)).toEqual(["id", "name", "createdAt", "lastSeenAt"]);
	});

	it("survives a restart, because the point is that it outlives the process", async () => {
		const { secret, device } = await devices.issue("Chrome on a Mac");
		const later = new Devices(join(where, "devices.json"));
		expect((await later.whose(secret))?.id).toBe(device.id);
		expect((await later.all()).map((d) => d.name)).toEqual(["Chrome on a Mac"]);
	});

	it("can be renamed, because a guess is a label and not an identity", async () => {
		const { device, secret } = await devices.issue("a browser");
		expect(await devices.rename(device.id, "the laptop")).toBe(true);
		expect((await devices.whose(secret))?.name).toBe("the laptop");
	});

	it("reads an absent or broken file as nobody", async () => {
		expect(await new Devices(join(where, "nothing.json")).all()).toEqual([]);
	});
});

describe("naming a browser nobody has named", () => {
	it("finds the two useful words in a paragraph of archaeology", () => {
		expect(
			nameFromAgent(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
			),
		).toBe("Chrome on a Mac");
		expect(
			nameFromAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Safari/604.1"),
		).toBe("Safari on an iPhone");
		expect(nameFromAgent(undefined)).toBe("a browser");
	});
});
