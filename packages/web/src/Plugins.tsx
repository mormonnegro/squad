import type { AgentSummary, Plugin } from "@squad/control-plane";
import { Blocks } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { nameOf } from "./face.ts";
import type { Connected, Plane } from "./plane.ts";

/** How long the screen keeps looking after a consent screen was opened in another tab. */
const WATCH_MS = 3 * 60_000;
/** How often, while it is looking. The plane hears about the landing; this is how the row finds out. */
const BEAT_MS = 2000;

/**
 * The plugins: what this plane can reach, and through whose account.
 *
 * Two lists, and the order they are in is the argument. What is already connected comes first,
 * because the question that brings somebody here twice is "which of these does that agent have" —
 * and what there is to connect comes second, because that question is only asked once per plugin.
 *
 * One plugin is not one connection. A person with a Stripe account for the company and one for the
 * side project has two of them here, under two names, holding two tokens, and can give one agent
 * one and another agent the other. That is the whole reason connections are a list rather than a
 * column of ticks down the catalogue.
 */
export function Plugins({ plane, agents }: { plane: Plane; agents: readonly AgentSummary[] }) {
	const [catalog, setCatalog] = useState<readonly Plugin[]>([]);
	const [made, setMade] = useState<readonly Connected[] | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	/** Which row is mid-request, so its own button says so and nothing else on the screen moves. */
	const [busy, setBusy] = useState<string | undefined>();
	const [watching, setWatching] = useState(false);

	const load = useCallback(async (): Promise<void> => {
		try {
			const said = await plane.plugins();
			setCatalog(said.catalog);
			setMade(said.instances);
			setWhy(undefined);
		} catch (error) {
			setWhy((error as Error).message);
		}
	}, [plane]);

	useEffect(() => {
		void load();
	}, [load]);

	/**
	 * Keeps looking while a login is out at a consent screen.
	 *
	 * The trip happens in another tab and lands on the plane, which tells nobody: this screen asked
	 * for the page and then has no way of knowing it worked. So for as long as one is out, the list
	 * is re-read, and the row goes green on its own a second after the browser comes back. It stops
	 * by itself, because a screen left open for a week should not be a screen polling for a week.
	 */
	useEffect(() => {
		if (!watching) return;
		const beat = setInterval(() => void load(), BEAT_MS);
		const done = setTimeout(() => setWatching(false), WATCH_MS);
		return () => {
			clearInterval(beat);
			clearTimeout(done);
		};
	}, [watching, load]);

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

	/**
	 * Connects one, and takes the person straight to the consent screen where there is one.
	 *
	 * Two steps that are one intention. "Connect Stripe" has never once meant "write down Stripe's
	 * address and stop", and a screen that made somebody press a second button called "log in" would
	 * be asking them to confirm what they just asked for.
	 */
	const connect = async (plugin: Plugin): Promise<void> => {
		await run(`add:${plugin.id}`, async () => {
			const made = await plane.connectPlugin(plugin.id);
			if (made.wants === "login") await open(made.name);
		});
	};

	const open = async (name: string): Promise<void> => {
		const page = await plane.loginPlugin(name);
		// Opened from here because this is the browser somebody is sitting at. The plane may be a
		// container on a machine with no screen at all, and it is the one that knows the address.
		if (page.url !== "") window.open(page.url, "_blank", "noreferrer");
		setWatching(true);
	};

	const connected = made ?? [];
	const known = (id: string): Plugin | undefined => catalog.find((one) => one.id === id);

	return (
		<>
			{/* The same head the conversation has, because this is the same kind of thing: a screen the
			    column on the left switches between, rather than a question raised over one. */}
			<header className="pane-head">
				<span className="face" style={{ color: "var(--cyan)" }} aria-hidden="true">
					<Blocks className="size-3.5" />
				</span>
				<span className="pane-title">Plugins</span>
				<div className="pane-facts">
					{connected.length > 0 && <span>{connected.length} connected</span>}
					<span>{catalog.length} on the shelf</span>
				</div>
			</header>

			<div className="pane-scroll">
				<div className="pane-column">
					<p className="lede">
						A plugin gives an agent tools it did not have: a Stripe to read, a Linear to file into,
						a Postgres to ask. Connecting one opens an account here and nothing else — no agent has
						it until it is handed over below, and the agents never hold the token.
					</p>

					{why !== undefined && <span className="why block">{why}</span>}
					{made === undefined && why === undefined && (
						<span className="text-[0.85rem] text-muted">asking the plane…</span>
					)}

					{connected.length > 0 && (
						<section className="flex flex-col gap-2">
							<Head
								title={`Connected · ${connected.length}`}
								says="Each row is one account. The same plugin can be here twice, with a different account behind each."
							/>
							{connected.map((one) => (
								<Row
									key={one.name}
									one={one}
									plugin={one.from === undefined ? undefined : known(one.from)}
									agents={agents}
									busy={busy}
									onLogin={() => void run(`login:${one.name}`, () => open(one.name))}
									onLogout={() => void run(`login:${one.name}`, () => plane.logoutPlugin(one.name))}
									onHold={(agentId, held) =>
										void run(`hold:${one.name}:${agentId}`, () =>
											plane.holdPlugin(agentId, one.name, held),
										)
									}
									onLabel={(label) =>
										void run(`label:${one.name}`, () => plane.labelPlugin(one.name, label))
									}
									onForget={() =>
										void run(`forget:${one.name}`, () => plane.forgetPlugin(one.name))
									}
								/>
							))}
						</section>
					)}

					<section className="flex flex-col gap-3">
						<Head
							title="Add a plugin"
							says="Connecting one you already have connected makes a second, separate account — which is what two Stripe accounts are."
						/>
						{/* An empty shop is the one failure this screen can have that looks like nothing at all,
				    and it has one cause: the catalogue comes from the plane, and the plane is older than
				    the page it is serving. Said here, with the two words that fix it, rather than left as
				    a heading with nothing under it. */}
						{made !== undefined && catalog.length === 0 && (
							<p className="text-[0.8rem]/[1.5] text-muted">
								This plane has no catalogue to offer: it is running a version older than this
								console. <code className="md-code">squad dev</code> puts your checkout behind it,
								and <code className="md-code">squad update</code> puts it on the published image.
								Anything below still works — an address is an address.
							</p>
						)}
						{SHELVES.map(([shelf, title]) => {
							const here = catalog.filter((one) => one.shelf === shelf);
							if (here.length === 0) return null;
							return (
								<div key={shelf} className="flex flex-col gap-1.5">
									<div className="font-medium text-[0.72rem] text-muted uppercase tracking-[0.07em]">
										{title}
									</div>
									<div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
										{here.map((one) => (
											<Card
												key={one.id}
												plugin={one}
												held={connected.filter((made) => made.from === one.id).length}
												busy={busy === `add:${one.id}`}
												onConnect={() => void connect(one)}
											/>
										))}
									</div>
								</div>
							);
						})}
					</section>

					<Custom
						busy={busy === "custom"}
						onAdd={(name, line) => run("custom", () => plane.addPlugin(name, line))}
					/>
				</div>
			</div>
		</>
	);
}

/**
 * The groups, and the order they are read in.
 *
 * Kept here rather than taken off the wire with the catalogue: it is how this screen chooses to
 * arrange what it was given, which is a decision about a screen and not a fact about a plane. A
 * plugin arriving under a group this list has never heard of falls through to the end rather than
 * disappearing.
 */
const SHELVES: readonly (readonly [string, string])[] = [
	["money", "Money"],
	["work", "Work"],
	["code", "Code"],
	["runs", "Where it runs"],
	["data", "Data"],
	["read", "Reading"],
];

function Head({ title, says }: { title: string; says: string }) {
	return (
		<div>
			<h3 className="font-medium text-[0.88rem] text-said">{title}</h3>
			<p className="mt-1 text-[0.8rem]/[1.5] text-muted">{says}</p>
		</div>
	);
}

/**
 * One connection: whose account it is, who has it, and the two things that can be done to it.
 *
 * The agents are toggles rather than a list with an "edit" behind it. Handing a plugin to an agent
 * is the most common thing anybody does on this screen, it is reversible, and a screen where the
 * common act costs two clicks and a second dialog is a screen people stop using.
 */
function Row({
	one,
	plugin,
	agents,
	busy,
	onLogin,
	onLogout,
	onHold,
	onLabel,
	onForget,
}: {
	one: Connected;
	plugin: Plugin | undefined;
	agents: readonly AgentSummary[];
	busy: string | undefined;
	onLogin: () => void;
	onLogout: () => void;
	onHold: (agentId: string, held: boolean) => void;
	onLabel: (label: string) => void;
	onForget: () => void;
}) {
	const [naming, setNaming] = useState(false);
	const [typed, setTyped] = useState(one.label ?? "");
	const field = useRef<HTMLInputElement>(null);
	const where = one.server.transport === "stdio" ? undefined : hostOf(one.server.url);
	const working = busy === `login:${one.name}`;

	useEffect(() => {
		if (naming) field.current?.focus();
	}, [naming]);

	return (
		<div className="rounded-lg border border-line bg-raised p-3">
			<div className="flex items-center gap-3">
				<Mark host={plugin?.mark ?? where} letter={one.name} size={30} />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="font-mono font-medium text-said">{one.name}</span>
						{plugin !== undefined && (
							<span className="text-[0.78rem] text-muted">{plugin.title}</span>
						)}
						{one.label !== undefined && (
							<span className="truncate text-[0.78rem] text-here">{one.label}</span>
						)}
					</div>
					<div className="truncate font-mono text-[0.72rem] text-muted">
						{one.server.transport === "stdio"
							? [one.server.command, ...one.server.args].join(" ")
							: one.server.url}
					</div>
				</div>
				<Standing
					loggedIn={one.loggedIn}
					needs={where !== undefined}
					open={plugin?.account === "open"}
				/>
				{where !== undefined &&
					plugin?.account !== "open" &&
					(one.loggedIn ? (
						<button type="button" className="key" disabled={working} onClick={onLogout}>
							{working ? "…" : "log out"}
						</button>
					) : (
						<button
							type="button"
							className="key"
							data-yes="true"
							disabled={working}
							onClick={onLogin}
						>
							{working ? "opening…" : "log in"}
						</button>
					))}
				<button type="button" className="key" onClick={() => setNaming((was) => !was)}>
					label
				</button>
				<button type="button" className="key" onClick={onForget}>
					remove
				</button>
			</div>

			{naming && (
				<form
					className="mt-3 flex gap-2 border-line border-t pt-3"
					onSubmit={(event) => {
						event.preventDefault();
						onLabel(typed.trim());
						setNaming(false);
					}}
				>
					<input
						ref={field}
						className="field min-w-0 flex-1"
						value={typed}
						placeholder="the live account"
						onChange={(event) => setTyped(event.target.value)}
					/>
					<button type="submit" className="key" data-yes="true">
						save
					</button>
				</form>
			)}

			{/* Who has it. A connection nobody was given reaches nothing at all, which is the one thing
			    a list of connections otherwise leaves you to find out by opening every agent. */}
			<div className="mt-3 flex flex-wrap items-center gap-1.5 border-line border-t pt-3">
				<span className="mr-1 text-[0.76rem] text-muted">Given to</span>
				{agents.length === 0 && (
					<span className="text-[0.76rem] text-muted">nobody yet — no agents here</span>
				)}
				{agents.map((agent) => {
					const held = one.agents.includes(agent.id);
					return (
						<button
							key={agent.id}
							type="button"
							className="key"
							data-yes={held}
							disabled={busy === `hold:${one.name}:${agent.id}`}
							onClick={() => onHold(agent.id, !held)}
						>
							{held ? "✓ " : "+ "}
							{nameOf(agent.id)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/**
 * Whether there is an account behind this connection, and whether there was meant to be one.
 *
 * "No account" on something that wants none is a warning about nothing, and a screen that warns
 * about nothing is one whose warnings stop being read. The ones that answer to anybody say so.
 */
function Standing({ loggedIn, needs, open }: { loggedIn: boolean; needs: boolean; open: boolean }) {
	if (!needs) {
		return (
			<span className="flex-none rounded border border-line px-1.5 py-0.5 font-mono text-[0.65rem] text-muted">
				runs here
			</span>
		);
	}
	if (open && !loggedIn) {
		return (
			<span className="flex-none rounded border border-line px-1.5 py-0.5 font-mono text-[0.65rem] text-muted">
				no account needed
			</span>
		);
	}
	return loggedIn ? (
		<span className="flex-none rounded border border-up/40 px-1.5 py-0.5 font-mono text-[0.65rem] text-up">
			logged in
		</span>
	) : (
		<span className="flex-none rounded border border-working/40 px-1.5 py-0.5 font-mono text-[0.65rem] text-working">
			no account
		</span>
	);
}

/** One on the shelf: what it is for, and how many accounts of it are already here. */
function Card({
	plugin,
	held,
	busy,
	onConnect,
}: {
	plugin: Plugin;
	held: number;
	busy: boolean;
	onConnect: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3">
			<div className="flex items-center gap-2.5">
				<Mark host={plugin.mark} letter={plugin.title} size={26} />
				<span className="min-w-0 flex-1 truncate font-medium text-said">{plugin.title}</span>
				{held > 0 && (
					<span className="flex-none rounded border border-up/40 px-1.5 py-0.5 font-mono text-[0.65rem] text-up">
						{held}
					</span>
				)}
			</div>
			<p className="min-h-[2.4em] text-[0.78rem]/[1.5] text-muted">{plugin.does}</p>
			<button type="button" className="key self-start" disabled={busy} onClick={onConnect}>
				{busy ? "connecting…" : held > 0 ? "connect another" : "connect"}
			</button>
		</div>
	);
}

/**
 * Anything not on the shelf, which is most of what exists.
 *
 * The same grammar the console takes, because a second way of writing down a server would be a
 * second thing that is nearly right: a URL is a URL wherever it appears, and anything that is not
 * one is the command to start it with. What it means is settled by the plane, which is the end that
 * already has the reader for it.
 */
function Custom({
	busy,
	onAdd,
}: {
	busy: boolean;
	onAdd: (name: string, line: string) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [line, setLine] = useState("");

	if (!open) {
		return (
			<button type="button" className="key self-start" onClick={() => setOpen(true)}>
				＋ something else
			</button>
		);
	}

	return (
		<form
			className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3"
			onSubmit={(event) => {
				event.preventDefault();
				void onAdd(name.trim(), line.trim()).then(() => {
					setName("");
					setLine("");
					setOpen(false);
				});
			}}
		>
			<Head
				title="Anything else"
				says="A URL for a remote server, sse and a URL for the older transport, or the command the sandbox should start."
			/>
			<div className="flex gap-2">
				<input
					className="field w-40 font-mono"
					value={name}
					placeholder="name"
					onChange={(event) => setName(event.target.value)}
				/>
				<input
					className="field min-w-0 flex-1 font-mono"
					value={line}
					placeholder="https://mcp.example.com/mcp"
					onChange={(event) => setLine(event.target.value)}
				/>
				<button
					type="submit"
					className="key"
					data-yes="true"
					disabled={busy || name === "" || line === ""}
				>
					{busy ? "adding…" : "add"}
				</button>
				<button type="button" className="key" onClick={() => setOpen(false)}>
					cancel
				</button>
			</div>
		</form>
	);
}

/**
 * A company's mark, asked of the company.
 *
 * From the site itself rather than from a favicon service, which would be the shorter line and
 * would tell a third party every plugin anybody here connects. A site that serves nothing gets an
 * initial in the same space, so a row is the same height either way.
 */
export function Mark({
	host,
	letter,
	size = 30,
}: {
	host: string | undefined;
	letter: string;
	size?: number;
}) {
	const [drawn, setDrawn] = useState(true);
	if (host === undefined || !drawn) {
		return (
			<span
				aria-hidden="true"
				className="grid flex-none place-items-center rounded-lg border border-line bg-sunk font-semibold text-muted"
				style={{ width: size, height: size, fontSize: size * 0.42 }}
			>
				{letter.slice(0, 1).toUpperCase()}
			</span>
		);
	}
	return (
		<img
			className="flex-none rounded-lg border border-line bg-sunk object-contain p-1"
			style={{ width: size, height: size }}
			src={`https://${host}/favicon.ico`}
			alt=""
			loading="lazy"
			onError={() => setDrawn(false)}
		/>
	);
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}
