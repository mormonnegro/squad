import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from "../src/signature.ts";
import { asked, authentic, deliveryIn } from "../src/signer.ts";

const SECRET = "whsec_test";
const NOW = new Date("2026-09-13T10:00:00.000Z");
const SECONDS = Math.floor(NOW.getTime() / 1000).toString();

const presented = (headers: Record<string, string | undefined>, body: string) => ({
	headers,
	body,
	secret: SECRET,
	now: NOW,
	toleranceSeconds: 300,
});

describe("who signed a delivery", () => {
	it("takes this plane's own signature", () => {
		const body = '{"type":"squad.test"}';
		expect(
			authentic(
				"squad",
				presented(
					{ [TIMESTAMP_HEADER]: SECONDS, [SIGNATURE_HEADER]: sign(SECRET, SECONDS, body) },
					body,
				),
			),
		).toBe(true);
	});

	/**
	 * Stripe signs the timestamp, a dot and the body — which is the same string this plane signs.
	 * What differs is that both numbers arrive in one header, and that there may be several while a
	 * secret is being rotated.
	 */
	it("takes Stripe's, including a second signature during a rotation", () => {
		const body = '{"id":"evt_1","type":"customer.subscription.deleted"}';
		const v1 = createHmac("sha256", SECRET).update(`${SECONDS}.${body}`).digest("hex");
		expect(
			authentic("stripe", presented({ "stripe-signature": `t=${SECONDS},v1=${v1}` }, body)),
		).toBe(true);
		expect(
			authentic(
				"stripe",
				presented({ "stripe-signature": `t=${SECONDS},v1=deadbeef,v1=${v1}` }, body),
			),
		).toBe(true);
	});

	it("refuses a Stripe delivery signed with another secret, or kept until it is stale", () => {
		const body = '{"id":"evt_1","type":"charge.refunded"}';
		const wrong = createHmac("sha256", "whsec_other").update(`${SECONDS}.${body}`).digest("hex");
		expect(
			authentic("stripe", presented({ "stripe-signature": `t=${SECONDS},v1=${wrong}` }, body)),
		).toBe(false);

		const old = (Math.floor(NOW.getTime() / 1000) - 4000).toString();
		const signed = createHmac("sha256", SECRET).update(`${old}.${body}`).digest("hex");
		expect(
			authentic("stripe", presented({ "stripe-signature": `t=${old},v1=${signed}` }, body)),
		).toBe(false);
	});

	it("takes GitHub's, which signs the body and nothing else", () => {
		const body = '{"action":"opened"}';
		const digest = createHmac("sha256", SECRET).update(body).digest("hex");
		expect(
			authentic("github", presented({ "x-hub-signature-256": `sha256=${digest}` }, body)),
		).toBe(true);
		expect(authentic("github", presented({ "x-hub-signature-256": "sha256=nope" }, body))).toBe(
			false,
		);
	});

	it("refuses anything with nothing presented at all", () => {
		for (const signer of ["squad", "stripe", "github"] as const) {
			expect(authentic(signer, presented({}, "{}"))).toBe(false);
		}
	});
});

describe("what arrived", () => {
	it("reads Stripe's kind and id out of the body", () => {
		expect(
			deliveryIn("stripe", {}, '{"id":"evt_1","type":"customer.subscription.deleted"}'),
		).toEqual({ kind: "customer.subscription.deleted", id: "evt_1" });
	});

	it("reads GitHub's out of its headers", () => {
		expect(
			deliveryIn("github", { "x-github-event": "push", "x-github-delivery": "abc" }, "{}"),
		).toEqual({ kind: "push", id: "abc" });
	});

	it("says nothing rather than guessing at a body that is not JSON", () => {
		expect(deliveryIn("stripe", {}, "hola")).toEqual({ kind: undefined, id: undefined });
	});
});

describe("which of them were asked for", () => {
	it("takes everything when nothing was said", () => {
		expect(asked([], "anything")).toBe(true);
		expect(asked([], undefined)).toBe(true);
	});

	it("matches a name exactly, and a prefix with a star", () => {
		expect(asked(["customer.subscription.deleted"], "customer.subscription.deleted")).toBe(true);
		expect(asked(["customer.subscription.deleted"], "customer.subscription.updated")).toBe(false);
		expect(asked(["customer.subscription.*"], "customer.subscription.updated")).toBe(true);
		expect(asked(["customer.*", "charge.refunded"], "charge.refunded")).toBe(true);
	});

	// A delivery whose kind cannot be read cannot be said to be one of the ones asked for, and the
	// safe answer to that is the one that does not spend a turn.
	it("refuses what it cannot name when something was asked for", () => {
		expect(asked(["charge.refunded"], undefined)).toBe(false);
	});
});
