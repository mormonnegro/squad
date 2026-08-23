#!/usr/bin/env bash
#
# Runs agent-dive end to end on this machine, on throwaway names, and wakes the agent with a signed
# webhook. Everything it creates is prefixed "agent-dive-demo" and removed by `demo.sh down`.
#
# This is not the deployment. deploy/compose.yaml is. The difference is that state lives under the
# working tree here, because /var/lib needs root and is not shared with Docker Desktop on macOS.
#
#   ./deploy/demo.sh up      build if needed, start, and send a wakeup
#   ./deploy/demo.sh logs    follow the control plane
#   ./deploy/demo.sh down    remove the containers, networks, volume and state
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
  docker rm -f "$PLANE" "$SANDBOX" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker network rm "$EGRESS" "$UPLINK" >/dev/null 2>&1 || true
  rm -rf "$STATE"
  say "removed the demo containers, networks, volume and $STATE"
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
agents:
  - id: $AGENT
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

  # Uplink first, then the agents' network. A published port is forwarded to the address the
  # container had on its first network, and an internal network drops anything that did not come
  # from inside it — so a plane that joins $EGRESS first has a webhook port nothing can reach.
  say "starting the control plane"
  docker run -d --name "$PLANE" \
    --network "$UPLINK" \
    --label "agent-dive.state=$STATE" \
    -e MODEL_KEY="${ANTHROPIC_API_KEY:-sk-ant-placeholder}" \
    -e HOOK_SECRET="$HOOK_SECRET" \
    -v "$STATE:$STATE" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -p 8787:8787 \
    agent-dive/control-plane:dev run "$STATE/config.yaml" >/dev/null
  docker network connect --alias egress "$EGRESS" "$PLANE"

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
  echo "  $cli ls --state $STATE"
  echo "      what each agent is and whether it is up"
  echo "  $cli logs --state $STATE"
  echo "      follow turns and egress decisions"
  echo "  ./deploy/demo.sh down"
  echo "      remove everything"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  logs) docker logs -f "$PLANE" ;;
  *) echo "usage: $0 [up|logs|down]" >&2; exit 1 ;;
esac
