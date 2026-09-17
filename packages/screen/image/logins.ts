/**
 * Signing in, without the credential ever leaving this container.
 *
 * The screen exists because a logged-in browser is a cookie jar and a cookie jar in the sandbox is a
 * file the agent can read. This is the same argument one step earlier: a password in the sandbox is
 * a password the agent holds, and an operator who pasted one into a chat has handed it over for
 * good. So the vault is opened here, by a `op` that reads a service-account token this container has
 * and the agent has no path to, and what crosses into the page is keystrokes.
 *
 * What the agent may ask for is a host — "sign me into github.com" — and never an item. It cannot
 * name a vault entry, cannot list what is in there, and cannot ask for a site its operator has not
 * opened: the list of those is pushed in by the plane and is checked here, on the door the agent
 * knocks at. The reply it gets says whether it worked and nothing else; the password is not in the
 * answer, not in the page reading afterwards — a filled password field reads as `•••` — and not in
 * the transcript.
 */

/** What a login needs, out of whatever the vault had. Any of them may be missing. */
export interface Credential {
	readonly username: string | undefined;
	readonly password: string | undefined;
	/** The current code, when the item has one. The half of a login that wastes the most time. */
	readonly otp: string | undefined;
}

/** One entry as `op item list --format json` gives it, cut down to what is used here. */
export interface VaultItem {
	readonly id: string;
	readonly title: string;
	readonly urls?: readonly { readonly href?: string; readonly primary?: boolean }[];
	/**
	 * Which vault it is in, which a service account has to be told even when it can only read one.
	 *
	 * Not a nicety of ours: `op item get <id>` refuses outright when the caller is a service account
	 * and no vault was named — "a vault query must be provided when this command is called by a
	 * service account". The listing already answers it, so nothing has to be asked twice.
	 */
	readonly vault?: { readonly id?: string; readonly name?: string };
}

/**
 * How to ask for one entry, which is not the same question a person asks.
 *
 * A person running `op` is signed into an account and one id is enough. A service account is not: it
 * is scoped to vaults, and reading an item means naming the one it is in. The id is preferred over
 * the name because a name is whatever somebody typed and can be two things at once.
 */
export function itemArgs(item: VaultItem): readonly string[] {
	const at = item.vault?.id ?? item.vault?.name;
	return [
		"item",
		"get",
		item.id,
		...(at === undefined || at === "" ? [] : ["--vault", at]),
		"--format",
		"json",
		// Concealed fields come back as a placeholder without this, and a placeholder typed into a
		// login is a password box with the word "concealed" in it.
		"--reveal",
	];
}

/** The site an address is for, which is what a vault entry and a page have in common. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return url
			.trim()
			.replace(/^www\./, "")
			.toLowerCase();
	}
}

/**
 * Which entry is the one for this site.
 *
 * By the addresses on the entry rather than by its title, because a title is whatever somebody typed
 * — "Google (work)", "gh" — and an address is the thing the site and the vault actually agree on. A
 * site with two entries is a question rather than a guess: two accounts on one host is exactly the
 * case where picking one for somebody is picking wrong half the time.
 */
export function itemFor(host: string, items: readonly VaultItem[]): VaultItem | string {
	const wanted = hostOf(host);
	if (wanted === "") return "There is no site to sign into here.";
	const found = items.filter((item) =>
		(item.urls ?? []).some((url) => {
			const at = hostOf(url.href ?? "");
			return at === wanted || at.endsWith(`.${wanted}`) || wanted.endsWith(`.${at}`);
		}),
	);
	const first = found[0];
	if (first === undefined) return `Nothing in the vault is for ${wanted}.`;
	if (found.length > 1) {
		return `The vault has ${found.length} entries for ${wanted}: ${found
			.map((item) => item.title)
			.join(", ")}. Say which one at the console.`;
	}
	return first;
}

/**
 * Whether this page is one of the sites the operator opened for this agent.
 *
 * A subdomain of an opened site counts, and that is the whole of the rule worth arguing about. A
 * sign-in almost never happens on the host somebody types: they open `google.com` and the form is
 * at `accounts.google.com`, they open `atlassian.com` and land on `id.atlassian.com`. An exact
 * match would refuse every one of those, and what the operator would see is a permission they
 * granted and an agent that says it was not let in.
 *
 * It does not go the other way. Opening `id.atlassian.com` is opening that and not the company:
 * what an operator names is the most a grant can be, never the least.
 */
export function openedFor(host: string, opened: readonly string[]): boolean {
	const wanted = hostOf(host);
	if (wanted === "") return false;
	return opened.some((one) => {
		const site = hostOf(one);
		return site !== "" && (wanted === site || wanted.endsWith(`.${site}`));
	});
}

/** One field of an entry, as `op item get --format json --reveal` gives it. */
interface VaultField {
	readonly id?: string;
	readonly label?: string;
	readonly purpose?: string;
	readonly type?: string;
	readonly value?: string;
	readonly totp?: string;
}

/**
 * The three things out of an entry, found by what a field is for rather than by what it is called.
 *
 * `purpose` is 1Password's own answer to "which of these is the password", and it is right when it
 * is there. The id and the label are the fallbacks, in that order, because a vault that has been
 * imported from somewhere else often has neither purpose nor a tidy label.
 */
export function credentialIn(raw: string): Credential | string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "The vault answered something this screen could not read.";
	}
	const fields = ((parsed as { fields?: VaultField[] }).fields ?? []).filter(
		(field) => typeof field === "object" && field !== null,
	);
	const by = (...names: readonly string[]): string | undefined => {
		for (const field of fields) {
			const purpose = (field.purpose ?? "").toLowerCase();
			const id = (field.id ?? "").toLowerCase();
			const label = (field.label ?? "").toLowerCase();
			if (names.includes(purpose) || names.includes(id) || names.includes(label)) {
				if (typeof field.value === "string" && field.value !== "") return field.value;
			}
		}
		return undefined;
	};
	const otp = fields.find((field) => (field.type ?? "").toUpperCase() === "OTP")?.totp;
	return {
		username: by("username", "email", "user", "usuario", "correo"),
		password: by("password", "contraseña"),
		otp: typeof otp === "string" && otp !== "" ? otp : undefined,
	};
}

/**
 * What is on the page to fill in, found the way a password manager finds it.
 *
 * A password box is unambiguous — there is one kind of input that hides what you type — and the
 * name that goes with it is the text box above it, which is what a form is. Everything cleverer
 * than that is a heuristic for the same answer: two-step sign-ins show one box at a time, so a page
 * with only a name on it is filled with the name and submitted, and the password lands on the next
 * one.
 *
 * Nothing here reads a value back. It says which boxes it found and whether they are filled, and a
 * screen that could report what is in a password field would be the leak this whole arrangement is
 * built to avoid.
 */
export const FORM_SCRIPT = `(() => {
	const shown = (el) => {
		const box = el.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) return false;
		const style = getComputedStyle(el);
		return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
	};
	const inputs = [...document.querySelectorAll("input")].filter(
		(el) => !el.disabled && !el.readOnly && shown(el),
	);
	const at = (el) => {
		const box = el.getBoundingClientRect();
		return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
	};
	const password = inputs.find((el) => el.type === "password");
	const codeish = /otp|one-?time|2fa|totp|verification|c[oó]digo/i;
	const code = inputs.find(
		(el) =>
			el.autocomplete === "one-time-code" ||
			codeish.test(el.name + " " + el.id + " " + (el.getAttribute("aria-label") || "") + " " + (el.placeholder || "")),
	);
	// The name box is the text box in front of the password one, which is what a form looks like. On
	// a page with no password box at all it is whatever single text box is being asked for, which is
	// the first half of a two-step sign-in.
	const named = inputs.filter(
		(el) => ["text", "email", "tel", ""].includes(el.type) && el !== code,
	);
	const before = password === undefined ? named : named.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
	const username = before[before.length - 1] ?? (password === undefined ? named[0] : undefined);
	return JSON.stringify({
		username: username === undefined ? null : { at: at(username), filled: username.value !== "" },
		password: password === undefined ? null : { at: at(password), filled: password.value !== "" },
		code: code === undefined ? null : { at: at(code), filled: code.value !== "" },
	});
})()`;

/** Where the boxes are on the screen right now, and whether anything is in them already. */
export interface TheForm {
	readonly username: Spot | undefined;
	readonly password: Spot | undefined;
	readonly code: Spot | undefined;
}

export interface Spot {
	readonly at: { readonly x: number; readonly y: number };
	readonly filled: boolean;
}

export function readForm(raw: unknown): TheForm | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const parsed = JSON.parse(raw) as Record<string, Spot | null>;
		return {
			username: parsed.username ?? undefined,
			password: parsed.password ?? undefined,
			code: parsed.code ?? undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * What was filled, said in the words the operator and the agent both get.
 *
 * Every one of these says what happened to the page and none of them says what was typed. "Signed
 * in" is not among them either: what this did is fill boxes, and whether the site accepted them is
 * a question about the page afterwards.
 */
export function filledSaid(form: TheForm, credential: Credential): string {
	const did: string[] = [];
	if (form.username !== undefined && credential.username !== undefined) did.push("the name");
	if (form.password !== undefined && credential.password !== undefined) did.push("the password");
	if (form.code !== undefined && credential.otp !== undefined) did.push("the code");
	if (did.length === 0) {
		if (form.username === undefined && form.password === undefined && form.code === undefined) {
			return "There is nothing on this page to sign in with: no name box, no password box.";
		}
		return "The vault entry for this site has nothing that fits the boxes on this page.";
	}
	const filled =
		did.length === 1 ? did[0] : `${did.slice(0, -1).join(", ")} and ${did[did.length - 1]}`;
	return `Filled in ${filled}. Whether the site takes it is the next thing on the page.`;
}
