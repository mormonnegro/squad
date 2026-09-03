import Link from "next/link";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

const CLI: [string, string][] = [
	["squad", "the console: every agent, its turns and its logs on one screen"],
	["squad chat scout", "talk to one in the scrollback, turn after turn"],
	["squad ls", "what each agent is and whether it is up"],
	[
		'squad wake scout "check the issues"',
		"take one turn, as the operator, and wait for the answer",
	],
	["squad logs", "follow what every agent runs, answers and spends"],
	["squad rm scout [--purge]", "the sandbox, and with --purge the repository inside it"],
	["squad connect", "ask again where the agents should live"],
	["squad update", "the latest squad on the plane and on this computer"],
	["squad help", "the rest"],
];

const KEYS: [string, string][] = [
	["↑ ↓", "walk the column: every agent, the row that makes one, the feed, the config screen"],
	["tab", "the same ring, and shift-tab for the way back"],
	["← →", "the lines you have typed at this agent, left for older"],
	["^U ^D", "half a pane, the way less moves"],
	["/", "the commands, filtered by whatever is typed after it"],
	["!", "the shell inside the sandbox, from an empty prompt"],
	["esc", "stop the turn this agent is taking"],
	["^C", "quit, and the terminal comes back as it was"],
];

const SLASH: [string, string, string][] = [
	["/limit", "[<amount>|off]", "what it has spent today, and the ceiling for it"],
	["/model", "[<name>]", "what it thinks with, and what else there is"],
	["/mcp", "[<name>|add …|login …]", "the MCP servers it has, and the shelf to add from"],
	["/serve", "[<port>|stop <port>]", "open a port inside it on the machine you are sitting at"],
	[
		"/repo",
		"[<owner/name> [<branch>…]|drop …]",
		"the GitHub repositories it holds, and which branches it may push",
	],
	["/telegram", "[<token>|off]", "the bot it answers on, and how to pair one"],
	[
		"/email",
		"[<address>|<password>|off]",
		"the address it is reached at, and how to connect a mailbox",
	],
	["/clear", "", "forget the conversation, and start it again on nothing"],
	["/delete", "", "delete this agent, after asking whether you meant it"],
	[
		"/config",
		"[models|search|grants|mcp|email]",
		"the whole plane's screen: its keys, models, reach and mailbox",
	],
	["/help", "", "every command there is"],
];

export default function Console() {
	return (
		<Docs
			title="The console"
			lede="A running plane listens on a unix socket in its state directory. That is the whole control surface, and these are typed on your own computer whichever machine the plane is on."
			description="The squad console: the commands, the screen, every key, the slash commands, and the shell into the sandbox."
		>
			<section>
				<span className="eyebrow">At a shell</span>
				<h2>Nine commands, and the first one is the thing itself</h2>
				<table className="table table-cmd">
					<tbody>
						{CLI.map(([cmd, what]) => (
							<tr key={cmd}>
								<td>{cmd}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					The name is needed only when there is a choice to make: a plane running one agent already
					knows which one is meant, so <code>squad wake "check the issues"</code> works, and a first
					word that names an agent addresses it instead. A name no agent answers to is refused
					before anything is queued — the plane would otherwise accept the event and deliver it to
					nobody, and that wait is fifteen minutes long and looks exactly like an agent thinking.
				</p>
				<p className="small muted">
					The console needs a terminal it can take over and a plane to open on. Missing either — a
					pipe, a CI job, no plane running — <code>squad</code> prints where the state is and what
					is in it, so <code>squad | grep</code> keeps working and nothing has to know which case it
					is in.
				</p>
			</section>

			<section>
				<span className="eyebrow">The screen</span>
				<h2>One column, top to bottom</h2>
				<Screen>{`
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ demo                         deepseek-v4-flash   $0.42 / $5.00 │
│                      ││                                                                │
│ ◐ demo         $0.42 ││ > what is a webhook                                            │
│ ● maxi     15m $4.80 ││                                                                │
│ ○ scout              ││ A webhook is one service telling another that something        │
│                      ││ happened: when an event fires, the first sends an HTTP         │
│ + new agent          ││ request to a URL you configured.                               │
│                      ││ ⠹ 9s search webhook retry semantics                            │
│ logs                 ││ ⋯ and how often does it retry?                                 │
│ config               ││                                                                │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ >                                                          │ │
│ ↑↓ moves             ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ agents   ←→ history   ^U^D scroll   / commands   ! shell   ^C quit
`}</Screen>
				<p>
					The column on the left is the whole of what this console can show, as one list: every
					agent the plane has — <code>●</code> up, <code>○</code> stopped, <code>◐</code> mid-turn —
					then the row that makes one, then the log feed and the config screen. Thinking gets a mark
					of its own because with several agents on screen it is the one thing you cannot find out
					by asking again in a second.
				</p>
				<p>
					The feed and the config screen stand at the foot of the column rather than behind an agent
					because neither is about an agent. The feed is the plane's, one stream with every agent in
					it, and the config screen is everything the plane itself was given. Under the agents
					rather than over them because that is the order they are used in: you open this to talk to
					an agent, and you go to the feed when something is wrong or to the keys once, at the
					start.
				</p>
				<p>
					What each agent has spent today is on its row, because "which of these is burning through
					its day" is a question about all of them at once and the header can only ever answer it
					about the one you are standing on. It turns yellow at four fifths of its ceiling and red
					at it, and an agent that has spent nothing says nothing. Where a name leaves room for only
					one of them the wait wins — <code>15m</code> above is an agent that will act while nobody
					is watching, and the money is not that.
				</p>
				<p className="small muted">
					A turn is not waited on, so asking one agent something and then watching another think is
					a matter of pressing <code>↑</code>. Each agent keeps its own conversation and it belongs
					to the plane rather than to the console, so closing one is not ending it: the next console
					opens on what was said.
				</p>
			</section>

			<section>
				<span className="eyebrow">The keys</span>
				<h2>Two for the list, two for the history</h2>
				<table className="table">
					<tbody>
						{KEYS.map(([key, what]) => (
							<tr key={key}>
								<td>{key}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					The line already sent is walked back through sideways because this prompt takes no cursor:
					there was never a line to walk along with left and right, so they cost it nothing, and up
					and down go to the column, which is the one thing on this screen that is a list. The
					half-written line you were on when the walk began comes back whole at the end of it.
				</p>
				<p className="small muted">
					<code>esc</code> is offered in the hint row only while there is a turn to stop, since a
					hint for a key that does nothing is a hint that lies. What stops is the process inside the
					container, killed rather than disconnected from — letting go of the pipe leaves a model
					thinking on the other side of it, going on being paid for after somebody has been told it
					stopped. The question that started it goes back into the prompt, over an empty prompt only
					and only while nothing has come back.
				</p>
				<p className="small muted">
					Dragging over the conversation highlights the rows and putting the button back down puts
					them on the clipboard, <code>⧉ 3 rows copied</code> in the tab row to say it landed. Over{" "}
					<code>ssh</code> there is no local program to hand the text to, so it goes to the terminal
					as an OSC 52 sequence and the row says <code>sent to the terminal</code> rather than
					claiming a clipboard it cannot see. The console takes the whole window and gives it back
					on the way out, the way <code>less</code> and <code>vim</code> do.
				</p>
			</section>

			<section>
				<span className="eyebrow">Said to the plane, not to the agent</span>
				<h2>A line starting with a slash</h2>
				<p>
					It is a command about the agent rather than something said to it, answered by the plane
					without waking anything — a turn spent reading a settings change is a turn wasted. The
					slash opens the list of what there is, over the prompt, filtered by whatever is typed
					after it.
				</p>
				<table className="table table-cmd">
					<tbody>
						{SLASH.map(([cmd, takes, what]) => (
							<tr key={cmd}>
								<td>
									{cmd}
									{takes === "" ? "" : ` ${takes}`}
								</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					<code>↑↓</code> move between the entries and <code>⏎</code> or <code>tab</code> takes one.
					A first return chooses and a second sends, because every command here can be given an
					argument and a return that fired the moment a name was highlighted would make{" "}
					<code>/limit 5</code> the one thing the menu could not be used to type. Where the argument
					is itself a name off a list — <code>/model</code>, and the models — the space behind the
					command opens that list too.
				</p>
				<p className="small muted">
					A message that merely begins with a path is still a message:{" "}
					<code>/etc/hosts is wrong</code> comes back as a command that does not exist rather than
					being quietly swallowed. And <code>/config</code> is the one row that is not about the
					agent whose prompt it was typed at — it moves the column to{" "}
					<Link href="/docs/config/">the plane's own screen</Link>, and naming a section lands
					inside it.
				</p>
			</section>

			<section>
				<span className="eyebrow">Looking around inside</span>
				<h2>! is the door into the box</h2>
				<Screen>{`
! ~/.self  git status --short
 M src/queue.ts
! ~/.self  cd packages/queue
/home/agent/.self/packages/queue
! ~/.self/packages/queue  curl -s api.github.com
curl: (56) Received HTTP code 403 from proxy after CONNECT
exit 56
`}</Screen>
				<p>
					Pressing <code>!</code> at an empty prompt puts you inside, and the prompt says where you
					are standing. You stay in until you backspace off the empty line, because nobody looks
					around a machine one command at a time, and <code>cd</code> moves you the way it does
					anywhere else — every command is its own <code>sh</code>, so the plane carries the
					directory from one to the next.
				</p>
				<p>
					It runs where the agent runs, as the agent — the same directory, the same environment, the
					same proxy — so what comes back is about the agent's world rather than about a shell that
					happens to be nearby, and <code>!curl</code> is refused exactly where the agent's would
					be. It grants nothing: whoever can reach the control socket already holds the Docker
					socket the plane runs on and could open the same shell the long way round.
				</p>
				<p className="small muted">
					<code>tab</code> completes a path here, which is what <code>tab</code> is at a shell
					prompt everywhere else — so in this mode it stops changing panes, and the way to the other
					panes is over an empty line. Nothing about the completion is recorded and nothing about it
					runs: the sandbox is asked to read a directory with the half-typed word handed over as an
					argument, so a directory the agent called <code>; rm -rf ~</code> stays a directory.
				</p>
				<p className="small muted">
					It is independent of the turn, so an agent that is thinking can be looked at while it
					thinks, which is when there is most to see — and the agent is not told it happened,
					because looking around inside is not the same as saying something.
				</p>
			</section>

			<section>
				<span className="eyebrow">Where a turn came from</span>
				<h2>Everything not typed here wears a mark</h2>
				<Screen>{`
> how is the queue looking?
four issues open, none of them blocked.
‹wake› check the queue again
still the same.
‹email› and the build?
‹→ email› green since last night.
‹webhook:github› the nightly build failed on main
`}</Screen>
				<p>
					A turn nobody at a keyboard started appears in the conversation too — a schedule coming
					due, a webhook arriving, a message you sent by mail, an agent waking itself — with a mark
					saying where it came from. Your own mail is marked as well, and for the same reason: it is
					you, and it is not you at this keyboard. An agent that answered its mail at four in the
					morning would otherwise read back, hours later, as something you had sat down and typed.
				</p>
				<p>
					The answer to it carries an arrow, because it is the half that went somewhere. An answer
					written into the pane and an answer also sent are the same words, and without the mark the
					pane is the same picture either way. What you typed here is answered here, and that is
					left unmarked — marking it would mark nearly every line an agent ever says.
				</p>
				<p className="small muted">
					Only what arrives on the control socket is drawn as the operator. Everything else is named
					for the channel it came in on, because the pane gets read back to work out who asked for
					what, and a line from a stranger drawn the same way as the operator's is the one bug in a
					chat window that matters. <Link href="/docs/trust/">Trust</Link> is that rule in full.
				</p>
			</section>

			<section>
				<span className="eyebrow">The feed</span>
				<h2>What every agent runs, answers and spends</h2>
				<Screen>{`
18:12:53  maxi      bash        pnpm -r test
18:12:53  maxi      bash      ✗ after 12.4s: FAIL test/turn.test.ts > carries the failure detail
18:12:53  maxi      read        packages/control-plane/src/turn.ts
18:12:53  scout     egress    ✗ denied GET api.github.com/repos — no_matching_host
18:12:53  maxi      answer      The test asserted the old message.
18:12:53  maxi      spent       1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12
`}</Screen>
				<p>
					The commands each agent runs inside its sandbox as it runs them, what a failed one printed
					and how long it took to fail, the answer when the turn ends, and what the turn spent.
					Model round-trips that worked are counted rather than printed, and the count arrives with
					the turn that made them — one identical <code>allowed POST api.deepseek.com</code> per
					request is what the lines that matter used to be buried in.
				</p>
				<p className="small muted">
					A request that was denied, or came back 401 or 429, is said the moment it happens, because
					it is the reason the agent is about to misbehave.
				</p>
			</section>

			<section>
				<span className="eyebrow">Asked for rather than typed</span>
				<h2>An agent can ask for some of these</h2>
				<Screen>{`
‹ask› /mcp add ahrefs https://mcp.ahrefs.com/mcp
"ahrefs" is on the shelf, and this agent has it.

It wants an account first: /mcp login ahrefs

‹ask› /mcp login ahrefs
Log in to mcp.ahrefs.com here — opened already, if this console is somewhere with a browser:

  https://auth.ahrefs.com/authorize?response_type=code&client_id=…
`}</Screen>
				<p>
					An agent that wanted one MCP server used to write out, patiently and correctly, the host
					to add and the command that approves it — and then sit there until somebody read the
					paragraph. <code>console_command</code> asks for console commands by name instead, and the
					answer goes to the console rather than back to the agent, because the console runs on the
					machine the person is at and the link ends in their browser.
				</p>
				<p>
					What it may ask for is decided outside the command, and the line is not "destructive" — it
					is whether an agent talked into this by something it read could get anywhere by it.
					Connecting a server, opening a consent screen, moving between configured models, serving a
					port and being held to a <em>tighter</em> ceiling widen nothing. Deleting itself, raising
					its ceiling, logging a server out, clearing its own conversation and opening{" "}
					<code>/config</code> stay with the operator.
				</p>
				<Screen>{`
‹ask› /limit 50
This agent asked for a ceiling of $50.00 a day, which is above the $5.00 it has. It can ask to
be held to less, never to more: /limit $50.00, if you meant it.
`}</Screen>
				<p className="small muted">
					A refusal prints the line the operator would have typed, which is the point rather than
					the consolation: the operator finds out the command exists by being handed it, at the
					moment it is the answer. With two exceptions — <code>/telegram</code> and{" "}
					<code>/email</code> are refused without the line, because there the line <em>is</em> the
					attack.
				</p>
			</section>
		</Docs>
	);
}
