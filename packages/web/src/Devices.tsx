import { Copy, Laptop, Plus, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils.ts";
import { Modal } from "./Modal.tsx";
import type { DeviceRow, Invitation, Plane } from "./plane.ts";
import { Spin } from "./spin.tsx";

/** How long an invitation may be made to last, in the words the screen offers. */
const LASTS = [
	["hour", "1 hour"],
	["day", "1 day"],
	["week", "7 days"],
] as const;

/**
 * Who may come in, and who is in.
 *
 * Two lists, and they are the same subject twice: an invitation is a way in that has been handed to
 * somebody, and a device is a browser that used one. Before there were invitations this screen was
 * only the second half, and it was a list that could take a browser out and then watch the same
 * person walk back in with the token they still had — because the only way in was the plane's own
 * key, which never expires and is the same string for everybody.
 */
export function Devices({ plane, onClose }: { plane: Plane; onClose: () => void }) {
	const [rows, setRows] = useState<readonly DeviceRow[] | undefined>();
	const [invites, setInvites] = useState<readonly Invitation[]>([]);
	const [here, setHere] = useState<string | undefined>();
	const [why, setWhy] = useState<string | undefined>();

	const load = useCallback(async (): Promise<void> => {
		try {
			const [answer, handed] = await Promise.all([plane.devices(), plane.invites()]);
			setRows(answer.devices);
			setInvites(handed);
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
		<Modal wide title="Access" onClose={onClose}>
			<p className="lede">
				Everybody who can drive these agents. An invitation is a way in you hand to one person, and
				it runs out; a browser that used one holds a key of its own from then on — so taking one out
				here takes out that one and leaves every other exactly where it was.
			</p>

			{why !== undefined && <span className="why block">{why}</span>}
			{rows === undefined && why === undefined && (
				<span className="inline-flex items-center gap-2 text-[0.85rem] text-muted">
					<Spin />
					asking the plane…
				</span>
			)}

			<Invites plane={plane} invites={invites} onChanged={() => void load()} />

			<div className="section-head">
				<h2 className="section-title">
					In
					{rows !== undefined && <span className="tally">{rows.length}</span>}
				</h2>
				<p className="section-says">
					Every browser that has been let in. Each holds a key it earned once, which was never sent
					anywhere again.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				{rows?.map((row) => (
					<Row
						key={row.id}
						row={row}
						from={invites.find((one) => one.id === row.from)?.label}
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

/**
 * The ways in that have been handed out, and the making of one more.
 *
 * The link is shown once, here, and then never again from anywhere: the plane keeps a hash of it
 * and nothing else. That is not a limitation to apologise for — it is the difference between a list
 * of things that have been given out and a drawer full of working keys — but it does decide the
 * shape of this: the address has to be in front of somebody, copyable, before the screen is allowed
 * to move on.
 */
function Invites({
	plane,
	invites,
	onChanged,
}: {
	plane: Plane;
	invites: readonly Invitation[];
	onChanged: () => void;
}) {
	const [making, setMaking] = useState(false);
	const [label, setLabel] = useState("");
	const [lasts, setLasts] = useState<"hour" | "day" | "week">("day");
	const [many, setMany] = useState(false);
	const [busy, setBusy] = useState(false);
	const [why, setWhy] = useState<string | undefined>();
	/** The one just made, with its address, which is the only moment it can be read. */
	const [made, setMade] = useState<{ label: string; url: string } | undefined>();
	const [copied, setCopied] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (making) field.current?.focus();
	}, [making]);

	const send = async (): Promise<void> => {
		setBusy(true);
		setWhy(undefined);
		try {
			const answer = await plane.invite(label.trim(), lasts, many ? 20 : 1);
			// Composed here because this is the end that knows the address: the plane is reached at
			// whatever this page was opened at, and it cannot know what that was from inside a container.
			setMade({
				label: answer.invite.label,
				url: `${window.location.origin}/?t=${encodeURIComponent(answer.secret)}`,
			});
			setLabel("");
			setMaking(false);
			setCopied(false);
			onChanged();
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="section">
			<div className="section-head">
				<h2 className="section-title">
					Invitations
					{invites.length > 0 && <span className="tally">{invites.length}</span>}
				</h2>
				<p className="section-says">
					A way in for one person, which runs out. Whoever opens it gets a key of their own and
					shows up below under their own name — so calling this off later takes out that person and
					nobody else.
				</p>
			</div>

			{why !== undefined && <span className="why block">{why}</span>}

			{/* The address, once. Kept on screen until it is put away on purpose, because there is
			    nowhere else it can ever be read from. */}
			{made !== undefined && (
				<div className="rounded-[10px] border border-up/40 bg-up/5 p-3">
					<div className="mb-2 text-[0.82rem] text-said">
						The invitation for <strong>{made.label}</strong>. This is the only time it can be read —
						hand it over now, and make another if it gets lost.
					</div>
					<div className="flex gap-2">
						<input
							className="field min-w-0 flex-1 font-mono"
							readOnly
							value={made.url}
							onFocus={(event) => event.target.select()}
						/>
						<button
							type="button"
							className="pill"
							onClick={() => {
								void navigator.clipboard.writeText(made.url).then(
									() => setCopied(true),
									() => setCopied(false),
								);
							}}
						>
							<Copy className="size-3.5" />
							{copied ? "copied" : "copy"}
						</button>
						<button type="button" className="pill" onClick={() => setMade(undefined)}>
							done
						</button>
					</div>
				</div>
			)}

			{invites.length > 0 && (
				<div className="flex flex-col gap-2">
					{invites.map((one) => (
						<Handed
							key={one.id}
							one={one}
							onRevoke={async () => {
								await plane.revokeInvite(one.id);
								onChanged();
							}}
						/>
					))}
				</div>
			)}

			{!making && (
				<button type="button" className="pill self-start" onClick={() => setMaking(true)}>
					<Plus className="size-3.5" />
					invite somebody
				</button>
			)}

			{making && (
				<form
					className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-raised p-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (!busy && label.trim() !== "") void send();
					}}
				>
					<input
						ref={field}
						className="field min-w-[12rem] flex-1"
						value={label}
						placeholder="who is it for?"
						onChange={(event) => setLabel(event.target.value)}
					/>
					{/* It always runs out. "Never" is what the plane's own token already is, and handing
					    that out is the thing these exist to replace. */}
					{LASTS.map(([key, said]) => (
						<button
							key={key}
							type="button"
							className="pill"
							data-yes={lasts === key}
							onClick={() => setLasts(key)}
						>
							{said}
						</button>
					))}
					<button
						type="button"
						className="pill"
						data-yes={many}
						title="one link several people can open, until it expires"
						onClick={() => setMany((was) => !was)}
					>
						{many ? "several browsers" : "one browser"}
					</button>
					<button
						type="submit"
						className="pill"
						data-yes="true"
						disabled={busy || label.trim() === ""}
					>
						{busy && <Spin />}
						{busy ? "making…" : "make the link"}
					</button>
					<button type="button" className="pill" onClick={() => setMaking(false)}>
						cancel
					</button>
				</form>
			)}
		</section>
	);
}

/** One invitation, and what became of it. */
function Handed({ one, onRevoke }: { one: Invitation; onRevoke: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const over = Date.parse(one.expiresAt) <= Date.now();
	const spent = one.left <= 0;
	const state = over ? "expired" : spent ? "used" : `expires ${until(one.expiresAt)}`;

	return (
		<div className="flex items-center gap-3 rounded-lg border border-line p-3">
			<Plus className={cn("size-4 flex-none", over || spent ? "text-muted" : "text-here")} />
			<div className="min-w-0 flex-1">
				<div className="truncate font-medium text-said">{one.label}</div>
				<div className="truncate text-[0.78rem] text-muted">
					{state}
					{one.admitted.length > 0 &&
						` · let in ${one.admitted.length} ${one.admitted.length === 1 ? "browser" : "browsers"}`}
				</div>
			</div>
			{/* Worth calling off only while it can still admit somebody. What it already let in is a
			    browser in the list below, under its own name, and that is where it is taken out. */}
			{!over && !spent && (
				<button
					type="button"
					className="pill"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						void onRevoke().finally(() => setBusy(false));
					}}
				>
					{busy && <Spin />}
					{busy ? "calling off…" : "call it off"}
				</button>
			)}
		</div>
	);
}

function Row({
	row,
	from,
	here,
	plane,
	onGone,
}: {
	row: DeviceRow;
	/** The invitation it came in on, named, for the ones that came in on one. */
	from: string | undefined;
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
						{/* Which is the question a list of browsers cannot answer by itself, and the one
						    somebody has the moment they find a row they do not recognise. */}
						{from !== undefined && ` · let in by "${from}"`}
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
							{busy ? <Spin /> : <ShieldOff className="size-3.5" />}
							{busy ? "removing…" : here ? "sign out anyway" : "remove"}
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
/**
 * A moment still to come, said the way the one below says a moment that has passed.
 *
 * `when` counts backwards and floors at zero, so an expiry a day away read "just now" — the one
 * word that is wrong about every future. Same scale, said forwards.
 */
function until(at: string): string {
	const then = new Date(at).getTime();
	if (Number.isNaN(then)) return "at some point";
	const left = then - Date.now();
	if (left <= 0) return "now";
	const minutes = Math.floor(left / 60_000);
	if (minutes < 1) return "in under a minute";
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `in ${hours}h`;
	const days = Math.round(hours / 24);
	return `in ${days}d`;
}

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
