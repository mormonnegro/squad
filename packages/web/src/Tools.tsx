import { Check, Eye, KeyRound, MousePointerClick, Search, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
	Plane,
	ToolOffer,
	ToolStanding,
	Tools as ToolsAnswer,
	VaultStanding,
} from "./plane.ts";
import { Spin } from "./spin.tsx";

/**
 * The two tools that have a model of their own, and every model either of them could use.
 *
 * Here together because they are the same kind of thing, and that is not obvious until you see them
 * side by side: an agent thinks with one model and there is no sense in choosing that model for the
 * one turn a week where something has to be searched for or looked at. So each of these jobs goes
 * somewhere else, to a model the operator picks once, paid for with a key no agent ever holds — and
 * what comes back is prose either way.
 *
 * The whole table rather than the rows that are paid for. The question somebody has at this screen
 * is not only "what can I turn on" but "what would I have to add", and a provider missing from the
 * list for want of a key is a provider nobody knows to want.
 */
export function Tools({ plane }: { plane: Plane }) {
	const [tools, setTools] = useState<ToolsAnswer>();
	const [why, setWhy] = useState<string>();
	const [busy, setBusy] = useState<string>();

	const look = useCallback(async () => {
		try {
			setTools(await plane.tools());
			setWhy(undefined);
		} catch (error) {
			setWhy((error as Error).message);
		}
	}, [plane]);

	useEffect(() => {
		void look();
	}, [look]);

	const run = async (what: string, doing: () => Promise<void>) => {
		setBusy(what);
		try {
			await doing();
			await look();
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<>
			{/* The same head the conversation has, because this is the same kind of thing: a screen the
			    column on the left switches between, rather than a question raised over one. */}
			<header className="pane-head">
				<span className="face" style={{ color: "var(--cyan)" }} aria-hidden="true">
					<Wrench className="size-3.5" />
				</span>
				<span className="pane-title">Abilities</span>
				<div className="pane-facts">
					<span>{tools?.vault.held === true ? "vault on" : "vault off"}</span>
					<span>{tools?.vision.using === undefined ? "looking off" : "looking on"}</span>
					<span>{tools?.pointing.using === undefined ? "pointing off" : "pointing on"}</span>
				</div>
			</header>

			<div className="pane-scroll">
				<div className="pane-column">
					<div className="page-head">
						<h1 className="page-title">Abilities</h1>
						<p className="page-says">
							Three things an agent's own model does badly, dearly or not at all. Each of them is
							done somewhere else by a model you pick here, paid for with a key the agents never
							hold. Choosing is the whole of setting one up: the host, the key and the price come
							with the provider, and the proxy is told to pay for that one endpoint and nothing else
							on it.
						</p>
					</div>

					{why !== undefined && <span className="why block">{why}</span>}
					{tools === undefined && why === undefined && (
						<span className="inline-flex items-center gap-2 text-[0.85rem] text-muted">
							<Spin />
							asking the plane…
						</span>
					)}

					{tools !== undefined && (
						<>
							<Ability
								icon={<Search className="size-3.5" />}
								title="Searching"
								says="An agent has no route to the web of its own: it asks, and a model on the other side of one approved host does the searching and the reading and answers in prose with its sources in it. Every plane searches — the only question is which model does it."
								offers={tools.search.offers}
								busy={busy}
								what="search"
								onUse={(offer) =>
									void run(`search:${offer.provider}:${offer.model}`, () =>
										plane.chooseSearch({ provider: offer.provider, model: offer.model }),
									)
								}
							/>

							<Ability
								icon={<Eye className="size-3.5" />}
								title="Looking"
								says="An agent reads a page as text and numbers, which is exact and nearly free. Looking is for what text cannot say — a chart, a captcha, a page that reads as empty and is not. The picture goes to a model that can see, with the agent's question, and prose comes back. Off, a screenshot is handed to the agent's own model, which reads it or silently does not."
								offers={tools.vision.offers}
								busy={busy}
								what="vision"
								off={tools.vision.using === undefined}
								onOff={() => void run("vision:off", () => plane.chooseVision(null))}
								onUse={(offer) =>
									void run(`vision:${offer.provider}:${offer.model}`, () =>
										plane.chooseVision({ provider: offer.provider, model: offer.model }),
									)
								}
							/>

							<Pointing
								standing={tools.pointing}
								busy={busy}
								onKey={(value) =>
									void run("pointing:key", () => plane.setKey("TYPESAFE_API_KEY", value))
								}
							/>

							<Vault
								standing={tools.vault}
								busy={busy}
								onKey={(value) =>
									void run("vault:key", () => plane.setKey("OP_SERVICE_ACCOUNT_TOKEN", value))
								}
							/>
						</>
					)}
				</div>
			</div>
		</>
	);
}

/**
 * Roughly what one use costs, which is the number somebody deciding actually reads.
 *
 * Rounded hard and rounded up. What this has to do is tell a tenth of a cent from three cents,
 * because that is the decision being made — not reconcile a bill, which the spending line does.
 */
function each(rate: { input: number; output: number }, what: What): string {
	// A screenshot is about seventeen hundred tokens however a provider counts them; a search reads
	// a few pages; a page handed over to be pointed at is about four thousand. The first two answer
	// in a few hundred tokens and the third answers with a number.
	const input = what === "vision" ? 1700 : 4000;
	const usd = (input * rate.input) / 1e6 + ((what === "pointing" ? 20 : 300) * rate.output) / 1e6;
	if (usd >= 0.01) return `~$${usd.toFixed(2)} each`;
	if (usd >= 0.001) return `~$${usd.toFixed(3)} each`;
	return "under a tenth of a cent";
}

/** The three jobs on this screen, which is what the cost line and the busy key are keyed on. */
type What = "search" | "vision" | "pointing";

/**
 * The third one, which is a key rather than a choice.
 *
 * The two above it are a decision — which model looks, which model searches — and a key to pay for
 * whichever was decided. This is one provider answering one kind of question at one price, so there
 * is nothing to decide and a list of one to pick from would be a question asked for the symmetry of
 * it. The key is the switch: paste it and agents can name things on a page, take it out and they go
 * back to reading the page for its numbers.
 */
function Pointing({
	standing,
	busy,
	onKey,
}: {
	standing: ToolStanding;
	busy: string | undefined;
	onKey: (value: string) => void;
}) {
	const [typed, setTyped] = useState("");
	const on = standing.using !== undefined;
	const offer = standing.offers[0];

	return (
		<section className="section">
			<div className="section-head">
				<h2 className="section-title">
					<span className="mr-2 inline-flex text-muted">
						<MousePointerClick className="size-3.5" />
					</span>
					Pointing
					{!on && <span className="tally">off</span>}
				</h2>
				<p className="section-says">
					An agent works a page by reading it — every button and box on it, numbered — and then
					naming a number. That list is most of what a browsing turn costs, and it is carried for
					the rest of the turn. With this on it can name the thing instead: the page goes to a
					classifier that answers in about a tenth of a second with which element it is, and the
					agent never sees the list. Unsure, nothing is pressed and it reads the page as before.
				</p>
			</div>

			<div
				className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${
					on ? "border-up/40 bg-up/5" : "border-line"
				}`}
			>
				<span className="w-4 flex-none text-up">{on && <Check className="size-3.5" />}</span>
				<span className="min-w-0 flex-1 truncate">
					<span className="text-said">{standing.using?.model ?? offer?.model ?? "jev-latest"}</span>
					<span className="ml-2 text-[0.8rem] text-muted">
						{standing.using?.provider ?? offer?.provider ?? "typesafe"}
					</span>
				</span>
				<span className="flex-none text-[0.78rem] text-muted">
					{offer === undefined ? "" : each(offer.rate, "pointing")}
				</span>
				{on ? (
					<button
						type="button"
						className="flex-none rounded-md border border-line px-2.5 py-1 text-[0.78rem] hover:text-say disabled:text-muted"
						disabled={busy !== undefined}
						onClick={() => onKey("")}
					>
						{busy === "pointing:key" ? <Spin /> : "forget the key"}
					</button>
				) : (
					<form
						className="flex flex-none items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (typed.trim() === "") return;
							onKey(typed.trim());
							setTyped("");
						}}
					>
						{/* Nothing here ever shows a key. The plane answers with whether it holds one and
						    never with the value, which is why this is a box to type into and not a field
						    with something in it. */}
						<input
							className="field w-56"
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="TYPESAFE_API_KEY…"
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
						/>
						<button
							type="submit"
							className="flex-none rounded-md border border-line px-2.5 py-1 text-[0.78rem] hover:text-say disabled:text-muted"
							disabled={typed.trim() === "" || busy !== undefined}
						>
							{busy === "pointing:key" ? <Spin /> : "turn it on"}
						</button>
					</form>
				)}
			</div>

			<p className="section-says">
				One key from <code>console.typesafe.ai</code> and this is on. It is the whole of the switch:
				no agent ever holds it — the request leaves the sandbox with no credential and is given one
				on its way out, at that one endpoint and nowhere else.
			</p>
		</section>
	);
}

/**
 * The vault, which is the one thing on this screen that is not a model at all.
 *
 * It is here because of what it is a switch for: an agent stopped at a login has three ways on and
 * two of them are bad — invent a credential, or give up quietly. This is the third, and it is the
 * only one that costs the operator nothing at the moment it is needed.
 *
 * What the paragraph has to say is where the password goes, because that is the question somebody
 * pasting this is actually asking. It goes into the browser\'s container, which is the one the agent
 * has no filesystem in, and into the page as keystrokes. The agent names a site; it never sees a
 * field. Which sites, per agent, is the other half and is not decided here: it is decided in front
 * of the agent, with /screen login.
 */
function Vault({
	standing,
	busy,
	onKey,
}: {
	standing: VaultStanding;
	busy: string | undefined;
	onKey: (value: string) => void;
}) {
	const [typed, setTyped] = useState("");

	return (
		<section className="section">
			<div className="section-head">
				<h2 className="section-title">
					<span className="mr-2 inline-flex text-muted">
						<KeyRound className="size-3.5" />
					</span>
					Signing in
					{!standing.held && <span className="tally">off</span>}
				</h2>
				<p className="section-says">
					A 1Password service account, read inside each agent\'s browser and nowhere else. The agent
					asks to be signed into a site, the password is looked up in that container and typed into
					the page, and what comes back to the agent is a sentence about which boxes were filled —
					never a field, never a value, not in the answer and not in any later reading of the page.
					Which sites each agent may ask for is its own list:{" "}
					<code>/screen login &lt;host&gt;</code> in its conversation, and nothing it can type opens
					one for itself.
				</p>
			</div>

			<div
				className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${
					standing.held ? "border-up/40 bg-up/5" : "border-line"
				}`}
			>
				<span className="w-4 flex-none text-up">
					{standing.held && <Check className="size-3.5" />}
				</span>
				<span className="min-w-0 flex-1 truncate">
					<span className="text-said">{standing.held ? "a vault is connected" : "no vault"}</span>
					<span className="ml-2 text-[0.8rem] text-muted">
						{standing.held && !standing.here ? "from this machine's environment" : "1password"}
					</span>
				</span>
				{standing.held ? (
					<button
						type="button"
						className="flex-none rounded-md border border-line px-2.5 py-1 text-[0.78rem] hover:text-say disabled:text-muted"
						disabled={busy !== undefined || !standing.here}
						title={
							standing.here
								? "the browsers are made again without it"
								: "this one was exported to the plane on the host, so it is taken back there"
						}
						onClick={() => onKey("")}
					>
						{busy === "vault:key" ? <Spin /> : "forget the token"}
					</button>
				) : (
					<form
						className="flex flex-none items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (typed.trim() === "") return;
							onKey(typed.trim());
							setTyped("");
						}}
					>
						{/* A box to type into rather than a field with something in it: this plane answers
						    with whether it holds a token and never with the token. */}
						<input
							className="field w-56"
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="ops_…"
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
						/>
						<button
							type="submit"
							className="flex-none rounded-md border border-line px-2.5 py-1 text-[0.78rem] hover:text-say disabled:text-muted"
							disabled={typed.trim() === "" || busy !== undefined}
						>
							{busy === "vault:key" ? <Spin /> : "connect it"}
						</button>
					</form>
				)}
			</div>

			<p className="section-says">
				Make it in 1Password under Developer → Service accounts, and give it read access to one
				vault — the accounts in that vault are the accounts your agents can be signed into, so it is
				worth being a vault made for this. A service account cannot read your Private vault at all.
				Every browser is made again when this changes, which takes a few seconds and costs nothing
				that was signed in.
			</p>
		</section>
	);
}

function Ability({
	icon,
	title,
	says,
	offers,
	busy,
	what,
	off,
	onOff,
	onUse,
}: {
	icon: React.ReactNode;
	title: string;
	says: string;
	offers: readonly ToolOffer[];
	busy: string | undefined;
	what: What;
	/** Searching cannot be off: every plane searches, and there is no row for not searching. */
	off?: boolean;
	onOff?: () => void;
	onUse: (offer: ToolOffer) => void;
}) {
	return (
		<section className="section">
			<div className="section-head">
				<h2 className="section-title">
					<span className="mr-2 inline-flex text-muted">{icon}</span>
					{title}
					{off === true && <span className="tally">off</span>}
				</h2>
				<p className="section-says">{says}</p>
			</div>

			<div className="flex flex-col gap-1">
				{offers.map((offer) => (
					<div
						key={`${offer.provider}:${offer.model}`}
						className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
							offer.using ? "border-up/40 bg-up/5" : "border-line"
						}`}
					>
						<span className="w-4 flex-none text-up">
							{offer.using && <Check className="size-3.5" />}
						</span>
						<span className="min-w-0 flex-1 truncate">
							<span className="text-said">{offer.model}</span>
							<span className="ml-2 text-[0.8rem] text-muted">{offer.provider}</span>
						</span>
						{/* What it would cost, and — when the key is missing — the name of the thing to go
						    and add. A row that said only "no key" would send somebody looking for which. */}
						<span className="flex-none text-[0.78rem] text-muted">{each(offer.rate, what)}</span>
						<span
							className={`flex-none text-[0.78rem] ${offer.held ? "text-muted" : "text-working"}`}
							title={offer.held ? "this plane holds that key" : `${offer.keyEnv} is not held here`}
						>
							{offer.held ? "key ✓" : `key ✗ ${offer.keyEnv}`}
						</span>
						<button
							type="button"
							className="flex-none rounded-md border border-line px-2.5 py-1 text-[0.78rem] hover:text-say disabled:text-muted"
							disabled={offer.using || busy !== undefined}
							onClick={() => onUse(offer)}
						>
							{busy === `${what}:${offer.provider}:${offer.model}` ? (
								<Spin />
							) : offer.using ? (
								"in use"
							) : (
								"use"
							)}
						</button>
					</div>
				))}
			</div>

			{onOff !== undefined && (
				<button
					type="button"
					className="mt-2 self-start text-[0.8rem] text-muted hover:text-say disabled:text-muted"
					disabled={off === true || busy !== undefined}
					onClick={onOff}
				>
					{off === true ? "nothing is looking" : "turn looking off"}
				</button>
			)}
		</section>
	);
}
