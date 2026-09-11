import {
	Check,
	ChevronsUpDown,
	Cloud,
	KeyRound,
	Laptop,
	Plus,
	Server,
	Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	type Connection,
	forget,
	keyOf,
	makeCode,
	nameFor,
	readAddress,
	remember,
} from "./connections.ts";
import { cn } from "./lib/utils.ts";
import { Modal } from "./Modal.tsx";
import { browserWire, Plane } from "./plane.ts";
import {
	Menu,
	MenuContent,
	MenuGroup,
	MenuHeader,
	MenuItem,
	MenuSeparator,
	MenuTile,
	MenuTrigger,
} from "./ui/menu.tsx";

/**
 * The environment this page is looking at, and the way to another.
 *
 * At the top because it is the widest thing true of everything below it: every agent, every
 * conversation and every number on this screen belongs to one machine, and a screen that does not
 * say which one is a screen whose every fact is unattributed.
 */
export function Picker({
	all,
	at,
	connected,
	onPick,
	onAdd,
	onKeys,
	onManage,
}: {
	all: readonly Connection[];
	at: Connection;
	connected: boolean;
	onPick: (one: Connection) => void;
	onAdd: () => void;
	onKeys: () => void;
	onManage: () => void;
}) {
	return (
		<Menu>
			<MenuTrigger className="flex w-full items-center gap-2.5 px-3 py-3 text-left outline-none hover:bg-white/5 data-[state=open]:bg-white/5">
				<MenuTile>{initials(at.name)}</MenuTile>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-semibold text-[0.92rem] text-said">{at.name}</span>
					<span className="block truncate font-mono text-[0.72rem] text-muted">
						{at.origin === "" ? "serving this page" : at.origin}
					</span>
				</span>
				<ChevronsUpDown className="size-3.5 flex-none text-muted" />
			</MenuTrigger>

			<MenuContent className="w-[15.5rem]">
				{/* What you are on, said again at the top: a menu that only lists alternatives makes a
				    person count rows to work out which one they are already looking at. */}
				<MenuHeader>
					<div className="flex items-center gap-2.5">
						<MenuTile>{initials(at.name)}</MenuTile>
						<div className="min-w-0">
							<div className="truncate font-semibold text-said">{at.name}</div>
							<div className="flex items-center gap-1.5 font-mono text-[0.72rem] text-muted">
								<span className={cn("size-1.5 rounded-full", connected ? "bg-up" : "bg-bad")} />
								{connected ? "connected" : "not answering"}
							</div>
						</div>
					</div>
				</MenuHeader>

				<MenuGroup>
					{all.map((one) => (
						<MenuItem key={keyOf(one)} onSelect={() => onPick(one)}>
							<MenuTile>{initials(one.name)}</MenuTile>
							<span className="min-w-0 flex-1">
								<span className="block truncate">{one.name}</span>
								<span className="block truncate font-mono text-[0.7rem] text-muted">
									{one.origin === "" ? "serving this page" : one.origin}
								</span>
							</span>
							{keyOf(one) === keyOf(at) && <Check className="size-4 flex-none text-here" />}
						</MenuItem>
					))}
				</MenuGroup>

				<MenuSeparator />
				<MenuGroup>
					<MenuItem onSelect={onAdd}>
						<Plus className="size-4 flex-none text-muted" />
						Add an environment
					</MenuItem>
					{/* Here rather than under the agents, because a key is the environment's and every
					    agent in it spends the same one. */}
					<MenuItem onSelect={onKeys} disabled={!connected}>
						<KeyRound className="size-4 flex-none text-muted" />
						Keys
					</MenuItem>
					<MenuItem onSelect={onManage}>
						<Settings className="size-4 flex-none text-muted" />
						Manage and share
					</MenuItem>
				</MenuGroup>
			</MenuContent>
		</Menu>
	);
}

/** Two letters, so a row with no picture still has something to be recognised by. */
function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
	return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Where an environment runs, which is the only question this screen is really asking. */
type Where = "here" | "server" | "code";

/**
 * Connecting an environment.
 *
 * The question is where the agents will run, so the screen is three places and nothing else. Being
 * handed somebody else's is a real way in and a different question — it is not a place — so it sits
 * under them as one line rather than as a fourth card competing for the same glance.
 *
 * It says first, and it says there can be more. Somebody deciding where to put their agents on the
 * way in should know the decision is not the last one they will get to make.
 */
export function AddEnvironment({
	first,
	onAdded,
	onClose,
}: {
	first: boolean;
	onAdded: (made: Connection, all: readonly Connection[]) => void;
	onClose?: (() => void) | undefined;
}) {
	const [where, setWhere] = useState<Where | undefined>();

	return (
		<Modal
			wide
			title={first ? "Connect your first environment" : "Add an environment"}
			onClose={onClose}
		>
			<p className="lede">
				An environment is one machine running your agents — its own containers, its own keys, its
				own bill.{" "}
				{first
					? "This is your first. You can add more later and move between them from the top of the sidebar."
					: "This page holds several, and they never mix."}
			</p>

			<div className="grid gap-3 sm:grid-cols-3">
				<Place
					icon={<Laptop className="size-5" />}
					name="This computer"
					says="Docker runs it here. Good for trying it."
					here={where === "here"}
					onPick={() => setWhere("here")}
				/>
				<Place
					icon={<Server className="size-5" />}
					name="A server"
					says="Stays up when your laptop sleeps. A $5 VPS is enough."
					here={where === "server"}
					onPick={() => setWhere("server")}
				/>
				<Place
					icon={<Cloud className="size-5" />}
					name="In the cloud"
					says="The one we run for you."
					soon
					here={false}
					onPick={() => {}}
				/>
			</div>

			{where !== undefined && <Rest where={where} onAdded={onAdded} />}

			{where !== "code" && (
				<button
					type="button"
					onClick={() => setWhere("code")}
					className="flex items-center gap-2 self-start text-[0.82rem] text-muted hover:text-say"
				>
					<KeyRound className="size-3.5" />
					Somebody sent me a code for theirs
				</button>
			)}
		</Modal>
	);
}

function Place({
	icon,
	name,
	says,
	here,
	soon,
	onPick,
}: {
	icon: React.ReactNode;
	name: string;
	says: string;
	here: boolean;
	soon?: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={soon}
			onClick={onPick}
			className={cn(
				"flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors",
				"border-line bg-raised hover:border-[#39414a]",
				here && "border-here bg-white/5",
				soon && "cursor-default opacity-45 hover:border-line",
			)}
		>
			<span className={cn("text-muted", here && "text-here")}>{icon}</span>
			<span className="font-medium text-said">{name}</span>
			<span className="text-[0.8rem]/[1.45] text-muted">{says}</span>
			{soon === true && (
				<span className="rounded border border-line px-1.5 py-0.5 font-mono text-[0.65rem] text-muted">
					soon
				</span>
			)}
		</button>
	);
}

function Rest({
	where,
	onAdded,
}: {
	where: Where;
	onAdded: (made: Connection, all: readonly Connection[]) => void;
}) {
	const [typed, setTyped] = useState("");
	const [why, setWhy] = useState<string | undefined>();
	const [trying, setTrying] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the step changing is why it must focus
	useEffect(() => field.current?.focus(), [where]);

	const add = async (): Promise<void> => {
		const read = readAddress(typed);
		if (typeof read === "string") {
			setWhy(read);
			return;
		}
		setTrying(true);
		setWhy(undefined);
		// Knocked on before it is kept. A saved environment that answers nothing is a row that fails
		// every time it is opened, and by then whoever added it has walked away.
		const client = new Plane(browserWire(read.origin, read.token));
		try {
			await client.connect();
			client.close();
		} catch (error) {
			setTrying(false);
			setWhy(`${(error as Error).message} — is it running, and does it answer at ${read.origin}?`);
			return;
		}
		const made: Connection = { name: nameFor(read.origin), origin: read.origin, token: read.token };
		onAdded(made, remember(made));
	};

	return (
		<div className="flex flex-col gap-4 border-t border-line pt-6">
			{where === "code" ? (
				<Step n={1}>
					Ask them for the code. One line starting with <code className="md-code">squad_</code>,
					from <em>Manage and share</em> in their own picker.
					<Note>
						A code is that machine's key, not a guest pass: it makes you an operator of those
						agents, with a shell inside their sandboxes.
					</Note>
				</Step>
			) : (
				<>
					<Step n={1}>
						{where === "here" ? "Run this here:" : "Run this on the server:"}
						<Line>curl -fsSL https://squad.mormon.garden/install.sh | sh</Line>
						<Note>It ends by printing one address. That address is the key.</Note>
					</Step>
					{where === "server" && (
						<Step n={2}>
							Bring it within reach of this browser:
							<Line>ssh -N -L 8789:127.0.0.1:8789 you@your-server</Line>
							<Note>
								Nothing is opened on the server — the bytes cross the SSH connection you already
								have, which is why the address still says 127.0.0.1 from here.
							</Note>
						</Step>
					)}
				</>
			)}

			<Step n={where === "server" ? 3 : 2}>
				Paste it:
				<form
					className="mt-2 flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!trying) void add();
					}}
				>
					<input
						ref={field}
						className="field min-w-0 flex-1"
						value={typed}
						disabled={trying}
						placeholder={where === "code" ? "squad_…" : "http://127.0.0.1:8789/?t=…"}
						onChange={(event) => setTyped(event.target.value)}
					/>
					<button type="submit" className="key" data-yes="true" disabled={trying}>
						{trying ? "knocking…" : "connect"}
					</button>
				</form>
				{why !== undefined && <span className="why mt-2 block">{why}</span>}
			</Step>
		</div>
	);
}

/** A numbered step, because these are done in order and the order is the instruction. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
	return (
		<div className="flex gap-3">
			<span className="mt-0.5 grid size-5 flex-none place-items-center rounded-full border border-line font-mono text-[0.68rem] text-muted">
				{n}
			</span>
			<div className="min-w-0 flex-1 text-[0.88rem]">{children}</div>
		</div>
	);
}

function Line({ children }: { children: React.ReactNode }) {
	return (
		<code className="mt-2 block overflow-x-auto whitespace-pre rounded-md border border-line bg-sunk px-3 py-2 font-mono text-[0.78rem] text-say">
			{children}
		</code>
	);
}

function Note({ children }: { children: React.ReactNode }) {
	return <span className="mt-2 block text-[0.8rem]/[1.5] text-muted">{children}</span>;
}

/** The environments this browser holds: what each is, how to hand one over, how to be rid of one. */
export function Environments({
	all,
	at,
	onPick,
	onForget,
	onAdd,
	onClose,
}: {
	all: readonly Connection[];
	at: Connection;
	onPick: (one: Connection) => void;
	onForget: (all: readonly Connection[]) => void;
	onAdd: () => void;
	onClose: () => void;
}) {
	return (
		<Modal wide title="Environments" onClose={onClose}>
			<p className="lede">
				Each one is a machine of its own. This browser holds them and nothing else does — not this
				page, and not whoever serves it.
			</p>
			<div className="planes">
				{all.map((one) => (
					<Row
						key={keyOf(one)}
						one={one}
						here={keyOf(one) === keyOf(at)}
						onPick={() => onPick(one)}
						onForget={() => onForget(forget(one))}
					/>
				))}
			</div>
			<div className="ask-keys">
				<button type="button" className="key" data-yes="true" onClick={onAdd}>
					+ add an environment
				</button>
			</div>
		</Modal>
	);
}

function Row({
	one,
	here,
	onPick,
	onForget,
}: {
	one: Connection;
	here: boolean;
	onPick: () => void;
	onForget: () => void;
}) {
	const [shown, setShown] = useState(false);
	const [copied, setCopied] = useState(false);
	// Only an environment this browser holds a key for can be handed on. The plane serving this page
	// gave this browser a cookie and no key, so there is nothing here to give away.
	const shareable = one.origin !== "" && one.token !== undefined;
	const code = shareable ? makeCode(one) : "";

	return (
		<div className="plane-row" data-here={here}>
			<div className="plane-line">
				<button type="button" className="plane-open" onClick={onPick}>
					<span className="card-name">{one.name}</span>
					<span className="row-note">{one.origin === "" ? "serving this page" : one.origin}</span>
				</button>
				{shareable && (
					<button type="button" className="key" onClick={() => setShown((was) => !was)}>
						{shown ? "hide code" : "share"}
					</button>
				)}
				{one.origin !== "" && (
					<button type="button" className="key" onClick={onForget}>
						forget
					</button>
				)}
			</div>

			{shown && (
				<div className="share">
					<span className="how-note">
						Whoever holds this drives these agents. It is handed over, not posted — and anyone you
						give it to can take it back out of their own picker and give it on.
					</span>
					<div className="paste">
						<input className="field" readOnly value={code} onFocus={(e) => e.target.select()} />
						<button
							type="button"
							className="key"
							onClick={() => {
								void navigator.clipboard.writeText(code).then(
									() => setCopied(true),
									() => setCopied(false),
								);
							}}
						>
							{copied ? "copied" : "copy"}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
