import { useEffect, useRef, useState } from "react";
import { type Connection, forget, keyOf, nameFor, readAddress, remember } from "./connections.ts";
import { browserWire, Plane } from "./plane.ts";

/**
 * Where the agents live, asked once and remembered.
 *
 * The same question `squad` asks the first time it is run, on a screen instead of a prompt, with the
 * same two doors and the third one that is coming. Nothing here installs anything: a plane is put on
 * a machine by one line typed at that machine, and what this collects is the address that line
 * eventually prints.
 */
export function Connect({
	first,
	onAdded,
	onClose,
}: {
	/** Nothing is connected yet, so this is the whole screen rather than a way to add another. */
	first: boolean;
	onAdded: (made: Connection, all: readonly Connection[]) => void;
	onClose?: (() => void) | undefined;
}) {
	const [door, setDoor] = useState<"here" | "server" | undefined>(first ? undefined : "here");

	return (
		<div className="empty connect">
			<h1>{first ? "Where do your agents live?" : "Connect a plane"}</h1>
			<p>
				An agent is a container that stays running on some machine. This page is where you talk to
				them; the machine is somewhere you choose, and it can be more than one.
			</p>

			<div className="doors">
				<Door
					name="On this computer"
					says="A container here, and Docker is what runs it."
					here={door === "here"}
					onPick={() => setDoor("here")}
				/>
				<Door
					name="On a server"
					says="A machine you have SSH to. A $5 VPS is enough."
					here={door === "server"}
					onPick={() => setDoor("server")}
				/>
				<Door
					name="In the cloud"
					says="The one we run. Not yet."
					soon
					here={false}
					onPick={() => {}}
				/>
			</div>

			{door !== undefined && <Door2 door={door} onAdded={onAdded} />}
			{onClose !== undefined && (
				<button type="button" className="key" onClick={onClose}>
					back
				</button>
			)}
		</div>
	);
}

function Door({
	name,
	says,
	here,
	soon,
	onPick,
}: {
	name: string;
	says: string;
	here: boolean;
	soon?: boolean;
	onPick: () => void;
}) {
	return (
		<button type="button" className="card door" data-here={here} disabled={soon} onClick={onPick}>
			<span className="card-name">{name}</span>
			<span className="door-says">{says}</span>
		</button>
	);
}

/** What to do once a door is chosen: put a plane there if there is none, then paste what it prints. */
function Door2({
	door,
	onAdded,
}: {
	door: "here" | "server";
	onAdded: (made: Connection, all: readonly Connection[]) => void;
}) {
	const [typed, setTyped] = useState("");
	const [why, setWhy] = useState<string | undefined>();
	const [trying, setTrying] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	// Taken when the door changes, because the field is what the new step is for and arriving at it
	// with the cursor somewhere else is one keystroke of nothing.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the door changing is why it must focus
	useEffect(() => field.current?.focus(), [door]);

	const add = async (): Promise<void> => {
		const read = readAddress(typed);
		if (typeof read === "string") {
			setWhy(read);
			return;
		}
		setTrying(true);
		setWhy(undefined);
		// Tried before it is kept. A saved address that answers nothing is a row in a list that fails
		// every time it is opened, and the person who typed it has already walked away.
		const client = new Plane(browserWire(read.origin, read.token));
		try {
			await client.connect();
			client.close();
		} catch (error) {
			setTrying(false);
			setWhy(
				`${(error as Error).message} — is the plane running, and is this the address it printed?`,
			);
			return;
		}
		const made: Connection = { name: nameFor(read.origin), origin: read.origin, token: read.token };
		onAdded(made, remember(made));
	};

	return (
		<div className="steps-two">
			<ol className="how">
				<li>
					{door === "here" ? "On this computer, once:" : "On the server, once:"}
					<code className="how-line">curl -fsSL https://squad.mormon.garden/install.sh | sh</code>
					<span className="how-note">
						It ends by printing one address. That address is the key — paste it below.
					</span>
				</li>
				{door === "server" && (
					<li>
						Bring it within reach of this browser:
						<code className="how-line">ssh -N -L 8789:127.0.0.1:8789 you@your-server</code>
						<span className="how-note">
							Nothing is opened on the server. The bytes cross the SSH connection you already have,
							which is why the address says 127.0.0.1 from here too.
						</span>
					</li>
				)}
				<li>Paste it:</li>
			</ol>

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
					placeholder="http://127.0.0.1:8789/?t=…"
					onChange={(event) => setTyped(event.target.value)}
				/>
				<button type="submit" className="key" data-yes="true" disabled={trying}>
					{trying ? "knocking…" : "connect"}
				</button>
			</form>
			{why !== undefined && <span className="why">{why}</span>}
			<span className="how-note">
				Lost it? <code>squad web</code>, on the machine the plane runs on, prints it again.
			</span>
		</div>
	);
}

/** The connections this browser holds, and the way to be rid of one. */
export function Connections({
	all,
	at,
	onPick,
	onForget,
	onAdd,
}: {
	all: readonly Connection[];
	at: Connection;
	onPick: (one: Connection) => void;
	onForget: (all: readonly Connection[]) => void;
	onAdd: () => void;
}) {
	return (
		<div className="empty">
			<h1>Planes</h1>
			<p>
				Each one is a machine of its own: its own agents, its own address, its own key. This browser
				holds them, and nothing else does.
			</p>
			<div className="planes">
				{all.map((one) => (
					<div className="plane-row" key={keyOf(one)} data-here={keyOf(one) === keyOf(at)}>
						<button type="button" className="plane-open" onClick={() => onPick(one)}>
							<span className="card-name">{one.name}</span>
							<span className="row-note">
								{one.origin === "" ? "serving this page" : one.origin}
							</span>
						</button>
						{one.origin !== "" && (
							<button type="button" className="key" onClick={() => onForget(forget(one))}>
								forget
							</button>
						)}
					</div>
				))}
			</div>
			<div className="ask-keys">
				<button type="button" className="key" data-yes="true" onClick={onAdd}>
					connect another
				</button>
			</div>
		</div>
	);
}
