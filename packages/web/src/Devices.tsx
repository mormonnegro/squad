import { Laptop, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "./lib/utils.ts";
import { Modal } from "./Modal.tsx";
import type { DeviceRow, Plane } from "./plane.ts";

/**
 * The browsers this environment has let in.
 *
 * The screen that makes a list worth having. A plane used to hold one secret, which could answer
 * none of the questions anybody actually has: who is in here, take this one out, when was that
 * laptop last used. None of those are hard once there is a list — they were impossible before,
 * because the only way to remove anybody was to change the secret and remove everybody.
 */
export function Devices({ plane, onClose }: { plane: Plane; onClose: () => void }) {
	const [rows, setRows] = useState<readonly DeviceRow[] | undefined>();
	const [here, setHere] = useState<string | undefined>();
	const [why, setWhy] = useState<string | undefined>();

	const load = useCallback(async (): Promise<void> => {
		try {
			const answer = await plane.devices();
			setRows(answer.devices);
			setHere(answer.here);
			setWhy(undefined);
		} catch (error) {
			setWhy((error as Error).message);
		}
	}, [plane]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<Modal wide title="Devices" onClose={onClose}>
			<p className="lede">
				Every browser that has been let into this environment. Each holds a key of its own, earned
				once and never sent anywhere again — so taking one out here takes out that one, and leaves
				every other exactly where it was.
			</p>

			{why !== undefined && <span className="why block">{why}</span>}
			{rows === undefined && why === undefined && (
				<span className="text-[0.85rem] text-muted">asking the plane…</span>
			)}

			<div className="flex flex-col gap-2">
				{rows?.map((row) => (
					<Row
						key={row.id}
						row={row}
						here={row.id === here}
						onGone={() => {
							void load();
						}}
						plane={plane}
					/>
				))}
			</div>

			{rows !== undefined && rows.length === 0 && (
				<p className="small muted">
					Nothing has been let in yet, which means this page is reached some other way — through a
					relay, or by a token carried in a header.
				</p>
			)}
		</Modal>
	);
}

function Row({
	row,
	here,
	plane,
	onGone,
}: {
	row: DeviceRow;
	here: boolean;
	plane: Plane;
	onGone: () => void;
}) {
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);

	const out = async (): Promise<void> => {
		setBusy(true);
		try {
			await plane.revoke(row.id);
			onGone();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className={cn("rounded-lg border p-3", here ? "border-here/40 bg-white/5" : "border-line")}
		>
			<div className="flex items-center gap-3">
				<Laptop className={cn("size-4 flex-none", here ? "text-here" : "text-muted")} />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="truncate font-medium text-said">{row.name}</span>
						{here && <span className="flex-none text-[0.7rem] text-here">this one</span>}
					</div>
					<div className="truncate text-[0.78rem] text-muted">
						joined {when(row.createdAt)} · last seen {when(row.lastSeenAt)}
					</div>
				</div>
				{/* Asked twice for this one only. Every other row takes somebody else out; this row is the
				    screen you are reading, and the click that closes it looks exactly the same. */}
				{!asking && (
					<button type="button" className="pill" disabled={busy} onClick={() => setAsking(true)}>
						{here ? "sign out" : "remove"}
					</button>
				)}
				{asking && (
					<span className="flex flex-none items-center gap-2">
						<span className="text-[0.78rem] text-muted">
							{here ? "this is the browser you are in —" : "sure?"}
						</span>
						<button type="button" className="pill" disabled={busy} onClick={() => void out()}>
							<ShieldOff className="mr-1 inline size-3.5" />
							{busy ? "…" : here ? "sign out anyway" : "remove"}
						</button>
						<button type="button" className="pill" disabled={busy} onClick={() => setAsking(false)}>
							cancel
						</button>
					</span>
				)}
			</div>
		</div>
	);
}

/** Close enough for a list somebody reads, which is what these two dates are for. */
function when(at: string): string {
	const then = new Date(at).getTime();
	if (Number.isNaN(then)) return "at some point";
	const ago = Math.max(0, Date.now() - then);
	const minutes = Math.floor(ago / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days < 30 ? `${days}d ago` : new Date(at).toLocaleDateString();
}
