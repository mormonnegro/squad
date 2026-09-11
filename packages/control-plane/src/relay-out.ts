import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { link } from "@squad/relay/link";
import { dialLocal } from "./control-client.ts";

/**
 * The plane's way of being reachable without being reachable.
 *
 * The console's port is on loopback and stays there, because the plane holds the Docker socket and
 * publishing it would be root on the internet. That leaves two honest ways in — a forwarded port, or
 * a name of its own with a certificate — and both of them ask something of the operator: an open
 * terminal, or a domain. This is the third, for everyone who has neither.
 *
 * It is a connection the plane opens outwards and keeps, which is why it works from behind a NAT
 * and why nothing here is published. What crosses it is sealed with a key derived from this plane's
 * own token, so the relay is a switchboard that cannot listen: what it is given is a room number,
 * one-way from that token, and ciphertext.
 *
 * Off unless the operator turns it on. A plane that phoned somewhere by default would be a plane
 * whose operator did not choose the one thing this whole design is about.
 */
export function relayOut(
	stateDir: string,
	origin: string,
	say: (line: string) => void,
): () => void {
	let live = true;
	let socket: Duplex | undefined;
	let held: Awaited<ReturnType<typeof link>> | undefined;
	// Doubling, and capped: a relay that is down comes back, and a plane that asked every second
	// while it was would be the reason it stayed down.
	let waitMs = 1_000;

	void (async () => {
		while (live) {
			try {
				await once();
				waitMs = 1_000;
			} catch (error) {
				if (!live) return;
				say(`relay: ${(error as Error).message} — trying again in ${Math.round(waitMs / 1000)}s`);
			}
			if (!live) return;
			await new Promise((go) => setTimeout(go, waitMs));
			waitMs = Math.min(waitMs * 2, 60_000);
		}
	})();

	/** One connection, from opening it to whatever ends it. */
	async function once(): Promise<void> {
		const secret = (await readFile(join(stateDir, "web.token"), "utf8")).trim();
		if (secret.length === 0) throw new Error("no token yet");

		const control = await dialLocal(stateDir)();
		socket = control;
		let rest = "";
		// The protocol is newline-delimited, and a socket hands over whatever arrived — which is not
		// lines. Reassembled here so that what is sealed is one protocol line and not half of one.
		control.on("data", (chunk: Buffer) => {
			rest += chunk.toString("utf8");
			let cut = rest.indexOf("\n");
			while (cut !== -1) {
				const line = rest.slice(0, cut);
				rest = rest.slice(cut + 1);
				if (line.length > 0) void held?.send(line).catch(() => {});
				cut = rest.indexOf("\n");
			}
		});

		const gone = new Promise<void>((settle, fail) => {
			control.once("close", () => settle());
			control.once("error", fail);
			void link({
				origin,
				secret,
				side: "plane",
				onLine: (line) => control.write(`${line}\n`),
				onDown: (why) => fail(why),
				onRefused: (why) => say(`relay: dropped a frame — ${why.message}`),
			}).then(
				(opened) => {
					held = opened;
					say(`relay: reachable through ${origin}`);
				},
				(why: Error) => fail(why),
			);
		});

		try {
			await gone;
		} finally {
			held?.close();
			held = undefined;
			control.destroy();
			socket = undefined;
		}
	}

	return () => {
		live = false;
		held?.close();
		socket?.destroy();
	};
}
