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

Build the sandbox image and start the control plane:

```sh
docker build -t agent-dive/sandbox:dev packages/sandbox/image

cd deploy
cp .env.example .env          # fill in the values
cp config.example.yaml config.yaml
docker compose up -d --build
```

`config.example.yaml` is the whole surface: agents, what each may reach, when each wakes up, which
webhooks exist, and — under `defaults` — what an agent made later starts from. No secret is in it — it names environment variables, and the process holds
the values. That is the point: the file describing what an agent can reach should be committable
and diffable, because a grant nobody noticed being added is the failure mode.

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
╭────────────────╮╭──────────────────────────────────────────────────────────────╮
│ agents         ││ demo   chat · logs                                           │
│ ● demo         ││ > que es un webhook                                          │
│ ◐ maxi         ││                                                              │
│ ○ scout        ││ Un webhook es una forma de comunicación automática entre     │
│                ││ servicios: cuando ocurre un evento en un sistema, ese sistema│
│                ││  envía una petición HTTP a una URL configurada de antemano.  │
│                ││                                                              │
│                ││ ╭──────────────────────────────────────────────────────────╮ │
│                ││ │ >                                                        │ │
│                ││ ╰──────────────────────────────────────────────────────────╯ │
╰────────────────╯╰──────────────────────────────────────────────────────────────╯
 ↑↓ agent   ^U^D scroll   tab logs   ^C quit
```

The column on the left is every agent the plane has, `●` up, `○` stopped, `◐` mid-turn — thinking
gets a mark of its own because with several agents on screen it is the one thing you cannot find
out by asking again in a second. `↑↓` moves between them and `tab` swaps the panel between that
agent's conversation and the log feed, which is the same feed `agent logs` prints and runs the
whole time either way. The prompt shows the spinner and the seconds while that agent is thinking,
because a spinner alone says something is happening and the number rising beside it is what says
whether it still is.

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
terminal tells them apart. Saying yes builds a container, scaffolds a repository and starts a
session, and the new agent may reach exactly what `defaults` in the config allows — nothing more,
because the one thing a keyboard may never do here is grant. A plane with no defaults makes an agent
that cannot reach the model, and says so at the moment it is made rather than mid-turn.

Created agents are written down in the state directory, since the config file is the operator's and
no plane may write it. That is also the only thing `--purge` can truly delete: a declared agent
comes back on the next start no matter what, and one made from the CLI has nowhere else to come back
from.

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
participant trust, never operator, however it asks. The note comes back fenced like anything else
the agent did not hear from its operator, introduced as the reminder it is rather than as an
instruction — the turn that wrote it may have been reading a stranger at the time.

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
