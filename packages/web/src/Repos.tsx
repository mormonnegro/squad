import type { AgentSummary } from "@squad/control-plane";
import { GitBranch, Lock, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "./avatar.tsx";
import { nameOf } from "./face.ts";
import type { Plane, RepoOffer, RepoRow } from "./plane.ts";
import { Spin } from "./spin.tsx";

/**
 * The repositories this plane can reach, and which agent may do what in each.
 *
 * Giving an agent a repository used to be four words typed into that agent's conversation, with the
 * token pasted into the same box — which meant the answer to "who can push to this" was to open
 * every agent in turn and read their lists. This is the other way up: the token once, the
 * repositories the token can see, and then who holds each of them and how far.
 *
 * What is given is never the token. An agent's requests leave its sandbox with no credential and
 * the proxy writes this plane's onto them on the way out, so what an agent holds is a scope and not
 * a secret — and the branches in that scope are read off the wire of every push.
 */
export function Repos({ plane, agents }: { plane: Plane; agents: readonly AgentSummary[] }) {
	const [held, setHeld] = useState<readonly RepoRow[] | undefined>();
	const [token, setToken] = useState(false);
	const [offers, setOffers] = useState<readonly RepoOffer[] | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const [note, setNote] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();
	const [find, setFind] = useState("");

	const load = useCallback(async (): Promise<void> => {
		try {
			const said = await plane.repos();
			setHeld(said.repos);
			setToken(said.token);
			setWhy(undefined);
			if (!said.token) {
				setOffers([]);
				return;
			}
			// Asked of GitHub, so it is slower than the rest and allowed to fail on its own: a token
			// that has gone stale should not take the list of what is already held down with it.
			setOffers(
				await plane.githubRepos().catch((error: Error) => {
					setWhy(error.message);
					return [];
				}),
			);
		} catch (error) {
			setWhy((error as Error).message);
		}
	}, [plane]);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (what: string, act: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setWhy(undefined);
		try {
			await act();
			await load();
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			setBusy(undefined);
		}
	};

	const rows = held ?? [];
	const shown = (offers ?? []).filter(
		(one) => find.trim() === "" || one.repo.toLowerCase().includes(find.trim().toLowerCase()),
	);

	return (
		<>
			<header className="pane-head">
				<span className="face" style={{ color: "var(--cyan)" }} aria-hidden="true">
					<GitBranch className="size-3.5" />
				</span>
				<span className="pane-title">Repositories</span>
				<div className="pane-facts">
					{rows.length > 0 && <span>{rows.length} held</span>}
					{offers !== undefined && offers.length > 0 && <span>{offers.length} in reach</span>}
				</div>
			</header>

			<div className="pane-scroll">
				<div className="pane-column">
					<div className="page-head">
						<h1 className="page-title">Repositories</h1>
						<p className="page-says">
							Code an agent can clone, read and push — with the branches it may push checked on the
							wire, push by push. The token is this plane's and stays here: an agent's requests
							leave its sandbox with no credential and are given one on the way out.
						</p>
					</div>

					{why !== undefined && <span className="why block">{why}</span>}
					{note !== undefined && <span className="section-says text-working">{note}</span>}
					{held === undefined && why === undefined && (
						<span className="inline-flex items-center gap-2 text-[0.85rem] text-muted">
							<Spin />
							asking the plane…
						</span>
					)}

					<Token
						held={token}
						busy={busy === "token"}
						onSet={(said) => void run("token", () => plane.setGithubToken(said))}
					/>

					{rows.length > 0 && (
						<section className="section">
							<Head
								title="Held"
								count={rows.length}
								says="Each row is one repository and says which agents can reach it, and how far into it each of them may go."
							/>
							<div className="flex flex-col gap-3">
								{rows.map((one) => (
									<Held
										key={one.repo}
										one={one}
										agents={agents}
										busy={busy}
										onHold={(agentId, push) =>
											void run(`hold:${one.repo}:${agentId}`, async () => {
												const said = await plane.holdRepo(agentId, one.repo, push);
												setNote(said === "" ? undefined : said);
											})
										}
										onDrop={(agentId) =>
											void run(`hold:${one.repo}:${agentId}`, () =>
												plane.dropRepo(agentId, one.repo),
											)
										}
									/>
								))}
							</div>
						</section>
					)}

					{token && (
						<section className="section">
							<Head
								title="Your repositories"
								count={offers?.length}
								says="What this plane's token can see. A fine-grained token answers for the repositories you chose when you made it, so this is that choice read back rather than asked for twice."
							/>
							<label className="flex items-center gap-2 rounded-[10px] border border-line bg-raised px-3 py-2">
								<Search className="size-3.5 flex-none text-muted" />
								<input
									className="min-w-0 flex-1 bg-transparent font-mono text-[0.85rem] outline-none"
									value={find}
									placeholder="find a repository"
									onChange={(event) => setFind(event.target.value)}
								/>
								{find !== "" && (
									<button type="button" className="icon-key" onClick={() => setFind("")}>
										<X className="size-3.5" />
									</button>
								)}
							</label>
							{offers === undefined && <Spin />}
							<div className="flex flex-col gap-1.5">
								{shown.slice(0, 40).map((one) => (
									<Offer
										key={one.repo}
										one={one}
										agents={agents}
										held={rows.find((row) => row.repo === one.repo)}
										busy={busy}
										onGive={(agentId) =>
											void run(`give:${one.repo}:${agentId}`, async () => {
												const said = await plane.holdRepo(agentId, one.repo);
												setNote(said === "" ? undefined : said);
											})
										}
									/>
								))}
								{shown.length > 40 && (
									<span className="text-[0.78rem] text-muted">
										{shown.length - 40} more — type to narrow it down.
									</span>
								)}
								{offers !== undefined && offers.length === 0 && why === undefined && (
									<span className="text-[0.8rem] text-muted">
										This token can see no repositories. A fine-grained one has to be given them when
										it is made.
									</span>
								)}
							</div>
						</section>
					)}
				</div>
			</div>
		</>
	);
}

function Head({ title, count, says }: { title: string; count?: number | undefined; says: string }) {
	return (
		<div className="section-head">
			<h2 className="section-title">
				{title}
				{count !== undefined && <span className="tally">{count}</span>}
			</h2>
			<p className="section-says">{says}</p>
		</div>
	);
}

/**
 * Where a token gets made, with as much of the form filled in as GitHub will accept.
 *
 * The classic page takes its scopes in the address, so that link arrives with `repo` ticked and the
 * note written — one click from here to a token. The fine-grained page takes nothing: there is no
 * documented way to pre-tick a permission, which is why the list below it is written out instead of
 * linked around. The narrow one is still the one to want, because it is the only one where the
 * repositories are chosen at the same time.
 */
const CLASSIC = `https://github.com/settings/tokens/new?scopes=repo&description=${encodeURIComponent("squad — this plane's repositories")}`;
const FINE = "https://github.com/settings/personal-access-tokens/new";

/** What the fine-grained page has to be told by hand, and what each one is actually for. */
const NEEDS = [
	["Contents", "Read and write", "clone, fetch, and push to the branches an agent is given"],
	["Pull requests", "Read and write", "open and update a PR, which is the only way it may write"],
	["Metadata", "Read-only", "GitHub ticks this one itself"],
] as const;

/**
 * The one credential the whole of this screen runs on.
 *
 * A token rather than an account, and deliberately: connecting an account would mean an OAuth app
 * registered somewhere, and a fine-grained token does the thing an app cannot — the repositories it
 * answers for are chosen on GitHub, one by one, when it is made. So the narrowing happens there and
 * this end reads it back.
 */
function Token({
	held,
	busy,
	onSet,
}: {
	held: boolean;
	busy: boolean;
	onSet: (token: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) field.current?.focus();
	}, [open]);

	if (!open) {
		return (
			<div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-raised p-3">
				<span className="badge" data-tone={held ? "up" : "warn"}>
					{held ? "token held" : "no token"}
				</span>
				<span className="min-w-0 flex-1 text-[0.82rem]/[1.5] text-muted">
					{held
						? "This plane holds a GitHub token. Every repository below is reached with it, and no agent ever sees it."
						: "This plane holds no GitHub token, so it can see no repositories and hand over none."}
				</span>
				<button type="button" className="pill" data-yes={!held} onClick={() => setOpen(true)}>
					{held ? "replace it" : "make one"}
				</button>
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-2 rounded-[10px] border border-line bg-raised p-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!busy && typed.trim() !== "") {
					onSet(typed.trim());
					setTyped("");
					setOpen(false);
				}
			}}
		>
			<p className="section-says">
				Kept here as this plane's own: never written into a conversation, never handed to an agent,
				and spent by the proxy on the way out of a sandbox.
			</p>

			<div className="flex flex-col gap-2 rounded-[10px] border border-line-soft bg-sunk p-3">
				<div className="flex flex-wrap items-center gap-2">
					<a className="pill" data-yes="true" href={FINE} target="_blank" rel="noreferrer">
						fine-grained token
					</a>
					<span className="text-[0.78rem] text-muted">
						— you pick the repositories on that page, and tick these three:
					</span>
				</div>
				<ul className="flex flex-col gap-1">
					{NEEDS.map(([what, how, why]) => (
						<li key={what} className="flex flex-wrap items-baseline gap-x-2 text-[0.78rem]">
							<span className="font-medium text-said">{what}</span>
							<code className="md-code">{how}</code>
							<span className="text-muted">— {why}</span>
						</li>
					))}
				</ul>
				{/* The other page takes its scopes in the address, so this link is the whole of the form.
				    Wider than the first: a classic token reaches every repository the account can. */}
				<div className="flex flex-wrap items-center gap-2 border-line-soft border-t pt-2">
					<a className="pill" href={CLASSIC} target="_blank" rel="noreferrer">
						classic token, scopes filled in
					</a>
					<span className="text-[0.78rem] text-muted">
						— one click, and it reaches every repository your account does.
					</span>
				</div>
			</div>
			<div className="flex gap-2">
				<input
					ref={field}
					type="password"
					autoComplete="off"
					spellCheck={false}
					className="field min-w-0 flex-1 font-mono"
					value={typed}
					placeholder="github_pat_…"
					onChange={(event) => setTyped(event.target.value)}
				/>
				<button type="submit" className="pill" data-yes="true" disabled={busy || typed === ""}>
					{busy && <Spin />}
					{busy ? "keeping…" : "keep it"}
				</button>
				<button type="button" className="pill" onClick={() => setOpen(false)}>
					cancel
				</button>
			</div>
		</form>
	);
}

/** The scopes an agent can be held to, in the order they widen. */
const SCOPES = [
	{ id: "read", said: "read only", means: "clone and read", push: [] as readonly string[] },
	{ id: "lane", said: "its own branches", means: "push to its own branches", push: undefined },
	{
		id: "all",
		said: "any branch",
		means: "push to any branch, main included",
		push: ["*"] as readonly string[],
	},
] as const;

/** Which of them a held scope is, for a row that has to show what it already says. */
function scopeOf(push: readonly string[], agentId: string): string {
	if (push.length === 0) return "read";
	if (push.length === 1 && push[0] === "*") return "all";
	if (push.length === 1 && push[0] === `${agentId}/*`) return "lane";
	return "named";
}

/**
 * One repository, and how far each agent may go in it.
 *
 * The scope is per agent rather than per repository, which is the whole reason this is a row with
 * chips in it and not a list of names: the same repository can be something one agent reads and
 * another pushes branches to, and that difference is the useful half of giving it at all.
 */
function Held({
	one,
	agents,
	busy,
	onHold,
	onDrop,
}: {
	one: RepoRow;
	agents: readonly AgentSummary[];
	busy: string | undefined;
	onHold: (agentId: string, push?: readonly string[]) => void;
	onDrop: (agentId: string) => void;
}) {
	return (
		<div className="conn">
			<div className="conn-head">
				<span className="site-mark grid place-items-center" style={{ width: 32, height: 32 }}>
					<GitBranch className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<span className="conn-name">{one.repo}</span>
					<span className="conn-where">{one.url}</span>
				</div>
				<a className="pill" href={one.url} target="_blank" rel="noreferrer">
					open on GitHub
				</a>
			</div>

			{/*
			 * One line per agent: who, and how far.
			 *
			 * No chip for "no access", because the absence of a choice already is one — a filled green
			 * chip saying access is off was the colour of "held" on the word for "not held", which is the
			 * one thing on a screen about permissions that must not be ambiguous. Nothing lit means
			 * nothing given; pressing any of the three gives it at that width.
			 */}
			<div className="conn-given flex-col items-stretch gap-2.5">
				{agents.map((agent) => {
					const has = one.by.find((by) => by.agentId === agent.id);
					const mine = busy === `hold:${one.repo}:${agent.id}`;
					const scope = has === undefined ? undefined : scopeOf(has.push, agent.id);
					return (
						<div key={agent.id} className="flex flex-wrap items-center gap-2">
							<span className="flex min-w-0 flex-none items-center gap-2">
								<Avatar id={agent.id} size={18} />
								<span className="w-24 truncate text-[0.85rem] text-said">{nameOf(agent.id)}</span>
								{/* Beside the name rather than after the chips: it is what this agent has, and
								    at the end of a row that wraps it ends up on a line of its own saying it
								    about nothing. */}
								{has === undefined && (
									<span className="w-16 text-[0.76rem] text-muted">no access</span>
								)}
							</span>

							{has !== undefined && has.origin === "file" ? (
								// The operator's own file said this one, and a console that offered to change it
								// would be offering to lose the change on the next deploy.
								<span className="badge">
									{has.push.length === 0 ? "read only" : has.push.join(", ")} · from the config
								</span>
							) : (
								<>
									{SCOPES.map((width) => (
										<button
											key={width.id}
											type="button"
											className="hold"
											data-held={scope === width.id}
											disabled={mine}
											title={`${nameOf(agent.id)} may ${width.means} in ${one.repo}`}
											onClick={() => onHold(agent.id, width.push)}
										>
											{mine && scope === width.id && <Spin />}
											{width.said}
										</button>
									))}
									{/* Branches somebody wrote by hand, which these three cannot say. */}
									{scope === "named" && <span className="badge">{has?.push.join(", ")}</span>}
									{has !== undefined && (
										<button
											type="button"
											className="icon-key"
											data-bad="true"
											disabled={mine}
											title={`take ${one.repo} back from ${nameOf(agent.id)}`}
											onClick={() => onDrop(agent.id)}
										>
											<X className="size-3.5" />
										</button>
									)}
								</>
							)}
						</div>
					);
				})}
				{agents.length === 0 && (
					<span className="text-[0.76rem] text-muted">There are no agents here yet.</span>
				)}
			</div>
		</div>
	);
}

/** One repository the token can see, and the agents it can be given to in one press. */
function Offer({
	one,
	agents,
	held,
	busy,
	onGive,
}: {
	one: RepoOffer;
	agents: readonly AgentSummary[];
	held: RepoRow | undefined;
	busy: string | undefined;
	onGive: (agentId: string) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2">
			{one.private && <Lock className="size-3 flex-none text-muted" />}
			<span className="min-w-0 flex-1 truncate font-mono text-[0.85rem] text-said">{one.repo}</span>
			{!one.push && (
				<span className="badge" title="the token can read this one and not write to it">
					read only
				</span>
			)}
			{held !== undefined && (
				<span className="badge" data-tone="up">
					{held.by.length === 1 ? nameOf(held.by[0]?.agentId ?? "") : `${held.by.length} agents`}
				</span>
			)}
			{/* Given with the narrow scope, always: the row above is where it is widened, and a button
			    that handed out `*` because it was the only button would be a button that means something
			    other than what it says. */}
			{agents.map((agent) => {
				const has = held?.by.some((by) => by.agentId === agent.id) === true;
				if (has) return null;
				return (
					<button
						key={agent.id}
						type="button"
						className="hold"
						disabled={busy === `give:${one.repo}:${agent.id}`}
						title={`give ${one.repo} to ${nameOf(agent.id)}, on its own branches`}
						onClick={() => onGive(agent.id)}
					>
						{busy === `give:${one.repo}:${agent.id}` ? <Spin /> : <Plus className="size-3" />}
						{nameOf(agent.id)}
					</button>
				);
			})}
		</div>
	);
}
