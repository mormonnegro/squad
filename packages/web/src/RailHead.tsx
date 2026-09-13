import { Blocks, ChevronsUpDown, KeyRound, Laptop } from "lucide-react";
import { cn } from "./lib/utils.ts";
import {
	Menu,
	MenuContent,
	MenuGroup,
	MenuHeader,
	MenuItem,
	MenuTile,
	MenuTrigger,
} from "./ui/menu.tsx";

/**
 * The head of the column: which plane this is, and the screens that belong to it rather than to an
 * agent.
 *
 * There used to be a list here, and a way to add another machine to it. It is one plane now — the
 * one that served this page, reached at its own address with the key it gave this browser — because
 * driving several is a thing to get right after driving one is simple, and it was spreading: two
 * kinds of wire, a code to paste, a screen to manage the list, and a first question on every open
 * about which of them you meant. What it looked like on screen was a picker over a list of one.
 */
export function RailHead({
	connected,
	onKeys,
	onPlugins,
	onAccess,
}: {
	connected: boolean;
	onKeys: () => void;
	onPlugins: () => void;
	onAccess: () => void;
}) {
	return (
		<Menu>
			{/* On the rail's own grid: the same left edge, the same face column, the same gap — so the
			    plane's name and every name under it stand in one line. The transparent border is the
			    two pixels a row keeps for the stripe that marks where you are. */}
			<MenuTrigger className="flex w-full items-center gap-2 border-transparent border-l-2 px-[0.9rem] py-3 text-left outline-none hover:bg-white/5 data-[state=open]:bg-white/5">
				<MenuTile size="row">◇</MenuTile>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-semibold text-[0.92rem] text-said">squad</span>
					<span className="block truncate font-mono text-[0.72rem] text-muted">{where()}</span>
				</span>
				<ChevronsUpDown className="size-3.5 flex-none text-muted" />
			</MenuTrigger>

			<MenuContent className="w-[15.5rem]">
				{/* Whether the thing every number on this screen comes from is answering. Said here
				    rather than only in the banner, because a banner is for news and this is a fact. */}
				<MenuHeader>
					<div className="flex items-center gap-2.5">
						<MenuTile>◇</MenuTile>
						<div className="min-w-0">
							<div className="truncate font-semibold text-said">squad</div>
							<div className="flex items-center gap-1.5 font-mono text-[0.72rem] text-muted">
								<span className={cn("size-1.5 rounded-full", connected ? "bg-up" : "bg-bad")} />
								{connected ? "connected" : "not answering"}
							</div>
						</div>
					</div>
				</MenuHeader>

				<MenuGroup>
					{/* The three things that are the plane's rather than one agent's: what it pays with,
					    what it can reach, and who may drive it. */}
					<MenuItem onSelect={onKeys} disabled={!connected}>
						<KeyRound className="size-4 flex-none text-muted" />
						Keys
					</MenuItem>
					<MenuItem onSelect={onPlugins} disabled={!connected}>
						<Blocks className="size-4 flex-none text-muted" />
						Plugins
					</MenuItem>
					<MenuItem onSelect={onAccess} disabled={!connected}>
						<Laptop className="size-4 flex-none text-muted" />
						Access
					</MenuItem>
				</MenuGroup>
			</MenuContent>
		</Menu>
	);
}

/** Where this is, in the words a person uses: the machine, or nothing when it is this one. */
function where(): string {
	const { hostname, host } = window.location;
	return hostname === "127.0.0.1" || hostname === "localhost" ? "on this computer" : host;
}
