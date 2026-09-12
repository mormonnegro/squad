import type { ProviderStanding } from "@squad/control-plane";
import { ArrowLeft, Check, ExternalLink, KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils.ts";
import { Modal } from "./Modal.tsx";
import type { Plane } from "./plane.ts";
import { lookOf, Mark } from "./providers.tsx";

/**
 * The first key, asked for once and confirmed rather than assumed.
 *
 * Everything else is in place by the time somebody sees this: the plane is up, an agent exists, the
 * console is open. What is missing is the one thing without which a turn stops at the model, and
 * the screen that took keys before this was a settings list of nine providers — right for changing
 * one, wrong for the first, where the question is not "which row" but "which of these do you have an
 * account with".
 *
 * It ends by asking the provider. A key that is present and a key that works are different facts,
 * and this is the only moment anybody is in a position to learn which one they have.
 */
export function FirstKey({
	plane,
	onClose,
	onDone,
}: {
	plane: Plane;
	onClose: () => void;
	onDone: () => void;
}) {
	const [rows, setRows] = useState<readonly ProviderStanding[] | undefined>();
	const [picked, setPicked] = useState<ProviderStanding | undefined>();

	useEffect(() => {
		void plane
			.providers()
			.then((all) => setRows(all))
			.catch(() => setRows([]));
	}, [plane]);

	// The ones a model here already names. A key for a provider nothing is configured to think with
	// buys nothing, which makes it the wrong thing to offer somebody who has none at all.
	const spent = (rows ?? []).filter((one) => one.models.length > 0);

	return (
		<Modal size="wider" title="Give it something to think with" onClose={onClose}>
			{picked === undefined ? (
				<>
					<p className="lede">
						An agent here runs in a container on your machine, and thinks through a model somewhere
						else. Which one is yours to choose — the key goes to this plane, which spends it on the
						agent's behalf and never hands it over.
					</p>
					<div className="grid gap-3 sm:grid-cols-3">
						{spent.map((one) => (
							<button
								type="button"
								key={one.keyEnv}
								onClick={() => setPicked(one)}
								className={cn(
									"flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors",
									"border-line bg-raised hover:border-[#39414a]",
								)}
							>
								<Mark id={one.id} />
								<span className="font-medium text-said">{lookOf(one.id).name}</span>
								<span className="text-[0.8rem]/[1.45] text-muted">{lookOf(one.id).says}</span>
								<span className="mt-auto w-full truncate pt-1 font-mono text-[0.68rem] text-muted">
									{one.models.join(", ")}
								</span>
							</button>
						))}
					</div>
					{rows !== undefined && spent.length === 0 && (
						<p className="small muted">
							No model in this plane's configuration names a provider, so there is nothing a key
							would be spent on yet.
						</p>
					)}
					<p className="small muted">
						One is enough to start. The rest, and every other provider this knows how to reach, are
						under <strong>Keys</strong> in the environment menu.
					</p>
				</>
			) : (
				<Paste
					provider={picked}
					plane={plane}
					onBack={() => setPicked(undefined)}
					onDone={onDone}
				/>
			)}
		</Modal>
	);
}

function Paste({
	provider,
	plane,
	onBack,
	onDone,
}: {
	provider: ProviderStanding;
	plane: Plane;
	onBack: () => void;
	onDone: () => void;
}) {
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [why, setWhy] = useState<string | undefined>();
	const [good, setGood] = useState<number | undefined>();
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => field.current?.focus(), []);

	const look = lookOf(provider.id);

	const save = useCallback(async (): Promise<void> => {
		setBusy(true);
		setWhy(undefined);
		try {
			await plane.setKey(provider.keyEnv, typed.trim());
			// Asked of the provider, not of the file. Saving a key only proves somebody typed one.
			const catalog = await plane.offers();
			const mine = catalog.trouble.filter((line) => line.startsWith(provider.id));
			if (mine.length > 0) {
				// Kept rather than left in place: a key that does not work is worse than none, because
				// the screen stops saying anything is missing and the failure moves to the first turn.
				await plane.setKey(provider.keyEnv, "");
				setWhy(`${lookOf(provider.id).name} refused it — ${mine[0]}`);
				return;
			}
			setGood(catalog.offers.filter((offer) => offer.provider === provider.id).length);
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			setBusy(false);
		}
	}, [plane, provider, typed]);

	if (good !== undefined) {
		return (
			<div className="flex flex-col gap-4">
				<div className="flex items-center gap-3">
					<Check className="size-5 flex-none text-up" />
					<div>
						<div className="font-medium text-said">
							{look.name} answered
							{good > 0 ? ` with ${good} model${good === 1 ? "" : "s"}` : ""}
						</div>
						<div className="text-[0.82rem] text-muted">
							It holds from the next turn, with nothing restarted.
						</div>
					</div>
				</div>
				<button type="button" className="key self-start" data-yes="true" onClick={onDone}>
					done
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<button
				type="button"
				onClick={onBack}
				className="flex items-center gap-1.5 self-start text-[0.82rem] text-muted hover:text-say"
			>
				<ArrowLeft className="size-3.5" />
				another provider
			</button>

			<div className="flex items-start gap-3">
				<Mark id={provider.id} />
				<div>
					<div className="flex items-baseline gap-2">
						<span className="font-medium text-said">{look.name}</span>
						<span className="font-mono text-[0.72rem] text-muted">{provider.keyEnv}</span>
					</div>
					{look.at !== undefined && (
						<a
							href={look.at}
							target="_blank"
							rel="noreferrer noopener"
							className="mt-1 inline-flex items-center gap-1.5 text-[0.82rem] text-here hover:underline"
						>
							<ExternalLink className="size-3.5" />
							where {look.name} gives you one
						</a>
					)}
				</div>
			</div>

			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!busy && typed.trim().length > 0) void save();
				}}
			>
				<input
					ref={field}
					type="password"
					autoComplete="off"
					spellCheck={false}
					className="field min-w-0 flex-1 font-mono"
					value={typed}
					disabled={busy}
					placeholder={`${provider.keyEnv}…`}
					onChange={(event) => setTyped(event.target.value)}
				/>
				<button
					type="submit"
					className="key"
					data-yes="true"
					disabled={busy || typed.trim() === ""}
				>
					<KeyRound className="mr-1 inline size-3.5" />
					{busy ? "asking…" : "use it"}
				</button>
			</form>

			{why !== undefined && <span className="why">{why}</span>}

			<p className="small muted">
				It is written where only this plane can read it, and the agents never see it: a request
				leaves a sandbox with no credential and is given one on its way out.
			</p>
		</div>
	);
}
