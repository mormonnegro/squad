import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerEngine } from "@squad/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildScreenImage } from "../src/build.ts";
import { DockerScreens } from "../src/screens.ts";
import { screenContainerName, screenVolumeName } from "../src/spec.ts";

const IMAGE = "squad/screen:itest";
const AGENT_ID = "itest";
const TEST_NETWORK = "squad-test-screen";

const engine = new DockerEngine();
const dockerUp = await engine.isAvailable();
const suite = dockerUp ? describe : describe.skip;

/** Kept inside the repo because Docker Desktop shares /Users and not every temporary directory. */
const pkiDir = join(process.cwd(), ".pki");
const caPath = join(pkiDir, "screen-itest-ca.crt");

suite("a screen against a live daemon", () => {
	const screens = new DockerScreens(engine, TEST_NETWORK, "squad-test", IMAGE);

	/**
	 * Waits for the line the screen prints when both its doors are open, and answers with the log.
	 *
	 * The log rather than a boolean, because what a caller does when this fails is read it: a browser
	 * that will not start says why in there, and an assertion on a boolean would throw that away.
	 */
	async function upAgain(): Promise<string> {
		const deadline = Date.now() + 120_000;
		for (;;) {
			const raw = await engine
				.requestRaw(
					"GET",
					`/containers/${screenContainerName(AGENT_ID, "squad-test")}/logs?stdout=1&stderr=1`,
				)
				.catch(() => Buffer.alloc(0));
			const log = raw.toString("utf8");
			if (log.includes("verbs on") || Date.now() > deadline) return log;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}

	beforeAll(async () => {
		await mkdir(pkiDir, { recursive: true });
		await writeFile(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
		await screens.destroy(AGENT_ID, { discardProfile: true });
		await engine.request("POST", "/networks/create", { Name: TEST_NETWORK, Driver: "bridge" });
	}, 120_000);

	afterAll(async () => {
		await screens.destroy(AGENT_ID, { discardProfile: true });
		await engine.request("DELETE", `/networks/${TEST_NETWORK}`).catch(() => {});
		await engine
			.request("DELETE", `/images/${encodeURIComponent(IMAGE)}?force=true`)
			.catch(() => {});
		await rm(caPath, { force: true });
	}, 120_000);

	/*
	 * The build is the first test because it is the first thing that happens on a real plane: nobody
	 * ships this image, and `/screen on` is what causes it to exist. A tar written by hand is being
	 * handed to Docker's own untar, and the only honest check of that is Docker accepting it.
	 */
	it("builds the browser image out of a tar this program wrote", async () => {
		const said: string[] = [];
		await buildScreenImage({
			engine,
			image: IMAGE,
			dir: new URL("../image", import.meta.url).pathname,
			say: (line) => said.push(line),
		});

		expect(await screens.imageId()).toBeDefined();
		expect(said.join("\n")).toContain("FROM");
	}, 900_000);

	it("comes up, and says so rather than leaving somebody to guess", async () => {
		await screens.create({
			agentId: AGENT_ID,
			proxyUrl: "http://itest:tok@egress:8080",
			caCertHostPath: caPath,
		});
		await screens.start(AGENT_ID);

		const status = await screens.status(AGENT_ID);
		expect(status?.running).toBe(true);
		// Read back off the container, because the container is the record of what the browser will
		// actually present at the proxy — whatever the configuration has since been edited to say.
		expect(status?.proxyUrl).toBe("http://itest:tok@egress:8080");

		expect(await upAgain()).toContain("verbs on");
	}, 180_000);

	it("refuses an agent that is not the one whose screen it is", async () => {
		// The door is on a network every sandbox shares. This is the whole of what keeps one agent out
		// of another's signed-in browser, so it is checked against the running thing and not a unit.
		const asked = await screens.exec(AGENT_ID, [
			"node",
			"-e",
			`fetch("http://127.0.0.1:7181", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer not-the-token" },
				body: JSON.stringify({ verb: "read" }),
			}).then((r) => process.stdout.write(String(r.status)))`,
		]);
		expect(asked.stdout).toBe("403");
	}, 60_000);

	/*
	 * A screen's second life, which is the one that broke.
	 *
	 * Chromium marks a profile as in use with symlinks naming the host holding it, and a container's
	 * host name is its id — so a replaced container finds its own profile locked by a machine that no
	 * longer exists, tries to put a dialog about it on a screen it does not have, and exits. Then it
	 * restarts, finds the same lock, and does it again. Every screen worked once and bricked on being
	 * recreated, which the plane does on every image change and every `/screen off` and on again.
	 *
	 * So this waits for the browser rather than only checking that a file survived. The file
	 * surviving was never the part in doubt.
	 */
	it("comes back with its login after the container is replaced", async () => {
		await screens.exec(AGENT_ID, ["sh", "-c", "echo signed-in > /home/screen/profile/proof"]);
		await screens.destroy(AGENT_ID);
		expect(await screens.status(AGENT_ID)).toBeUndefined();

		await screens.create({
			agentId: AGENT_ID,
			proxyUrl: "http://itest:tok@egress:8080",
			caCertHostPath: caPath,
		});
		await screens.start(AGENT_ID);
		const read = await screens.exec(AGENT_ID, ["cat", "/home/screen/profile/proof"]);
		expect(read.stdout.trim()).toBe("signed-in");
		expect(await upAgain()).toContain("verbs on");
	}, 180_000);

	it("takes the profile only when it is asked to", async () => {
		await screens.destroy(AGENT_ID, { discardProfile: true });
		const volume = await engine
			.request("GET", `/volumes/${encodeURIComponent(screenVolumeName(AGENT_ID, "squad-test"))}`)
			.catch(() => undefined);
		expect(volume).toBeUndefined();
	}, 60_000);
});
