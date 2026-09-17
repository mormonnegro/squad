import { describe, expect, it } from "vitest";
import {
	type Credential,
	credentialIn,
	filledSaid,
	hostOf,
	itemArgs,
	itemFor,
	openedFor,
	readForm,
	type TheForm,
	type VaultItem,
} from "../image/logins.ts";
import { readSite, siteHost } from "../src/sites.ts";

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

/**
 * The two halves of one rule, held against each other.
 *
 * The plane writes down the sites an agent may sign into; the browser decides whether the site it
 * is on is one of them. They are two copies of the same function in two packages — the image cannot
 * import out of its own build context — and the day they disagree is the day an operator opens
 * `github.com` at the console and their agent is refused at github.com with nothing to explain it.
 */
describe("the plane and the browser agree on what a site is", () => {
	const addresses = [
		"github.com",
		"https://github.com/settings/keys",
		"www.github.com",
		"WWW.GitHub.com",
		"https://accounts.google.com/signin",
		"mail.google.com",
		"not a host",
		"",
	];

	it("reads the same host out of every address either of them will meet", () => {
		for (const address of addresses) expect(siteHost(address)).toBe(hostOf(address));
	});
});

/**
 * What the console refuses to write down, which is a different question from what a host is.
 *
 * A mistyped host is not refused anywhere later: it is a line in a list that quietly matches no
 * page, and the operator finds out when their agent says it was not let in. So it is caught while
 * the person who typed it is still looking at the screen.
 */
describe("what may be opened at the console", () => {
	it("takes a host, with or without everything around it", () => {
		expect(readSite("github.com")).toBe("github.com");
		expect(readSite("https://github.com/settings/keys")).toBe("github.com");
		expect(readSite("www.GitHub.com")).toBe("github.com");
	});

	it("turns away what is not one", () => {
		expect(readSite("")).toBeUndefined();
		expect(readSite("localhost")).toBeUndefined();
		expect(readSite("not a host")).toBeUndefined();
		expect(readSite("github .com")).toBeUndefined();
		expect(readSite(".com")).toBeUndefined();
	});
});

/**
 * The door the agent knocks at, which is the list and not the vault.
 *
 * Every case here is a real sign-in: the form is almost never on the host somebody typed, and a
 * rule that refused those would be a permission an operator granted and an agent that still says
 * it was not let in.
 */
describe("whether a page is one the operator opened", () => {
	const opened = ["github.com", "mail.google.com"];

	it("lets in the site itself, however the address was written", () => {
		expect(openedFor("github.com", opened)).toBe(true);
		expect(openedFor("https://github.com/login", opened)).toBe(true);
		expect(openedFor("www.github.com", opened)).toBe(true);
	});

	it("lets in the subdomain the sign-in form actually lives on", () => {
		expect(openedFor("gist.github.com", opened)).toBe(true);
	});

	// The other direction is a wider grant than the one that was made: opening one host of a company
	// is opening that host, and reading it as the company is an operator's typing turned into more
	// than they said.
	it("does not let in the parent of a site that was opened", () => {
		expect(openedFor("google.com", opened)).toBe(false);
		expect(openedFor("drive.google.com", opened)).toBe(false);
	});

	it("lets in nothing at all when nothing was opened", () => {
		expect(openedFor("github.com", [])).toBe(false);
		expect(openedFor("", opened)).toBe(false);
	});

	// The host it is about is the page, not a string somebody could make look like one: a site named
	// to end in the opened one is not a subdomain of it.
	it("is not fooled by a name that merely ends the same way", () => {
		expect(openedFor("notgithub.com", opened)).toBe(false);
		expect(openedFor("github.com.evil.example", opened)).toBe(false);
	});
});

/**
 * How one entry is asked for, which is not the question a person at a terminal asks.
 *
 * A person is signed into an account and an id is enough. A service account is scoped to vaults and
 * refuses an id on its own — "a vault query must be provided when this command is called by a
 * service account" — which is exactly the failure this covers, found the hard way against a live
 * vault after the agent could only report that the entry would not come out.
 */
describe("asking the vault for one entry", () => {
	const item = { id: "abc123", title: "X", vault: { id: "v1", name: "Squad" } };

	it("names the vault the listing already said it was in", () => {
		expect(itemArgs(item)).toEqual([
			"item",
			"get",
			"abc123",
			"--vault",
			"v1",
			"--format",
			"json",
			"--reveal",
		]);
	});

	// The id is what the CLI is sure about; a name is whatever somebody typed and can be two things.
	it("falls back to the vault's name when there is no id", () => {
		expect(itemArgs({ id: "abc123", title: "X", vault: { name: "Squad" } })).toContain("Squad");
	});

	// An older listing, or a token that is somebody's own account rather than a service account: the
	// id alone works there, and sending an empty --vault would break what used to work.
	it("asks by id alone when the listing said no vault", () => {
		expect(itemArgs({ id: "abc123", title: "X" })).not.toContain("--vault");
		expect(itemArgs({ id: "abc123", title: "X", vault: {} })).not.toContain("--vault");
	});

	// Concealed fields come back as a placeholder without this, and a placeholder typed into a login
	// is a password box with the word "concealed" in it.
	it("always asks for the values rather than their placeholders", () => {
		expect(itemArgs(item)).toContain("--reveal");
	});
});
