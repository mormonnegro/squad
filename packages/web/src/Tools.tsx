import { Check, Eye, Search, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Plane, ToolOffer, Tools as ToolsAnswer } from "./plane.ts";
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
					<span>{tools?.vision.using === undefined ? "looking off" : "looking on"}</span>
				</div>
			</header>

			<div className="pane-scroll">
				<div className="pane-column">
					<div className="page-head">
						<h1 className="page-title">Abilities</h1>
						<p className="page-says">
							Two things an agent cannot do with the model it thinks with. Each of them is done
							somewhere else by a model you pick here, paid for with a key the agents never hold,
							and answered in words. Choosing is the whole of setting one up: the host, the key and
							the price come with the provider, and the proxy is told to pay for that one endpoint
							and nothing else on it.
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
function each(rate: { input: number; output: number }, what: "search" | "vision"): string {
	// A screenshot is about seventeen hundred tokens however a provider counts them; a search reads
	// a few pages. Both answer in a few hundred.
	const input = what === "vision" ? 1700 : 4000;
	const usd = (input * rate.input) / 1e6 + (300 * rate.output) / 1e6;
	if (usd >= 0.01) return `~$${usd.toFixed(2)} each`;
	if (usd >= 0.001) return `~$${usd.toFixed(3)} each`;
	return "under a tenth of a cent";
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
	what: "search" | "vision";
	/** Only looking can be off. Every plane searches, and there is no row for not searching. */
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
