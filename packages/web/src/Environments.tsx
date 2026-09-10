import { Check, ChevronsUpDown, Plus, Settings } from "lucide-react";
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
	onManage,
}: {
	all: readonly Connection[];
	at: Connection;
	connected: boolean;
	onPick: (one: Connection) => void;
	onAdd: () => void;
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

type Door = "mine" | "theirs";

/**
 * Connecting an environment, over the whole screen.
 *
 * Over the whole screen because it is not a step inside anything: until it is answered there is no
 * agent to look at and nothing else on the page means anything. Two ways in, and they are genuinely
 * different questions — one is "put a plane somewhere and let me in", and the other is "somebody
 * already did, and gave me this".
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
	const [door, setDoor] = useState<Door | undefined>();

	return (
		<Modal
			wide
			title={first ? "Where do your agents live?" : "Add an environment"}
			onClose={onClose}
		>
			<p className="lede">
				An environment is one machine running one plane: its own agents, its own keys, its own bill.
				This page can hold several and they never mix.
			</p>

			<div className="doors">
				<Choice
					name="Mine"
					says="A machine I have — this computer, or a server I can SSH to."
					here={door === "mine"}
					onPick={() => setDoor("mine")}
				/>
				<Choice
					name="Somebody else's"
					says="They set one up and sent me a code."
					here={door === "theirs"}
					onPick={() => setDoor("theirs")}
				/>
			</div>
			{door !== undefined && <Rest door={door} onAdded={onAdded} />}
		</Modal>
	);
}

function Choice({
	name,
	says,
	here,
	onPick,
}: {
	name: string;
	says: string;
	here: boolean;
	onPick: () => void;
}) {
	return (
		<button type="button" className="card door" data-here={here} onClick={onPick}>
			<span className="card-name">{name}</span>
			<span className="door-says">{says}</span>
		</button>
	);
}

function Rest({
	door,
	onAdded,
}: {
	door: Door;
	onAdded: (made: Connection, all: readonly Connection[]) => void;
}) {
	const [where, setWhere] = useState<"here" | "server">("here");
	const [typed, setTyped] = useState("");
	const [why, setWhy] = useState<string | undefined>();
	const [trying, setTrying] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the step changing is why it must focus
	useEffect(() => field.current?.focus(), [door, where]);

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
			setWhy(
				`${(error as Error).message} — is the plane running, and does it answer at ${read.origin}?`,
			);
			return;
		}
		const made: Connection = { name: nameFor(read.origin), origin: read.origin, token: read.token };
		onAdded(made, remember(made));
	};

	return (
		<div className="steps-two">
			{door === "mine" ? (
				<>
					<div className="doors">
						<Choice
							name="On this computer"
							says="A container here, and Docker is what runs it."
							here={where === "here"}
							onPick={() => setWhere("here")}
						/>
						<Choice
							name="On a server"
							says="A machine you have SSH to. A $5 VPS is enough."
							here={where === "server"}
							onPick={() => setWhere("server")}
						/>
					</div>
					<ol className="how">
						<li>
							{where === "here" ? "On this computer, once:" : "On the server, once:"}
							<code className="how-line">
								curl -fsSL https://squad.mormon.garden/install.sh | sh
							</code>
							<span className="how-note">
								It ends by printing one address. That address is the key — paste it below.
							</span>
						</li>
						{where === "server" && (
							<li>
								Bring it within reach of this browser:
								<code className="how-line">ssh -N -L 8789:127.0.0.1:8789 you@your-server</code>
								<span className="how-note">
									Nothing is opened on the server. The bytes cross the SSH connection you already
									have, which is why the address still says 127.0.0.1 from here.
								</span>
							</li>
						)}
						<li>Paste it:</li>
					</ol>
				</>
			) : (
				<ol className="how">
					<li>
						Ask them for the code. It is one line starting with <code>squad_</code>, and they get it
						from <em>Manage and share</em> in their own environment picker.
						<span className="how-note">
							A code is that plane's key, not a guest pass: it makes you an operator of those
							agents, with a shell inside their sandboxes. Take one only from somebody who meant to
							make you one.
						</span>
					</li>
					<li>Paste it:</li>
				</ol>
			)}

			<form
				className="paste"
				onSubmit={(event) => {
					event.preventDefault();
					if (!trying) void add();
				}}
			>
				<input
					ref={field}
					className="field"
					value={typed}
					disabled={trying}
					placeholder={door === "mine" ? "http://127.0.0.1:8789/?t=…" : "squad_…"}
					onChange={(event) => setTyped(event.target.value)}
				/>
				<button type="submit" className="key" data-yes="true" disabled={trying}>
					{trying ? "knocking…" : "connect"}
				</button>
			</form>
			{why !== undefined && <span className="why">{why}</span>}
		</div>
	);
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
