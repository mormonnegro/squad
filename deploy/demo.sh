#!/usr/bin/env bash
#
# Runs agent-dive end to end on this machine, on throwaway names, and wakes the agent with a signed
# webhook. Everything it creates is prefixed "agent-dive-demo" and removed by `demo.sh down`.
#
# This is not the deployment. deploy/compose.yaml is. The difference is that state lives under the
# working tree here, because /var/lib needs root and is not shared with Docker Desktop on macOS.
#
#   ./deploy/demo.sh up      build, start from nothing, and send a wakeup
#   ./deploy/demo.sh reload  rebuild the plane and swap it in, keeping the agent
#   ./deploy/demo.sh logs    follow the control plane
#   ./deploy/demo.sh down    remove the containers, networks, volume and state
#
# `up` starts from nothing, which means it deletes the agent's volume: its soul, memory, skills and
# tools. `reload` is the one to use after changing the code, and it keeps all of that.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
STATE="$ROOT/.demo"

AGENT=demo
PLANE=agent-dive-demo-plane
SANDBOX=agent-dive-$AGENT
VOLUME=agent-dive-$AGENT
EGRESS=agent-dive-demo-egress
UPLINK=agent-dive-demo-uplink
HOOK_SECRET=demo-secret-not-for-production

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

down() {
  # Whatever ended up on the demo's network, not only what this script started: `agent chat <name>`
  # makes agents nothing here ever named, and they are the demo's to clean up too.
  for made in $(docker ps -aq --filter "network=$EGRESS" 2>/dev/null); do
    local name
    name=$(docker inspect -f '{{.Name}}' "$made" 2>/dev/null | sed 's|^/||')
    docker rm -f "$made" >/dev/null 2>&1 || true
    [ -n "$name" ] && docker volume rm "$name" >/dev/null 2>&1 || true
  done
  docker rm -f "$PLANE" "$SANDBOX" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker network rm "$EGRESS" "$UPLINK" >/dev/null 2>&1 || true
  rm -rf "$STATE"
  say "removed the demo containers, networks, volume and $STATE"
}

# Uplink first, then the agents' network. A published port is forwarded to the address the container
# had on its first network, and an internal network drops anything that did not come from inside it
# — so a plane that joins $EGRESS first has a webhook port nothing can reach.
start_plane() {
  docker run -d --name "$PLANE" \
    --network "$UPLINK" \
    --label "agent-dive.state=$STATE" \
    -e MODEL_KEY="$1" \
    -e HOOK_SECRET="$HOOK_SECRET" \
    -v "$STATE:$STATE" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -p 8787:8787 \
    agent-dive/control-plane:dev run "$STATE/config.yaml" >/dev/null
  docker network connect --alias egress "$EGRESS" "$PLANE"
}

# Swaps in newly built control plane code without touching the agent.
#
# The sandbox keeps running throughout, which is only safe because the proxy token it was created
# with is written down in $STATE rather than invented on every start. Recreating the container is
# how the plane picks up new code at all: the image copies the sources in.
reload() {
  docker inspect "$PLANE" >/dev/null 2>&1 ||
    { echo "Nothing to reload. Start it with ./deploy/demo.sh up" >&2; exit 1; }

  say "rebuilding the control plane"
  docker build -q -f deploy/Dockerfile -t agent-dive/control-plane:dev . >/dev/null

  # Read back off the running container, so a reload never asks for the key again.
  local key
  key=$(docker inspect "$PLANE" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    sed -n 's/^MODEL_KEY=//p')

  docker rm -f "$PLANE" >/dev/null
  start_plane "${key:-sk-ant-placeholder}"

  say "the plane is new, the agent is the one you had"
  docker ps --filter "name=agent-dive-demo" --filter "name=$SANDBOX" --format '  {{.Names}}  {{.Status}}'
  docker exec "$SANDBOX" curl -s -o /dev/null -w '  api.anthropic.com (injected)  -> %{http_code}\n' \
    -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models || true
}

up() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }

  # Asked for here rather than required up front: the key is only needed at the model, and a demo
  # that stops to say "export this first" is a demo nobody gets to the end of.
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -t 0 ]; then
    say "an Anthropic API key"
    echo "Only the turn needs it. Everything else runs without one, and the wakeup stays queued."
    printf '  paste a key, or press enter to go on without it: '
    read -rs ANTHROPIC_API_KEY || true
    echo
  fi
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    say "no ANTHROPIC_API_KEY"
    echo "Everything will run, but the turn itself will fail at the model and the wakeup will stay"
    echo "queued for a retry."
  fi

  # Always, not "if missing". The image copies the sources in, so an existing tag is not a current
  # one, and a demo that silently runs last week's code is worse than one that takes a minute. The
  # layer cache makes this nearly free when nothing has changed.
  say "building the images"
  docker build -q -t agent-dive/sandbox:dev packages/sandbox/image
  docker build -q -f deploy/Dockerfile -t agent-dive/control-plane:dev .

  down >/dev/null 2>&1 || true
  mkdir -p "$STATE"

  # stateDir is an absolute host path and the control plane is mounted at that same path, because
  # the daemon resolves the CA bind source on the host when it creates the sandbox.
  cat > "$STATE/config.yaml" <<YAML
stateDir: $STATE
networkName: $EGRESS
# What every agent starts from, including one made later with \`agent chat <name>\`. Without a model
# grant here, an agent created at the keyboard would be born unable to think.
defaults:
  # Not the key. pi wants the variable set, and what it sends is discarded: the proxy strips the
  # agent's own x-api-key before writing the injected one, so this is the whole credential the
  # agent ever holds.
  env:
    ANTHROPIC_API_KEY: injected-by-the-proxy
  grants:
    - id: model
      host: api.anthropic.com
      injection:
        kind: header
        name: x-api-key
        value: { ref: MODEL_KEY }
agents:
  - id: $AGENT
    grants:
      - id: example
        host: example.com
        methods: [GET]
        injection: { kind: none }
hooks:
  - id: ping
    agentId: $AGENT
    secretEnv: HOOK_SECRET
    trust: participant
YAML

  # Internal means unrouted: the agent cannot reach the host or the internet from here, so the
  # proxy has to be on this network too. Uplink is how the control plane gets out.
  docker network create --internal "$EGRESS" >/dev/null
  docker network create "$UPLINK" >/dev/null

  say "starting the control plane"
  start_plane "${ANTHROPIC_API_KEY:-sk-ant-placeholder}"

  for _ in $(seq 60); do
    [ "$(docker inspect -f '{{.State.Running}}' "$SANDBOX" 2>/dev/null)" = "true" ] && break
    sleep 0.5
  done
  docker inspect -f '{{.State.Running}}' "$SANDBOX" >/dev/null 2>&1 ||
    { docker logs "$PLANE"; echo "the control plane never started the sandbox" >&2; exit 1; }

  say "the agent is up"
  docker ps --filter "name=agent-dive-demo" --filter "name=$SANDBOX" --format '  {{.Names}}  {{.Status}}'

  # From the host, over the control socket in $STATE, which the plane's container shares at the same
  # path. Where the share cannot carry a socket, the CLI finds the container by its label instead.
  say "asking the plane from outside the container"
  node packages/control-plane/bin/agent.mjs ls --state "$STATE" | sed 's/^/  /'

  say "what the agent can reach"
  docker exec "$SANDBOX" curl -s -o /dev/null -w '  example.com (granted)         -> %{http_code}\n' https://example.com/ || true
  # 200 here is the whole point: the request left the sandbox with no key in it, and the proxy put
  # one in. The agent cannot spend that key anywhere else, because nowhere else matches a grant.
  docker exec "$SANDBOX" curl -s -o /dev/null -w '  api.anthropic.com (injected)  -> %{http_code}\n' \
    -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models || true
  docker exec "$SANDBOX" curl -s -o /dev/null -w '  api.github.com (not granted)  -> %{http_code}\n' https://api.github.com/ 2>/dev/null ||
    echo '  api.github.com (not granted)  -> refused at CONNECT'

  local body ts sig
  body='{"text":"the nightly build failed on main"}'
  ts=$(date +%s)
  sig="sha256=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$HOOK_SECRET" -r | cut -d' ' -f1)"

  say "waking the agent with a signed webhook"
  curl -sS -w '  POST /hooks/ping -> %{http_code}\n' -o /dev/null \
    -X POST http://localhost:8787/hooks/ping \
    -H "x-agent-dive-timestamp: $ts" \
    -H "x-agent-dive-signature: $sig" \
    -d "$body"

  echo "  (an unsigned request should be refused:)"
  curl -sS -w '  POST /hooks/ping -> %{http_code}\n' -o /dev/null \
    -X POST http://localhost:8787/hooks/ping -d "$body"

  say "the turn"
  sleep 8
  docker logs "$PLANE" 2>&1 | tail -20

  say "next"
  local cli="node packages/control-plane/bin/agent.mjs"
  echo "  $cli chat $AGENT --state $STATE"
  echo "      talk to it, turn after turn"
  echo "  $cli chat maxi --state $STATE"
  echo "      a name no agent answers to: it offers to make one"
  echo "  $cli ls --state $STATE"
  echo "      what each agent is and whether it is up"
  echo "  $cli logs --state $STATE"
  echo "      follow turns and egress decisions"
  echo "  ./deploy/demo.sh reload"
  echo "      after changing the code, keeping this agent"
  echo "  ./deploy/demo.sh down"
  echo "      remove everything"
}

case "${1:-up}" in
  up) up ;;
  reload) reload ;;
  down) down ;;
  logs) docker logs -f "$PLANE" ;;
  *) echo "usage: $0 [up|reload|logs|down]" >&2; exit 1 ;;
esac
