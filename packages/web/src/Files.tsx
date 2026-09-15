import type { AgentSummary } from "@squad/control-plane";
import {
	ArrowLeft,
	ArrowUpFromLine,
	CornerLeftUp,
	Download,
	File,
	FileText,
	Folder,
	Image,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "./avatar.tsx";
import { BoxIs, paths, useBox } from "./box.tsx";
import { nameOf } from "./face.ts";
import { Markdown } from "./markdown.tsx";
import type { FileEntry, Listing, Plane } from "./plane.ts";
import { Spin } from "./spin.tsx";

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

/** The three places worth a name of their own, and what each one is. */
const PLACES = [
	{ path: "workspace", name: "workspace", says: "what it has built" },
	{ path: "workspace/inbox", name: "inbox", says: "what you have left it" },
	{ path: ".self", name: "self", says: "its soul, its skills, what it remembers" },
] as const;

/** Where the workspace starts, which is where the folder button in a conversation opens. */
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
}: {
	plane: Plane;
	agent: AgentSummary;
	/** The folder or file on screen, relative to the agent's home. Empty is the home itself. */
	where: string;
	onWhere: (path: string) => void;
	/** Back to the conversation, which is where this was opened from. */
	onClose: () => void;
}) {
	const [listing, setListing] = useState<Listing | undefined>();
	const [read, setRead] = useState<Read | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const [dots, setDots] = useState(false);
	const [drops, setDrops] = useState<readonly Drop[]>([]);
	const [dragging, setDragging] = useState(false);
	const [saving, setSaving] = useState(false);
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
					<div className="flex flex-wrap items-center gap-1.5">
						{PLACES.map((place) => (
							<button
								key={place.path}
								type="button"
								className="pill"
								data-yes={placeOf(where) === place.path}
								title={place.says}
								onClick={() => onWhere(place.path)}
							>
								{place.name}
							</button>
						))}
						<span className="flex-1" />
						<button
							type="button"
							className="pill"
							data-yes={dots}
							title="the names that start with a dot"
							onClick={() => setDots(!dots)}
						>
							dotfiles
						</button>
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

					<Crumbs where={where} onWhere={onWhere} />

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
							/>
						</BoxIs>
					) : listing?.kind === "dir" ? (
						<Rows
							listing={listing}
							where={where}
							dots={dots}
							onWhere={onWhere}
							onLeave={() => picker.current?.click()}
						/>
					) : null}
				</div>

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

/** The path as a row of places to go back to. `~` is the agent's home and is one of them. */
function Crumbs({ where, onWhere }: { where: string; onWhere: (path: string) => void }) {
	const parts = where === "" ? [] : where.split("/");
	return (
		// The padding hangs outside the column, so the path starts on the same line as the pills above
		// it and the rows below: one left edge down the screen rather than three that nearly agree.
		<div className="-mx-1 flex flex-wrap items-center gap-1 font-mono text-[0.85rem]">
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

/** What is in a folder: the rows, and what to say when there are none. */
function Rows({
	listing,
	where,
	dots,
	onWhere,
	onLeave,
}: {
	listing: Extract<Listing, { kind: "dir" }>;
	where: string;
	dots: boolean;
	onWhere: (path: string) => void;
	onLeave: () => void;
}) {
	const shown = listing.entries.filter((one) => dots || !one.name.startsWith("."));
	const hidden = listing.entries.length - shown.length;

	return (
		<div className="-mx-2.5 flex flex-col">
			{where !== "" && (
				<button
					type="button"
					className="flex items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-white/5"
					onClick={() => onWhere(folderOf(where))}
				>
					<CornerLeftUp className="size-4" />
					<span className="flex-1 font-mono text-[0.88rem]">..</span>
				</button>
			)}

			{shown.map((one) => (
				<Row
					key={one.name}
					entry={one}
					onOpen={() => onWhere(where === "" ? one.name : `${where}/${one.name}`)}
				/>
			))}

			{shown.length === 0 && (
				<div className="flex flex-col items-start gap-2 px-2.5 py-6">
					<p className="text-[0.9rem] text-muted">
						{listing.entries.length === 0
							? "Nothing in here yet."
							: `Nothing but ${hidden} name${hidden === 1 ? "" : "s"} starting with a dot.`}
					</p>
					<button type="button" className="pill" onClick={onLeave}>
						<ArrowUpFromLine className="size-3.5" />
						leave a file here
					</button>
				</div>
			)}

			<div className="mt-3 flex items-center gap-3 px-2.5 text-[0.78rem] text-muted">
				{listing.entries.length < listing.total && (
					<span>
						{listing.entries.length} of {listing.total} — the rest is past what a list is for.
					</span>
				)}
				{hidden > 0 && shown.length > 0 && <span>{hidden} more starting with a dot.</span>}
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

function Row({ entry, onOpen }: { entry: FileEntry; onOpen: () => void }) {
	const Glyph = entry.kind === "dir" ? Folder : glyphOf(entry.name);
	return (
		<button
			type="button"
			className="flex items-center gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-white/5"
			onClick={onOpen}
		>
			<Glyph className={`size-4 ${entry.kind === "dir" ? "text-here" : "text-muted"}`} />
			<span className="flex-1 truncate font-mono text-[0.88rem]">
				{entry.name}
				{entry.kind === "dir" && "/"}
				{entry.link === true && <span className="text-muted"> →</span>}
			</span>
			<span className="w-20 text-right font-mono text-[0.78rem] text-muted tabular-nums">
				{entry.kind === "dir" ? "" : sized(entry.size)}
			</span>
			<span className="hidden w-24 text-right text-[0.78rem] text-muted sm:block">
				{when(entry.changedAt)}
			</span>
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
 * left itself and reading those as source is reading them twice. Everything else that is text as
 * text; a picture as a picture; and the rest said plainly rather than drawn as a wall of
 * replacement characters.
 */
function Document({
	name,
	at,
	size,
	changedAt,
	read,
	saving,
	onSave,
}: {
	name: string;
	at: string;
	size: number;
	changedAt: string;
	read: Read | undefined;
	saving: boolean;
	onSave: () => void;
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
					{paths(text, base)}
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

function bytesOf(base64: string): Uint8Array {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
	return out;
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

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
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

/** Which of the named places a path is in, for the row of them at the top. */
function placeOf(where: string): string | undefined {
	return PLACES.map((one) => one.path)
		.filter((path) => where === path || where.startsWith(`${path}/`))
		.sort((a, b) => b.length - a.length)[0];
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
