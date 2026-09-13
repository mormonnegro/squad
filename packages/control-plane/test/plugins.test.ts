import { describe, expect, it } from "vitest";
import { readName } from "../src/mcp.ts";
import { nameFor, PLUGINS, pluginAt, pluginOf, SHELVES, serverOf } from "../src/plugins.ts";

describe("the shelf of plugins", () => {
	it("gives every one a name the plane would accept and the model can spell", () => {
		for (const plugin of PLUGINS) {
			// The id becomes the connection's name, which becomes half of every tool identifier the
			// model has to produce exactly. A catalogue entry that cannot be added is a button that
			// fails on the machine of whoever presses it first.
			expect(readName(plugin.id), plugin.id).toBeUndefined();
		}
	});

	it("names each one once", () => {
		expect(new Set(PLUGINS.map((one) => one.id)).size).toBe(PLUGINS.length);
	});

	/**
	 * The one whose account is at a provider that advertises nothing.
	 *
	 * Every other login here discovers where to go by asking the server. Google is not a server: it
	 * is an API this plane reaches on an agent's behalf, and its two addresses have not moved in a
	 * decade. So they are written down, with the scope — reading, and nothing that sends.
	 */
	it("carries the addresses for the one that publishes none", () => {
		const gmail = pluginOf("gmail");

		// A process rather than a place: it reaches Gmail's own API with an app the operator made, and
		// carries nothing — the proxy writes the token on, for one host, one path, and `GET`.
		expect(gmail?.runs).toEqual(["squad-gmail"]);
		expect(serverOf(gmail as never)).toEqual({
			transport: "stdio",
			command: "squad-gmail",
			args: [],
		});
		expect(gmail?.reaches).toEqual({
			host: "gmail.googleapis.com",
			pathPrefix: "/gmail/v1/users/me/",
			methods: ["GET"],
		});
		expect(gmail?.oauth?.authorizationUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(gmail?.oauth?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
		// Without the first there is no refresh token at all, and without the second there is one only
		// on the very first consent — which is a login that stops working within the hour.
		expect(gmail?.oauth?.extra).toEqual({ access_type: "offline", prompt: "consent" });
		expect(gmail?.oauth?.steps.length).toBeGreaterThan(2);
	});

	it("reaches each one over https, since the proxy carries nothing else worth carrying", () => {
		for (const plugin of PLUGINS) {
			expect(plugin.url.startsWith("https://"), plugin.url).toBe(true);
			expect(new URL(plugin.url).hostname.length).toBeGreaterThan(0);
		}
	});

	it("puts every one under a group the screen knows how to draw", () => {
		const groups = new Set(SHELVES.map(([shelf]) => shelf));
		for (const plugin of PLUGINS) expect(groups.has(plugin.shelf), plugin.id).toBe(true);
	});

	it("says something about each one, and where its mark is drawn from", () => {
		for (const plugin of PLUGINS) {
			expect(plugin.does.length, plugin.id).toBeGreaterThan(10);
			expect(plugin.mark, plugin.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
		}
	});

	it("hands the shelf underneath a server it already knows how to store", () => {
		const stripe = pluginOf("stripe");
		expect(stripe).toBeDefined();
		expect(serverOf(stripe as never)).toEqual({
			transport: "http",
			url: "https://mcp.stripe.com",
		});
	});

	it("has nothing under a name nobody shelved", () => {
		expect(pluginOf("not-a-plugin")).toBeUndefined();
	});
});

/**
 * One plugin is not one connection, and this is the whole of what that costs.
 *
 * Two Stripe accounts are two connections, two tokens and two names, and the second one has to be
 * named without asking: whoever is connecting it is answering "which account", not "what shall we
 * call it". The first takes the plain name because that is the one that gets typed.
 */
describe("naming one more copy", () => {
	it("takes the plain name while it is free", () => {
		expect(nameFor("stripe", [])).toBe("stripe");
		expect(nameFor("stripe", ["linear", "notion"])).toBe("stripe");
	});

	it("numbers the ones after it, counting past the numbers already taken", () => {
		expect(nameFor("stripe", ["stripe"])).toBe("stripe-2");
		expect(nameFor("stripe", ["stripe", "stripe-2"])).toBe("stripe-3");
		expect(nameFor("stripe", ["stripe", "stripe-3"])).toBe("stripe-2");
	});

	it("still answers with something the plane accepts when a hundred are held", () => {
		const taken = ["stripe", ...Array.from({ length: 99 }, (_, at) => `stripe-${at + 2}`)];
		expect(readName(nameFor("stripe", taken))).toBeUndefined();
	});
});
