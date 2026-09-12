import type { AgentSummary, ModelStanding, Plugin } from "@squad/control-plane";
import { useCallback, useEffect, useState } from "react";
import { nameOf } from "./face.ts";
import { Modal } from "./Modal.tsx";
import { Mark } from "./Plugins.tsx";
import type { Connected, Plane } from "./plane.ts";
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
	onClose,
	onChanged,
}: {
	plane: Plane;
	agent: AgentSummary;
	onClose: () => void;
	onChanged: () => void;
}) {
	const [made, setMade] = useState<readonly Connected[]>([]);
	const [catalog, setCatalog] = useState<readonly Plugin[]>([]);
	const [models, setModels] = useState<readonly ModelStanding[]>([]);
	const [limit, setLimit] = useState(agent.limitUsd === undefined ? "" : String(agent.limitUsd));
	const [why, setWhy] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();

	const load = useCallback(async (): Promise<void> => {
		try {
			const [plugins, held] = await Promise.all([plane.plugins(), plane.models()]);
			setMade(plugins.instances);
			setCatalog(plugins.catalog);
			setModels(held);
			setWhy(undefined);
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
				What this agent may spend, what it thinks with, and what it can reach. All three take effect
				on its next turn — nothing here interrupts one that is running.
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
