import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Grant } from "@squad/proxy";

/**
 * A repository an agent holds: where it is, and which branches it may push there.
 *
 * Three grants come out of one of these, and none of them is written by hand. A grant is a host, a
 * path, a method and a credential, and a repository is all of that three times over — the clone and
 * the push under one host, the pull request under another — which is a paragraph of YAML for a thing
 * an operator says in four words. So the four words are what is kept, and the grants are derived where
 * the model grants and the search grant are.
 */
export interface RepoSpec {
	/** `owner/name` on GitHub. */
	readonly repo: string;
	/**
	 * The branches it may push, as refspec patterns: `scout/*` for everything under that prefix, `*`
	 * for anything at all. Left out, it is the agent's own lane — `<agent>/*` — so nothing lands on
	 * main because nobody said which branches.
	 */
	readonly push?: readonly string[];
}

/** Where a repository came from, which is what decides whether a console may take it back. */
export type RepoOrigin = "file" | "here";

/** A repository as the console has it: what it is, where it is, and what the agent may do to it. */
export interface RepoStanding {
	readonly repo: string;
	readonly url: string;
	readonly push: readonly string[];
	readonly origin: RepoOrigin;
}

/**
 * What giving an agent a repository came to.
 *
 * Three answers rather than a value or a throw, because two of the three are the ordinary course of
 * the first time: the plane has no token yet and the next line is where one gets pasted, or GitHub
 * would not have the token against that repository and the words it used are the fix.
 */
export type RepoHold =
	| {
			readonly kind: "held";
			readonly standing: RepoStanding;
			/** Held, and still worth a sentence: the token can see the repository and not write to it. */
			readonly warning?: string;
	  }
	| { readonly kind: "token-needed"; readonly spec: RepoSpec }
	| { readonly kind: "refused"; readonly why: string };

export const GITHUB_HOST = "github.com";
export const GITHUB_API_HOST = "api.github.com";

/** The one variable every repository grant spends: this plane's GitHub token. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

/** What GitHub wants in the username when the password is a token. A fact about GitHub, not a secret. */
const GIT_USERNAME = "x-access-token";

/** The branches an agent gets when nobody says: its own name, and anything under it. */
export function lane(agentId: string): string {
	return `${agentId}/*`;
}

/** Namespaced the way every derived grant is, so nothing written by hand can land on one. */
export function repoId(repo: string): string {
	return `repo:${repo}`;
}

export function repoUrl(repo: string): string {
	return `https://${GITHUB_HOST}/${repo}`;
}

/**
 * The grants one repository comes to.
 *
 * The first is the repository itself, with the push scope on it: clone, fetch and push, the last
 * only to the branches listed, read off the wire by the proxy. The other two are the API, and they
 * are two rather than one because the API is where the branch scope could be walked around: a PUT
 * on `contents/` commits to any branch, a PATCH on `git/refs/` moves any ref, a POST on `merges`
 * merges into main. So reading is granted whole and writing is granted for pull requests only — a
 * PR is the one thing the agent should be able to open, and merging one is a PUT it is not given.
 */
export function repoGrants(agentId: string, spec: RepoSpec): readonly Grant[] {
	const token = { ref: GITHUB_TOKEN_ENV };
	return [
		{
			id: repoId(spec.repo),
			host: GITHUB_HOST,
			pathPrefix: `/${spec.repo}`,
			injection: { kind: "basic", username: { literal: GIT_USERNAME }, password: token },
			git: { push: pushOf(agentId, spec) },
		},
		{
			id: `${repoId(spec.repo)}:api`,
			host: GITHUB_API_HOST,
			pathPrefix: `/repos/${spec.repo}`,
			methods: ["GET"],
			injection: { kind: "bearer", token },
		},
		{
			id: `${repoId(spec.repo)}:pulls`,
			host: GITHUB_API_HOST,
			pathPrefix: `/repos/${spec.repo}/pulls`,
			methods: ["GET", "POST", "PATCH"],
			injection: { kind: "bearer", token },
		},
	];
}

function pushOf(agentId: string, spec: RepoSpec): readonly string[] {
	return spec.push ?? [lane(agentId)];
}

export function standingOf(agentId: string, spec: RepoSpec, origin: RepoOrigin): RepoStanding {
	return { repo: spec.repo, url: repoUrl(spec.repo), push: pushOf(agentId, spec), origin };
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Takes `owner/name` out of whatever was pasted, because what a person has to hand is a URL.
 *
 * The clone box on GitHub offers three spellings of the same repository and a hand will paste any
 * of them; refusing two of the three is a second thing to get right before the first one works. A
 * repository somewhere other than GitHub is refused by name, so the answer says what is missing
 * rather than that the words were wrong.
 */
export function readRepo(said: string): { readonly repo: string } | { readonly refused: string } {
	const trimmed = said.trim();
	if (trimmed.length === 0) return { refused: "a repository, like acme/website" };
	if (/\s/.test(trimmed))
		return { refused: `"${trimmed}" is more than one word — a repository is one` };

	let path = trimmed;
	const scp = /^git@([^:]+):(.+)$/.exec(trimmed);
	const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.*)$/i.exec(trimmed);
	const bare = /^([a-z0-9.-]+\.[a-z]{2,})\/(.+)$/i.exec(trimmed);
	const named = scp ?? url ?? (bare !== null && bare[1]?.includes(".") ? bare : null);
	if (named !== null) {
		const host = (named[1] ?? "").toLowerCase().replace(/:\d+$/, "");
		if (host !== GITHUB_HOST && host !== `www.${GITHUB_HOST}`) {
			return {
				refused: `${host} is not ${GITHUB_HOST}, which is the one host this knows how to hold`,
			};
		}
		path = named[2] ?? "";
	}
	const [owner = "", name = ""] = path.replace(/^\/+/, "").split("/");
	const repo = `${owner}/${name.replace(/\.git$/, "")}`;
	if (!REPO.test(repo) || owner.length === 0 || name.length === 0) {
		return { refused: `"${trimmed}" is not owner/name — try acme/website, or the page's URL` };
	}
	return { repo };
}

/** What a branch pattern may be made of: a ref name's characters and the star. */
const PUSH_PATTERN = /^[A-Za-z0-9_./*-]+$/;

/**
 * Reads the branch patterns typed after a repository, refusing what git would.
 *
 * Refused rather than passed through because the proxy matches these on every push, and a pattern
 * git would never write — a dot-dot, a leading dash — is one that matches nothing and says nothing
 * about why the push was turned down.
 */
export function readPush(
	words: readonly string[],
): { readonly push: readonly string[] } | { readonly refused: string } {
	const push = words.map((word) => word.replace(/^refs\/heads\//, ""));
	for (const word of push) {
		if (
			!PUSH_PATTERN.test(word) ||
			word.includes("..") ||
			word.startsWith("-") ||
			word.startsWith("/") ||
			word.endsWith("/") ||
			word.endsWith(".lock")
		) {
			return { refused: `"${word}" is not a branch pattern — try scout/*, release-*, or *` };
		}
	}
	return { push };
}

/** Whether a word is a GitHub token rather than a repository, which is what tells the two forms of /repo apart. */
export function looksLikeGithubToken(word: string): boolean {
	return /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(word);
}

/** What GitHub said about a token against a repository, before anything was written down. */
export type RepoCheck =
	| { readonly kind: "ok"; readonly push: boolean; readonly defaultBranch: string }
	| { readonly kind: "refused"; readonly why: string };

/**
 * Asks GitHub whether the token can see the repository, and whether it may write there.
 *
 * Asked before the repository is held, for the reason a bot token is tried before it is kept: a token
 * missing a repository becomes an agent that is told it holds one and meets a 404 on the first clone,
 * and nothing about that points back at the line it was pasted on. GitHub answers 404 rather than 403
 * for a private repository the token was not given, so the words here say both readings.
 */
export async function checkRepo(
	repo: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<RepoCheck> {
	let response: Response;
	try {
		response = await fetchImpl(`https://${GITHUB_API_HOST}/repos/${repo}`, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"user-agent": "squad",
				"x-github-api-version": "2022-11-28",
			},
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		return { kind: "refused", why: `GitHub could not be reached: ${(error as Error).message}` };
	}
	if (response.status === 401) return { kind: "refused", why: "GitHub does not know this token" };
	if (response.status === 404) {
		return {
			kind: "refused",
			why: `the token cannot see ${repo}: there is no such repository, or the token was not given it`,
		};
	}
	if (!response.ok) {
		return { kind: "refused", why: `GitHub answered ${response.status} for ${repo}` };
	}
	const body = (await response.json().catch(() => ({}))) as {
		readonly permissions?: { readonly push?: boolean };
		readonly default_branch?: string;
	};
	return {
		kind: "ok",
		push: body.permissions?.push === true,
		defaultBranch: body.default_branch ?? "main",
	};
}

/**
 * What the agent is told about the repositories it holds, on every turn.
 *
 * Said by the plane rather than left for the agent to discover, because a grant nobody mentions is a
 * grant found by trial: the agent clones under the wrong name and meets a 403, or pushes to main and
 * meets a refusal it did not know was coming. Nothing at all when it holds none, for the reason the
 * lessons are nothing when there are none.
 */
export function reposPrompt(
	repos: readonly RepoStanding[],
	workspacePath: string,
): string | undefined {
	if (repos.length === 0) return undefined;
	return [
		"Repositories you hold. They are reached through the proxy with credentials you never see, so",
		"clone and push by URL with no token, and never write one into a remote:",
		"",
		...repos.map((held) => {
			const name = held.repo.split("/")[1] ?? held.repo;
			return `- ${held.url}, checked out under ${workspacePath}/${name}. You may push to ${held.push.join(", ")} and to nothing else there; a push anywhere else is refused before it leaves.`;
		}),
		"",
		"Hand work back by pushing a branch of yours and opening a pull request against the default",
		"branch through api.github.com. Never rewrite history on a branch you did not make.",
	].join("\n");
}

/**
 * The repositories given to agents at the console, on top of the ones their file declares.
 *
 * Beside the operator's file rather than in it, for the reason everything decided at a console is:
 * the file is theirs, and a repository that vanished on the next deploy would be worse than one that
 * was never offered. Nothing here is a secret — the token is in the keys file, and this is what it is
 * spent on.
 */
export class HeldRepos {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async of(agentId: string): Promise<readonly RepoSpec[]> {
		return (await this.#serialize(() => this.#read()))[agentId] ?? [];
	}

	/** Holds it for the agent, replacing what was held under the same name: a second `/repo` narrows or widens, it does not duplicate. */
	async hold(agentId: string, spec: RepoSpec): Promise<void> {
		await this.#serialize(async () => {
			const all = await this.#read();
			const mine = (all[agentId] ?? []).filter((held) => held.repo !== spec.repo);
			mine.push(spec);
			await this.#write({ ...all, [agentId]: mine });
		});
	}

	/** True when there was one to drop, so the console can tell a typo from a repository that is gone. */
	async drop(agentId: string, repo: string): Promise<boolean> {
		return await this.#serialize(async () => {
			const all = await this.#read();
			const mine = all[agentId] ?? [];
			const left = mine.filter((held) => held.repo !== repo);
			if (left.length === mine.length) return false;
			await this.#write({ ...all, [agentId]: left });
			return true;
		});
	}

	async #read(): Promise<Record<string, RepoSpec[]>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const held: Record<string, RepoSpec[]> = {};
			for (const [agentId, list] of Object.entries(parsed)) {
				if (!Array.isArray(list)) continue;
				held[agentId] = list.filter(
					(entry): entry is RepoSpec =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as RepoSpec).repo === "string",
				);
			}
			return held;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, RepoSpec[]>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
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
