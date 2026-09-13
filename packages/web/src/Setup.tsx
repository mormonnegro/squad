import type { AgentSummary, ModelStanding, Plugin } from "@squad/control-plane";
import { useCallback, useEffect, useState } from "react";
import { nameOf } from "./face.ts";
import { Modal } from "./Modal.tsx";
import { Mark } from "./Plugins.tsx";
import type { Connected, Plane, Skill, Trigger } from "./plane.ts";
import { Spin } from "./spin.tsx";

/**
 * One agent's settings, where the agent is.
 *
 * Everything here was already possible by typing a command into that agent's conversation, and
 * that is exactly the problem: `/limit 5` is a message to an agent about itself, and what it sets
 * is not the agent's opinion but the operator's. Said here instead, on a screen that opens from the
 * agent's own title row, where the three facts somebody actually goes looking for — what it may
 * spend, what it thinks with, what it can reach — are in one place and none of them is a sentence
 * to remember.
 */
export function Setup({
	plane,
	agent,
	agents,
	onClose,
	onChanged,
}: {
	plane: Plane;
	agent: AgentSummary;
	/** The rest of the fleet, so a skill can be handed to one of them without leaving this screen. */
	agents: readonly AgentSummary[];
	onClose: () => void;
	onChanged: () => void;
}) {
	const [made, setMade] = useState<readonly Connected[]>([]);
	const [catalog, setCatalog] = useState<readonly Plugin[]>([]);
	const [models, setModels] = useState<readonly ModelStanding[]>([]);
	const [limit, setLimit] = useState(agent.limitUsd === undefined ? "" : String(agent.limitUsd));
	const [skills, setSkills] = useState<readonly Skill[] | undefined>();
	const [keeping, setKeeping] = useState("");
	const [triggers, setTriggers] = useState<readonly Trigger[]>([]);
	const [making, setMaking] = useState({ name: "", from: "stripe", only: "" });
	/** The one just made, kept on screen until this dialog closes: its secret is shown once. */
	const [fresh, setFresh] = useState<Trigger | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();

	const load = useCallback(async (): Promise<void> => {
		try {
			const [plugins, held] = await Promise.all([plane.plugins(), plane.models()]);
			setMade(plugins.instances);
			setCatalog(plugins.catalog);
			setModels(held);
			setWhy(undefined);
			// After the rest, and allowed to fail on its own: reading these runs a command inside the
			// box, and an agent whose container is down should not take the whole screen with it.
			await plane.skills(agent.id).then(
				(learned) => setSkills(learned),
				() => setSkills([]),
			);
			await plane.triggers().then(
				(all) => setTriggers(all.filter((one) => one.agentId === agent.id)),
				() => setTriggers([]),
			);
		} catch (error) {
			setWhy((error as Error).message);
		}
	}, [plane, agent.id]);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (what: string, act: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setWhy(undefined);
		try {
			await act();
			await load();
			onChanged();
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			setBusy(undefined);
		}
	};

	const spent = agent.spentUsd;
	const ceiling = agent.limitUsd;

	return (
		<Modal wide title={nameOf(agent.id)} onClose={onClose}>
			<p className="lede">
				What this agent may spend, what it thinks with, what it can reach, and what it has to show
				you first. All of it takes effect on its next turn — nothing here interrupts one that is
				running.
			</p>

			{why !== undefined && <span className="why block">{why}</span>}

			<section className="flex flex-col gap-2">
				<Head
					title="Spending"
					says="A ceiling in dollars a day, reset at midnight UTC. The agent can ask to be held to less and never to more."
				/>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-line bg-raised p-3">
					<div className="min-w-[12rem] flex-1">
						<div className="font-mono text-said tabular-nums">
							${spent.toFixed(2)}
							<span className="text-muted">
								{ceiling === undefined ? " spent today" : ` of $${ceiling.toFixed(2)} today`}
							</span>
						</div>
						{ceiling !== undefined && (
							<div className="mt-2 h-1 overflow-hidden rounded-full bg-sunk">
								<div
									className="h-full rounded-full"
									style={{
										width: `${Math.min(100, (spent / ceiling) * 100)}%`,
										background:
											spent >= ceiling
												? "var(--red)"
												: spent >= ceiling * 0.8
													? "var(--amber)"
													: "var(--green)",
									}}
								/>
							</div>
						)}
					</div>
					<form
						className="flex flex-none items-center gap-1.5 whitespace-nowrap"
						onSubmit={(event) => {
							event.preventDefault();
							const amount = Number(limit.replace(/^\$/, ""));
							if (!Number.isFinite(amount) || amount <= 0) {
								setWhy(`"${limit}" is not an amount.`);
								return;
							}
							void run("limit", () => plane.setLimit(agent.id, amount));
						}}
					>
						<span className="text-[0.8rem] text-muted">$</span>
						<input
							className="field w-20 font-mono"
							value={limit}
							placeholder="none"
							onChange={(event) => setLimit(event.target.value)}
						/>
						<span className="text-[0.8rem] text-muted">/ day</span>
						<button type="submit" className="pill" data-yes="true" disabled={busy === "limit"}>
							{busy === "limit" && <Spin />}
							{busy === "limit" ? "setting…" : "set"}
						</button>
						{ceiling !== undefined && (
							<button
								type="button"
								className="pill"
								disabled={busy === "limit"}
								onClick={() => {
									setLimit("");
									void run("limit", () => plane.setLimit(agent.id, null));
								}}
							>
								no limit
							</button>
						)}
					</form>
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<Head
					title="Plugins"
					says="Which connections this agent holds. A plugin it does not hold is one it cannot reach, however logged in the account is."
				/>
				{made.length === 0 && (
					<p className="text-[0.8rem] text-muted">
						Nothing is connected on this plane yet. The Plugins screen is where that starts.
					</p>
				)}
				{made.map((one) => {
					const held = one.agents.includes(agent.id);
					const where = one.server.transport === "stdio" ? undefined : hostOf(one.server.url);
					// The company's own mark rather than the address its server happens to answer at:
					// `mcp.deepwiki.com` serves no icon and is not what anybody recognises anyway.
					const plugin = catalog.find((known) => known.id === one.from);
					return (
						<button
							key={one.name}
							type="button"
							className="flex items-center gap-3 rounded-lg border border-line bg-raised p-2.5 text-left hover:border-muted/50"
							data-here={held}
							disabled={busy === `hold:${one.name}`}
							onClick={() =>
								void run(`hold:${one.name}`, () => plane.holdPlugin(agent.id, one.name, !held))
							}
						>
							<Mark host={plugin?.mark ?? where} letter={one.name} size={26} />
							<span className="min-w-0 flex-1">
								<span className="block truncate font-mono text-said">{one.name}</span>
								<span className="block truncate text-[0.75rem] text-muted">
									{one.label ?? where ?? "runs in the sandbox"}
								</span>
							</span>
							{/* The account, because a plugin held without one is a tool that answers 401 and an
							    agent that spends a turn finding that out. */}
							{where !== undefined && !one.loggedIn && plugin?.account !== "open" && (
								<span className="badge" data-tone="warn">
									no account
								</span>
							)}
							{/* The same two chips the plugins screen draws, because they are the same two
							    states and a second shape for them would be a second thing to learn. */}
							<span className="hold" data-held={held}>
								{held ? "✓ held" : "+ give"}
							</span>
						</button>
					);
				})}
			</section>

			<section className="flex flex-col gap-2">
				<Head
					title="Triggers"
					says="What outside this plane gives it a turn. A wakeup answers when; this answers when something happens — Stripe cancels a subscription, GitHub merges a branch. Say which events are worth a turn, or every one the sender has will be one."
				/>
				<div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3">
					{triggers.length === 0 && fresh === undefined && (
						<span className="text-[0.8rem] text-muted">Nothing outside wakes this agent.</span>
					)}
					{triggers.map((one) => (
						<div key={one.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
							<code className="md-code">{one.name}</code>
							<span className="text-[0.78rem] text-muted">{one.from}</span>
							<span className="min-w-[8rem] flex-1 text-[0.78rem] text-muted">
								{one.only.length === 0 ? "every event it sends" : one.only.join(", ")} ·{" "}
								{one.fired === 0 ? "never fired" : `fired ${one.fired}×`}
							</span>
							<code className="md-code">{`${window.location.origin}/hooks/${one.name}`}</code>
							<button
								type="button"
								className="pill"
								data-no="true"
								disabled={busy === `trigger:${one.name}`}
								onClick={() =>
									void run(`trigger:${one.name}`, async () => {
										await plane.dropTrigger(one.name);
										setFresh(undefined);
									})
								}
							>
								{busy === `trigger:${one.name}` && <Spin />}
								drop
							</button>
						</div>
					))}

					{/* Once, here, and never again: it is pasted into a form on the sender's own site the
					    moment it exists, and a console that could show it later would be one it could be
					    taken from. */}
					{fresh?.secret !== undefined && (
						<div className="flex flex-col gap-1 border-line-soft border-t pt-2">
							<span className="text-[0.78rem] text-said">
								Paste this into {fresh.from}, with the address above. It is not shown again:
							</span>
							<code className="md-code break-all">{fresh.secret}</code>
						</div>
					)}

					<form
						className="flex flex-wrap items-center gap-2 border-line-soft border-t pt-2"
						onSubmit={(event) => {
							event.preventDefault();
							const name = making.name.trim();
							if (name === "") return;
							void run("trigger", async () => {
								const one = await plane.addTrigger(
									agent.id,
									name,
									making.from,
									making.only
										.split(/[\s,]+/)
										.map((word) => word.trim())
										.filter((word) => word.length > 0),
								);
								setFresh(one);
								setMaking({ name: "", from: making.from, only: "" });
							});
						}}
					>
						<input
							className="field w-36 font-mono"
							value={making.name}
							placeholder="stripe-cancels"
							spellCheck={false}
							onChange={(event) => setMaking({ ...making, name: event.target.value })}
						/>
						{SIGNERS.map((one) => (
							<button
								key={one}
								type="button"
								className="pill"
								data-yes={making.from === one}
								onClick={() => setMaking({ ...making, from: one })}
							>
								{one}
							</button>
						))}
						<input
							className="field min-w-[12rem] flex-1 font-mono"
							value={making.only}
							placeholder="customer.subscription.deleted"
							spellCheck={false}
							onChange={(event) => setMaking({ ...making, only: event.target.value })}
						/>
						<button
							type="submit"
							className="pill"
							data-yes="true"
							disabled={busy === "trigger" || making.name.trim() === ""}
						>
							{busy === "trigger" && <Spin />}
							make it
						</button>
					</form>
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<Head
					title="Skills"
					says="What it has written down about how to do something, in its own repository, where it reads them back. It writes them; this asks it to, and passes one to another agent."
				/>
				<div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3">
					{skills === undefined ? (
						<span className="flex items-center gap-2 text-[0.8rem] text-muted">
							<Spin /> reading its repository…
						</span>
					) : skills.length === 0 ? (
						<span className="text-[0.8rem] text-muted">
							Nothing written down yet. After it does something worth doing the same way twice, ask
							it to keep the procedure.
						</span>
					) : (
						skills.map((skill) => (
							<div key={skill.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
								<code className="md-code">{skill.name}</code>
								<span className="min-w-[8rem] flex-1 text-[0.8rem] text-muted">
									{skill.does === "" ? "—" : skill.does}
								</span>
								{/* Handed over rather than shared: the copy is the other agent's from then on,
								    which is the only version of this that does not need a second owner. */}
								{agents
									.filter((one) => one.id !== agent.id)
									.map((one) => (
										<button
											key={one.id}
											type="button"
											className="pill"
											disabled={busy === `give:${skill.name}:${one.id}`}
											title={`copy ${skill.name} into ${nameOf(one.id)}`}
											onClick={() =>
												void run(`give:${skill.name}:${one.id}`, async () => {
													await plane.giveSkill(agent.id, skill.name, one.id);
												})
											}
										>
											{busy === `give:${skill.name}:${one.id}` ? <Spin /> : "→"}
											{nameOf(one.id)}
										</button>
									))}
							</div>
						))
					)}
					<form
						className="flex flex-wrap items-center gap-2 border-line-soft border-t pt-2"
						onSubmit={(event) => {
							event.preventDefault();
							const name = keeping.trim();
							if (name === "") return;
							void run("keep", async () => {
								await plane.keepSkill(agent.id, name);
								setKeeping("");
							});
						}}
					>
						<input
							className="field w-40 font-mono"
							value={keeping}
							placeholder="weekly-report"
							spellCheck={false}
							onChange={(event) => setKeeping(event.target.value)}
						/>
						<button
							type="submit"
							className="pill"
							data-yes="true"
							disabled={busy === "keep" || keeping.trim() === ""}
						>
							{busy === "keep" && <Spin />}
							keep what it just did
						</button>
						<span className="text-[0.78rem] text-muted">
							— it takes a turn to write the procedure down and commit it.
						</span>
					</form>
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<Head
					title="Ask first"
					says="The two doors that open onto somebody else's inbox. Held, an answer is shown to you whole before it goes, and a yes sends exactly what it wrote — an approval decides the message, it does not take back one already sent."
				/>
				<div className="flex flex-wrap gap-1.5">
					{GATES.map((gate) => {
						const held = agent.gates.includes(gate.id);
						return (
							<button
								key={gate.id}
								type="button"
								className="pill"
								data-yes={held}
								disabled={busy === `gate:${gate.id}`}
								title={
									held
										? `${nameOf(agent.id)} shows you what it sends ${gate.said}`
										: `${nameOf(agent.id)} sends ${gate.said} without asking`
								}
								onClick={() =>
									void run(`gate:${gate.id}`, async () => {
										await plane.setGate(agent.id, gate.id, !held);
										onChanged();
									})
								}
							>
								{busy === `gate:${gate.id}` && <Spin />}
								{held ? "✓ " : ""}
								{gate.name}
							</button>
						);
					})}
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<Head
					title="Model"
					says="What it thinks with. Only the models this plane is configured with and can pay for."
				/>
				<div className="flex flex-wrap gap-1.5">
					{models.length === 0 && (
						<span className="text-[0.8rem] text-muted">No models configured on this plane.</span>
					)}
					{models.map((model) => (
						<button
							key={model.id}
							type="button"
							className="pill"
							data-yes={model.id === agent.model}
							disabled={busy === "model" || !model.held}
							title={model.held ? model.model : `${model.keyEnv} is not set on this plane`}
							onClick={() =>
								void run("model", async () => {
									await plane.command(agent.id, `/model ${model.id}`);
								})
							}
						>
							{model.id === agent.model ? "✓ " : ""}
							{model.id}
						</button>
					))}
				</div>
			</section>
		</Modal>
	);
}

/**
 * The doors an answer can leave by in the operator's name.
 *
 * Written here rather than read off the plane because it is two rows that have to be drawn whether
 * or not a plane answers, and because each of them wants a sentence a person would say. The plane
 * refuses anything it does not know, which is what keeps the two lists from drifting.
 */
/** Who can be at the other end of a trigger. The plane refuses anything it does not know. */
const SIGNERS = ["stripe", "github", "squad"] as const;

const GATES = [
	{ id: "mail", name: "Mail", said: "by mail" },
	{ id: "telegram", name: "Telegram", said: "on Telegram" },
] as const;

function Head({ title, says }: { title: string; says: string }) {
	return (
		<div>
			<h3 className="font-medium text-[0.88rem] text-said">{title}</h3>
			<p className="mt-1 text-[0.8rem]/[1.5] text-muted">{says}</p>
		</div>
	);
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}
