import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Served } from "./ports.ts";

/** Where an agent's screen stands: what was decided, what is actually running, and who is driving. */
export interface ScreenStanding {
	/** Whether this agent is meant to have one, out of the file and whatever the console said since. */
	readonly on: boolean;
	/** Whether the container is up. Off for a moment after `/screen on`, and after a machine reboot. */
	readonly running: boolean;
	/** Where the live view is opened on the operator's own machine, once there is one to open. */
	readonly at?: Served;
	/** Who has the keyboard right now, when the screen was there to be asked. */
	readonly keyboard?: "agent" | "operator";
	/**
	 * Whether the browser image is being built, which is what an empty screen is usually waiting on.
	 *
	 * Said apart from `running` because they are different kinds of nothing: a screen that is building
	 * will be there in a few minutes with nothing to type, and one that is merely not running is
	 * something to look into.
	 */
	readonly building?: boolean;
	/**
	 * Whether the agent's sandbox is too old to hold the screen tools.
	 *
	 * A screen has two halves and they ship in different images. The browser is this plane's to
	 * build; the tools that drive it are in the sandbox image, which on most installs is pulled and
	 * therefore lags. Said out loud because the failure is otherwise invisible from both ends: the
	 * live view works, the operator can drive the browser themselves, and the agent simply never
	 * mentions having one.
	 */
	readonly toolless?: boolean;
	/**
	 * The sites this agent may sign into out of the operator's vault.
	 *
	 * On the standing rather than asked for separately because everything that draws a screen draws
	 * this beside it: the list is short, it is the second half of what a browser is allowed to do,
	 * and a console that had to ask twice would show one without the other for a moment.
	 */
	readonly sites: readonly string[];
	/** Whether this plane holds a vault at all, which is what an empty list usually means. */
	readonly vault: boolean;
}

/**
 * Which agents have been given a browser, decided at the console rather than in the file.
 *
 * A screen is the kind of thing an operator turns on because of what is in front of them right now
 * — an agent that has just said it cannot get past a login — and the kind of thing they turn off
 * again when the job is done, because it is a container and a gigabyte. Making that an edit to
 * config.yaml and a redeploy is making it something nobody does.
 *
 * Three states rather than two, for the reason the spending ceiling has three: a file that declares
 * a screen and a console that turned it off are not in conflict, they are in order, and an `off`
 * that quietly meant "whatever the file says" would turn itself back on at the next restart.
 */
export class ScreenChoices {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** What the console said about this agent, or undefined if it has never said anything. */
	async of(agentId: string): Promise<boolean | undefined> {
		return (await this.#serialize(() => this.#read()))[agentId];
	}

	async all(): Promise<Readonly<Record<string, boolean>>> {
		return this.#serialize(() => this.#read());
	}

	/** `null` hands the decision back to the operator's file, which is not the same as `false`. */
	async set(agentId: string, on: boolean | null): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			if (on === null) delete all[agentId];
			else all[agentId] = on;
			await this.#write(all);
		});
	}

	async forget(agentId: string): Promise<void> {
		await this.set(agentId, null);
	}

	async #read(): Promise<Record<string, boolean>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const all: Record<string, boolean> = {};
			for (const [agentId, on] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof on === "boolean") all[agentId] = on;
			}
			return all;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, boolean>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, so a plane killed mid-write leaves the old file rather than
		// half of a new one — which here would read as every agent's screen having been turned off.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(all, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}

/**
 * Whether this agent has a screen, out of what the file said and what the console said since.
 *
 * The console wins, because the console is the same operator saying the same kind of thing later.
 * What it does not do is write back to the file: the file is theirs, and a plane that edited it
 * would be a plane that loses an operator's comments the first time somebody presses a key.
 */
export function hasScreen(declared: boolean | undefined, chosen: boolean | undefined): boolean {
	return chosen ?? declared ?? false;
}

/**
 * The sites each agent may sign into out of its operator's vault, decided at the console.
 *
 * The other permission a browser has, and a different kind from the first. Whether an agent has a
 * screen is about a container; this is about a password: an agent that has been talked into signing
 * into somewhere it was never meant to reach is the failure this list exists to make impossible, so
 * it is deny by default, per agent, and written nowhere the agent can read or reach.
 *
 * Kept here rather than in the config file for the reason the screen itself is: it is decided in
 * front of an agent that has just said it cannot get past a login, and a permission that costs an
 * edit and a redeploy is one nobody grants at the moment it is wanted.
 */
export class SignInSites {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	/** The sites this agent may sign into, in the order they were opened. */
	async of(agentId: string): Promise<readonly string[]> {
		return (await this.#serialize(() => this.#read()))[agentId] ?? [];
	}

	async all(): Promise<Readonly<Record<string, readonly string[]>>> {
		return this.#serialize(() => this.#read());
	}

	/** Opens one. Answers whether anything changed, so a second `/screen login` says so. */
	async add(agentId: string, host: string): Promise<boolean> {
		return this.#serialize(async () => {
			const all = await this.#read();
			const held = all[agentId] ?? [];
			if (held.includes(host)) return false;
			all[agentId] = [...held, host];
			await this.#write(all);
			return true;
		});
	}

	/** Closes one. Answers whether there was one to close. */
	async drop(agentId: string, host: string): Promise<boolean> {
		return this.#serialize(async () => {
			const all = await this.#read();
			const held = all[agentId] ?? [];
			if (!held.includes(host)) return false;
			const left = held.filter((one) => one !== host);
			if (left.length === 0) delete all[agentId];
			else all[agentId] = left;
			await this.#write(all);
			return true;
		});
	}

	/**
	 * Everything opened for one agent, forgotten.
	 *
	 * For a name that has been deleted. A list left behind would come back the day somebody made an
	 * agent with the same name — and what it would hand them is somebody else's accounts.
	 */
	async forget(agentId: string): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			if (all[agentId] === undefined) return;
			delete all[agentId];
			await this.#write(all);
		});
	}

	async #read(): Promise<Record<string, string[]>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const all: Record<string, string[]> = {};
			for (const [agentId, hosts] of Object.entries(parsed as Record<string, unknown>)) {
				if (!Array.isArray(hosts)) continue;
				all[agentId] = hosts.filter((host): host is string => typeof host === "string");
			}
			return all;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, string[]>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		// Written elsewhere and renamed, as the choices beside it are: a plane killed mid-write must
		// leave the old file rather than half of a new one, and half of this one is a permission.
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(all, null, "\t")}\n`, "utf8");
		await rename(temporary, this.#path);
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
