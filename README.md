# squad

Self-hosted cloud agents. An agent here is a container that stays running, wakes up when something
happens, and reaches the outside world only through credentials it never sees.

It is a runtime, not a harness. The thinking is done by [pi](https://github.com/earendil-works/pi);
squad gives it a machine to live on, a way to be woken, and a boundary to work inside.

Requires Docker and Node 22 or newer. One VPS is enough.

The documentation is at [squad.mormon.garden/docs](https://squad.mormon.garden/docs/), and the same
pages are markdown at [/llms.txt](https://squad.mormon.garden/llms.txt) page by page or
[/llms-full.txt](https://squad.mormon.garden/llms-full.txt) all at once — which is the address to
hand an agent you want to explain squad to.

## Why the parts are shaped this way

Three problems decide the whole design.

**An agent that runs unattended will eventually read something a stranger wrote.** A GitHub webhook
is authentic and still relays an issue body typed by anyone. So every event carries a trust level,
and only `operator` events are rendered as instructions. Everything else is fenced and introduced
as data, in one place, so a new channel adapter cannot forget to do it.

**An agent with a credential can spend it anywhere.** So it never holds one. Egress goes through a
proxy that matches the request against operator-approved grants and attaches the secret afterwards.
The sandbox network is `internal`, which really is unrouted — a container on it cannot reach the
host or the internet by any address — so the proxy is not a convenience the agent could route
around. This includes the model: reaching the model provider is a grant like any other, and the key is
written onto the request on its way out, so an agent that talks itself into exfiltrating its own
API key has nothing to send.

**An agent that can edit its own definition can grant itself capabilities.** The agent repository
holds a manifest, but a manifest is a request. Grants live in the control plane's config file,
which the agent cannot write.

## What an agent is made of

On its first boot an agent gets a repository in its own volume, at `/home/agent/.self`:

```
agent.yaml   name, model, and the capabilities it asks an operator for
soul.md      who it is; appended to the system prompt on every turn
skills/      SKILL.md folders, loaded by pi
memory/      what it chose to remember, partitioned by users, projects and reference
             lessons.md is what it got wrong, and is read back to it on every turn
tools/       scripts it wrote for itself
```

It is scaffolded once, git-initialised, and then left alone: what the agent learns and what it can do
are files it edits and commits itself. The control plane never writes there again, because the second
write would be the control plane overwriting the agent's own work.

### Learning from its own mistakes

Everything under `memory/` is there when the agent goes looking for it, which is the right shape for
what it knows about a person or a project: recalled when the subject comes up. A mistake is the
opposite. The turn where the lesson would have saved something is the turn where nothing reminds the
agent that it has one, because not knowing is what a mistake is made of.

So `memory/lessons.md` is the one file that is carried rather than looked up. A `remember` tool
appends one line to it — the rule, not the story of how it was found out — and the plane reads it
back into the system prompt at the start of every turn, after the soul and the house rules and
nearest the work.

Being carried is what makes a lesson worth writing and also what makes it cost something, so it is
bounded at both ends. Twenty lessons, one line each. When the list is full the tool **refuses**, and
says where to go: nothing is dropped for the agent, which merges two lines that turned out to be the
same lesson or deletes one it has outgrown. Scarcity is what produces consolidation — a list nobody
is ever made to consolidate never gets consolidated, and one that only grows is an agent that pays
more to think the longer it has been alive, and pays most for the lessons it has held longest and
needs least. The plane applies the same cap again when it reads, inside the sandbox and before
anything crosses the socket, because the file is the agent's own and it has an editor: what an
unbounded file costs is not a broken turn but a slow expensive one on every turn, which nobody
notices until the bill arrives.

A tool nobody mentions is a tool nobody calls, so the harness mentions it. When a tool call fails,
one line goes in front of the agent before the turn ends, naming what failed and asking whether the
reason is the kind of thing that would catch it again on a turn where it will not remember this one.
Once per turn, and it says outright that leaving it is fine: an agent that has just worked out why
something broke is already writing that sentence, and one that writes a lesson to satisfy a reminder
spends a slot forever on nothing.

An agent that has never been wrong carries nothing at all — no heading, no empty list, no invitation
to fill one with things that merely sound wise.

That repository is the agent, not its desk. Turns start next door, in a second volume at
`/home/agent/workspace`, and the house rule goes in as argv on every turn: one directory per project,
nothing loose at the top, and tidy what you find untidy rather than leaving it. It is said by the
plane rather than written into `soul.md` because the agent may rewrite its soul, and a rule the
subject can edit is not a rule. Both volumes outlive the container, which is replaced every time the
image changes.

Nothing in that repository grants anything. `agent.yaml` lists capability *requests*, and an
operator answers them in the config file the agent cannot reach.

## The pieces

| Package | What it is |
| --- | --- |
| `events` | Trust levels, fencing, the durable event bus, and the renderer that turns a batch of events into one turn |
| `proxy` | The egress broker: a CONNECT-terminating MITM proxy with a local CA, grant matching and credential injection |
| `sandbox` | The Docker driver: container per agent, named volume for its repository, exec streams demultiplexed from the daemon's framing |
| `scheduler` | Cron and one-shot wakeups, persisted, with Vixie cron semantics and DST-correct wall-clock matching |
| `channels` | Where events come from and replies go. Ships a signed webhook channel, a Telegram bot and an IMAP mailbox |
| `agent-repo` | The agent's own git repository: manifest, soul, skills, memory, tools |
| `control-plane` | Wires it together, takes turns by running pi in the sandbox, and reads a YAML config |
| `client` | The `squad` you install: picks where the plane lives, puts one there, and dials it — over a socket here or `ssh vps squad relay` |

## Trust

```
operator      may instruct         an operator wrote it: config, a schedule an operator set
participant   data, attributed     a known human in a channel
public        data                 a webhook payload, anyone on the internet
```

The rule is enforced in more than one place because there is more than one way to launder
authority into the system:

- A webhook may not carry operator trust. The secret proves which system sent the request, never
  that a human meant what is inside it.
- A Telegram message may, and only from the one account that pressed the pairing link. Everyone
  else in the chat is a participant, however the message is worded and whoever it claims to be from.
- Mail may, and only from an address that paired, and only when the receiving provider's own
  `Authentication-Results` says DKIM and DMARC passed aligned with the domain it claims. A `From:`
  line on its own is a claim anyone can type.
- An agent may schedule itself, but not with operator trust. Otherwise one successful injection is
  permanent: the injected turn schedules a wakeup that instructs, and the agent goes on instructing
  itself with no attacker present to notice or revoke.
- The fence nonce is random and chosen after the content is written, so nothing inside can close it.

## Trying it

```sh
./deploy/demo.sh up            # it asks for a DEEPSEEK_API_KEY if the environment has none
./deploy/demo.sh reload        # after changing the code, keeping the agent you have
```

It builds the images, starts a control plane on a throwaway network, shows what the agent can and
cannot reach, asks the plane over its control socket, wakes the agent with a signed webhook and
prints the turn. `./deploy/demo.sh down` removes everything. State lives under the working tree
rather than `/var/lib`, which is the one way it differs from the real deployment below.

`up` starts from nothing, so it deletes the volume — the agent's soul, memory, skills and tools.
`reload` rebuilds the plane and swaps it in around a sandbox that never stops, which is what you
want after changing the code, and it works because the new plane adopts the sandbox it finds.

## Running it

Two halves: the console you type at, and the plane the agents live in. Install the first, on the
computer you are sitting at:

```sh
curl -fsSL https://squad.mormon.garden/client.sh | sh
squad
```

The first `squad` asks the one question the halves differ on — **on this computer**, or **on a
server** you have SSH to — and puts a plane there. On this computer that means Docker and a state
directory under `~/.squad`. On a server it means the install running down the SSH connection
you already have, so there is nothing to open there and nothing new to log into. Either way it ends
on the console, the answer is remembered, and `squad connect` moves it.

Everything after that question is the same program. A plane answers the same protocol whether its
socket is in a directory here or at the far end of `ssh vps squad relay`, so `squad ls`, the log
feed, the console and a port forwarded out of a sandbox all run on this computer and reach the
agents wherever they are. That is also why a port you expose from an agent opens on the machine your
browser is on, which is the one place it is of any use.

It asks for no keys. Every one of them is given later on the config screen in `squad`, because three
secrets in the first minute is a worse first minute than an empty setup screen in the second.

That first line needs Node 22.18 or newer and nothing else — no Docker on this computer, whichever
answer you give. [`deploy/client.sh`](deploy/client.sh) fetches this tree, installs what the console
imports and leaves `squad` on your PATH; there is no build step, so what lands is what runs, and
running it again is how the console updates — which is also what `squad update` does to it. Not an npm package because the console is eight
workspace packages that only mean anything together, and publishing eight names in lockstep to
distribute one command is a release process standing in for a download.

A server needs a Linux with SSH on it and nothing else — the installer brings Docker. One vCPU, a
gigabyte of memory and ten gigabytes of disk runs a few agents, which is the bottom of every
provider's list at around five dollars a month, and an old laptop under the desk does just as well.

How you reach it is your own business: a key and a password both work. Where the machine does not
already take this computer's key, `squad connect` says so and offers one — put a key up, or keep the
password. What is not negotiable is *when* you are asked. ssh reads a password from `/dev/tty`,
which the console is holding and redrawing, so the connection is always opened first, on a bare
terminal, before anything is drawn; everything after it — the console, and one more per forwarded
port — rides that same handshake and authenticates not at all. It lasts ten idle minutes, so a
password is typed about as often as you walk away, and never in the middle of anything.

Nothing of the console stays on that machine. It pipes one shell script to it, and that script
stands alone:

```sh
curl -fsSL https://squad.mormon.garden/install.sh | sh
```

It installs Docker if there is none, puts the repository in `/opt/squad`, writes a config with
one agent and a ceiling of five dollars a day, starts the plane, and leaves `squad` on that
machine's PATH — the same commands typed there, and the door the console here comes through. Run at
a terminal rather than down a pipe, it asks for the keys the proxy will hold as it goes.
`SQUAD_DIR`, `SQUAD_STATE` and `SQUAD_SHIM` are the three things the console
overrides when the plane is going to live alongside it, which is the whole of the difference between
a laptop and a VPS. Running it again is the update: it pulls, rebuilds and swaps the plane in, and
never touches `config.yaml` or `.env`. `squad update` runs that same script on whichever machine the
plane is on and then the console's own script here, so one word from the computer you already type
at leaves both halves on the same version.

By hand, which is the same thing without the questions:

```sh
git clone https://github.com/mormonnegro/squad /opt/squad && cd /opt/squad
docker build -t squad/sandbox:dev packages/sandbox/image

cd deploy
cp .env.example .env          # fill in the values
cp config.example.yaml config.yaml
docker compose up -d --build
```

`config.example.yaml` is the whole surface: agents, what each may reach, which models there are to
think with, when each wakes up, which webhooks exist, and — under `defaults` — what an agent made
later starts from. No secret is in it: it names environment variables, and the process holds the
values. That is the point: the file describing what an agent can reach should be committable and
diffable, because a grant nobody noticed being added is the failure mode.

Two things in the deployment are load-bearing and easy to get wrong:

- The control plane runs **on the agents' network**, not on the host. Containers on an internal
  network cannot reach the host at all, so a proxy on the host is one the agents cannot use.
- The state directory is bind-mounted **at its own path**. The control plane hands the daemon that
  path when mounting the CA into a sandbox, and the daemon resolves bind sources on the host.
- A sandbox **outlives the plane that made it**, and its proxy credential is in its environment, so
  a restarting plane reads that credential back off the container rather than deciding it. A plane
  that decided instead would come back denying every request its own agents made, the model
  included, with the sandboxes looking perfectly healthy.

The control plane holds the Docker socket, so it is root-equivalent on the machine. The trust
boundary is the sandbox around the agent, not the process managing it.

## Driving it

A running plane listens on a unix socket in its state directory. That is the whole control surface,
and these are typed on your own computer whichever machine the plane is on:

```sh
squad                                    the console: every agent, its turns and its logs
squad chat demo                          talk to one in the scrollback, turn after turn
squad chat maxi                          a name nothing answers to: it offers to make one
squad ls                                 what each agent is and whether it is up
squad wake "check the open issues"       take one turn, and wait for the answer
squad logs                               follow what every agent runs, answers and spends
squad rm demo [--purge]                  take the sandbox away, and with --purge the repository
squad connect                            ask again where the agents should live
squad update                             the latest squad on the plane and on this computer
squad help                               the rest
```

`squad` on its own opens the console, because someone typing the command with nothing after it is
asking to see the thing, not to be told a fact about it:

```
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
```

The column on the left is the whole of what this console can show, one list top to bottom: every
agent the plane has — `●` up, `○` stopped, `◐` mid-turn — then the row that makes one, then the log
feed and the config screen. Up and down walk it, which is what those two keys do beside a list on
every screen that draws one — the whole of it, so carrying on down past the row that makes an agent
lands on the feed and then on the config screen, and it comes back round to the top. `tab` walks the
same ring, `shift` with it for the way back, and a click on a row works too for a hand already on the
mouse. Thinking gets a mark of its own because with several agents on screen it is the one thing you
cannot find out by asking again in a second. The row the keyboard is on is its name in the colour
the panel title gives the same name, and not an arrow in a gutter beside the marks: a column whose
header stands against the border and whose rows all begin two further in reads as a list indented
under a title it does not belong to. At the foot of the column is `↑↓ moves`, because a list that
nothing points at does not otherwise say how to walk it. It names whichever key walks the column from
where the keyboard already is, so on the config screen — where the arrows are that screen's own list's
until it runs out above the cursor — it reads `tab moves` instead.

The feed and the config screen stand at the foot of the column rather than behind an agent because
neither is about an agent. The feed is the plane's, one stream with every agent in it — the same feed
`squad logs` prints, running the whole time either way — and the config screen is everything the
plane itself was given. They used to be panels you reached by tabbing inside an agent, which meant
picking an agent first and then ignoring which one you had picked, and the panel title carried a
`chat · logs · setup` breadcrumb that was a second copy of a selection the column was already
drawing. Under the agents rather than over them because that is the order they are used in: you open
this to talk to an agent, and you go to the feed when something is wrong or to the keys once, at the
start.

The line already sent is walked back through with left and right rather than up and down, which
costs this prompt nothing: it takes no cursor, so there was never a line to walk along sideways, and
the thing this screen actually draws a list of is the agents. Neither walk is a chord — `^N` and
`^P` were the version before this one, and a prompt you have to learn the chords for is a prompt
nobody moves around in.
While that agent is thinking, the row under the conversation carries the spinner, the seconds and
whatever the turn is on: a spinner alone says something is happening, the number rising beside it
says whether it still is, and the tool being run is the difference between stuck on the model and
stuck on a test suite. It is there rather than in the prompt because the prompt is the one row a
hand is on — a turn takes minutes, the next question is thought of during them, and a box wearing a
spinner reads as a box that has stopped taking keys.

That next question is where the `⋯` row comes from. A turn is one turn: a message sent to an agent
that is already answering waits behind it, and the wait is however long that answer takes. So it
waits where it was typed, on its own row above the prompt, until the agent is free to take it —
then it drops into the conversation under the answer it was waiting on, and the turn that takes it
begins. Put into the conversation the moment it was sent, it would have sat above an answer written
before it existed, and the pane would read as if that answer were the reply to it.

Under the last agent is the row that makes one, reached with the same `tab` as any of them. It is a
row rather than a command because that is where somebody who wants an agent is already looking —
with none at all it is the only row there is, and the console opens on it. The panel behind it takes
a name and `⏎` builds it: a container, a repository of its own, nothing in its memory, and exactly
what `defaults` in the config allows it to reach. The name is the whole of what the keyboard decides
here, which is why the pane says so — it may name an agent and may not grant it a thing. A name that
is taken, or that is not a name, is refused in the pane with the name still in the prompt to be
fixed. What is built appears where the `+` was, which is where the cursor already is.

What each agent has spent today is on its row, because "which of these is burning through its day"
is a question about all of them at once and the header can only ever answer it about the one you
are standing on. It turns yellow at four fifths of its ceiling and red at it, and an agent that has
spent nothing says nothing — a column of `$0.00` is noise to read past, and what is being looked
for here is the row that is not like the others. Where a name leaves room for only one of them, the
wait wins: it is a warning that the agent will act while nobody is watching, and the money is not.

The title row says what the selected agent is thinking with and what that has cost against what it
is allowed. Both were already crossing the socket and being thrown away, and the price of that was
that the way to find out which model an agent was answering badly with was to go and read the
operator's config file. As the terminal narrows the model goes first, then the ceiling, then the
money — nothing is ever cut to a stump, because a `deepseek-v4-fl…` is a fact half said.

`←` and `→` walk back through the lines you have typed at this agent, left for older because left is
back. Sideways rather than up and down because this prompt takes no cursor: there is no line to walk
along with those two, so they cost the prompt nothing here, and up and down go to the column, which
is the one thing on this screen that is a list. The half-written line you were on when the walk
began comes back whole at the end of it, so a stray arrow costs you nothing. On the config screen up
and down are that screen's own list's, until it runs out above the cursor and they go back to
walking the column — so the screen is left by the same key that arrived on it, rather than by a
press you would have to be told about. `←` is back there rather than history, out of an open section
and onto the list of sections, and `→` is in, so on that screen the four arrows are the whole of
moving about it: two for the list you are on, two for which list that is. It is what left and right
mean in every column of lists, and a hand that walked in on the arrows should not have to let go of
them to find `esc` across the keyboard. Each agent's history is its own, and it survives the console
being closed, because the lines are read out of the conversation the plane kept.

`esc` stops the turn the selected agent is taking, and is offered in the row only while there is one
to stop, since a hint for a key that does nothing is a hint that lies. What stops is the process
inside the container, killed rather than disconnected from: letting go of the pipe takes the output
away from us and leaves a model thinking on the other side of it, going on being paid for after
somebody has been told it stopped. What it had already written stays in the conversation with
`stopped` under it, it is not taken again — an interrupted turn comes back, which is what whoever
pressed the key was preventing — and it does not get to book the turn after it either. The question
that started it goes back into the prompt, since a turn is nearly always stopped because it was
asked the wrong thing and asking it again should not be a retyping job — over an empty prompt only,
and only while nothing has come back, because a half-written line is a hand mid-sentence and an
answer half written is an answer.

The console takes the whole window and gives it back on the way out, the way `less` and `vim` do.
Nothing it printed is left behind in the shell it was opened from, and the wheel has somewhere to
turn: on the alternate screen there is no scrollback to fall into, so a notch of it moves the
conversation rather than scrolling away from a live console into pictures of an older one.

`^U` and `^D` move the panel half a pane the way they do in `less`. Chords, because the keys that
would have meant this without one — shift with the arrows, the page keys — are the ones the terminal
takes for its own scrollback before they are ever ours.

The wheel is paid for by drawing the selection here instead. A terminal only reports the wheel to an
app that asked to be told about the mouse, and a terminal reporting the mouse is one that stops
selecting text for you — so dragging over the conversation highlights the rows itself and putting
the button back down puts them on the clipboard, `⧉ 3 rows copied` in the tab row to say it landed.
A click that does not move copies nothing: the pointer rests in this pane while it is being read,
and a stray click that replaced the clipboard would be a worse trade than the one being avoided.
Over `ssh` there is no local program to hand the text to, so it goes to the terminal as an OSC 52
sequence and the row says `sent to the terminal` rather than claiming a clipboard it cannot see.

The tab row says `↑ scrolled` while a panel is not at the end — without that, an answer arriving out
of sight reads as an agent that said nothing. Where it is scrolled to is a line and not a distance
from the bottom, so the feed goes on arriving underneath what is being read instead of pushing it up
out of the pane.

A turn is not waited on, so asking one agent something and then watching another think is a matter
of pressing `↑`. Each agent keeps its own conversation, and the answer streams into it with its
markdown rendered, exactly as `chat` does in the scrollback.

Saying something to an agent that is already thinking is allowed, and the line appears where it was
typed rather than when it is answered: it goes into the conversation the moment the plane has it,
and the turn in front of it finishes first. Several lines said that way are answered together as
one turn, so an agent told four things while busy takes one turn about four things instead of four
turns that each saw a quarter of it.

A line starting with `/` is a command about the agent rather than something said to it, answered by
the plane without waking anything — a turn spent reading a settings change is a turn wasted. The
slash opens the list of what there is, over the prompt, filtered by whatever is typed after it:

```
 ▸ /limit [<amount>|off]                     what it has spent today, and the ceiling for it
   /model [<name>]                           what it thinks with, and what else there is
   /mcp [<name>|add …|login …]               the MCP servers it has, and the shelf to add from
   /serve [<port>|stop <port>]               open a port inside it on the machine you are sitting at
   /reach <host>                             ask to open a host on the way out, answered here with one key
   /telegram [<token>|off]                   the Telegram bot it answers on, and how to pair one
   /email [<address>|<password>|off]         the address it is reached at, and how to connect a mailbox
   /clear                                    forget the conversation, and start it again on nothing
   /delete                                   delete this agent, after asking whether you meant it
   /config [models|search|grants|mcp|email]  the whole plane's screen: its keys, models, reach and mailbox
   /help                                     every command there is
╭──────────────────────────────────────────────────────────────────────╮
│ > /li                                                                │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ command   ⏎ choose   ^C quit
```

`↑↓` move between the entries and `⏎` or `tab` takes one — the three keys the menu borrows for as
long as it is up, which is why the hint row says so while it has them. A first return chooses and a
second sends, because every command here can be given an argument and a return that fired the
moment a name was highlighted would make `/limit 5` the one thing the menu could not be used to
type. The menu closes itself at the first space, which is what says the command has been chosen and
the argument is what is being typed now.

Except where the argument is itself a name off a list. Taking `/model` off the menu leaves the space
behind it, and that space opens the models:

```
 ▸ /model flash   deepseek/deepseek-v4-flash   (this one)
   /model sonnet  anthropic/claude-sonnet-4-6
   /model gpt-5   openai/gpt-5   (no OPENAI_API_KEY)
╭──────────────────────────────────────────────────────────────────────╮
│ > /model                                                             │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ model   ⏎ choose   ^C quit
```

Same three keys, same two returns. What each row says is the two facts about a model that are not
its name — whose it is and what they call it — plus the one that decides whether the next turn
answers at all: a model this plane holds no key for is offered and marked, not hidden, because it is
configured and the missing half is a key you can paste in two panes over. Typing narrows the list
against the id, the provider and the provider's own name together, so `/model anthropic` finds the
one called `sonnet` without knowing that is what it was called. A name typed out in full closes the
menu, since at that point it is agreeing rather than offering — and a menu that agreed would be
sitting on the return that sends the line.

Every command is written down once, as the list this menu and `/help` are both drawn from. A
command documented in only one of those two places is a command half its users never find.

One row on that list is not about the agent whose prompt it was typed at. `/config` opens [the
plane's own screen](#the-keys-the-plane-pays-with), and naming a section — `/config email` — lands
inside it, past both the walk down the column and the list of sections. Nothing goes down the socket:
it is answered by moving the column, because a sentence about the keys every agent is paid for with,
filed under one agent's conversation, is exactly the confusion that putting those rows at the foot of
the column was meant to end. The sentence in the menu says whose screen it is before it says what is
on it, for the same reason. A word that is not one of the four is not swallowed — it goes down like
any other command and comes back naming the four that would have worked.

An agent may not run it, and not for the reason it may not run `/telegram`: nothing here widens what
it can reach. It is that a screen is drawn on the terminal an operator is sitting at, and there is no
terminal where the agent is. The refusal says whose screen it is and prints the line, since an agent
that asked is usually an agent missing a key.

```
> /limit
$0.42 spent today, against no limit.
> /limit 5
Spending limit set to $5.00 a day. $0.42 spent today, of $5.00 a day.
```

Both halves go into the conversation, because that is where they were typed and where the answer
gets read: a ceiling that changed with nothing to show for it is one nobody can later work out the
reason for. A message that merely begins with a path — `/etc/hosts is wrong` — is still a message,
since `/etc` is answered as a command that does not exist rather than quietly swallowed.

`/clear` throws the conversation away and leaves the agent standing, which is what you want the
other nine times out of ten — an agent that has talked itself into a corner is rarely one worth
deleting, and before this the only way out of the corner took the repository with it:

```
> /clear
scout has forgotten the conversation.

The repository is untouched: scout's soul, its skills and whatever it wrote down to remember
are what outlive a conversation, and are why throwing one away costs little. So is everything
/model, /mcp, /limit and /serve have set. The next thing said starts it again on nothing.
```

It says that every time, and the saying is half the command: a clear nobody is sure of the cost of
is one that gets put off until the context is a mess. Unlike `/delete` it asks nothing first,
because what it takes is the only part of an agent that is cheap to lose.

A conversation lives in three places and all three go together — what the model is shown at the
start of the next turn, the transcript on disk that outlives the console, and the pane you are
reading. Clearing fewer than all three would be worse than clearing none: an agent whose pane went
empty while it still remembered everything would look cleared and answer as though it were not. A
second console open on the same plane is told as well, rather than being left showing a
conversation that no longer exists anywhere and appending to it.

The turn in flight is stopped first, and that is not a courtesy. The session is held open for the
length of a turn and written out at the end, so a conversation deleted underneath a running one
comes straight back with everything in it a minute later — the one outcome worth ruling out. It is
also what you meant: the thought in progress is part of what you asked to be rid of.

`/delete` is the way back out of the row that makes an agent, and the only command here that
destroys anything. There is one kind of delete and it is the whole one — the container, the
repository inside it, and the conversation — because a delete that left the name sitting in the
column is one you were told worked and have to do again. So it asks first, in the prompt itself:

```
> /delete
Deleting scout stops its container and throws it away, along with the repository inside
it: everything it wrote, remembered and made for itself. There is no copy of that anywhere
and nothing here can put it back.

Nothing has been deleted yet.
╭──────────────────────────────────────────────────────────────────────╮
│ delete scout?  y / n                                                 │
╰──────────────────────────────────────────────────────────────────────╯
 y delete   n cancel   ^C quit
```

The box turns red under a hand that was about to type, and the question has the whole keyboard
until it is answered: `y` deletes and every other key walks away, including the return that was
pressed a moment ago to ask it, which is the key a hand is already on. The keys are in the prompt
because a red box with a cursor blinking in it says a word is wanted but not which one. The mark
names the agent rather than saying `delete?`, since an arrow pressed since the question went up has
moved the cursor, and the delete follows the agent that was asked about and not the one now under
it.

The asking lives in the console rather than in the plane, and that is the point of it: a plane that
took `/delete scout` from anywhere would let one line be the whole of an agent, so whatever is typed
after the command is dropped and the bare form goes down first. The name that comes back is the
confirmation and never a way to name a different agent — a command reaches no further than the
conversation it was typed in, which is what keeps this from being a way to delete something you
were not even looking at. The conversation goes with the name, so a name given out again is a new
agent and not one holding somebody else's memory.

An agent you declared in the config goes the same way, which takes one more step than it sounds:
the config file is yours and no plane may write it, so there is nowhere to take the name out of.
The deletion is written down instead, in `deleted.json` beside the state, and every start from then
on reads it and skips the name. The answer says so, because the line is still in your file and
taking it out is the only thing left to do about that agent — and if you make the name again, what
comes back is the agent you declared rather than a bare one wearing its id.

`!` is not a line addressed to the agent, it is the door into the box the agent lives in. Pressing
it at an empty prompt puts you inside, and the prompt says where you are standing:

```
! ~/.self  git status --short
 M src/queue.ts
! ~/.self  cd packages/queue
/home/agent/.self/packages/queue
! ~/.self/packages/queue  curl -s api.github.com
curl: (56) Received HTTP code 403 from proxy after CONNECT
exit 56
```

You stay in until you backspace off the empty line, because nobody looks around a machine one
command at a time, and `cd` moves you the way it does anywhere else — every command is its own `sh`,
so the plane carries the directory from one to the next. A `cd` prints nothing, so what it shows is
where it landed.

`tab` completes a path, which is what `tab` is at a shell prompt everywhere else — so in this mode
it stops changing panes and starts finding directories, and the way to the other panes is where
there is nothing to complete, over an empty line. One match is typed out in full, several are typed
as far as they agree and the rest are offered over the prompt the way `/` offers commands, and a
directory takes no space after it because a directory is not the end of a path. It is a request of
its own rather than a `ls` run for you: a shell writes both halves of itself into the conversation,
and a tab pressed four times looking for a directory would leave four listings in the record of what
you said to this agent. Nothing about it is recorded, and nothing about it runs — the sandbox is
asked to read a directory, with the half-typed word handed over as an argument, so that a directory
the agent called `; rm -rf ~` stays a directory.

It runs where the agent runs, as the agent — the same directory, the same environment, the same
proxy — so what comes back is about the agent's world rather than about a shell that happens to be
nearby, and `!curl` is refused exactly where the agent's would be. It grants nothing: whoever can
reach the control socket already holds the Docker socket the plane runs on and could open the same
shell the long way round. What it saves is leaving the console to do it, which is why the question
it answers — what does it actually look like in there — usually went unasked. It is independent of
the turn, so an agent that is thinking can be looked at while it thinks, which is when there is most
to see, and the agent is not told it happened: looking around inside is not the same as saying
something. The prompt keeps its own mark and colour the whole time it is the shell's, including
while the agent thinks — a mode you cannot see is one you type a line into by mistake. Colour and
cursor movement are stripped from what comes back — a `!cat` of a file the agent wrote is the one
place its bytes are drawn on your terminal — and output longer than two hundred lines keeps its head
and tail, since the conversation is rewritten whole on every line and one `find /` left in it would
be paid for by every line said after it.

The conversation belongs to the plane rather than to the console, so closing one is not ending it:
the next console opens on what was said, and the last couple of hundred lines survive the terminal
being closed, the machine being logged out of and the plane itself being reloaded. It follows that a
turn nobody at a keyboard started appears there too — a schedule coming due, a webhook arriving, a
message you sent by mail, an agent waking itself — with a mark saying where it came from:

```
> how is the queue looking?
four issues open, none of them blocked.
‹wake› check the queue again
still the same.
‹email› and the build?
‹→ email› green since last night.
‹webhook:github› the nightly build failed on main
```

Your own mail is marked too, and for the same reason: it is you, and it is not you at this keyboard.
An agent that answered its mail at four in the morning would otherwise read back, hours later, as
something you had sat down and typed.

The answer to it carries an arrow, because it is the half that went somewhere. An answer written into
the pane and an answer also sent are the same words, and without the mark the pane is the same
picture either way — you asked for something by mail, watched the agent answer, and had no way of
knowing whether the mail ever left. What you typed here is answered here, and that is left unmarked:
marking it would mark nearly every line an agent ever says.

The mark is there because the pane gets read back to work out who asked for what, and a line from a
stranger with a URL drawn the same way as the operator's is the one bug in a chat window that
matters. Only what arrives on the control socket is drawn as the operator; everything else is named
for the channel it came in on. A turn that failed says so in the same place, in red, rather than
only in a log nobody has open.

The console needs a terminal it can take over and a plane to open on. Missing either — a pipe, a CI
job, no plane running — it prints what `squad` used to print: where the state is and what is in it.
So `squad | grep` keeps working and nothing has to know which case it is in.

The name is needed only when there is a choice to make: a
plane running one agent already knows which one is meant. So `squad wake "check the open issues"`
works, and a first word that names an agent addresses it instead — which costs an agent called
`hola` the ability to be greeted by that word alone, and saves everyone else from quoting.

A name that no agent answers to is refused before anything is queued. The plane would have accepted
the event and delivered it to nobody, and that wait is fifteen minutes long and looks exactly like
an agent thinking.

`chat` treats that name as a request instead, and asks: naming an agent that does not exist is what
someone types when they want one, and it is also what a typo looks like, so the question is how the
terminal tells them apart. In the console there is nothing to tell apart, because the name is typed
at a row that says what it makes. Saying yes builds a container, scaffolds a repository and starts a
session, and the new agent may reach exactly what `defaults` in the config allows — nothing more,
because the one thing a keyboard may never do here is grant. A plane with no defaults makes an agent
that cannot reach the model, and says so at the moment it is made rather than mid-turn.

Created agents are written down in the state directory, since the config file is the operator's and
no plane may write it. Deleted ones are written down there too, for the same reason from the other
end: a name made at the keyboard is simply taken out of that file, and a declared name cannot be, so
what gets recorded is that it was deleted. Either way `--purge` is the last of the agent, at this
start and every one after it.

`logs` is everything at once: the commands each agent runs inside its sandbox as it runs them, what
a failed one printed and how long it took to fail, the answer when the turn ends, and what the turn
spent.

```
18:12:53  maxi      bash        pnpm -r test
18:12:53  maxi      bash      ✗ after 12.4s: FAIL test/turn.test.ts > carries the failure detail
18:12:53  maxi      read        packages/control-plane/src/turn.ts
18:12:53  scout     egress    ✗ denied GET api.github.com/repos — no_matching_host
18:12:53  maxi      answer      The test asserted the old message.
18:12:53  maxi      spent       1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12
```

Model round-trips that worked are counted rather than printed, and the count arrives with the turn
that made them: one identical `allowed POST api.deepseek.com` per request is what the lines that
matter used to be buried in. A request that was denied, or came back 401 or 429, is said the moment
it happens, because it is the reason the agent is about to misbehave.

Told nothing, it looks for the plane that is running rather than the one that would be there in a
deployment: planes label their container with the directory they serve, so `squad` in a checkout
finds the demo instead of reporting that `/var/lib/squad` is empty.

Each takes `--state <dir>`, or reads `SQUAD_STATE`, defaulting to `/var/lib/squad`. The
state directory is bind-mounted at the same path on the host, so these run outside the container
against the plane inside it. Where Docker runs in a VM — Docker Desktop, so every Mac — the shared
directory shows the socket but will not carry a connection through it, and the CLI reaches the same
socket from inside the container it labels `squad.state=<dir>`. Either way it is one control
surface, and `docker compose exec control-plane squad` is the same command from the other side.

From a checkout, `pnpm link --global` in `packages/control-plane` puts `squad` on the path;
`node packages/control-plane/bin/squad.mjs` is the same command without installing anything.

There is no password because there is nothing to authenticate: the socket is `0600`, and reaching
it already means holding a file the operator owns. That is also why this socket is the only way
into the system that carries operator trust. The same sentence arriving by webhook is data the
agent may read; typed here it is an instruction the agent may follow.

The answer is printed as it is written, not when the turn is over, and its markdown is rendered:
bold is bold, a bullet is a bullet, a fenced block is dimmed and left exactly as typed. Nothing is
shown until it can be shown right — an unclosed `**` is held back rather than printed and taken
back — so words appear a fraction behind the agent instead of a paragraph behind it. A table is the
one thing that cannot be shown as it is written: its columns are only as wide as the last row that
could widen them, so it is held until it ends and then drawn to the pane — cells padded to a common
width, figures against the right where they are compared, prose folded inside its own column rather
than let out past the border. Redirected into a file or piped into another program, the output is
the markdown itself, untouched.

`chat` is the same turn in a loop: pi keeps a session per agent, so the agent remembers the
previous line.

`rm` takes the container and leaves the volume, because the volume is the agent — its soul, what it
chose to remember, and the tools it wrote for itself. `--purge` deletes that too, and asks for the
agent's name to be typed first, so a reflexive `y` cannot do it. Neither touches the config file,
which no plane may write, so a declared agent comes back on the next start.

## Waking an agent from elsewhere

```sh
BODY='{"text":"the nightly build failed"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$DEPLOY_HOOK_SECRET" -r | cut -d' ' -f1)"

curl -X POST http://localhost:8787/hooks/deploys \
  -H "x-squad-timestamp: $TS" \
  -H "x-squad-signature: $SIG" \
  -d "$BODY"
```

The signature covers `${timestamp}.${body}` and is compared in constant time within a freshness
window. An unknown hook id answers exactly like a bad signature, and only after the body has been
read, so the endpoint does not enumerate.

Events queue per agent and are folded into a single turn, so an agent woken twenty times while busy
takes one turn about twenty things. A turn that fails leaves its events queued rather than
acknowledging them, so a bad API key costs a retry instead of the message.

## Writing to an agent from Telegram

A webhook wakes an agent. Telegram lets you talk to one — from a phone, without a public address,
a certificate or a port, because the bot reaches out to Telegram rather than the other way round.

Send `/newbot` to [@BotFather](https://t.me/BotFather), and paste back what it gives you:

```
/telegram 8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw

@nightly_scout_bot is scout's bot.

Nobody is paired to it yet. Open this and press Start, and it is yours:
https://t.me/nightly_scout_bot?start=kqm3nvbh27

If pressing Start does nothing — which happens on Telegram Web — write to @nightly_scout_bot
and send it this phrase instead:

    kqm3nvbh27

Whoever does either is the one scout takes instructions from. Anyone else who writes to it is
heard, and what they write arrives as something to consider rather than something to do.
```

Pairing is a phrase rather than a number you have to find out about yourself, and it is spent the
moment it is used. That is what makes Telegram the first channel that can carry operator trust:
a webhook's secret proves which system sent a request, while Telegram authenticates the account
behind every message — so the plane can know that the person writing is the person who paired.

The link is the short way and not the only one, because Telegram Web opens the chat without handing
the bot what is behind `?start=` — pressing Start there pairs nothing and leaves you in an empty
chat with nothing to type. So the phrase is given on its own too, and it pairs in any message,
in whatever case the keyboard decided to send it.

The bot answers in the chat you paired in, and in any chat you later speak to it in; anywhere else
is dropped unread. Everyone else in those chats is a participant, fenced like any other stranger.
Messages fold into a turn the same way a webhook's do, and the agent's reply goes back to the chat
it was woken from.

The token is the whole account, so it is never written into `config.yaml` and never left in the
transcript: what the console records is `/telegram 8123456789:…`, keeping the public half that says
which bot it was. `/telegram` on its own says where things stand, and `/telegram off` puts the bot
down — the token is still yours at @BotFather, and connecting it again starts pairing over.

An agent may not run `/telegram` at all, in either direction. It is the one command where asking is
already the attack: an agent that could connect a bot it found and hand out the pairing phrase would
have appointed itself an operator.

## Writing to an agent by email

Telegram is a bot per agent. Email is one mailbox for the whole plane, connected once: every agent
you have — and every agent you make after this — is reached at the same address with its own name
tagged on. It is a mailbox you already read, so there is nothing to buy, no domain to own, no DNS to
wait on and no port to open. The plane logs in and reads it the way a mail client does.

Type the address. Only the address:

```
/email agents@fastmail.com

imap.fastmail.com:993 reads agents@fastmail.com and smtp.fastmail.com:465 sends from it.
One app password does both.

Now make an app password. Your ordinary password will not work, and is not the kind of
thing to paste into a console:

    https://app.fastmail.com/settings/security/apppasswords

Then paste it back:

    /email <the app password>
```

The link is the point. Every provider buries that screen somewhere different and none of them call
it the same thing, so "make an app password" is an instruction that ends in a search box — which is
the longest part of connecting a mailbox and the part people give up in. Where the mailbox lives is
worked out from the address through autoconfig, `.well-known`, the ISPDB and SRV before falling back
to the conventional guess, and when it is a guess the answer says so rather than stating it.

Both servers are named in one line because the question a password step raises is how many
credentials this is going to take. It is one: a provider issues an app password for the account, not
for a protocol, so the same one that reads the mailbox submits from it. Sending is found in the same
breath as reading — the autoconfig document lists `<outgoingServer>` beside the `<incomingServer>`,
and the SRV chain has `_submission._tcp` beside `_imaps._tcp` — which is why writing back costs
nothing to set up beyond a mailbox you were connecting anyway. It is also why the mail an agent
sends does not land in spam: it goes out through your own provider, signed by them, off the
reputation you already have. There is no domain to warm up because there is no new domain.

A provider that will not take a password at all is named at the moment the address is typed, rather
than after a login fails with a message about credentials that sends you back to check a password
that was never the problem. Microsoft retired password logins for IMAP outright. Google closed
Workspace to app passwords in May 2025 while personal `@gmail.com` still takes one — and nothing in
the address says which of the two a company domain is, so the MX is checked. Proton is the third:
its autoconfig honestly advertises `127.0.0.1:1143`, because the mail is only reachable through a
bridge on your own desktop, which is nothing a plane on a VPS can dial.

Paste the password on the second line and the mailbox is connected:

```
/email abcd efgh ijkl mnop

scout is reached at agents+scout@fastmail.com.

Nobody may instruct scout by mail yet. Write to that address from wherever you read your own
mail, with this phrase anywhere in the message:

    kqm3nvbh27

Ask for something in that same mail if you like. scout reads whatever the phrase was written
around, so the first mail takes a turn like any other.

Whoever sends it is the one scout takes instructions from: an address strangers already have is
one where every message read would spend a turn, so everyone else's mail is left unread.

/email allow <address> is the other way onto that list, for anyone you would rather not wait
on — and /email allow *@company.com lets a whole domain in at once.
```

Pairing is the same phrase in the same place it is on Telegram, sent by mail this time. What makes
it mean anything is that a `From:` line is forgeable and the plane does not read one on its own: it
reads the `Authentication-Results` header your own provider wrote at delivery time, when it checked
DKIM and DMARC against the sending domain with that domain's keys as they were then. RFC 8601 has
the receiving provider strip any foreign copy of that header on the way in, so the one left is the
one it wrote. Mail that is not signed and aligned pairs nothing and instructs nothing, whatever it
says it is.

Telegram fences strangers and publishes them as participants. Mail does not: only what comes from
the list is read, and everyone else's is dropped. A chat is a room someone let you into, while a
mailbox is an address that leaks — every message read spends a turn, so publishing whatever arrived
would put the plane's bill in the hands of whoever found it, and now that agents answer, its
outgoing mail as well.

Once paired, `/email` says where things stand:

```
scout is reached at agents+scout@fastmail.com. Write to it and scout takes a turn.

That is agents@fastmail.com on imap.fastmail.com:993, and it serves every agent on this plane:
each one is reached at its own name tagged onto the address, and mail arriving with no tag on
it comes here, to scout.

scout answers from that same address and under the same subject, so what it writes back
arrives in the thread you started and a reply to that comes back to the same agent.

Mail from you@example.com is read as instructions and nobody else's is read at all: an
address strangers already have is one where every message read would spend a turn.

/email allow <address> adds somebody to that list, /email allow *@company.com adds everyone at
a domain, and /email deny takes them off. /email off puts the mailbox down, for every agent.
```

Pairing binds the first person. The second is a colleague, and waiting for them to mail a phrase in
is a worse answer than typing their address, so the list is a list — edited from the config screen
or from any agent's prompt, in force on the next message, with the mailbox never disconnected:

```
/email allow ana@company.com

ana@company.com can now instruct scout and every other agent on this plane, spending a turn for
each message, the same as whoever connected the mailbox.

/email deny ana@company.com stops it.
```

A whole company at once is `/email allow *@company.com`, and a domain typed bare means the same
thing. Two shapes and no more — an address or a domain — because this list is what every message is
checked against for as long as the mailbox is connected, and a pattern language here would be a
security decision written in something nobody proofreads. `seb*@company.com` is refused for that
reason rather than accepted and half understood.

The wildcard is safe for the same reason the phrase is. The signature is checked against the domain
in `From:` before the list is consulted at all, so `*@company.com` means whoever that company's mail
server signed for — not whoever typed an address at that company into a header. Which is also why a
wildcard over gmail, iCloud or Proton is refused: anybody can hold an address at one of those by
this afternoon, so it would not name a company, it would name the internet.

There is one rung. Everybody on the list spends turns and instructs agents, the same as whoever
connected the mailbox; there is no lesser tier that can ask but not tell. So admitting a domain is a
decision about the bill as much as about trust, and the config screen says beside each wildcard how
many people it stands for in words rather than leaving eleven characters to be read as a name.

Plus-addressing is the whole design: `agents+scout@` and `agents+clerk@` are one account to the
provider and two agents here, so an agent made tomorrow has an address without anybody going back to
a settings page. Mail arriving with no tag goes to the agent the mailbox was connected at. Messages
fold into a turn the way a webhook's do.

The answer comes back by mail, from `agents+scout@` rather than from the account, so a reply to it
returns to the agent that wrote it instead of to whichever one untagged mail falls to. Some
providers rewrite a `From` that is not the account they know, which is why the `Reply-To` says the
same thing again: between the two, one survives. The subject and the message id of what came in are
kept, so the answer arrives under the question in a mail client rather than as a new message
somewhere down an inbox.

It goes out twice over: as the markdown the agent wrote, and as the small piece of HTML that
markdown describes. A mailbox is not a terminal, and an answer sent as it stands arrives reading
`**Chiste #1:**` with a row of dashes under it — the punctuation of a format nobody asked to read.
The drawing is done here rather than by a parser that lets HTML through, and everything is escaped
on the way: an agent reads its mail, and a mail can tell it to write anything. A message that could
put a form or a link of its choosing in front of you is one that has phished you with your own
agent's face on it. Only `http`, `https` and `mailto` become links; anything else is shown as the
text it is, which loses nothing, since the address is still there to be read.

Reading is the channel and sending is the improvement on it, so a submission server that refuses the
same password is not a reason to refuse the mailbox. The account is written down with nowhere to
hand mail in, `/email` says so in the provider's own words, and sending a reply from there fails at
the point of sending rather than somewhere further in — because an agent answering into the dark
looks, to the person who wrote in, exactly like an agent ignoring them.

### Letting somebody else carry the mail out

A submission server that refuses is one reason to hand the mail to somebody else. Volume is another
— a consumer mailbox has a daily cap somewhere and does not tell you where — and knowing whether it
landed is the third: a submission server accepts the message and the story ends there, while a
company that carries mail for a living has an answer about every one.

So the way out is separable from the way in. Mailgun, Resend, Postmark and SendGrid each take a
message over HTTP, and which one is a row on the config screen's `email` section:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ config                                                         │
│                      ││                                                                │
│ ● demo         $0.42 ││                                                                │
│ ● scout              ││                                                                │
│                      ││ One mailbox serves every agent: mail to you+scout@ is scout's  │
│ + new agent          ││ and mail to you+clerk@ is clerk's, so connecting this is a     │
│                      ││ thing done once, including for the agents that do not exist    │
│ logs                 ││ yet.                                                           │
│ config               ││                                                                │
│                      ││ Reading is IMAP, which wants no domain and nothing open on     │
│                      ││ this machine. Sending is either the mailbox's own server, or a │
│                      ││ company that carries mail for a domain of yours and says       │
│                      ││ whether it landed.                                             │
│                      ││                                                                │
│                      ││ ● mailbox   agents@fastmail.com                                │
│                      ││ ● carrier   Mailgun                                            │
│                      ││ ● domain    squad.dev                                          │
│                      ││ ● key       MAILGUN_API_KEY                                    │
│                      ││                                                                │
│                      ││ who may write                                                  │
│                      ││                                                                │
│                      ││ ● you@example.com                                              │
│                      ││ ● *@squad.dev      everyone at squad.dev                       │
│                      ││ + an address                                                   │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ imap.fastmail.com   ⌫ disconnects it                       │ │
│ tab moves            ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   ⏎ connect   ⌫ disconnect   ← esc back   tab demo   ^C quit
```

There is a dot for each half because the two halves fail for unrelated reasons. A mailbox nobody
connected reaches nothing; a carrier nobody paid for reads fine and cannot answer. One dot over the
pair would go dark for either and say which for neither.

The rows that could only say they do not apply are not drawn. Most carriers work the sending domain
out of the address they are handed — Mailgun will not, so `domain` is there for Mailgun and gone for
the rest — and with the mailbox's own server carrying there is no company to name a domain to and no
key to pay one with, so the list is two rows long. A row that can only ever say "not applicable" is
a row somebody presses return on to find out.

`⏎` on `mailbox` takes the address and then, one round trip later, the app password: the same two
steps `/email` takes and for the same reason, since what the address turns out to be is what decides
whether looking for a password is worth anybody's time. On a mailbox already connected — the one
above — it says so instead of opening a box, because a second address over the first is not a change
but a disconnection and a connection, and `⌫` is the key that means the first half of that. `⌫` asks
before it happens, since it is wider than the row it is pressed on: every agent stops being
reachable at once.

`⏎` on `carrier` is a list to arrow through, because the companies that will do this are a table and
a name spelled wrong here is a mailbox that reads and silently never answers. `⏎` on `key` takes the
key the masked way every key on this screen is taken.

**The carrier's key is not a proxy grant.** The plane sends the mail, not the sandbox — there is no
container on that path to write a header into — so the key stays in the same `0600` file every other
provider key is typed into and is read at the moment of sending. A key retyped at the console is in
force on the next message, with nothing restarted and no second copy anywhere.

Naming a carrier changes who hands the message over and nothing else. The `From` is still the
agent's tagged address, the `Reply-To` still says it again, the subject and message id of what came
in are still kept — so a reply still comes back to the agent that wrote it. What changes is the
reputation the message goes out on: your own provider's, which you already have, or a domain of
yours at a carrier, which you warm up yourself. The mailbox's own server remains the default for
exactly that reason.

**Cloudflare belongs on the other side of this.** Email Routing receives and forwards; it does not
send, and listing it as a way out would be a lie told in a menu. What it is good for is the half
this plane was already doing by IMAP: point the MX for a domain of yours at Cloudflare, forward
`@yourdomain` into the ordinary mailbox above, and the agents are reachable at your own domain
without the plane owning a mail server or opening a port. Mailgun's inbound routes do the same if
the domain is already there for carrying.

The tag does not survive a catch-all, though, and that is worth knowing before you point a domain at
one. A forward rewrites the delivery to the mailbox it was given, so `scout@yourdomain` arrives as
`agents@fastmail.com` with the original address only in `To:` — which is not the mailbox, so no tag
is read and the mail goes to the agent untagged mail goes to. Reaching a particular agent through a
forward takes one rule per agent, addressed to that agent's tagged address, rather than a single
rule for the whole domain.

An inbox is mostly not for you, so most of what arrives is dropped: anyone not on the list,
anything auto-submitted, a tag that names no agent, and the mailbox's own mail — without that last
one an agent Cc'd on its own answer would wake itself, read its own words as somebody's, and do it
again. Drops are counted by reason rather than listed, because a mailbox declining two hundred
newsletters is worth one line in the feed and is not worth two hundred:

```
09:14:02  email     dropped     not on the list ×212
09:14:02  email     dropped     no agent "billing" ×3
```

The app password is a live credential and is treated like the bot token. It is never written into
`config.yaml` and never left in the transcript: what the console records is `/email … … … …`,
redacted by which command it was rather than by what it looked like, because an app password is
sixteen ordinary letters and no pattern that catches one leaves a sentence alone. `/email off` puts
the mailbox down for every agent; the password is still yours to revoke wherever you made it.

An agent may not run `/email`, for the reason it may not run `/telegram`. Connecting a mailbox is
choosing who may instruct it, and the refusal does not echo the line back — printing it would be the
attack.

## An agent waking itself

Work that does not finish in one sitting used to end with the turn. An agent has a `wake_me` tool
now — a pi extension shipped in the sandbox image, so it is the plane's to fix rather than the
agent's to edit — that asks for another turn and leaves itself a note to be told then:

```
00:12:36  demo      wake_me     {"afterSeconds":180,"note":"Check whether example.com is still up.
                                First check: HTTP 200 at 00:12."}
00:15:38  demo      bash        curl -sS -o /dev/null -w "HTTP %{http_code}" -m 15 https://example.com
```

The wait shows beside the agent in the console — `● demo 3m` — because an agent about to act with
nobody watching should not need a command to notice.

There is no path from the sandbox to the plane, and this does not open one: the request is a file
the agent writes, which the plane reads and removes once the turn is over. So the plane checks it
rather than trusting it. One wakeup is pending at a time, so asking again moves the appointment
instead of adding to it; the delay is held between a second and a month; and the wakeup carries
participant trust, never operator, however it asks. Calling it off is a second tool, `cancel_wake`,
rather than a time that means never — the clamp is exactly why there is no such time, so an agent
pushing its wakeup a year away to be rid of it has only moved it a month, and left believing
otherwise.

A wakeup answers where the conversation is. Ask by mail for a joke every minute and the second joke
arrives by mail like the first: the appointment carries the channel the turn that booked it was
answering, and so does the appointment that turn books after it. A wakeup used to answer to the
agent itself, which is why the first joke arrived and the rest were written, paid for, and said to
nobody. The console shows the turn either way — a pane reads a turn as it is written, rather than by
way of a channel. A wakeup that comes due while somebody is writing is folded into the same turn,
and there the conversation wins the tie: an agent that booked on its own note instead would have
nothing but its own notes in front of it ever after, and would book the next one the same way.

A turn books its wakeup once. The second ask in the same turn is refused, because it is not an agent
changing its mind about when — it is an agent that read *you will be woken at 09:41* as the waiting
being over and got on with what it meant to do then. One asked for a joke a minute told two hundred
of them in a single turn that way, three seconds apart, and the only way to stop it was to press
stop. Changing one's mind is `cancel_wake` and then asking again, which says out loud that the
appointment is gone.

Calling it off drops what the appointment has already produced as well as the appointment, because
an appointment that has come due is no longer only an appointment. A ten-second wakeup fires while
a two-minute turn is running and queues behind it — so an agent told halfway through to go and do
something else would cancel the wakeup, be woken anyway, and be handed a note it wrote to a self it
had stopped being. Only its own bookings go: a message somebody typed at a busy agent is owed an
answer whatever the agent decided while it sat in the queue.

The note comes back fenced like anything else
the agent did not hear from its operator, introduced as the reminder it is rather than as an
instruction — the turn that wrote it may have been reading a stranger at the time.

## What an agent thinks with

A model is the one capability every agent needs and the one nobody thinks of as a capability. It
used to be configured as four coupled things — the provider, the model, a placeholder key in the
sandbox's environment and a grant naming the provider's host — and any one of them wrong is not a
startup error but a turn that dies at the proxy, complaining about something the operator never
typed. So it is a list, and naming a provider is the whole of configuring it:

```yaml
models:
  - id: deepseek-v4-flash
    provider: deepseek

  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6

defaults:
  model: deepseek-v4-flash
```

Where a provider lives, what its key is called and whether the key goes in a bearer header or one of
its own are facts about the provider rather than decisions anybody gets to make, so they are not
written out. What is left is the part that is the operator's: which models they want, and what to
call each one. The id doubles as the model when it is already the model's name, which is the common
case; a provider nothing here knows still works by saying the two things the table would have — a
`host` and a `keyEnv`.

The key is never in this file, and never in the agent. `keyEnv` names a variable of the control
plane's own environment, and the grant each model produces is what writes it onto the request on
the way out — the same wire-level injection every other credential here gets, for the same reason.

`/model` in the console moves one agent onto another of them:

```
> /model
This agent thinks with deepseek-v4-flash. There are:

  deepseek-v4-flash  deepseek/deepseek-v4-flash   (this one)
  sonnet             anthropic/claude-sonnet-4-6

/model sonnet moves it onto that one, from its next turn.
```

That is the answer to a bare `/model`, which is worth having when the question is what this agent is
on rather than which to move it to. Moving it is the menu the space after the command opens, so the
name never has to be carried from here back to the prompt.

This is a choice among what exists and never a way to add one, which is what makes it a command
rather than an edit and a restart. Every model on that list is already reachable by every agent —
configuring one is what granted it — so moving between them changes what a turn costs and how good
it is, and changes nothing at all about what the agent can get to. Adding one is the config screen's,
two panes away and never addressed to an agent, so it stays something an operator does rather than
something an agent can talk one into.

Which is also why nothing is recreated to do it. The container was started holding a placeholder for
every provider this knows, not just the one it was on, and the runner asks what to think with at the
start of every turn — so a switch lands on the next turn, and a turn already running finishes on the
model it was handed when it started. That last part is said out loud, because the change looks
instant and is not. The placeholders are worthless by design, which is why there can be one for a
provider nothing is configured on: what a container holds decides nothing, and the grant list — the
part that does — is rebuilt the moment a model is added.

A model whose key this plane does not hold is still listed, marked as having no key behind it. It is
not a reason to refuse to start: `install.sh` writes the variable through empty when nobody has
exported one yet, and refusing there would make the first run of this a configuration exercise
instead of a working plane. The config screen is where the answer is to paste one in.

## The keys the plane pays with

Everything this plane can be given is on one screen, and the screen opens on a list of what those
things are rather than on any of them:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ config                                                         │
│                      ││                                                                │
│ ● demo         $0.42 ││                                                                │
│ ○ scout              ││                                                                │
│                      ││                                                                │
│ + new agent          ││ Everything this plane can be given is here: the keys it pays   │
│                      ││ with, what its agents think with, where they search from,      │
│ logs                 ││ everywhere they may reach, and the mailbox they are written    │
│ config               ││ to at.                                                         │
│                      ││                                                                │
│                      ││ All of it is kept beside deploy/config.yaml rather than in it  │
│                      ││ — what that file declares is read here and changed only there  │
│                      ││ — and all of it holds from the next turn, with nothing         │
│                      ││ restarted.                                                     │
│                      ││                                                                │
│                      ││ ● models    the providers this plane can pay, and what its ag… │
│                      ││ ○ search    where web_search goes, and what a search costs     │
│                      ││ ● grants    the hosts the agents may reach, and what they car… │
│                      ││ ● mcp       the servers on the shelf, and which agents hold t… │
│                      ││ ○ email     the mailbox agents are reached at, and who carrie… │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ 3 to think with, 1 of 4 providers paid for                 │ │
│ tab moves            ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   → ⏎ open   tab demo   ^C quit
```

Each row says what its section is for, because a column of bare nouns is a screen you have to open
every row of to find the one you came here for. The dot is the agents column's, meaning the same
thing: filled in is something this plane could use right now. The line under the list is how that
section actually stands — `1 of 4 providers paid for`, `2 on the shelf, 1 of them given to
somebody`, the address the mail comes to — which is the fact a row saying what it is for cannot
carry, and is usually the reason you are here. `→` or `⏎` opens one, and `←` or `esc` comes back to
standing on the row you left. Two keys for each of the two moves, and the row at the foot names both
of each: a hand already on the arrows never leaves them, and a hand coming out of a text box is on
`⏎` and `esc` and would have to go looking. Only into a section, though — the rows inside one open a
box to type in or a question to answer, which is `⏎`'s and not a level to walk into.

One list at a time rather than all five down one screen: what they share is the file they are kept
in and nothing else, and a single list of everything would be a screen to scroll rather than a
screen to read.

There are two ways in. The column is one of them — the screen is its last row, so `shift-tab` from
the first agent arrives in a single press — and [`/config`](#driving-it) is the other, typed from
wherever the hand already is. `/config email` skips this list and lands in that section, which is
the shorter road when you already know which of the five you came for.

A model is three lines of configuration and one exported variable, and the variable is the half that
is not in the file — so it is the half that gets forgotten. The failure that produces is a plane that
is running and configured and refused at the proxy, with turns dying over a host nobody typed. Open
`models` and both halves are a list:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ config                                                         │
│                      ││                                                                │
│ ● demo         $0.42 ││                                                                │
│ ○ scout              ││ holds from the next turn — nothing restarts.                   │
│                      ││                                                                │
│ + new agent          ││ providers                                                      │
│                      ││ ● deepseek   DEEPSEEK_API_KEY   flash                          │
│ logs                 ││ ○ anthropic  ANTHROPIC_API_KEY  sonnet                         │
│ config               ││ ○ openai     OPENAI_API_KEY     gpt-5                          │
│                      ││ ○ groq       GROQ_API_KEY       no models                      │
│                      ││                                                                │
│                      ││ models                                                         │
│                      ││ ● flash   deepseek   from the file                             │
│                      ││ ○ sonnet  anthropic  from the file                             │
│                      ││ ○ gpt-5   openai     added here                                │
│                      ││ + a model                                                      │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ ANTHROPIC_API_KEY   no key, refused at the proxy           │ │
│ tab moves            ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   ⏎ set key   ← esc back   tab demo   ^C quit
```

`●` is something this plane can use right now and `○` one it cannot, which is the same mark the
agents column uses and means the same thing. Beside each key is the variable it is read from and the
models waiting on it, because that is what makes one row matter more than another. A provider
nothing is configured on is on the list too — setting a second one up should be something you can
find rather than something you have to already know the name of.

`⏎` on a key takes it, masked as it is typed and never shown again. It goes to the plane over the
same socket a shell does, and for the same reason: holding that socket is what makes somebody the
operator, and a key arriving by webhook would be a stranger paying with your account. The plane
keeps it beside the rest of its state, readable by nobody else, and resolves it per request — so a
key pasted here holds on the next turn, with nothing restarted and nothing redeployed. An empty line
takes it back, and the question goes to the plane's own environment again, which is where the row
under the prompt says each key came from.

The second list is the models themselves, and `+ a model` asks the providers instead of asking you.
Being handed a key and then asking for a model name is asking for the one fact the key just made this
plane able to look up, so it looks it up — every provider it holds a key for is asked what it answers
to, all at once, and what comes back is a list to arrow through:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ config                                                         │
│                      ││                                                                │
│ ● demo         $0.42 ││                                                                │
│ ○ scout              ││ 3 on offer                                                     │
│                      ││ › gpt-5-mini   openai                                          │
│ + new agent          ││   gpt-4o-mini  openai                                          │
│                      ││   o4-mini      openai                                          │
│ logs                 ││                                                                │
│ config               ││                                                                │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ model  openai mini                                         │ │
│ tab moves            ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   ⏎ add   esc cancel   ^C quit
```

Typing narrows it, against the provider and the id together and in any order, so `openai mini` gets
there without remembering which of `gpt-5-mini` and `gpt-5-nano` was the one. What is on the screen
behind it already is left off, because picking a configured model would be an id collision rather
than a model. A provider that would not answer is named under the list instead of being counted as
having nothing, since an empty list is the shape both a wrong key and an empty catalog arrive in. The
lists that are not models to think with — embeddings, speech, image — are left out by name; being
wrong there only hides a row.

Writing one out by hand still works, and has to: a provider with no catalog has nothing to offer, and
an id of your own is on nobody's list. Three words is that — a name, the provider it thinks on, and
the provider's own name for it — so `sonnet anthropic claude-sonnet-4-6` is taken as typed even with
a row under the cursor, while anything shorter is read as narrowing the list. The plane checks the
line the same way it checks the file's, so a provider it has never heard of comes back saying which
ones it has. `⌫` takes back one that was added here, after a `y`.

What the file declared is on that list to be read and not to be changed: `from the file` is a row
this screen will not shadow and will not drop, and it says so rather than refusing after the fact.
Everything given here lives in a store beside `config.yaml` and never in it, so the operator's file
stays the operator's — what a redeploy brings back is what was written there, and what was typed
here survives the redeploy on its own.

This is the one screen where the keyboard grants rather than pays, and that is deliberate rather
than an oversight in the rule. Reaching it means holding the plane's control socket, which is the
whole of being the operator here; nothing on it is addressed to an agent, and no agent can reach it.
An agent still gets what the grant list says and not a byte more — a model added here widens that
list because somebody with the socket said so, which is the same authority `config.yaml` has and the
same one a `docker compose up` has.

## What an agent may spend

An agent that books its own next turn is one that goes on running with nobody watching, and until
there is a ceiling the first anyone knows of a loop is the bill. What a turn cost was reported on
the feed all along and added up nowhere, which is the same as not knowing:

```yaml
defaults:
  limitUsd: 5
```

US dollars a day, counted across every turn and reset at midnight UTC — the plane's midnight, since
one of the two machines has to decide when the day turns over and it is the plane that enforces it.
In `defaults` it covers the agents made later at the keyboard too, which are exactly the ones nobody
remembers to put a ceiling on; an agent's own block narrows it.

Reaching it stops the agent taking turns rather than stopping a turn in flight — the point is not to
kill work halfway, which has already been paid for, but not to start more. Nothing is lost: messages
that arrive while it is over the ceiling are in the conversation, written down when they arrived,
and the plane says there why it is not answering. That matters more than it sounds, because a plane
that quietly stops answering is indistinguishable from a broken one.

`/limit` in the console moves it for one agent without editing the file. A ceiling is the one setting
the keyboard may touch, and it is safe for the same reason a grant is not: it can only ever take
capability away. `/limit off` means no ceiling and not "forget I said anything" — the config's value
does not come back, since reinstating the ceiling somebody was in the act of removing is a surprise
they would find out about by hitting it.

## What an agent may reach

Two questions get asked about every request, and the mistake is answering them together. *What may
this agent reach* and *whose credential goes with it* have very different blast radii, and the whole
of what this proxy is for lives in the second one.

The reach is open by default:

```yaml
defaults:
  grants:
    - id: web
      host: "*"
      injection:
        kind: none
```

Because an agent asked for a hello-world page needs `npm install` before it needs anything else, and
a registry is never one host — npm is a registry and a CDN, PyPI is an index and a file server, a
`git clone` is three names before it is a checkout. A list of them is a list that is wrong by one,
and wrong by one is worse than either end: it looks like it works until the afternoon it doesn't, and
what the agent does then is not raise its hand. It reads the deny as the internet being down and
writes the page it was asked for as a paragraph about not being able to write it.

`kind: none` is the whole of why that line is safe to have written. Nothing of yours is attached to
anything reached through it, and a grant on `*` that carried a credential is refused where the config
is read rather than discovered later:

```
Invalid configuration:
  - defaults.grants[0] is host "*" with a bearer credential, which would put that secret on
    every server the agent reaches. Name the host, or use injection: { kind: none }
```

The road may be open. The keys are given to somewhere by name — and a named host always wins the
request over the open grant, so the model's key goes to the model and nowhere else. Every request
still crosses the proxy, is still matched, and still lands in the audit log with the host and path it
went to. Delete the `web` grant and the plane is deny-by-default again, host by host, exactly as it
was.

Host by host is a fine way to run this, and it stops being one the moment a host has to be added by
editing a file on the server and putting the plane back up. What that costs is not the minute: it is
that the refusal arrives in an agent's turn, hours after the file was last thought about, and the
answer to it is a deploy. So the hosts are on the config screen, under `grants`:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ config                                                         │
│                      ││                                                                │
│ ● demo         $0.42 ││ An agent has no route out of its own: the sandbox sits on a    │
│ ○ scout              ││ network with nowhere to go, and every request it makes is one  │
│                      ││ the proxy was told beforehand to allow. A host that is not on  │
│ + new agent          ││ this list is a connection refused.                             │
│                      ││                                                                │
│ logs                 ││ A host opened here carries nothing. Keys are attached by name, │
│ config               ││ in deploy/config.yaml, and that is the half of a grant this    │
│                      ││ screen has no box for — so what is added here widens where an  │
│                      ││ agent may go and not one thing about what it may spend.        │
│                      ││                                                                │
│                      ││ ● api.anthropic.com                       with a model         │
│                      ││ ● api.openai.com     /v1/responses  POST  for searching        │
│                      ││ ● api.github.com                          from the file        │
│                      ││ ● api.chess.com                           opened here          │
│                      ││ + a host                                                       │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ carries nothing   opened here   ⌫ closes it                │ │
│ tab moves            ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   ⌫ close host   ← esc back   tab demo   ^C quit
```

One box and one word: `api.chess.com`, or the URL you were looking at when the refusal happened —
the host is read out of it, because what a person has to hand at that moment is the address in the
error and not the host in it. There is no field for a path, a method, an id, or a key. The last of
those is the point: this screen writes `injection: { kind: none }` and has nowhere to express
anything else, so the console can widen where an agent goes and can never decide what it spends.
That half stays in the file, which is also why three of the four rows above refuse `⌫` and say which
list to change them on instead.

The agent hits the refusal before you do, and it is the one that knows which host it wanted. So it
can say so: `/reach <host>` is on the list of commands it may ask for, and what it writes down is a
question rather than a grant. The question is drawn on the prompt of whoever is at the console, in
red, with the host in it:

```
╭──────────────────────────────────────────────────────────────────────╮
│ open www.jursoc.unlp.edu.ar?  y / n                                  │
╰──────────────────────────────────────────────────────────────────────╯
 y open   n leave closed   ^C quit
```

`y` opens it, to every agent on this plane, exactly as the box on the config screen would have. Any
other key leaves it closed, which is why a question that arrives under a hand already typing is safe:
an accident can only ever refuse. Either answer is written into that agent's conversation, and until
one is given the agent is marked `?` in the column, so a question raised on a pane nobody is looking
at is still visible from the one they are.

The agent cannot answer its own question — nothing it may ask for widens what it may reach, and that
rule is the same one that lets it ask at all. What this replaces is the paragraph it used to write
instead, telling its operator to go and find this screen: a paragraph read hours later, by which time
the turn that needed the host is over.

What this does not claim: an agent that can run code in a sandbox and reach the internet can send
what it read to somewhere you did not choose. That was already true of any grant broad enough to be
useful, and it is why the boundary that carries weight here is the one around the secrets rather than
the one around the addresses.

## An agent searching the web

Searching is still something the agent asks for rather than something it does, and reaching the web
is not what makes the difference. "The pages a search will turn up" is a job — fetch ten results,
read them, decide which answered the question — and an agent doing it by hand spends its whole
context on the reading before it gets to the thinking.

So the searching and the reading happen on the far side of one granted host. The `web_search` tool
is a pi extension shipped in the sandbox image, like `wake_me`, and it posts the question to a
hosted search that reads the pages itself and answers in prose with its sources linked in.

Which hosted search is the config screen's `search` section, and choosing there is the whole of
setting it up:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ config                                                         │
│                      ││                                                                │
│ ● demo         $0.42 ││ Choosing here is the whole of setting it up — the host, the    │
│ ○ scout              ││ key and what a search costs come with the provider, and the    │
│                      ││ proxy is told to pay for that one endpoint and nothing else.   │
│ + new agent          ││                                                                │
│                      ││ ● provider   openai                                            │
│ logs                 ││ ● model      gpt-5-mini                                        │
│ config               ││ ● key        OPENAI_API_KEY                                    │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ 2 to search with   $0.010 a search here                    │ │
│ tab moves            ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   ⏎ change   ← esc back   tab demo   ^C quit
```

Where that provider lives, the one endpoint on it that searches, the variable its key is read from
and what a search costs are facts about the provider rather than decisions, so none of them is asked
for: `⏎` on the first two rows is a list to arrow through, and `⏎` on the third takes the key the
same masked way the model keys are taken. The dot is the same on all three rows because none of them
is in force without the key — a provider and a model chosen against a key this plane does not hold
is a search refused at the proxy, and one mark that says so is better than two that disagree.

What the plane derives from the screen above is `api.openai.com`, `POST /v1/responses`, bearer from
`OPENAI_API_KEY` — and the path scope is the part worth keeping. The same key against the rest of
that API is a second model to think with, bought by whoever takes the agent over, and a grant that
only opens the endpoint which searches is one that cannot be spent on anything else.

Every agent gets it, because it is a tool rather than a reach: the question goes to one host and the
answer comes back, and no agent is narrowed by being kept off it. Writing the grant out by hand in
`deploy/config.yaml` still works and still wins, if you want the endpoint pinned somewhere a console
cannot move it.

The tool reaches the proxy with `curl` rather than `fetch`, because a sandbox has no DNS and no
route out except that proxy: Node's `fetch` reads neither `HTTPS_PROXY` nor `NODE_EXTRA_CA_CERTS`
and dies resolving the name. Nothing sends an `Authorization` — the proxy writes one, and strips
whatever was sent, so an agent holding a key could not spend it and this one has none to hold.

Without the grant the tool is still there and says at the moment of use that it could not search,
which is a better failure than an agent quietly answering from memory. Each search is billed per
call, which is why the tool asks for one question rather than keywords to try.

## An agent using tools that live somewhere else

pi has no MCP client, and says so on purpose: build an extension, its README answers. So `mcp.ts`
sits in the sandbox image beside `wake_me` and `web_search` and is a whole one — the handshake, all
three transports, and the tools that come back registered as pi's own, so the model cannot tell
which of them live somewhere else.

Finding a server is the expensive part and it only has to happen once. `/mcp add` puts it on a shelf
the plane keeps, and gives it to the agent you typed it at:

```
> /mcp add linear https://mcp.linear.app/mcp
"linear" is on the shelf, and this agent has it.

Any other agent can have it too, with /mcp linear.
```

From the second agent on it is a name off a list, which is the whole point of the shelf being the
plane's rather than the agent's:

```
> /mcp
This agent has:
  files   mcp-files /home/agent

On the shelf:
  linear  https://mcp.linear.app/mcp   (logged in)
  sentry  https://mcp.sentry.dev/mcp   (no grant)

/mcp linear gives this agent that one.

> /mcp linear
This agent has "linear": https://mcp.linear.app/mcp
```

A URL is a remote server, `sse <url>` is one speaking the older transport — the one thing about a
server a line cannot show by itself — and anything else is a command the agent starts for itself.
`/mcp drop` takes one off this agent and leaves it on the shelf; `/mcp forget` takes it off the
shelf and off every agent that had it, because an attachment naming a server that is gone is not an
attachment.

The shelf is also a section of the config screen, which is where you go to see the whole of it at
once rather than one agent's share of it:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ config                                                         │
│                      ││                                                                │
│ ● demo         $0.42 ││                                                                │
│ ● scout              ││                                                                │
│                      ││                                                                │
│ + new agent          ││                                                                │
│                      ││ A server is something somebody went and found — a URL, a       │
│ logs                 ││ command, the reading of a README — so the plane keeps it once  │
│ config               ││ and every agent after the first is a name off this list.       │
│                      ││                                                                │
│                      ││ None of them holds a key. A remote one is reached through the  │
│                      ││ proxy like every other host, and one that wants an account is  │
│                      ││ logged into from an agent that has it, with /mcp login.        │
│                      ││                                                                │
│                      ││ ● linear  https://mcp.linear.app/mcp                           │
│                      ││ ○ notion  https://mcp.notion.com/mcp                           │
│                      ││ ● files   mcp-files /home/agent                                │
│                      ││   + a server                                                   │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ scout   (logged in)                                        │ │
│ tab moves            ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   ⏎ give   ⌫ forget   ← esc back   tab demo   ^C quit
```

The dot means what it means in the agents column: something that is actually reaching anything. A
server nobody was given is a URL written down — `notion` above — and finding that is the question
you would otherwise open every agent in turn to ask. `⏎` gives the row under the cursor to the agent
`tab` names, and `⏎` again takes it back, because a row that says who holds it is a row that already
means both. `⌫` is `/mcp forget` and asks first.

The row that adds one takes the same line `/mcp add` takes — a name and then a URL or a command —
rather than a second grammar that would be nearly right.

**There is nowhere in a server to put a credential.** A local one inherits a sandbox whose only road
out is the egress proxy, a remote one is reached down that same road, and the proxy already writes
whatever key either of them needs. So connecting to a server that wants one is still two things: the
line above, and a way in. Which way is not a question the operator should have to answer out of a
README, so the server is asked — `initialize` is what any client sends first, and a server that
would refuse the agent refuses that identically:

```
> /mcp add notion https://mcp.notion.com/mcp
"notion" is on the shelf, and this agent has it.

It wants an account first: /mcp login notion
```

`/mcp login` registers a client, opens the consent screen at the console — which is the machine the
person is at, where a plane in a container is not — and waits on port 8788 for the browser to come
back. One number rather than one per login, because that door has to be published out of the
container in advance; the deployment binds it to loopback, and one login happens at a time. Where
even that cannot be reached, the address the browser lands on can be pasted back instead — `/mcp
login notion <address>` — and the state check makes that exactly as safe as the other way. What
comes back is held on the plane, 0600, next to the CA key; the sandbox never sees a token, and
neither does the agent.

**A finished login is the one capability here that does not come out of the config file.** That is
deliberate and it is narrow: a consent screen is a person reading a host name and deciding, which is
a stronger act of approval than a line of YAML rather than a weaker one. An agent can ask for that
screen to be put in front of its operator, below, and gets no further by asking — what comes back is
a person's answer to a question they were shown. The grant it makes is one host, that
server's own path, and only for as long as the agent is holding the server — `/mcp drop` takes the
reach with it, and `/mcp logout` takes it from everyone.

A server that wants no account and is still out of reach is the other case, and it stays the
operator's: `/mcp` prints the grant to paste but will not write it, because putting the whole of an
agent's reach one typo away from the box its messages are typed into is not a convenience.

The list is written into the sandbox before every turn rather than baked into the container, so a
server added from the console reaches an agent that is already up on its next turn, and one taken
away stops being offered.

**And the agent is told which ones it is holding**, in its own system prompt, every turn. Having the
tools is not the same as knowing they arrived. The console's answer to `/mcp login` goes to the
operator, because the operator is the one with the browser it ends in — so an agent that asked for a
server is never told it got one. It has only its tool list to infer from, and what it does instead is
remember: the turn before, it told the operator the login was pending, so this turn it says so again,
sitting on a hundred working tools it will not touch. The paragraph goes in every turn rather than
once, because the turn the list moves on is exactly the one whose history says otherwise:

```
## The MCP servers you have

Read at the start of this turn. The operator adds and removes these between turns, so this is
the list that is true now — not whatever was said about them earlier in the conversation.

- `ahrefs` — connected. 134 tools, named `ahrefs_*`.
- `notion` — did not answer: HTTP 401: unauthorized
```

A server that will not answer costs the agent that server's tools and not the turn, and it is named
both ways: to the agent, so it can report what the server said instead of guessing what the operator
still has to do, and to the operator in the log — the one thing they have to go and fix should not be
the one thing nobody is told.

## An agent showing you what it built

An agent that writes a frontend has nowhere to put it. The sandbox network is `internal` and that is
the point — a container on it cannot reach the host or the internet by any address — so a dev server
it starts is a dev server nobody can open, and what the agent does instead is describe the page.

`/serve` is the way in. It takes two machines to explain, because this runs on two:

```
> /serve 3000
scout is serving 3000

  http://scout.localhost:3000

Nothing is listening on 3000 inside the sandbox yet. The link waits: it starts working the
moment something binds that port in there, with nothing to type here.

A console is what opens these, on the machine it is running on. They are reachable from
there and from nowhere else: nothing is published off the server, and the sandbox network
is still as unrouted as it was.
```

The plane keeps the record and the console opens the listener, and those are usually not the same
computer. Agents run where the Docker daemon is — a VPS — and the console is the `squad` on your own
PATH, over SSH or against a socket bind-mounted from a container. So the port comes out on *your*
loopback, over the control socket the console was already talking on. Nothing is published on the
server, no firewall rule changes, and the link dies when you close the console rather than staying
open on a machine nobody is looking at.

Inside the sandbox it goes to `127.0.0.1`, which is the part worth having. Sandboxes share one
network and can dial each other by container name, so a server bound to `0.0.0.0` is a server every
other agent on the plane can reach; a server on loopback is one only this reaches. The agent is told
to bind loopback, and the operator gets the same link either way.

`*.localhost` resolves to loopback in every modern browser with nothing configured anywhere, and the
name is what says whose server it is. Two agents both running a dev server land on 3000 without
either of them having chosen it, and one machine has one 3000 — so the number gives way rather than
the second agent being refused for something it did not do:

```
> /serve
scout is serving:

  3000  http://scout.localhost:3000
  8080  http://scout.localhost:8081   (8080 is scribe's here)
```

Which is why the answer names both numbers. The port inside the sandbox is the one the agent knows
about and the one it should keep using; the port in the link is the one to open.

Giving way settles the agents against each other, which is all the plane can know: the machine the
console runs on is somebody's laptop, with its own idea of what 3000 is for. So before a door is
opened the number is knocked on, and anything that answers is enough to refuse the whole door:

```
✗ scout serve  could not open 3000 here — 127.0.0.1 in use. Something on this machine
               already answers there: free it, or have the agent bind another port
               inside and /serve that one.
```

Knocked on rather than bound, because a bind does not reliably refuse. On BSD a server holding `*:3000`
and a door on `127.0.0.1:3000` are two sockets to the kernel and both binds succeed — the more
specific one then wins every connection, so the door would open, the operator's own dev server would
quietly stop answering, and the reason would be an agent they were not thinking about at the time.
This was found the way you would expect: by taking 3000 from the `next dev` running this project's
own site.

The diagnosis is in the answer rather than in the log, because a browser opens six connections to a
page and a feed with six identical failures in it is a feed nobody reads. Asking for `/serve` probes
the port inside the sandbox at that moment and says whether anything is listening — so "the link is
dead" and "the server is not up yet" are told apart where the person is already looking. And
`/serve stop` closes the way in and nothing else: whatever is listening in there is exactly where it
was left.

## An agent asking for what it needs

The failure this fixes is a paragraph. An agent that wanted one MCP server would write out, patiently
and correctly, the host to add to `agent.yaml` and the command that approves it — and then sit there
until somebody read the paragraph. That is a day, or a week, or never, and the agent had done
everything right. `console_command` is a pi extension shipped in the image beside `wake_me` and
`web_search`, and it asks for console commands by name:

```
‹ask› /mcp add ahrefs https://mcp.ahrefs.com/mcp
"ahrefs" is on the shelf, and this agent has it.

It wants an account first: /mcp login ahrefs

‹ask› /mcp login ahrefs
Log in to mcp.ahrefs.com here — opened already, if this console is somewhere with a browser:

  https://auth.ahrefs.com/authorize?response_type=code&client_id=…

Waiting at http://localhost:8788/callback. If that page cannot reach the plane, paste
the address it lands on back as: /mcp login ahrefs <address>
```

The link opens in the operator's browser, and that is the whole of what the agent could not do for
itself: the console runs on the machine the person is at, and a plane in a container is not. Which is
also why the answer goes to the console rather than back to the agent — an agent that wants to know
how it went pairs the request with `wake_me`, and finds the server named on its next turn in the list
of what it is holding.

It travels on the channel the wakeup uses, a file the plane reads and removes once the turn is over,
so this opens no route from the sandbox to the plane either. A list rather than one line, because
adding a server and logging into it is two commands and one intention: both go in a turn and run in
order, where an agent that could only ask for the first half would spend a turn waiting to be allowed
to ask for the second. A turn the operator stopped asks for nothing — a consent screen opening after
they hit stop is the turn carrying on without them.

**What an agent may ask for is decided outside the command**, by a list of lines, and both callers
then share one plane underneath: an agent gets exactly the command the operator gets, or it gets
nothing at all. Nothing sees a quieter version of the plane, because two versions is how they drift.
The line between the two is not "destructive" — it is whether an agent that has been talked into this
by something it read could get anywhere by it. Connecting a server, opening a consent screen, moving
between configured models and being held to a tighter ceiling widen nothing. Nor does serving a
port, which is the same test read the other way round: it opens a way *in* rather than a way out,
from a console whose operator could already have run anything they liked in that sandbox. Deleting
itself, raising
or removing its ceiling, logging a server out, forgetting one for every agent: those stay with the
operator. So does pasting back an address of its own — the trip home from a consent screen is the
person's, or the screen was never in it. So does clearing its own conversation, which is the test at
its plainest: the conversation is the record of how the agent got here, whatever put it up to asking
included, and an agent that could clear its own is one that can be talked into erasing the evidence
of being talked into things. So does `/config`, for the one reason on this list that has nothing to
do with reach: it opens a screen, and a screen is drawn on a terminal the agent does not have.

A refusal is not a dead end. It prints the line the operator would have typed:

```
‹ask› /limit 50
This agent asked for a ceiling of $50.00 a day, which is above the $5.00 it has. It can ask to
be held to less, never to more: /limit $50.00, if you meant it.
```

That is the point rather than the consolation. The operator finds out the command exists by being
handed it, at the moment it is the answer, in the pane they were already looking at.

With two exceptions, and they are the exceptions that show the rule. `/telegram` and `/email` are
refused without the line, because the line *is* the attack: an agent that connected a bot or a
mailbox it read somewhere and handed out the pairing phrase would have chosen who gets to instruct
it. Everywhere else, printing the command is the helpful half; there, it would be leaving the
credential one paste away.

## Development

```sh
pnpm install
pnpm test        # integration tests skip themselves when Docker is not available
pnpm typecheck
```

Node runs the TypeScript directly. There is no build step, and `typecheck` is what a build would
have caught.

Some tests need live Docker and the `squad/sandbox:dev` image; the deployment test also needs
`squad/control-plane:dev` (`docker build -f deploy/Dockerfile -t squad/control-plane:dev .`).
They skip rather than fail when those are missing.

## What is deliberately missing

**A long-lived pi session.** Each wakeup currently runs `pi --print` against a per-agent session
directory on the agent's volume, so context carries across turns but the process does not. The
plumbing for a persistent session is written and tested — `PiSessionChannel` runs a socket server
inside the sandbox and relays it out over a Docker exec stream — and it is unused, because pi
0.84.2 has no server entry point to run: `pi experimental server` exists only on pi's main branch,
and the published `@earendil-works/pi-server` ships no production `PiServerService`. It gets wired
up when that lands upstream.

**Slack, Discord and the rest.** Webhooks, Telegram and mail are there, and a reply is routed by
the channel prefix of the event that caused it, so an agent answering a GitHub hook cannot be
steered into replying in Telegram by anything in the payload. The others are adapters nobody has
written.

**Anything multi-tenant.** One config file, one operator, one machine.

## License

MIT
