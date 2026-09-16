import type { AgentSummary } from "@squad/control-plane";
import {
	ArrowLeft,
	ArrowUpFromLine,
	CornerLeftUp,
	Download,
	File,
	FileText,
	Folder,
	FolderOpen,
	Image,
	LayoutGrid,
	List,
	MessageSquare,
	MoreVertical,
	Pencil,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "./avatar.tsx";
import { BoxIs, useBox } from "./box.tsx";
import { bytesOf, decode } from "./bytes.ts";
import { coloured } from "./code.tsx";
import { nameOf } from "./face.ts";
import { Modal } from "./Modal.tsx";
import { Markdown } from "./markdown.tsx";
import type { FileEntry, Listing, Plane } from "./plane.ts";
import { Spin } from "./spin.tsx";
import { Menu, MenuContent, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu.tsx";

/**
 * What an agent has in its box, as a place rather than as a command.
 *
 * `!ls` and `!cat` could already answer all of this, and that is the problem: the question "what has
 * it actually built in there" is answered by walking around, and walking around by typing means
 * holding the last three answers in your head. Here a folder is opened by pointing at it, a note the
 * agent left itself is read as the document it is, and the tree is the same tree the agent is
 * standing in — asked again every few seconds, because it is being written to while you read it.
 *
 * The other direction is the half that had no answer at all. An operator holding a PDF had to talk
 * the agent into fetching it from somewhere the agent could reach, which is a web server for a file
 * that is already on the desk. Now it is dropped on the screen and it is in there — and the sentence
 * that tells the agent so is offered rather than sent, because a drop is not a turn and nobody wants
 * a bill for saying hello.
 */

/**
 * Where the workspace starts, which is where the folder button in a conversation opens.
 *
 * A row of pills above the path used to offer three of these — the workspace, the inbox inside it,
 * and `.self`, where an agent keeps its soul and its skills. Two of the three were never pressed:
 * the inbox is a folder in the workspace and is opened by pointing at it like any other, and
 * nobody goes to read a soul from a file manager. What is left is a path and the things in it,
 * which is what the screen was for.
 */
export const FILES_HOME = "workspace";

/**
 * How much of a file is read to show it, and how much of one may be saved.
 *
 * A preview is a thing somebody looks at, and nobody looks at four megabytes of anything. Saving is
 * the other question — the file is wanted whole and the only limit is what a browser will hold in
 * memory while it is assembled.
 */
const READ_CAP = 4 * 1024 * 1024;
const SAVE_CAP = 64 * 1024 * 1024;

/** How much of an upload goes up in one request. The plane's own chunk, for the same reasons. */
const UP_CHUNK = 128 * 1024;

/** How often an open folder is asked for again. It is being written to while it is being read. */
const LOOK_MS = 5_000;

/**
 * Which shape a folder is drawn in, and where the answer is kept.
 *
 * Tiles first, because a box is looked at rather than read: what is in here is a handful of projects
 * and the odd screenshot, and the question is almost always which one rather than how big. The list
 * is the other view every file manager has, kept for the day the sizes and the dates are the point
 * — and remembered, because a view is a preference and nobody picks one twice.
 */
type View = "tiles" | "rows";

const VIEW_KEY = "squad.files.view";

function rememberedView(): View {
	try {
		return window.localStorage.getItem(VIEW_KEY) === "rows" ? "rows" : "tiles";
	} catch {
		// A browser with storage turned off. The view is a convenience and the screen works without
		// having been told, so this is not worth saying anything about.
		return "tiles";
	}
}

function rememberView(view: View): void {
	try {
		window.localStorage.setItem(VIEW_KEY, view);
	} catch {
		// As above.
	}
}

/** One file on its way into the box, and what became of it. */
interface Drop {
	readonly name: string;
	readonly into: string;
	readonly sent: number;
	readonly size: number;
	readonly why?: string;
}

export function Files({
	plane,
	agent,
	where,
	onWhere,
	onClose,
	onSay,
}: {
	plane: Plane;
	agent: AgentSummary;
	/** The folder or file on screen, relative to the agent's home. Empty is the home itself. */
	where: string;
	onWhere: (path: string) => void;
	/** Back to the conversation, which is where this was opened from. */
	onClose: () => void;
	/**
	 * Down to the conversation with this path in the box, ready to be asked about.
	 *
	 * The other half of what a file browser beside a chat is for. Half of what is looked at in here
	 * ends in a question — what is this, why is it here, finish it — and until now that question was
	 * asked by reading a path off the screen and typing it back in by hand, which is the thing this
	 * screen exists to stop. Nothing is sent: the path lands in the box, and the sentence around it
	 * is still the operator's to write.
	 */
	onSay: (path: string) => void;
}) {
	const [listing, setListing] = useState<Listing | undefined>();
	const [read, setRead] = useState<Read | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const [dots, setDots] = useState(false);
	const [view, setView] = useState<View>(rememberedView);
	const [drops, setDrops] = useState<readonly Drop[]>([]);
	const [dragging, setDragging] = useState(false);
	const [saving, setSaving] = useState(false);
	/** The one that has been asked about but not yet deleted, and where it is. */
	const [asked, setAsked] = useState<{ entry: FileEntry; at: string } | undefined>();
	const [going, setGoing] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	/**
	 * How deep the drag is.
	 *
	 * A `dragleave` fires for every child the pointer crosses on its way across the pane, so a flag
	 * turned off by the first one is a drop target that flickers off under the file being dropped on
	 * it. Counting enters against leaves is the way every list that accepts a drop does this.
	 */
	const depth = useRef(0);

	const look = useCallback(
		async (fresh = true): Promise<void> => {
			if (fresh) {
				setListing(undefined);
				setRead(undefined);
			}
			try {
				const found = await plane.files(agent.id, where === "" ? "." : where);
				setListing(found);
				setWhy(undefined);
				// A path that turns out to name a file is read rather than refused: the address is the
				// same kind of thing either way, and which of the two it is, is the answer.
				if (found.kind === "file") setRead(await readWhole(plane, agent.id, where, READ_CAP));
				else setRead(undefined);
			} catch (error) {
				if (fresh) setListing(undefined);
				setWhy((error as Error).message);
			}
		},
		[plane, agent.id, where],
	);

	useEffect(() => {
		void look();
	}, [look]);

	// Asked again while it is open, because the thing being shown is being written to: a turn that
	// is building something puts a file in here every few seconds, and a screen that answered once
	// is a photograph of a minute ago. Only folders — a file being re-read under the reader would
	// scroll the document out from under them.
	useEffect(() => {
		if (listing?.kind !== "dir") return;
		const timer = setInterval(() => void look(false), LOOK_MS);
		return () => clearInterval(timer);
	}, [listing?.kind, look]);

	/** Where a drop lands: the folder on screen, or the one holding the file on screen. */
	const into = listing?.kind === "file" ? folderOf(where) : where;

	/**
	 * What a path inside the file being read leads to.
	 *
	 * A README written in a project is written from inside it: it says `data/latest.md` and means
	 * the one beside it, not one at the top of the box. So the folder the document is in is what its
	 * names are read against — which makes a note an agent left itself a way around what it wrote
	 * about, rather than a description of it.
	 */
	const box = useMemo(() => ({ open: onWhere, base: folderOf(where) }), [onWhere, where]);

	const leave = useCallback(
		async (files: readonly globalThis.File[]): Promise<void> => {
			if (files.length === 0) return;
			setDrops(files.map((one) => ({ name: one.name, into, sent: 0, size: one.size })));
			const mark = (name: string, change: Partial<Drop>): void =>
				setDrops((was) => was.map((one) => (one.name === name ? { ...one, ...change } : one)));

			// One at a time rather than all at once: four uploads sharing one socket finish no sooner
			// together, and a row that moves is a row somebody can read.
			for (const file of files) {
				const at = into === "" ? file.name : `${into}/${file.name}`;
				let sent = 0;
				try {
					do {
						const slice = new Uint8Array(await file.slice(sent, sent + UP_CHUNK).arrayBuffer());
						const last = sent + slice.length >= file.size;
						await plane.putFile(agent.id, at, base64Of(slice), sent, last);
						sent += slice.length;
						mark(file.name, { sent });
					} while (sent < file.size);
				} catch (error) {
					mark(file.name, { why: (error as Error).message });
				}
			}
			await look(false);
		},
		[plane, agent.id, into, look],
	);

	const save = useCallback(
		async (at: string, name: string): Promise<void> => {
			setSaving(true);
			try {
				const whole = await readWhole(plane, agent.id, at, SAVE_CAP);
				const url = URL.createObjectURL(new Blob([whole.bytes as BlobPart]));
				const link = document.createElement("a");
				link.href = url;
				link.download = name;
				link.click();
				URL.revokeObjectURL(url);
			} catch (error) {
				setWhy((error as Error).message);
			} finally {
				setSaving(false);
			}
		},
		[plane, agent.id],
	);

	/**
	 * A new name for one of them, said to be taken or not.
	 *
	 * The folder is asked again rather than patched here: a rename inside a box that is being written
	 * to can land beside a file that appeared while the name was being typed, and a listing edited on
	 * this side would be a listing that is right about one row and stale about the rest.
	 */
	const rename = useCallback(
		async (from: string, to: string): Promise<boolean> => {
			const at = where === "" ? from : `${where}/${from}`;
			const onto = where === "" ? to : `${where}/${to}`;
			try {
				await plane.moveFile(agent.id, at, onto);
				setWhy(undefined);
				await look(false);
				return true;
			} catch (error) {
				setWhy((error as Error).message);
				return false;
			}
		},
		[plane, agent.id, where, look],
	);

	const remove = useCallback(
		async (at: string): Promise<void> => {
			setGoing(true);
			try {
				await plane.removeFile(agent.id, at);
				setWhy(undefined);
				setAsked(undefined);
				await look(false);
			} catch (error) {
				setWhy((error as Error).message);
				setAsked(undefined);
			} finally {
				setGoing(false);
			}
		},
		[plane, agent.id, look],
	);

	const landed = drops.filter((one) => one.why === undefined && one.sent >= one.size);
	const said = sentence(landed);

	return (
		<>
			<header className="pane-head">
				<button type="button" className="pane-back" onClick={onClose} title="back">
					<ArrowLeft className="size-4" />
				</button>
				<Avatar id={agent.id} />
				<span className="pane-title">{nameOf(agent.id)}</span>
				<div className="pane-facts">
					<span>files</span>
				</div>
			</header>

			{/* The whole pane is the drop target, not a dotted rectangle in the middle of it. A file
			    manager takes a file wherever it is let go, and where it lands is the folder that is
			    open — which is said out loud on the sheet that comes up under the pointer. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target is a place, not a control — the button beside it is the way in that a keyboard has */}
			<div
				className="pane-scroll relative"
				onDragEnter={(event) => {
					if (!Array.from(event.dataTransfer.types).includes("Files")) return;
					depth.current += 1;
					setDragging(true);
				}}
				onDragOver={(event) => event.preventDefault()}
				onDragLeave={() => {
					depth.current = Math.max(0, depth.current - 1);
					if (depth.current === 0) setDragging(false);
				}}
				onDrop={(event) => {
					event.preventDefault();
					depth.current = 0;
					setDragging(false);
					void leave(Array.from(event.dataTransfer.files));
				}}
			>
				<div className="mx-auto flex w-full max-w-[62rem] flex-col gap-4">
					{/* Where you are, and what can be done here: one row, the way a file manager puts it. */}
					<div className="flex flex-wrap items-center gap-1.5">
						<Crumbs where={where} onWhere={onWhere} />
						<span className="flex-1" />
						{/* The one button that says what pressing it does rather than where you are, which is
						    how Drive and Explorer both put this: the icon is the other view. Not over a
						    document, where there is no folder for it to be about. */}
						{listing?.kind !== "file" && (
							<button
								type="button"
								className="pill"
								title={view === "tiles" ? "as a list" : "as tiles"}
								onClick={() => {
									const next = view === "tiles" ? "rows" : "tiles";
									setView(next);
									rememberView(next);
								}}
							>
								{view === "tiles" ? (
									<List className="size-3.5" />
								) : (
									<LayoutGrid className="size-3.5" />
								)}
							</button>
						)}
						{/* A folder asks itself again every few seconds; a file on screen never does, because
						    re-reading one under the reader scrolls the document out from under them. This is
						    the way to ask for that one. */}
						<button
							type="button"
							className="pill"
							title="ask again"
							onClick={() => void look(false)}
						>
							<RefreshCw className="size-3.5" />
						</button>
						<button
							type="button"
							className="pill"
							data-yes="true"
							onClick={() => picker.current?.click()}
						>
							<ArrowUpFromLine className="size-3.5" />
							leave a file
						</button>
						<input
							ref={picker}
							type="file"
							multiple
							className="hidden"
							onChange={(event) => {
								void leave(Array.from(event.target.files ?? []));
								event.target.value = "";
							}}
						/>
					</div>

					{why !== undefined && <p className="why">{why}</p>}

					{drops.length > 0 && (
						<div className="flex flex-col gap-1.5 rounded-lg bg-raised px-3 py-2.5 shadow-[var(--shadow-border)]">
							{drops.map((one) => (
								<div key={one.name} className="flex items-center gap-3 text-[0.85rem]">
									<span className="flex-1 truncate font-mono">{one.name}</span>
									{one.why !== undefined ? (
										<span className="text-bad">{one.why}</span>
									) : one.sent >= one.size ? (
										<span className="text-up">in ~/{one.into}</span>
									) : (
										<span className="text-muted tabular-nums">
											{Math.round((one.sent / Math.max(1, one.size)) * 100)}%
										</span>
									)}
								</div>
							))}
							{said !== undefined && (
								<div className="mt-1 flex items-center gap-2 border-line-soft border-t pt-2">
									<span className="flex-1 text-[0.85rem] text-muted">
										It has not been told. Nothing wakes an agent but a message.
									</span>
									<button
										type="button"
										className="pill"
										data-yes="true"
										onClick={() => {
											plane.wake(agent.id, said).catch(() => {});
											setDrops([]);
											// Into the conversation, which is where the answer to it will appear.
											onClose();
										}}
									>
										tell {nameOf(agent.id)}
									</button>
									<button type="button" className="pill" onClick={() => setDrops([])}>
										later
									</button>
								</div>
							)}
						</div>
					)}

					{listing === undefined && why === undefined ? (
						<p className="flex items-center gap-2 text-[0.88rem] text-muted">
							<Spin />
							reading…
						</p>
					) : listing?.kind === "file" ? (
						<BoxIs value={box}>
							<Document
								name={nameOfPath(where)}
								at={listing.at}
								size={listing.size}
								changedAt={listing.changedAt}
								read={read}
								saving={saving}
								onSave={() => void save(where, nameOfPath(where))}
								onSay={() => onSay(where)}
							/>
						</BoxIs>
					) : listing?.kind === "dir" ? (
						<Inside
							key={where}
							listing={listing}
							where={where}
							dots={dots}
							view={view}
							onDots={() => setDots(!dots)}
							onWhere={onWhere}
							onLeave={() => picker.current?.click()}
							onRename={rename}
							onDelete={(entry, at) => setAsked({ entry, at })}
							onSave={(entry, at) => void save(at, entry.name)}
							onSay={onSay}
						/>
					) : null}
				</div>

				{asked !== undefined && (
					<Sure
						entry={asked.entry}
						at={asked.at}
						going={going}
						onSure={() => void remove(asked.at)}
						onNever={() => setAsked(undefined)}
					/>
				)}

				{dragging && (
					<div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-ground/70">
						<div className="rounded-xl border border-here border-dashed px-6 py-5 text-center">
							<p className="font-medium text-said">Leave it in ~/{into}</p>
							<p className="mt-1 text-[0.85rem] text-muted">
								It lands in {nameOf(agent.id)}'s box. It is not told about it yet.
							</p>
						</div>
					</div>
				)}
			</div>
		</>
	);
}

/**
 * The one question asked before anything is thrown away, answered by one key.
 *
 * Modal, and the answer is Enter: a delete that is confirmed by finding a small red word somewhere
 * on a screen is a delete that gets confirmed by accident. Nobody is asked to type the name back —
 * that teaches a person to copy it out of the sentence above the box, which proves nothing about
 * whether they meant it.
 *
 * What it says is what is true: there is no bin in that container, and a folder goes with what is
 * under it.
 */
function Sure({
	entry,
	at,
	going,
	onSure,
	onNever,
}: {
	entry: FileEntry;
	at: string;
	going: boolean;
	onSure: () => void;
	onNever: () => void;
}) {
	return (
		<Modal wide title={`Delete ${entry.name}?`} onClose={onNever}>
			<p className="text-[0.9rem] text-said">
				{entry.kind === "dir" ? (
					<>
						<code>~/{at}</code> goes, and everything in it with it.
					</>
				) : (
					<>
						<code>~/{at}</code> — {sized(entry.size)}, last changed {when(entry.changedAt)}.
					</>
				)}{" "}
				There is no bin in there to take it back out of.
			</p>
			<div className="mt-4 flex items-center gap-2">
				{/* Focused on purpose: the key that answers a modal is Enter, and this is the answer. */}
				<button
					type="button"
					className="pill"
					data-no="true"
					disabled={going}
					// biome-ignore lint/a11y/noAutofocus: a question with one key has to have the key land on it
					autoFocus
					onClick={onSure}
				>
					{going ? <Spin /> : <Trash2 className="size-3.5" />}
					delete it
				</button>
				<button type="button" className="pill" disabled={going} onClick={onNever}>
					keep it
				</button>
				<span className="text-[0.78rem] text-muted">↩ deletes · esc keeps it</span>
			</div>
		</Modal>
	);
}

/** The path as a row of places to go back to. `~` is the agent's home and is one of them. */
function Crumbs({ where, onWhere }: { where: string; onWhere: (path: string) => void }) {
	const parts = where === "" ? [] : where.split("/");
	return (
		// The padding hangs outside the column, so the path starts on the same line as the pills above
		// it and the rows below: one left edge down the screen rather than three that nearly agree.
		<div className="-ml-1 flex flex-wrap items-center gap-1 font-mono text-[0.85rem]">
			<button
				type="button"
				className="rounded px-1 py-0.5 text-muted hover:bg-white/5 hover:text-said"
				onClick={() => onWhere("")}
			>
				~
			</button>
			{parts.map((part, index) => {
				const path = parts.slice(0, index + 1).join("/");
				const last = index === parts.length - 1;
				return (
					<span key={path} className="flex items-center gap-1">
						<span className="text-muted/50">/</span>
						<button
							type="button"
							className="rounded px-1 py-0.5 hover:bg-white/5"
							data-here={last}
							style={last ? { color: "var(--text-strong)" } : { color: "var(--muted)" }}
							onClick={() => onWhere(path)}
						>
							{part}
						</button>
					</span>
				);
			})}
		</div>
	);
}

/**
 * What can be done to one of the things in a folder.
 *
 * Handed down as one object rather than as four props for the reason a menu is one menu: each of
 * these is offered in three places — the menu, a key, and the pointer — and a screen where a key
 * does one of them and the menu does the others is a screen with two answers to one question.
 */
interface Doing {
	readonly open: (entry: FileEntry) => void;
	readonly rename: (entry: FileEntry) => void;
	readonly remove: (entry: FileEntry) => void;
	readonly save: (entry: FileEntry) => void;
	/** Into the box you talk to it in, as the path the agent would find it under. */
	readonly say: (entry: FileEntry) => void;
}

/** What is in a folder, drawn in whichever shape was asked for, and what to say when there is none. */
function Inside({
	listing,
	where,
	dots,
	view,
	onDots,
	onWhere,
	onLeave,
	onRename,
	onDelete,
	onSave,
	onSay,
}: {
	listing: Extract<Listing, { kind: "dir" }>;
	where: string;
	dots: boolean;
	view: View;
	onDots: () => void;
	onWhere: (path: string) => void;
	onLeave: () => void;
	/** Whether the new name took, so the thing that now has it can be the one that is lit. */
	onRename: (from: string, to: string) => Promise<boolean>;
	onDelete: (entry: FileEntry, at: string) => void;
	onSave: (entry: FileEntry, at: string) => void;
	onSay: (at: string) => void;
}) {
	const shown = listing.entries.filter((one) => dots || !one.name.startsWith("."));
	/** How many names in here start with a dot, whether they are being shown or not. */
	const dotted = listing.entries.filter((one) => one.name.startsWith(".")).length;
	/** The folder holding this one, or nothing at the top of the box, where there is no up. */
	const up = where === "" ? undefined : folderOf(where);
	/** The one that is lit, and the one being given a new name. Both are a name in this folder. */
	const [picked, setPicked] = useState<string | undefined>();
	const [renaming, setRenaming] = useState<string | undefined>();
	const tiles = view === "tiles";

	const pathOf = (name: string): string => (where === "" ? name : `${where}/${name}`);
	const doing: Doing = {
		open: (entry) => onWhere(pathOf(entry.name)),
		rename: (entry) => setRenaming(entry.name),
		remove: (entry) => onDelete(entry, pathOf(entry.name)),
		save: (entry) => onSave(entry, pathOf(entry.name)),
		say: (entry) => onSay(pathOf(entry.name)),
	};

	return (
		<div className="flex flex-col">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the keys walk what is inside it, which is what has the focus */}
			<div
				className={tiles ? "tiles" : "-mx-2 flex flex-col"}
				onKeyDown={walk}
				// The ground between the things is a place to let go of the one that is picked, which is
				// what clicking the wallpaper does on every desktop there has ever been.
				onClick={(event) => {
					if (event.target === event.currentTarget) setPicked(undefined);
				}}
			>
				{up !== undefined && (
					// Walked with the arrows like everything else in here, and opened by the same key: it
					// is the first thing in the folder in every file manager, not a control beside it.
					<button
						type="button"
						data-item
						className="tile"
						data-as={tiles ? "tile" : "row"}
						title="the folder this one is in"
						onClick={() => onWhere(up)}
					>
						<CornerLeftUp
							className={`${tiles ? "size-9" : "size-4"} text-muted`}
							strokeWidth={tiles ? 1.25 : 2}
						/>
						<span className="tile-name text-muted">..</span>
					</button>
				)}
				{shown.map((one) =>
					renaming === one.name ? (
						<Naming
							key={one.name}
							entry={one}
							view={view}
							onDone={(to) => {
								setRenaming(undefined);
								if (to === one.name) return;
								void onRename(one.name, to).then((took) => {
									if (took) setPicked(to);
								});
							}}
						/>
					) : (
						<Thing
							key={one.name}
							entry={one}
							view={view}
							on={picked === one.name}
							doing={doing}
							onPick={() => setPicked(one.name)}
						/>
					),
				)}
			</div>

			{shown.length === 0 && (
				<div className="flex flex-col items-start gap-2 py-6">
					<p className="text-[0.9rem] text-muted">
						{listing.entries.length === 0 ? (
							"Nothing in here yet."
						) : (
							<Dotted count={dotted} dots={dots} onDots={onDots} />
						)}
					</p>
					<button type="button" className="pill" onClick={onLeave}>
						<ArrowUpFromLine className="size-3.5" />
						leave a file here
					</button>
				</div>
			)}

			<div className="mt-3 flex flex-wrap items-center gap-3 text-[0.78rem] text-muted">
				{listing.entries.length < listing.total && (
					<span>
						{listing.entries.length} of {listing.total} — the rest is past what a list is for.
					</span>
				)}
				{dotted > 0 && shown.length > 0 && <Dotted count={dotted} dots={dots} onDots={onDots} />}
				{/*
				 * The one thing about this screen that would otherwise be found out the hard way: the
				 * agent is told every turn to keep the top of its workspace clear, so a file left loose
				 * there is a file the next turn tidies away. The inbox is the drawer that is yours.
				 */}
				{where === "workspace" && (
					<span>
						Things left loose here get tidied away — the agent is told to. Leave them in{" "}
						<code>inbox</code>.
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * The arrows, walking whatever is drawn.
 *
 * Measured off the shape on the screen rather than off the data: how many things are in a row is a
 * fact about how wide the pane was dragged, and the browser has already worked it out. Everything
 * on the first row shares its top, so counting those is counting the columns — which in the list is
 * one, and makes ↑↓ the same key in both views without either of them knowing the other exists.
 */
function walk(event: React.KeyboardEvent<HTMLDivElement>): void {
	const key = event.key;
	if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "ArrowDown" && key !== "ArrowUp") {
		return;
	}
	const things = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-item]"));
	const at = things.indexOf(document.activeElement as HTMLElement);
	if (at === -1) return;
	event.preventDefault();
	const first = things[0];
	const columns =
		first === undefined ? 1 : things.filter((one) => one.offsetTop === first.offsetTop).length;
	const step =
		key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? columns : -columns;
	things[Math.min(things.length - 1, Math.max(0, at + step))]?.focus();
}

/**
 * One thing in the box, and everything that can be done to it.
 *
 * Something that behaves like a button rather than a button, because a thing in a file manager
 * holds a control of its own — the one that opens its menu — and a button inside a button is
 * neither of them.
 *
 * Clicked once it is picked and clicked twice it opens, which is what every desktop does and what a
 * person about to rename something expects. Where there is no pointer to hover with there is no
 * double click either, so on a touch screen the first tap opens it.
 */
function Thing({
	entry,
	view,
	on,
	doing,
	onPick,
}: {
	entry: FileEntry;
	view: View;
	on: boolean;
	doing: Doing;
	onPick: () => void;
}) {
	const Glyph = entry.kind === "dir" ? Folder : glyphOf(entry.name);
	const tiles = view === "tiles";
	const [menu, setMenu] = useState(false);
	/** The door the menu hangs off, and where the pointer was when it was asked for. */
	const door = useRef<HTMLButtonElement>(null);
	const at = useRef<{ x: number; y: number } | undefined>(undefined);

	/**
	 * Where the menu is drawn: at the pointer when that is what asked for it.
	 *
	 * A desktop puts the corner of the menu under the cursor, and it is not decoration — a menu
	 * that appears centred on the pointer has an item under it before the hand has moved, which is
	 * one stray click away from being chosen. Off the door instead when the door was pressed.
	 */
	const box = menu ? door.current?.getBoundingClientRect() : undefined;
	const point = at.current;
	const hangs =
		box !== undefined && point !== undefined
			? {
					alignOffset: Math.round(point.x - box.left),
					sideOffset: Math.round(point.y - box.bottom),
				}
			: { alignOffset: 0, sideOffset: 6 };

	return (
		// biome-ignore lint/a11y/useSemanticElements: it holds the button that opens its own menu, so it cannot be one
		<div
			data-item
			role="button"
			tabIndex={0}
			aria-label={entry.name}
			className="tile"
			data-as={tiles ? "tile" : "row"}
			data-on={on}
			title={entry.name}
			onFocus={onPick}
			onClick={(event) => {
				// A ctrl-click on a Mac is the other button, and it arrives here as a click as well as
				// a menu: opening the file it was asked about is the thing this is not for.
				if (event.ctrlKey || event.metaKey) return;
				doing.open(entry);
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				onPick();
				// Opened when the button comes back up, not when it goes down.
				//
				// This event arrives on the press on a Mac and on X11, and a menu drawn under the
				// pointer on the press is a menu whose first item the release lands on — which is how
				// the right button was opening the file instead of offering to. Where it arrives on
				// the release instead, which is Windows, the button is already up and there is nothing
				// to wait for.
				at.current = { x: event.clientX, y: event.clientY };
				if (event.buttons === 0) setMenu(true);
				else window.addEventListener("mouseup", () => setMenu(true), { once: true });
			}}
			onKeyDown={(event) => {
				// Backspace as well as Delete, because half the keyboards this is read on call the one
				// key by the other name. Both of them ask before anything goes.
				if (event.key === "Enter") doing.open(entry);
				else if (event.key === "F2") doing.rename(entry);
				else if (event.key === "Delete" || event.key === "Backspace") doing.remove(entry);
				else if (event.key === "Escape") event.currentTarget.blur();
				else return;
				event.preventDefault();
			}}
		>
			<Glyph
				className={`${tiles ? "size-9" : "size-4"} ${entry.kind === "dir" ? "text-here" : "text-muted"}`}
				strokeWidth={tiles ? 1.25 : 2}
			/>
			<span className="tile-name">
				{entry.name}
				{entry.link === true && <span className="text-muted"> →</span>}
			</span>
			{!tiles && (
				<>
					<span className="w-20 text-right font-mono text-[0.78rem] text-muted tabular-nums">
						{entry.kind === "dir" ? "" : sized(entry.size)}
					</span>
					<span className="hidden w-24 text-right text-[0.78rem] text-muted sm:block">
						{when(entry.changedAt)}
					</span>
				</>
			)}

			{/* The door a mouse finds without being told about the right button, and the same menu. */}
			<Menu open={menu} onOpenChange={setMenu}>
				<MenuTrigger asChild>
					<button
						ref={door}
						type="button"
						className="tile-more"
						title={`what can be done to ${entry.name}`}
						onClick={(event) => {
							// Pressed rather than pointed at, so it hangs off itself like any other menu.
							at.current = undefined;
							event.stopPropagation();
						}}
						onDoubleClick={(event) => event.stopPropagation()}
					>
						<MoreVertical className="size-3.5" />
					</button>
				</MenuTrigger>
				{/*
				 * Held off the thing it hangs on, which is not where it looks like it is.
				 *
				 * The menu is drawn in a portal at the end of the document, but a React event walks the
				 * tree the element was written in — so a click on an item arrived at this thing's own
				 * click as well, and choosing "rename" opened the file it was about.
				 */}
				<MenuContent
					align={point === undefined ? "end" : "start"}
					alignOffset={hangs.alignOffset}
					sideOffset={hangs.sideOffset}
					collisionPadding={8}
					className="min-w-[13rem]"
					onClick={(event) => event.stopPropagation()}
					onDoubleClick={(event) => event.stopPropagation()}
					onContextMenu={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
					onKeyDown={(event) => event.stopPropagation()}
				>
					<MenuGroup>
						<MenuItem onSelect={() => doing.open(entry)}>
							{entry.kind === "dir" ? (
								<FolderOpen className="size-4 flex-none text-muted" />
							) : (
								<FileText className="size-4 flex-none text-muted" />
							)}
							{entry.kind === "dir" ? "Open" : "Read it"}
							<Says says="↩" />
						</MenuItem>
						<MenuItem onSelect={() => doing.rename(entry)}>
							<Pencil className="size-4 flex-none text-muted" />
							Rename
							<Says says="F2" />
						</MenuItem>
						{/*
						 * The one that leaves this screen. Everything else in this menu happens to the
						 * file; this one is about it — the path goes into the box downstairs, where the
						 * question gets written around it, and nothing is sent until it is.
						 */}
						<MenuItem onSelect={() => doing.say(entry)}>
							<MessageSquare className="size-4 flex-none text-muted" />
							Ask about it
						</MenuItem>
						{entry.kind === "file" && (
							<MenuItem onSelect={() => doing.save(entry)}>
								<Download className="size-4 flex-none text-muted" />
								Save it
							</MenuItem>
						)}
					</MenuGroup>
					<MenuSeparator />
					<MenuGroup>
						<MenuItem
							className="text-bad data-[highlighted]:text-bad"
							onSelect={() => doing.remove(entry)}
						>
							<Trash2 className="size-4 flex-none" />
							Delete
							<Says says="⌫" />
						</MenuItem>
					</MenuGroup>
				</MenuContent>
			</Menu>
		</div>
	);
}

/** The key that does the same thing as the row it is on, said where a desktop says it. */
function Says({ says }: { says: string }) {
	return <span className="ml-auto pl-4 font-mono text-[0.75rem] text-muted">{says}</span>;
}

/**
 * The name, changed where it is read.
 *
 * In place rather than in a dialog, because a rename is done to the thing on the screen and a box
 * in the middle of the window is done to an abstraction. The stem is selected and the extension is
 * not, for the reason every file manager does that: `.png` is not the part being changed, and a
 * name typed over one is a file the browser has stopped knowing what to do with.
 */
function Naming({
	entry,
	view,
	onDone,
}: {
	entry: FileEntry;
	view: View;
	onDone: (to: string) => void;
}) {
	const Glyph = entry.kind === "dir" ? Folder : glyphOf(entry.name);
	const tiles = view === "tiles";
	const [text, setText] = useState(entry.name);
	const box = useRef<HTMLInputElement>(null);
	/** Enter takes this off the screen, and the blur on the way out would answer the same twice. */
	const said = useRef(false);

	useEffect(() => {
		const input = box.current;
		if (input === null) return;
		input.focus();
		const dot = entry.name.lastIndexOf(".");
		input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
	}, [entry.name]);

	const done = (to: string): void => {
		if (said.current) return;
		said.current = true;
		onDone(to.trim() === "" ? entry.name : to.trim());
	};

	return (
		<div className="tile" data-as={tiles ? "tile" : "row"} data-on="true">
			<Glyph
				className={`${tiles ? "size-9" : "size-4"} ${entry.kind === "dir" ? "text-here" : "text-muted"}`}
				strokeWidth={tiles ? 1.25 : 2}
			/>
			<input
				ref={box}
				className="tile-name naming"
				value={text}
				spellCheck={false}
				autoComplete="off"
				onChange={(event) => setText(event.target.value)}
				onBlur={() => done(text)}
				onKeyDown={(event) => {
					// Kept off the things behind it, which walk on the arrows and delete on backspace —
					// both of which are what a caret in a box is for.
					event.stopPropagation();
					if (event.key === "Enter") done(text);
					else if (event.key === "Escape") done(entry.name);
					else return;
					event.preventDefault();
				}}
			/>
		</div>
	);
}

/**
 * The names that start with a dot, said and switched in the same words.
 *
 * This used to be a pill up in the toolbar beside the places, which is where a setting goes and
 * this is not one: it is a fact about the folder you are looking at — there are two more things in
 * here — and the way to see them is to press the sentence that says so. One control fewer over
 * every folder in the box, and the count is in a line that was going to be printed anyway.
 */
function Dotted({ count, dots, onDots }: { count: number; dots: boolean; onDots: () => void }) {
	return (
		<button
			type="button"
			className="underline decoration-muted/40 underline-offset-[3px] hover:text-said hover:decoration-current"
			onClick={onDots}
		>
			{dots ? `${count} starting with a dot, shown.` : `${count} more starting with a dot.`}
		</button>
	);
}

/** How much of a file arrived, and the bytes of it. */
interface Read {
	readonly bytes: Uint8Array;
	readonly size: number;
	/** Whether the file goes on past what was read. */
	readonly cut: boolean;
}

/**
 * One file, drawn as what it is.
 *
 * Markdown as the document it was written as, because half of what is in an agent's box is a note it
 * left itself and reading those as source is reading them twice. Code as code, in colour, because
 * the other half is a program and nobody reads one as a grey wall. A picture as a picture. Plain
 * text as itself, and the rest said plainly rather than drawn as a wall of replacement characters.
 */
function Document({
	name,
	at,
	size,
	changedAt,
	read,
	saving,
	onSave,
	onSay,
}: {
	name: string;
	at: string;
	size: number;
	changedAt: string;
	read: Read | undefined;
	saving: boolean;
	onSave: () => void;
	onSay: () => void;
}) {
	const [url, setUrl] = useState<string | undefined>();
	const picture = read !== undefined && imageOf(name) !== undefined;
	const base = useBox()?.base;

	// An object URL is a handle on memory rather than a string, so it is made when the picture
	// changes and given back when it is no longer on screen.
	useEffect(() => {
		if (read === undefined) return;
		const type = imageOf(name);
		if (type === undefined) return;
		const made = URL.createObjectURL(new Blob([read.bytes as BlobPart], { type }));
		setUrl(made);
		return () => {
			URL.revokeObjectURL(made);
			setUrl(undefined);
		};
	}, [read, name]);

	const text =
		read !== undefined && !picture && readsAsText(read.bytes) ? decode(read.bytes) : undefined;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-mono text-[0.95rem] text-said">{name}</span>
				<span className="text-[0.8rem] text-muted">
					{sized(size)} · {when(changedAt)}
				</span>
				<span className="flex-1" />
				{/* Where a question is most often asked: you have just read the thing. */}
				<button type="button" className="pill" onClick={onSay}>
					<MessageSquare className="size-3.5" />
					ask about it
				</button>
				<button type="button" className="pill" disabled={saving} onClick={onSave}>
					{saving ? <Spin /> : <Download className="size-3.5" />}
					save it
				</button>
			</div>

			{read === undefined ? (
				<p className="flex items-center gap-2 text-[0.88rem] text-muted">
					<Spin />
					reading…
				</p>
			) : picture ? (
				<img
					src={url}
					alt={name}
					className="max-h-[70vh] max-w-full self-start rounded-lg object-contain"
				/>
			) : text === undefined ? (
				<p className="text-[0.88rem] text-muted">
					{sized(size)} of something that is not text. Save it and open it where it belongs.
				</p>
			) : isMarkdown(name) ? (
				<div className="rounded-lg bg-raised px-4 py-3 shadow-[var(--shadow-border)]">
					<Markdown text={text} />
				</div>
			) : (
				<pre className="overflow-x-auto rounded-lg bg-sunk px-4 py-3 font-mono text-[0.8rem] leading-relaxed shadow-[var(--shadow-border)]">
					{coloured(text, name, base)}
				</pre>
			)}

			{read?.cut === true && (
				<p className="text-[0.8rem] text-muted">
					The first {sized(read.bytes.length)} of it. Save it for the rest — {at} is {sized(size)}.
				</p>
			)}
		</div>
	);
}

/**
 * Reads a file out of the box, chunk after chunk, up to what was allowed.
 *
 * Sequential rather than in parallel because the answers have to be put back together in order and
 * the socket is one line at a time anyway. The cap is what stops a preview of a database file from
 * being a browser tab that dies quietly.
 */
async function readWhole(plane: Plane, agentId: string, at: string, cap: number): Promise<Read> {
	const parts: Uint8Array[] = [];
	let held = 0;
	let from = 0;
	let size = 0;
	let more = true;
	while (more && held < cap) {
		const slice = await plane.readFile(agentId, at, from);
		const bytes = bytesOf(slice.data);
		parts.push(bytes);
		held += bytes.length;
		from = slice.from + bytes.length;
		size = slice.size;
		more = slice.more;
		// A file being appended to while it is read is a log, and a reader that followed it forever
		// would never answer.
		if (bytes.length === 0) break;
	}
	return { bytes: joined(parts), size, cut: more };
}

function base64Of(bytes: Uint8Array): string {
	let binary = "";
	// In slices, because `String.fromCharCode(...bytes)` on a whole chunk is an argument list long
	// enough to blow the call stack — which it does at a few hundred kilobytes, on a good day.
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
	const whole = new Uint8Array(parts.reduce((sum, one) => sum + one.length, 0));
	let at = 0;
	for (const one of parts) {
		whole.set(one, at);
		at += one.length;
	}
	return whole;
}

/** Whether what came back reads as text: a zero byte in the first few kilobytes says it does not. */
function readsAsText(bytes: Uint8Array): boolean {
	return !bytes.subarray(0, 4096).includes(0);
}

function isMarkdown(name: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(name);
}

/** The type a picture is served as, or nothing for a file that is not one. */
function imageOf(name: string): string | undefined {
	const found = /\.(png|jpe?g|gif|webp|svg|avif)$/i.exec(name);
	if (found === null) return undefined;
	const kind = (found[1] ?? "").toLowerCase();
	if (kind === "jpg" || kind === "jpeg") return "image/jpeg";
	if (kind === "svg") return "image/svg+xml";
	return `image/${kind}`;
}

function glyphOf(name: string): typeof File {
	if (imageOf(name) !== undefined) return Image;
	return /\.(md|markdown|txt|log|json|ya?ml|csv|tsv|html?|css|[jt]sx?|py|rb|go|rs|sh|sql|toml)$/i.test(
		name,
	)
		? FileText
		: File;
}

function folderOf(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? "" : path.slice(0, cut);
}

function nameOfPath(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? path : path.slice(cut + 1);
}

/** What was left, in the words the agent would be told it in — or nothing, when nothing landed. */
function sentence(landed: readonly Drop[]): string | undefined {
	const first = landed[0];
	if (first === undefined) return undefined;
	const into = `~/${first.into}`;
	if (landed.length === 1) return `I left ${first.name} in ${into}. Go and have a look.`;
	return `I left ${landed.length} files in ${into}: ${landed.map((one) => one.name).join(", ")}. Go and have a look.`;
}

function sized(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
	return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * When something last changed, in the shortest true thing to say.
 *
 * A copy of the one on the devices screen rather than a shared import, like everything else this
 * small in here: a listing has a column of these and what it needs is the sentence, not a module.
 */
function when(at: string): string {
	const then = new Date(at).getTime();
	if (Number.isNaN(then)) return "";
	const ago = Math.max(0, Date.now() - then);
	const minutes = Math.floor(ago / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days < 30 ? `${days}d ago` : new Date(at).toLocaleDateString();
}
