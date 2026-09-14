import type { AgentSummary, ModelStanding, Plugin } from "@squad/control-plane";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./avatar.tsx";
import { nameOf } from "./face.ts";
import { Mark } from "./Plugins.tsx";
import type { Connected, Plane, Skill, Trigger } from "./plane.ts";
import { Spin } from "./spin.tsx";

/**
 * One agent's settings.
 *
 * Everything here was already possible by typing a command into that agent's conversation, and that
 * is exactly the problem: `/limit 5` is a message to an agent about itself, and what it sets is not
 * the agent's opinion but the operator's. Said here instead, where what it may spend, what it thinks
 * with, what it can reach and who may wake it are in one place and none of them is a sentence to
 * remember.
 *
 * A column of cards, one fact each: what it is, the control, and a bar along the bottom holding the
 * sentence that qualifies it and the button that commits it. The shape is borrowed on purpose —
 * every settings screen anybody has used this decade is this shape, and one that invents its own is
 * one where the button has to be found. What it replaced had the qualifying sentence floating
 * between two controls on one line, which is how six settings read as a heap.
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
	/** Back to the conversation, which is where this was opened from. */
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
	const [making, setMaking] = useState({ name: "", from: "stripe", only: "", says: "" });
	/** Whether the signed kind is on screen. Shut, because the one-click kind is what is wanted. */
	const [signing, setSigning] = useState(false);
	/** The secret of the one just made. Shown once, here, and never readable again. */
	const [secret, setSecret] = useState<
		{ name: string; from: string; secret: string } | undefined
	>();
	const [why, setWhy] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();

	const load = useCallback(async (): Promise<void> => {
		try {
			const [plugins, held] = await Promise.all([plane.plugins(), plane.models()]);
			setMade(plugins.instances);
			setCatalog(plugins.catalog);
			setModels(held);
			setWhy(undefined);
			// After the rest, and allowed to fail on their own: reading these runs a command inside the
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
	const others = agents.filter((one) => one.id !== agent.id);

	return (
		<>
			<header className="pane-head">
				<button type="button" className="pane-back" onClick={onClose} title="back">
					<ArrowLeft className="size-4" />
				</button>
				<Avatar id={agent.id} />
				<span className="pane-title">{nameOf(agent.id)}</span>
				<div className="pane-facts">
					<span>settings</span>
				</div>
			</header>

			<div className="pane-scroll">
				<div className="cards-column">
					{why !== undefined && <p className="why">{why}</p>}

					{/* ── what it may spend ─────────────────────────────────── */}
					<form
						className="card"
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
						<div className="card-body">
							<div>
								<h2 className="card-title">Daily ceiling</h2>
								<p className="card-says">
									The most {nameOf(agent.id)} may spend in a day. It stops taking turns when it gets
									there, and starts again when the day does.
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-[0.85rem] text-muted">$</span>
								<input
									className="field field-short font-mono"
									value={limit}
									placeholder="none"
									onChange={(event) => setLimit(event.target.value)}
								/>
								<span className="text-[0.85rem] text-muted">a day</span>
							</div>
							<div className="flex items-center gap-3">
								<div className="h-1 flex-1 overflow-hidden rounded-full bg-sunk">
									<div
										className="h-full rounded-full"
										style={{
											width:
												ceiling === undefined ? "0%" : `${Math.min(100, (spent / ceiling) * 100)}%`,
											background:
												ceiling !== undefined && spent >= ceiling
													? "var(--red)"
													: ceiling !== undefined && spent >= ceiling * 0.8
														? "var(--amber)"
														: "var(--green)",
										}}
									/>
								</div>
								<span className="font-mono text-[0.8rem] text-muted tabular-nums">
									${spent.toFixed(2)} today
								</span>
							</div>
						</div>
						<div className="card-foot">
							<p>Resets at midnight UTC. The agent can ask to be held to less, never to more.</p>
							<div className="flex items-center gap-2">
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
										no ceiling
									</button>
								)}
								<button type="submit" className="pill" data-yes="true" disabled={busy === "limit"}>
									{busy === "limit" && <Spin />}
									save
								</button>
							</div>
						</div>
					</form>

					{/* ── what it thinks with ───────────────────────────────── */}
					<div className="card">
						<div className="card-body">
							<div>
								<h2 className="card-title">Model</h2>
								<p className="card-says">
									What it thinks with. Only the models this plane is configured with and holds a key
									for.
								</p>
							</div>
							<select
								className="select"
								value={agent.model ?? ""}
								disabled={busy === "model" || models.length === 0}
								onChange={(event) => {
									const id = event.target.value;
									void run("model", async () => {
										await plane.command(agent.id, `/model ${id}`);
									});
								}}
							>
								{agent.model === undefined && <option value="">the plane's default</option>}
								{models.map((model) => (
									<option key={model.id} value={model.id} disabled={!model.held}>
										{model.id}
										{model.held ? "" : ` — no ${model.keyEnv}`}
									</option>
								))}
							</select>
						</div>
						<div className="card-foot">
							<p>
								{models.length === 0
									? "No models are configured on this plane."
									: "It takes effect on the next turn. One that is running finishes on the model it started with."}
							</p>
						</div>
					</div>

					{/* ── who may wake it ───────────────────────────────────── */}
					<div className="card">
						<div className="card-body">
							<div>
								<h2 className="card-title">Triggers</h2>
								<p className="card-says">
									An address that gives {nameOf(agent.id)} a turn. Paste it into whatever should
									wake it — Stripe, GitHub, a script of yours — and anything posted there is a turn,
									with the payload in its hands.
								</p>
							</div>

							{triggers.length > 0 && (
								<div className="card-rows">
									{triggers.map((one) => (
										<div key={one.name} className="card-row">
											<div className="card-row-main">
												<Address url={`${window.location.origin}/hooks/${one.name}`} />
												{/* What the operator says arrives here. It reaches the turn as their
												    instruction, apart from the payload, so the agent is not left
												    inferring from the JSON what it is looking at — and inferring it
												    differently each time. */}
												<Says
													said={one.says ?? ""}
													busy={busy === `says:${one.name}`}
													onSay={(says) =>
														void run(`says:${one.name}`, () =>
															plane.describeTrigger(one.name, says),
														)
													}
												/>
												<span className="card-row-meta">
													<span className="badge">{one.from}</span>
													<span>{one.only.length === 0 ? "every event" : one.only.join(", ")}</span>
													<span>·</span>
													<span>{one.fired === 0 ? "never fired" : `fired ${one.fired}×`}</span>
												</span>
											</div>
											<button
												type="button"
												className="pill"
												data-no="true"
												disabled={busy === `trigger:${one.name}`}
												onClick={() =>
													void run(`trigger:${one.name}`, async () => {
														await plane.dropTrigger(one.name);
														setSecret(undefined);
													})
												}
											>
												{busy === `trigger:${one.name}` && <Spin />}
												delete
											</button>
										</div>
									))}
								</div>
							)}

							{/* Once, here, and never again: it goes into a form on the sender's own site the
							    moment it exists, and a console it could be read from later is one it could be
							    taken from. */}
							{secret !== undefined && (
								<div className="lines">
									<p className="note">
										The secret <strong>{secret.name}</strong> signs with, for {secret.from}. It is
										not shown again.
									</p>
									<Address url={secret.secret} />
								</div>
							)}

							{/* For a sender that signs: the signature is checked, and only the events named are
							    worth a turn. Stripe posts every event on the account at anything that takes one. */}
							{signing && (
								<form
									className="lines"
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
												making.says,
											);
											if (one?.secret !== undefined) {
												setSecret({ name: one.name, from: one.from, secret: one.secret });
											}
											setMaking({ name: "", from: making.from, only: "", says: "" });
										});
									}}
								>
									<label className="ask-line">
										<span className="ask-name">Called</span>
										<input
											className="field font-mono"
											value={making.name}
											placeholder="stripe-cancels"
											spellCheck={false}
											onChange={(event) => setMaking({ ...making, name: event.target.value })}
										/>
									</label>
									<div className="ask-line">
										<span className="ask-name">Signed by</span>
										<span className="flex flex-wrap gap-1.5">
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
										</span>
									</div>
									<label className="ask-line">
										<span className="ask-name">Only</span>
										<input
											className="field font-mono"
											value={making.only}
											placeholder="customer.subscription.deleted"
											spellCheck={false}
											onChange={(event) => setMaking({ ...making, only: event.target.value })}
										/>
									</label>
									<label className="ask-line">
										<span className="ask-name">Arrives</span>
										<input
											className="field"
											value={making.says}
											placeholder="A subscription was cancelled. Find out why and write it up."
											onChange={(event) => setMaking({ ...making, says: event.target.value })}
										/>
									</label>
									<div className="ask-line">
										<span className="ask-name" />
										<button
											type="submit"
											className="pill"
											data-yes="true"
											disabled={busy === "trigger" || making.name.trim() === ""}
										>
											{busy === "trigger" && <Spin />}
											create
										</button>
										<span className="note">
											Leave <em>only</em> empty and every event the sender has is a turn.
										</span>
									</div>
								</form>
							)}
						</div>
						<div className="card-foot">
							<p>
								The address is the secret: anyone who has it can wake {nameOf(agent.id)}. A sender
								that signs can be checked as well.
							</p>
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="pill"
									aria-expanded={signing}
									onClick={() => setSigning(!signing)}
								>
									{signing ? "never mind" : "signed…"}
								</button>
								<button
									type="button"
									className="pill"
									data-yes="true"
									disabled={busy === "webhook"}
									onClick={() =>
										void run("webhook", async () => {
											await plane.addTrigger(agent.id, "", "url", []);
											setSecret(undefined);
										})
									}
								>
									{busy === "webhook" && <Spin />}
									create webhook
								</button>
							</div>
						</div>
					</div>

					{/* ── what it can reach ─────────────────────────────────── */}
					<div className="card">
						<div className="card-body">
							<div>
								<h2 className="card-title">Plugins</h2>
								<p className="card-says">
									Which connections {nameOf(agent.id)} holds. One it does not hold is one it cannot
									reach, however logged in the account is.
								</p>
							</div>
							{made.length === 0 ? (
								<p className="note">Nothing is connected on this plane yet.</p>
							) : (
								<div className="plug-grid">
									{made.map((one) => {
										const held = one.agents.includes(agent.id);
										const where =
											one.server.transport === "stdio" ? undefined : hostOf(one.server.url);
										// The company's own mark rather than the address its server happens to
										// answer at: `mcp.deepwiki.com` serves no icon and is not what anybody
										// recognises anyway.
										const plugin = catalog.find((known) => known.id === one.from);
										return (
											<button
												key={one.name}
												type="button"
												className="plug-row"
												data-here={held}
												disabled={busy === `hold:${one.name}`}
												onClick={() =>
													void run(`hold:${one.name}`, () =>
														plane.holdPlugin(agent.id, one.name, !held),
													)
												}
											>
												<Mark host={plugin?.mark ?? where} letter={one.name} size={24} />
												<span className="min-w-0 flex-1">
													<span className="block truncate font-mono text-[0.85rem] text-said">
														{one.name}
													</span>
													<span className="block truncate text-[0.74rem] text-muted">
														{one.label ?? where ?? "runs in the sandbox"}
													</span>
												</span>
												{/* The account, because a plugin held without one is a tool that
												    answers 401 and an agent that spends a turn finding that out. */}
												{where !== undefined && !one.loggedIn && plugin?.account !== "open" && (
													<span className="badge" data-tone="warn">
														no account
													</span>
												)}
												<span className="hold" data-held={held}>
													{held ? "✓ held" : "+ give"}
												</span>
											</button>
										);
									})}
								</div>
							)}
						</div>
						<div className="card-foot">
							<p>
								An agent never holds the credential. Its requests leave with none and the proxy
								writes this plane's onto them on the way out.
							</p>
						</div>
					</div>

					{/* ── what it has learned ───────────────────────────────── */}
					<form
						className="card"
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
						<div className="card-body">
							<div>
								<h2 className="card-title">Skills</h2>
								<p className="card-says">
									What it has written down about how to do something, in its own repository, where
									it reads them back. It writes them; this asks it to.
								</p>
							</div>

							{skills === undefined ? (
								<p className="note flex items-center gap-2">
									<Spin /> reading its repository…
								</p>
							) : skills.length === 0 ? (
								<p className="note">
									Nothing written down yet. After it does something worth doing the same way twice,
									ask it to keep the procedure.
								</p>
							) : (
								<div className="card-rows">
									{skills.map((skill) => (
										<div key={skill.name} className="card-row">
											<div className="card-row-main">
												<span className="card-row-said">{skill.name}</span>
												<span className="card-row-meta">
													{skill.does === "" ? "—" : skill.does}
												</span>
											</div>
											{/* Handed over rather than shared: the copy is the other agent's from then
											    on, which is the only version of this that needs no second owner. */}
											{others.map((one) => (
												<button
													key={one.id}
													type="button"
													className="pill"
													title={`hand a copy to ${nameOf(one.id)}`}
													disabled={busy === `give:${skill.name}:${one.id}`}
													onClick={() =>
														void run(`give:${skill.name}:${one.id}`, async () => {
															await plane.giveSkill(agent.id, skill.name, one.id);
														})
													}
												>
													{busy === `give:${skill.name}:${one.id}` ? (
														<Spin />
													) : (
														<Avatar id={one.id} size={16} />
													)}
													{nameOf(one.id)}
												</button>
											))}
										</div>
									))}
								</div>
							)}

							<input
								className="field field-name font-mono"
								value={keeping}
								placeholder="weekly-report"
								spellCheck={false}
								onChange={(event) => setKeeping(event.target.value)}
							/>
						</div>
						<div className="card-foot">
							<p>It takes a turn to write the procedure down and commit it.</p>
							<button
								type="submit"
								className="pill"
								data-yes="true"
								disabled={busy === "keep" || keeping.trim() === ""}
							>
								{busy === "keep" && <Spin />}
								keep what it just did
							</button>
						</div>
					</form>

					{/* ── what it must show you ─────────────────────────────── */}
					<div className="card">
						<div className="card-body">
							<div>
								<h2 className="card-title">Ask before sending</h2>
								<p className="card-says">
									The two doors that open onto somebody else's inbox. Held, an answer is shown to
									you whole before it goes, and a yes sends exactly what it wrote.
								</p>
							</div>
							<div>
								{GATES.map((gate) => {
									const held = agent.gates.includes(gate.id);
									return (
										<button
											key={gate.id}
											type="button"
											className="switch"
											data-on={held}
											disabled={busy === `gate:${gate.id}`}
											onClick={() =>
												void run(`gate:${gate.id}`, () => plane.setGate(agent.id, gate.id, !held))
											}
										>
											<span className="switch-box" />
											<span className="switch-name">
												{gate.name}
												<span className="switch-says">
													{held
														? `Shown to you before it goes ${gate.said}.`
														: `Goes out ${gate.said} as written.`}
												</span>
											</span>
											{busy === `gate:${gate.id}` && <Spin />}
										</button>
									);
								})}
							</div>
						</div>
						<div className="card-foot">
							<p>
								An approval decides the message it is shown. It does not take back one already sent.
							</p>
						</div>
					</div>

					{/* ── and the end of it ─────────────────────────────────── */}
					<div className="card" data-danger="true">
						<div className="card-body">
							<div>
								<h2 className="card-title">Delete {nameOf(agent.id)}</h2>
								<p className="card-says">
									The container, its conversation, and everything decided here. What it wrote in its
									own repository goes with it. This cannot be undone.
								</p>
							</div>
						</div>
						<div className="card-foot">
							<p>
								Its name is free afterwards, and an agent made again under it is a different agent.
							</p>
							<Sure
								what={`Delete ${nameOf(agent.id)}`}
								busy={busy === "delete"}
								onSure={() =>
									void run("delete", async () => {
										await plane.remove(agent.id, true);
										onClose();
									})
								}
							/>
						</div>
					</div>
				</div>
			</div>
		</>
	);
}

/**
 * A long string whose whole purpose is to end up somewhere else.
 *
 * An address or a secret is not read, it is taken — so it is one field with the control that takes
 * it at the end, and it scrolls inside rather than wrapping. Selecting forty characters of URL by
 * hand is the thing this exists to stop.
 */
function Address({ url }: { url: string }) {
	const [took, setTook] = useState(false);

	return (
		<span className="address">
			<code>{url}</code>
			<button
				type="button"
				title="copy"
				onClick={() => {
					void navigator.clipboard.writeText(url).then(
						() => {
							setTook(true);
							// Long enough to be seen, short enough that the next copy says so too.
							setTimeout(() => setTook(false), 1400);
						},
						() => undefined,
					);
				}}
			>
				{took ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
				{took ? "copied" : "copy"}
			</button>
		</span>
	);
}

/**
 * What the operator says arrives at a trigger, written in place.
 *
 * Kept until it is left rather than saved with a button: it is one sentence on a row in a list, and
 * a row with a Save on it is a row with two things to press. Nothing is written unless it changed.
 */
function Says({
	said,
	busy,
	onSay,
}: {
	said: string;
	busy: boolean;
	onSay: (says: string) => void;
}) {
	const [draft, setDraft] = useState(said);

	// What the plane holds wins whenever it changes underneath — another console, or the answer to
	// the save this row just made — but never while somebody is part-way through a sentence.
	useEffect(() => {
		setDraft(said);
	}, [said]);

	return (
		<span className="says">
			<input
				className="field"
				value={draft}
				placeholder="Say what arrives here, and what to do about it…"
				disabled={busy}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (draft.trim() !== said.trim()) onSay(draft);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") setDraft(said);
				}}
			/>
			{busy && <Spin />}
		</span>
	);
}

/**
 * A button that asks once before doing something that cannot be undone.
 *
 * Two presses and no typing. Asking somebody to write a name out to prove they meant it teaches them
 * to copy the name from the sentence above the box, which proves nothing.
 */
function Sure({ what, busy, onSure }: { what: string; busy: boolean; onSure: () => void }) {
	const [asked, setAsked] = useState(false);

	useEffect(() => {
		if (!asked) return;
		// It puts itself away: a red button left armed on a screen somebody walked away from is a red
		// button the next click lands on.
		const timer = setTimeout(() => setAsked(false), 5000);
		return () => clearTimeout(timer);
	}, [asked]);

	if (!asked) {
		return (
			<button type="button" className="pill" data-no="true" onClick={() => setAsked(true)}>
				{what}
			</button>
		);
	}
	return (
		<span className="flex items-center gap-2">
			<span className="text-[0.8rem] text-said">Sure?</span>
			<button type="button" className="pill" data-no="true" disabled={busy} onClick={onSure}>
				{busy && <Spin />}
				yes, delete
			</button>
			<button type="button" className="pill" onClick={() => setAsked(false)}>
				keep it
			</button>
		</span>
	);
}

/** Who can be at the other end of a trigger, out of the ones that sign. */
const SIGNERS = ["stripe", "github", "squad"] as const;

/**
 * The doors an answer can leave by in the operator's name.
 *
 * Written here rather than read off the plane because it is two rows that have to be drawn whether
 * or not a plane answers, and because each wants a sentence a person would say. The plane refuses
 * anything it does not know, which is what keeps the two lists from drifting.
 */
const GATES = [
	{ id: "mail", name: "Mail", said: "by mail" },
	{ id: "telegram", name: "Telegram", said: "on Telegram" },
] as const;

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}
