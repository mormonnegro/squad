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
# Both names are the sandbox driver's to choose, and this script only echoes them: the container is
# `agent-dive-<id>` and the volume that holds the agent is that name with `-self` after it. They were
# assumed equal here once, so every `docker volume rm` was a no-op that `|| true` hid, and a `down`
# that said it had removed the agent had left it on disk.
VOLUME=$SANDBOX-self
EGRESS=agent-dive-demo-egress
UPLINK=agent-dive-demo-uplink
HOOK_SECRET=demo-secret-not-for-production

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# The proxy lives in the control plane, and both `up` and `reload` have just replaced it. Asking
# before it listens answers 000, and 000 as the last line a command prints reads as the thing having
# failed rather than as having been asked too early. An empty answer is the sandbox not being there
# yet, which is its own kind of early: the plane recreates one whose environment no longer matches.
wait_for_egress() {
  local code
  for _ in $(seq 60); do
    code=$(docker exec "$SANDBOX" curl -s -o /dev/null -w '%{http_code}' \
      https://api.deepseek.com/models 2>/dev/null || true)
    case "$code" in "" | 000) sleep 0.5 ;; *) return 0 ;; esac
  done
}

down() {
  # Whatever ended up on the demo's network, not only what this script started: `agent chat <name>`
  # makes agents nothing here ever named, and they are the demo's to clean up too.
  for made in $(docker ps -aq --filter "network=$EGRESS" 2>/dev/null); do
    local name
    name=$(docker inspect -f '{{.Name}}' "$made" 2>/dev/null | sed 's|^/||')
    docker rm -f "$made" >/dev/null 2>&1 || true
    [ -n "$name" ] && docker volume rm "$name-self" >/dev/null 2>&1 || true
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
  # A socket left behind by the plane this one replaces, which was killed and never got to clean up.
  # The plane unlinks it on its way up, but a directory shared into Docker Desktop's VM does not let
  # the container remove one, and the bind then fails with ENOTSUP against a path that looks free.
  # From the host it is an ordinary file, and the host is what is starting the plane.
  rm -f "$STATE/control.sock"

  docker run -d --name "$PLANE" \
    --network "$UPLINK" \
    --label "agent-dive.state=$STATE" \
    -e MODEL_KEY="$1" \
    -e SEARCH_KEY="$2" \
    -e HOOK_SECRET="$HOOK_SECRET" \
    -v "$STATE:$STATE" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -p 8787:8787 \
    agent-dive/control-plane:dev run "$STATE/config.yaml" >/dev/null
  docker network connect --alias egress "$EGRESS" "$PLANE"
}

# Written by `up` and again by `reload`, because the config is part of what a reload swaps in: an
# edit here that only took effect on `up` would be one you cannot try without destroying the agent.
#
# stateDir is an absolute host path and the control plane is mounted at that same path, because the
# daemon resolves the CA bind source on the host when it creates the sandbox.
write_config() {
  cat > "$STATE/config.yaml" <<YAML
stateDir: $STATE
networkName: $EGRESS
# What every agent starts from, including one made later with \`agent chat <name>\`. Without a model
# grant here, an agent created at the keyboard would be born unable to think.
defaults:
  provider: deepseek
  model: deepseek-v4-flash
  # Not the key. pi wants the variable set, and what it sends is discarded: the proxy strips the
  # agent's own Authorization before writing the injected one, so this is the whole credential the
  # agent ever holds.
  env:
    DEEPSEEK_API_KEY: injected-by-the-proxy
  grants:
    - id: model
      host: api.deepseek.com
      injection:
        kind: bearer
        token: { ref: MODEL_KEY }
    # The one host the agent reaches the web through, and the searching and page-reading both happen
    # on the far side of it — which is why this is a grant anyone can write and "let it browse" is
    # not. Scoped to the one endpoint that searches: the same key on the rest of that API would be a
    # second model to think with, bought by whoever takes the agent over.
    - id: search
      host: api.openai.com
      pathPrefix: /v1/responses
      methods: [POST]
      injection:
        kind: bearer
        token: { ref: SEARCH_KEY }
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
}

# Swaps in newly built control plane code without touching the agent.
#
# The sandbox keeps running throughout, which is only safe because the new plane reads the proxy
# token off the container it finds rather than deciding one. Recreating the container is how the
# plane picks up new code at all: the image copies the sources in.
reload() {
  docker inspect "$PLANE" >/dev/null 2>&1 ||
    { echo "Nothing to reload. Start it with ./deploy/demo.sh up" >&2; exit 1; }

  # Both images, because what the agent runs with lives in the sandbox one: the plane's own tools are
  # shipped in there, and a reload that rebuilt only the plane would leave every agent without them.
  # The new plane replaces a sandbox that is not running what the tag points at now.
  say "rebuilding the images"
  docker build -q -t agent-dive/sandbox:dev packages/sandbox/image >/dev/null
  docker build -q -f deploy/Dockerfile -t agent-dive/control-plane:dev . >/dev/null
  write_config

  # Read back off the running container, so a reload never asks for the key again. A key in the
  # environment wins, which is how the provider gets changed without going through `up` and losing
  # the agent: the old key would be offered to the new provider and refused as a bad credential.
  local env key search
  env=$(docker inspect "$PLANE" --format '{{range .Config.Env}}{{println .}}{{end}}')
  key=$(printf '%s\n' "$env" | sed -n 's/^MODEL_KEY=//p')
  search=$(printf '%s\n' "$env" | sed -n 's/^SEARCH_KEY=//p')

  docker rm -f "$PLANE" >/dev/null
  start_plane "${DEEPSEEK_API_KEY:-${key:-no-key-configured}}" \
    "${OPENAI_API_KEY:-${search:-no-key-configured}}"

  # Before listing them, so the list is what settled rather than what was mid-flight: an agent whose
  # environment the new config changed is replaced here, and its old container is still up until it is.
  wait_for_egress

  say "the plane is new, the agent is the one you had"
  docker ps --filter "name=agent-dive-demo" --filter "name=$SANDBOX" --format '  {{.Names}}  {{.Status}}'
  docker exec "$SANDBOX" curl -s -o /dev/null -w '  api.deepseek.com (injected)   -> %{http_code}\n' \
    https://api.deepseek.com/models || true
  probe_search
}

# Deliberately without the search tool: what this asks is whether the tunnel and the injected key
# work, and the answer to that costs a few tokens rather than the ten dollars a thousand searches do.
# 401 is a key the operator has to fix and 403 is the proxy, which are the two worth telling apart.
probe_search() {
  docker exec "$SANDBOX" curl -s -o /dev/null -w '  api.openai.com (injected)     -> %{http_code}\n' \
    https://api.openai.com/v1/responses -H 'Content-Type: application/json' \
    -d '{"model":"gpt-5-mini","input":"hi"}' || true
}

up() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }

  # Asked for here rather than required up front: the key is only needed at the model, and a demo
  # that stops to say "export this first" is a demo nobody gets to the end of.
  if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -t 0 ]; then
    say "a DeepSeek API key"
    echo "Only the turn needs it. Everything else runs without one, and the wakeup stays queued."
    printf '  paste a key, or press enter to go on without it: '
    read -rs DEEPSEEK_API_KEY || true
    echo
  fi
  if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
    say "no DEEPSEEK_API_KEY"
    echo "Everything will run, but the turn itself will fail at the model and the wakeup will stay"
    echo "queued for a retry."
  fi

  # The one the agent searches the web with, and the only reason it can: without it the tool is still
  # there and says at the moment of use that there is no key, which is a better answer than an agent
  # that quietly makes the answer up.
  if [ -z "${OPENAI_API_KEY:-}" ] && [ -t 0 ]; then
    say "an OpenAI API key, for searching the web"
    echo "Optional. Without it the agent runs and thinks, it just cannot look anything up."
    printf '  paste a key, or press enter to go on without it: '
    read -rs OPENAI_API_KEY || true
    echo
  fi

  # Always, not "if missing". The image copies the sources in, so an existing tag is not a current
  # one, and a demo that silently runs last week's code is worse than one that takes a minute. The
  # layer cache makes this nearly free when nothing has changed.
  say "building the images"
  docker build -q -t agent-dive/sandbox:dev packages/sandbox/image
  docker build -q -f deploy/Dockerfile -t agent-dive/control-plane:dev .

  down >/dev/null 2>&1 || true
  mkdir -p "$STATE"

  write_config

  # Internal means unrouted: the agent cannot reach the host or the internet from here, so the
  # proxy has to be on this network too. Uplink is how the control plane gets out.
  docker network create --internal "$EGRESS" >/dev/null
  docker network create "$UPLINK" >/dev/null

  say "starting the control plane"
  start_plane "${DEEPSEEK_API_KEY:-no-key-configured}" "${OPENAI_API_KEY:-no-key-configured}"

  for _ in $(seq 60); do
    [ "$(docker inspect -f '{{.State.Running}}' "$SANDBOX" 2>/dev/null)" = "true" ] && break
    sleep 0.5
  done
  docker inspect -f '{{.State.Running}}' "$SANDBOX" >/dev/null 2>&1 ||
    { docker logs "$PLANE"; echo "the control plane never started the sandbox" >&2; exit 1; }

  wait_for_egress

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
  docker exec "$SANDBOX" curl -s -o /dev/null -w '  api.deepseek.com (injected)   -> %{http_code}\n' \
    https://api.deepseek.com/models || true
  probe_search
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
