# agent-dive

Self-hosted cloud agents. An agent here is a container that stays running, wakes up when something
happens, and reaches the outside world only through credentials it never sees.

It is a runtime, not a harness. The thinking is done by [pi](https://github.com/earendil-works/pi);
agent-dive gives it a machine to live on, a way to be woken, and a boundary to work inside.

Requires Docker and Node 22 or newer. One VPS is enough.

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
tools/       scripts it wrote for itself
```

It is scaffolded once, git-initialised, and then left alone: turns run inside it, so what the agent
learns and what it can do are files it edits and commits itself. The control plane never writes
there again, because the second write would be the control plane overwriting the agent's own work.

Nothing in that repository grants anything. `agent.yaml` lists capability *requests*, and an
operator answers them in the config file the agent cannot reach.

## The pieces

| Package | What it is |
| --- | --- |
| `events` | Trust levels, fencing, the durable event bus, and the renderer that turns a batch of events into one turn |
| `proxy` | The egress broker: a CONNECT-terminating MITM proxy with a local CA, grant matching and credential injection |
| `sandbox` | The Docker driver: container per agent, named volume for its repository, exec streams demultiplexed from the daemon's framing |
| `scheduler` | Cron and one-shot wakeups, persisted, with Vixie cron semantics and DST-correct wall-clock matching |
| `channels` | Where events come from and replies go. Ships a signed webhook channel |
| `agent-repo` | The agent's own git repository: manifest, soul, skills, memory, tools |
| `control-plane` | Wires it together, takes turns by running pi in the sandbox, and reads a YAML config |

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

On the machine it is going to live on:

```sh
curl -fsSL https://raw.githubusercontent.com/agent-dive/agent-dive/main/deploy/install.sh | sh
```

That installs Docker if there is none, puts the repository in `/opt/agent-dive`, asks on the
terminal for the keys the proxy will hold, writes a config with one agent and a ceiling of five
dollars a day, starts the plane, and leaves `agent` on the PATH — so from your own computer the
whole of it is `ssh -t root@your-vps agent`. Running it again is the update: it pulls, rebuilds and
swaps the plane in, and never touches `config.yaml` or `.env`.

By hand, which is the same thing without the questions:

```sh
git clone https://github.com/agent-dive/agent-dive /opt/agent-dive && cd /opt/agent-dive
docker build -t agent-dive/sandbox:dev packages/sandbox/image

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

A running plane listens on a unix socket in its state directory. That is the whole control surface:

```sh
agent                                    the console: every agent, its turns and its logs
agent chat demo                          talk to one in the scrollback, turn after turn
agent chat maxi                          a name nothing answers to: it offers to make one
agent ls                                 what each agent is and whether it is up
agent wake "check the open issues"       take one turn, and wait for the answer
agent logs                               follow what every agent runs, answers and spends
agent rm demo [--purge]                  take the sandbox away, and with --purge the repository
agent help                               the rest
```

`agent` on its own opens the console, because someone typing the command with nothing after it is
asking to see the thing, not to be told a fact about it:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ demo   chat · logs · setup   deepseek-v4-flash   $0.42 / $5.00 │
│                      ││                                                                │
│ ● demo         $0.42 ││ > que es un webhook                                            │
│ ◐ maxi     15m $4.80 ││                                                                │
│ ○ scout              ││ Un webhook es una forma de comunicación automática entre       │
│                      ││ servicios: cuando ocurre un evento en un sistema, ese          │
│ + new agent          ││ sistema envía una petición HTTP a una URL configurada.         │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ >                                                          │ │
│                      ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ agent   ^U^D scroll   tab logs   / commands   ! shell   ^C quit
```

The column on the left is every agent the plane has, `●` up, `○` stopped, `◐` mid-turn — thinking
gets a mark of its own because with several agents on screen it is the one thing you cannot find
out by asking again in a second. The one the keyboard is on is its name in the colour the panel
title gives the same name, and not an arrow in a gutter beside the marks: a column whose header
stands against the border and whose rows all begin two further in reads as a list indented under a
title it does not belong to. `↑↓` moves between them and `tab` cycles the panel through that
agent's conversation, the log feed — the same feed `agent logs` prints, running the whole time
either way — and the setup screen, which is about the plane rather than about the agent behind
it. The prompt shows the spinner and the seconds while that agent is thinking,
because a spinner alone says something is happening and the number rising beside it is what says
whether it still is.

Under the last agent is the row that makes one, reached with the same `↑↓` as any of them. It is a
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

`esc` stops the turn the selected agent is taking, and is offered in the row only while there is one
to stop, since a hint for a key that does nothing is a hint that lies. What stops is the process
inside the container, killed rather than disconnected from: letting go of the pipe takes the output
away from us and leaves a model thinking on the other side of it, going on being paid for after
somebody has been told it stopped. What it had already written stays in the conversation with
`stopped` under it, it is not taken again — an interrupted turn comes back, which is what whoever
pressed the key was preventing — and it does not get to book the turn after it either.

The wheel scrolls the panel, and `^U` and `^D` move it half a pane the way they do in `less`. The
console asks the terminal for the wheel because it has to: the scrollback belongs to the terminal
and holds the frames this printed rather than the conversation, so a wheel the terminal keeps for
itself scrolls away from a live console into pictures of an older one. The keys that would have
meant this without a chord — shift with the arrows, the page keys — are the ones the terminal takes
for that same scrollback before they are ever ours. While the mouse is being reported, selecting
text needs the modifier your terminal reserves for it: ⌥ in iTerm2, fn in Terminal.app.

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
 ▸ /limit [<amount>|off]        what it has spent today, and the ceiling for it
   /model [<name>]              what it thinks with, and what else there is
   /mcp [<name>|add …|login …]  the MCP servers it has, and the shelf to add from
   /delete                      delete this agent, after asking whether you meant it
   /help                        every command there is
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
turn nobody at a keyboard started appears there too — a schedule coming due, a webhook arriving, an
agent waking itself — with a mark saying where it came from:

```
> ¿cómo va la cola?
cuatro issues abiertos, ninguno bloqueado.
‹wake› volver a chequear la cola
sigue igual.
‹webhook:github› the nightly build failed on main
```

The mark is there because the pane gets read back to work out who asked for what, and a line from a
stranger with a URL drawn the same way as the operator's is the one bug in a chat window that
matters. Only what arrives on the control socket is drawn as the operator; everything else is named
for the channel it came in on. A turn that failed says so in the same place, in red, rather than
only in a log nobody has open.

The console needs a terminal it can take over and a plane to open on. Missing either — a pipe, a CI
job, no plane running — it prints what `agent` used to print: where the state is and what is in it.
So `agent | grep` keeps working and nothing has to know which case it is in.

The name is needed only when there is a choice to make: a
plane running one agent already knows which one is meant. So `agent wake "check the open issues"`
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
18:12:53  maxi      answer      El test esperaba el mensaje viejo.
18:12:53  maxi      spent       1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12
```

Model round-trips that worked are counted rather than printed, and the count arrives with the turn
that made them: one identical `allowed POST api.deepseek.com` per request is what the lines that
matter used to be buried in. A request that was denied, or came back 401 or 429, is said the moment
it happens, because it is the reason the agent is about to misbehave.

Told nothing, it looks for the plane that is running rather than the one that would be there in a
deployment: planes label their container with the directory they serve, so `agent` in a checkout
finds the demo instead of reporting that `/var/lib/agent-dive` is empty.

Each takes `--state <dir>`, or reads `AGENT_DIVE_STATE`, defaulting to `/var/lib/agent-dive`. The
state directory is bind-mounted at the same path on the host, so these run outside the container
against the plane inside it. Where Docker runs in a VM — Docker Desktop, so every Mac — the shared
directory shows the socket but will not carry a connection through it, and the CLI reaches the same
socket from inside the container it labels `agent-dive.state=<dir>`. Either way it is one control
surface, and `docker compose exec control-plane agent` is the same command from the other side.

From a checkout, `pnpm link --global` in `packages/control-plane` puts `agent` on the path;
`node packages/control-plane/bin/agent.mjs` is the same command without installing anything.

There is no password because there is nothing to authenticate: the socket is `0600`, and reaching
it already means holding a file the operator owns. That is also why this socket is the only way
into the system that carries operator trust. The same sentence arriving by webhook is data the
agent may read; typed here it is an instruction the agent may follow.

The answer is printed as it is written, not when the turn is over, and its markdown is rendered:
bold is bold, a bullet is a bullet, a fenced block is dimmed and left exactly as typed. Nothing is
shown until it can be shown right — an unclosed `**` is held back rather than printed and taken
back — so words appear a fraction behind the agent instead of a paragraph behind it. Redirected
into a file or piped into another program, the output is the markdown itself, untouched.

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
  -H "x-agent-dive-timestamp: $TS" \
  -H "x-agent-dive-signature: $SIG" \
  -d "$BODY"
```

The signature covers `${timestamp}.${body}` and is compared in constant time within a freshness
window. An unknown hook id answers exactly like a bad signature, and only after the body has been
read, so the endpoint does not enumerate.

Events queue per agent and are folded into a single turn, so an agent woken twenty times while busy
takes one turn about twenty things. A turn that fails leaves its events queued rather than
acknowledging them, so a bad API key costs a retry instead of the message.

## An agent waking itself

Work that does not finish in one sitting used to end with the turn. An agent has a `wake_me` tool
now — a pi extension shipped in the sandbox image, so it is the plane's to fix rather than the
agent's to edit — that asks for another turn and leaves itself a note to be told then:

```
00:12:36  demo   wake_me   {"afterSeconds":180,"note":"Volver a chequear si example.com sigue
                            arriba. Primera verificación: HTTP 200 a las 00:12."}
00:15:38  demo   bash      curl -sS -o /dev/null -w "HTTP %{http_code}" -m 15 https://example.com
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
it is, and changes nothing at all about what the agent can get to. Adding one is the setup screen's,
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
instead of a working plane. The setup screen is where the answer is to paste one in.

## The keys the plane pays with

A model is three lines of configuration and one exported variable, and the variable is the half that
is not in the file — so it is the half that gets forgotten. The failure that produces is a plane that
is running and configured and refused at the proxy, with turns dying over a host nobody typed. `tab`
to the setup screen and both halves are a list:

```
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ demo   chat · logs · setup                       $0.42 / $5.00 │
│                      ││                                                                │
│ ● demo         $0.42 ││                                                                │
│ ○ scout              ││ holds from the next turn — nothing restarts.                   │
│                      ││                                                                │
│ + new agent          ││ providers                                                      │
│                      ││ ● deepseek   DEEPSEEK_API_KEY   flash                          │
│                      ││ ○ anthropic  ANTHROPIC_API_KEY  sonnet                         │
│                      ││ ○ openai     OPENAI_API_KEY     gpt-5                          │
│                      ││ ○ groq       GROQ_API_KEY       no models                      │
│                      ││                                                                │
│                      ││ models                                                         │
│                      ││ ● flash   deepseek   from the file                             │
│                      ││ ○ sonnet  anthropic  from the file                             │
│                      ││ ○ gpt-5   openai     added here                                │
│                      ││ + a model                                                      │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ ANTHROPIC_API_KEY   no key, refused at the proxy           │ │
│                      ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ move   ⏎ set key   tab chat   ^C quit
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
│ agents               ││ demo   chat · logs · setup                       $0.42 / $5.00 │
│                      ││                                                                │
│ ● demo         $0.42 ││                                                                │
│ ○ scout              ││ 3 on offer                                                     │
│                      ││ › gpt-5-mini   openai                                          │
│ + new agent          ││   gpt-4o-mini  openai                                          │
│                      ││   o4-mini      openai                                          │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ model  openai mini                                         │ │
│                      ││ ╰────────────────────────────────────────────────────────────╯ │
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

## An agent searching the web

Searching is something the agent asks for rather than something it does, and that is the sandbox
showing through rather than a preference. Every host an agent reaches is a grant somebody wrote, and
"the pages a search will turn up" is not a list anybody can write in advance — so an agent that
fetched what it found would need the whole internet granted, which is the same as granting nothing
at all and meaning it.

So the searching and the reading happen on the far side of one granted host. The `web_search` tool
is a pi extension shipped in the sandbox image, like `wake_me`, and it posts the question to a
hosted search that reads the pages itself and answers in prose with its sources linked in:

```yaml
- id: search
  host: api.openai.com
  pathPrefix: /v1/responses
  methods: [POST]
  injection:
    kind: bearer
    token: { ref: OPENAI_API_KEY }
```

The path scope is the part worth keeping. The same key against the rest of that API is a second
model to think with, bought by whoever takes the agent over, and a grant that only opens the
endpoint which searches is one that cannot be spent on anything else.

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
away stops being offered. A server that will not answer costs the agent that server's tools and
says so on stderr; it does not cost the turn.

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
how it went pairs the request with `wake_me` and finds the server attached on its next turn.

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
between configured models and being held to a tighter ceiling widen nothing. Deleting itself, raising
or removing its ceiling, logging a server out, forgetting one for every agent: those stay with the
operator. So does pasting back an address of its own — the trip home from a consent screen is the
person's, or the screen was never in it.

A refusal is not a dead end. It prints the line the operator would have typed:

```
‹ask› /limit 50
This agent asked for a ceiling of $50.00 a day, which is above the $5.00 it has. It can ask to
be held to less, never to more: /limit $50.00, if you meant it.
```

That is the point rather than the consolation. The operator finds out the command exists by being
handed it, at the moment it is the answer, in the pane they were already looking at.

## Development

```sh
pnpm install
pnpm test        # integration tests skip themselves when Docker is not available
pnpm typecheck
```

Node runs the TypeScript directly. There is no build step, and `typecheck` is what a build would
have caught.

Some tests need live Docker and the `agent-dive/sandbox:dev` image; the deployment test also needs
`agent-dive/control-plane:dev` (`docker build -f deploy/Dockerfile -t agent-dive/control-plane:dev .`).
They skip rather than fail when those are missing.

## What is deliberately missing

**A long-lived pi session.** Each wakeup currently runs `pi --print` against a per-agent session
directory on the agent's volume, so context carries across turns but the process does not. The
plumbing for a persistent session is written and tested — `PiSessionChannel` runs a socket server
inside the sandbox and relays it out over a Docker exec stream — and it is unused, because pi
0.84.2 has no server entry point to run: `pi experimental server` exists only on pi's main branch,
and the published `@earendil-works/pi-server` ships no production `PiServerService`. It gets wired
up when that lands upstream.

**Channels other than webhooks.** The `Channel` interface and router are there and a reply is
routed by the channel prefix of the event that caused it, so an agent answering a GitHub hook
cannot be steered into replying in Slack by anything in the payload. Slack, email and the rest are
adapters that do not exist yet.

**Anything multi-tenant.** One config file, one operator, one machine.

## License

MIT
