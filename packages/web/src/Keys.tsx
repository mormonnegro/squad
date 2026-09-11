import type { ProviderStanding } from "@squad/control-plane";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils.ts";
import { Modal } from "./Modal.tsx";
import type { Plane } from "./plane.ts";

/**
 * The keys this plane can be given.
 *
 * This screen is why the install stopped asking. A key is not something you have to know before the
 * thing is running — it is a fact about what this plane can pay for, it changes, and the moment it
 * is typed here the proxy is already using it. Asking for three of them in the first minute made
 * them look like prerequisites, which is the one thing they are not.
 *
 * Nothing here ever shows a key. The plane answers with the name of the one it set and never with
 * the value, so a screen cannot leak what it was never told, and a row says only whether there is
 * one and where it came from.
 */
export function Keys({ plane, onClose }: { plane: Plane; onClose: () => void }) {
	const [rows, setRows] = useState<readonly ProviderStanding[] | undefined>();
	const [why, setWhy] = useState<string | undefined>();

	const load = useCallback(async (): Promise<void> => {
		try {
			setRows(await plane.providers());
			setWhy(undefined);
		} catch (error) {
			setWhy((error as Error).message);
		}
	}, [plane]);

	useEffect(() => {
		void load();
	}, [load]);

	const set = async (keyEnv: string, value: string): Promise<void> => {
		await plane.setKey(keyEnv, value);
		await load();
	};

	// Which models name this provider decides which half of the screen a row is in: the ones the
	// configuration is waiting on, and then the ones nothing here spends yet.
	const waiting = (rows ?? []).filter((row) => row.models.length > 0);
	const rest = (rows ?? []).filter((row) => row.models.length === 0);

	return (
		<Modal wide title="Keys" onClose={onClose}>
			<p className="lede">
				A key is how this environment pays for a model. The agents never hold one — a request leaves
				a sandbox with no credential and is given one on its way out — so what is typed here reaches
				the provider and nothing else, not the agent that spent it.
			</p>

			{why !== undefined && <span className="why block">{why}</span>}
			{rows === undefined && why === undefined && (
				<span className="text-[0.85rem] text-muted">asking the plane…</span>
			)}

			{waiting.length > 0 && (
				<Section
					title="What the models here need"
					says="Until one of these is set, a turn on those models fails at the proxy."
				>
					{waiting.map((row) => (
						<Row key={row.keyEnv} row={row} onSet={set} />
					))}
				</Section>
			)}

			{rest.length > 0 && (
				<Section
					title="Others this plane knows how to reach"
					says="A key here waits for a model that names the provider. Setting it first is fine — it is the same question, asked early."
				>
					{rest.map((row) => (
						<Row key={row.keyEnv} row={row} onSet={set} />
					))}
				</Section>
			)}
		</Modal>
	);
}

function Section({
	title,
	says,
	children,
}: {
	title: string;
	says: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div>
				<h3 className="font-medium text-[0.88rem] text-said">{title}</h3>
				<p className="mt-1 text-[0.8rem]/[1.5] text-muted">{says}</p>
			</div>
			<div className="flex flex-col gap-2">{children}</div>
		</div>
	);
}

/**
 * One provider.
 *
 * Open it and it is an input; it is never a row with a value in it. The field is a password field
 * for the reason every one of these is — a key pasted on a screen is a key in whatever is recording
 * that screen — and it is emptied the moment it has been sent.
 */
function Row({
	row,
	onSet,
}: {
	row: ProviderStanding;
	onSet: (keyEnv: string, value: string) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [why, setWhy] = useState<string | undefined>();
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) field.current?.focus();
	}, [open]);

	const send = async (value: string): Promise<void> => {
		setBusy(true);
		setWhy(undefined);
		try {
			await onSet(row.keyEnv, value);
			setTyped("");
			setOpen(false);
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rounded-lg border border-line bg-raised p-3">
			<div className="flex items-center gap-3">
				<KeyRound className={cn("size-4 flex-none", row.held ? "text-up" : "text-muted")} />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="font-medium text-said">{row.id}</span>
						<span className="truncate font-mono text-[0.72rem] text-muted">{row.keyEnv}</span>
					</div>
					<div className="truncate text-[0.78rem] text-muted">
						{row.models.length > 0 ? row.models.join(", ") : "no model here names it yet"}
					</div>
				</div>
				<Standing held={row.held} here={row.here} />
				{!open && (
					<button type="button" className="key" onClick={() => setOpen(true)}>
						{row.held ? "replace" : "add key"}
					</button>
				)}
			</div>

			{open && (
				<form
					className="mt-3 flex gap-2 border-t border-line pt-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (!busy && typed.length > 0) void send(typed);
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
						placeholder={`${row.keyEnv}…`}
						onChange={(event) => setTyped(event.target.value)}
					/>
					<button type="submit" className="key" data-yes="true" disabled={busy || typed === ""}>
						{busy ? "saving…" : "save"}
					</button>
					{/* Only the ones this plane was handed can be taken back. A key the machine exports
					    is the machine's, and a button here that pretended to remove it would leave a row
					    that says it is still held. */}
					{row.here && (
						<button type="button" className="key" disabled={busy} onClick={() => void send("")}>
							remove
						</button>
					)}
					<button type="button" className="key" disabled={busy} onClick={() => setOpen(false)}>
						cancel
					</button>
				</form>
			)}
			{why !== undefined && <span className="why mt-2 block">{why}</span>}
		</div>
	);
}

/** Whether there is a key, and which of the two places it came from. */
function Standing({ held, here }: { held: boolean; here: boolean }) {
	if (!held) {
		return (
			<span className="flex-none rounded border border-line px-1.5 py-0.5 font-mono text-[0.65rem] text-muted">
				no key
			</span>
		);
	}
	return (
		<span className="flex-none rounded border border-up/40 px-1.5 py-0.5 font-mono text-[0.65rem] text-up">
			{here ? "set here" : "from the machine"}
		</span>
	);
}
