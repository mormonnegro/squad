import { describe, expect, it } from "vitest";
import {
	type Credential,
	credentialIn,
	filledSaid,
	hostOf,
	itemFor,
	readForm,
	type TheForm,
	type VaultItem,
} from "../image/logins.ts";

const spot = (filled = false) => ({ at: { x: 10, y: 20 }, filled });
const form = (parts: Partial<TheForm>): TheForm => ({
	username: undefined,
	password: undefined,
	code: undefined,
	...parts,
});

describe("which entry is for this site", () => {
	const vault: readonly VaultItem[] = [
		{ id: "a", title: "GitHub", urls: [{ href: "https://github.com/login", primary: true }] },
		{ id: "b", title: "Google", urls: [{ href: "https://accounts.google.com" }] },
		{ id: "c", title: "No URL on it" },
	];

	it("matches on the address rather than on whatever the entry was called", () => {
		expect(itemFor("github.com", vault)).toMatchObject({ id: "a" });
		expect(itemFor("https://github.com/settings/keys", vault)).toMatchObject({ id: "a" });
	});

	/** A vault entry for the sign-in host is the entry for the site it signs you into. */
	it("counts a subdomain as the same site", () => {
		expect(itemFor("google.com", vault)).toMatchObject({ id: "b" });
	});

	it("says so in words when there is nothing for that site", () => {
		expect(itemFor("stripe.com", vault)).toBe("Nothing in the vault is for stripe.com.");
	});

	/** Two accounts on one host is the case where picking one is picking wrong half the time. */
	it("refuses to guess between two accounts on the same site", () => {
		const two = [
			...vault,
			{ id: "d", title: "GitHub (work)", urls: [{ href: "https://github.com" }] },
		];

		expect(itemFor("github.com", two)).toContain("2 entries for github.com");
	});
});

describe("what is in the entry", () => {
	it("finds the three fields by what they are for", () => {
		const raw = JSON.stringify({
			fields: [
				{ id: "username", purpose: "USERNAME", value: "sebastian" },
				{ id: "password", purpose: "PASSWORD", value: "hunter2" },
				{ id: "otp", type: "OTP", totp: "123456" },
			],
		});

		expect(credentialIn(raw)).toEqual({
			username: "sebastian",
			password: "hunter2",
			otp: "123456",
		});
	});

	/** An imported vault has neither a purpose nor a tidy label, and still has to work. */
	it("falls back to the label when nothing says what a field is for", () => {
		const raw = JSON.stringify({
			fields: [
				{ label: "correo", value: "hola@example.com" },
				{ label: "contraseña", value: "hunter2" },
			],
		});

		expect(credentialIn(raw)).toMatchObject({ username: "hola@example.com", password: "hunter2" });
	});

	it("says so rather than throwing when the vault answers something else", () => {
		expect(credentialIn("not json")).toBe(
			"The vault answered something this screen could not read.",
		);
	});
});

describe("what the page has to fill", () => {
	it("reads the three boxes the script found", () => {
		const raw = JSON.stringify({ username: spot(), password: spot(true), code: null });

		expect(readForm(raw)).toEqual({ username: spot(), password: spot(true), code: undefined });
	});

	it("is nothing when the page could not be asked", () => {
		expect(readForm(undefined)).toBeUndefined();
		expect(readForm("{")).toBeUndefined();
	});
});

describe("what it says afterwards", () => {
	const full: Credential = { username: "sebastian", password: "hunter2", otp: "123456" };

	/** Every one of these says what happened to the page and none of them says what was typed. */
	it("names what it filled and never what with", () => {
		const said = filledSaid(form({ username: spot(), password: spot(), code: spot() }), full);

		expect(said).toContain("the name, the password and the code");
		expect(said).not.toContain("hunter2");
	});

	it("says a two-step page got the half it had", () => {
		expect(filledSaid(form({ username: spot() }), full)).toContain("Filled in the name.");
	});

	it("says when the page is not a sign-in at all", () => {
		expect(filledSaid(form({}), full)).toContain("nothing on this page to sign in with");
	});

	it("says when the entry has nothing that fits", () => {
		const bare: Credential = { username: undefined, password: undefined, otp: undefined };

		expect(filledSaid(form({ password: spot() }), bare)).toContain("nothing that fits");
	});

	it("reads a host out of an address the way a vault does", () => {
		expect(hostOf("https://www.github.com/login")).toBe("github.com");
		expect(hostOf("github.com")).toBe("github.com");
	});
});
