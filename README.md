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
around.

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
export ANTHROPIC_API_KEY=...   # without it everything runs but the turn fails at the model
./deploy/demo.sh up
```

It builds what is missing, starts a control plane on a throwaway network, shows what the agent can
and cannot reach, asks the plane over its control socket, wakes the agent with a signed webhook and
prints the turn. `./deploy/demo.sh down`
removes everything. State lives under the working tree rather than `/var/lib`, which is the one way
it differs from the real deployment below.

## Running it

Build the sandbox image and start the control plane:

```sh
docker build -t agent-dive/sandbox:dev packages/sandbox/image

cd deploy
cp .env.example .env          # fill in the values
cp config.example.yaml config.yaml
docker compose up -d --build
```

`config.example.yaml` is the whole surface: agents, what each may reach, when each wakes up, and
which webhooks exist. No secret is in it — it names environment variables, and the process holds
the values. That is the point: the file describing what an agent can reach should be committable
and diffable, because a grant nobody noticed being added is the failure mode.

Two things in the deployment are load-bearing and easy to get wrong:

- The control plane runs **on the agents' network**, not on the host. Containers on an internal
  network cannot reach the host at all, so a proxy on the host is one the agents cannot use.
- The state directory is bind-mounted **at its own path**. The control plane hands the daemon that
  path when mounting the CA into a sandbox, and the daemon resolves bind sources on the host.

The control plane holds the Docker socket, so it is root-equivalent on the machine. The trust
boundary is the sandbox around the agent, not the process managing it.

## Driving it

A running plane listens on a unix socket in its state directory. That is the whole control surface:

```sh
agent-dive agents                             what each agent is and whether it is up
agent-dive wake demo "check the open issues"  take a turn, and wait for the answer
agent-dive logs                               follow turns and egress decisions live
```

Each takes `--state <dir>`, or reads `AGENT_DIVE_STATE`, defaulting to `/var/lib/agent-dive`. The
state directory is bind-mounted at the same path on the host, so these run outside the container
against the plane inside it. From a checkout, `node packages/control-plane/src/cli.ts` is the same
command.

There is no password because there is nothing to authenticate: the socket is `0600`, and reaching
it already means holding a file the operator owns. That is also why `wake` is the only way into the
system that carries operator trust. The same sentence arriving by webhook is data the agent may
read; typed here it is an instruction the agent may follow.

`wake` waits for the turn to finish, which is as long as the agent takes to think. It prints what
the agent said, and nothing if the agent chose to say nothing.

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
