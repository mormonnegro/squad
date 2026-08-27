#!/bin/sh
#
# Puts a plane on a machine that has nothing on it yet:
#
#   curl -fsSL https://raw.githubusercontent.com/agent-dive/agent-dive/main/deploy/install.sh | sh
#
# Installs Docker if there is none, puts the repository in /opt/agent-dive, asks for the keys the
# proxy will hold, writes a config that already works, starts the plane, and leaves `agent` on the
# PATH so the machine is driven by typing its name.
#
# This is the server half, and it does not know which machine it landed on: a VPS reached over SSH
# and the laptop the operator is sitting at run the same script. What differs is where things go,
# and that is three variables — AGENT_DIVE_DIR, AGENT_DIVE_STATE, and AGENT_DIVE_SHIM for whether
# to take the name `agent` on this PATH. The client passes them when the plane is going to live
# alongside it; a server takes the defaults.
#
# Everything it asks is read from /dev/tty, not stdin: arriving down a pipe, stdin is this script.
# With no terminal at all it takes the keys from the environment and goes on without the ones that
# are not there, because an unattended install that blocks on a question is an install that hangs.
#
# Run it again to update. The repository is pulled, the images rebuilt and the plane swapped in,
# and .env and config.yaml are left exactly as they are — the second run is the one that would
# quietly undo a grant somebody added.
#
set -eu

DIR=${AGENT_DIVE_DIR:-/opt/agent-dive}
REPO=${AGENT_DIVE_REPO:-https://github.com/agent-dive/agent-dive.git}
BRANCH=${AGENT_DIVE_BRANCH:-main}
# Mounted into the plane at its own name, so this path means the same thing on both sides of the
# daemon. /var/lib is right for a server and wrong for a laptop: Docker Desktop shares /Users and
# not that, so a state directory there is a bind mount the daemon resolves inside its own VM.
STATE=${AGENT_DIVE_STATE:-/var/lib/agent-dive}
# Whether to leave `agent` on this machine's PATH. On a server it is how the machine is driven, and
# it is the door a console elsewhere comes through. On the computer the operator sits at, `agent` is
# already the client that ran this, and a shim written over it would take the console away from the
# thing that opened it.
SHIM=${AGENT_DIVE_SHIM:-yes}
# Whether there is anyone to ask. Piped into a VPS there is no terminal and this is already no; on
# the laptop the terminal is right there, and it belongs to the client that started this. That
# client has a setup screen for the keys, so it says no here — three secrets in the first minute is
# a worse first minute than an empty setup screen in the second one.
ASK=${AGENT_DIVE_ASK:-yes}

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# A build that worked is a progress bar nobody reads, and one that failed is the only thing on the
# screen worth having. So it is kept until it is needed, and then it is all there.
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
quietly() {
	"$@" >"$LOG" 2>&1 && return 0
	cat "$LOG" >&2
	return 1
}

# Opened rather than tested for. A container has a /dev/tty that stats like any other device and
# fails at open with ENXIO, so the readable ones and the usable ones are not the same set.
have_tty() { [ "$ASK" = yes ] && (true >/dev/tty) 2>/dev/null; }

# Asked on the terminal even when stdin is the script. Nothing is echoed back, because the two
# things this ever asks for are API keys and a VPS scrolls its terminal into a log somewhere.
ANSWER=
ask_secret() {
	ANSWER=
	have_tty || return 0
	printf '  %s' "$1" >/dev/tty
	stty -echo </dev/tty 2>/dev/null || true
	read -r ANSWER </dev/tty || ANSWER=
	stty echo </dev/tty 2>/dev/null || true
	printf '\n' >/dev/tty
}

# Default yes, and yes when there is no terminal to ask: the questions guarded by this one are
# about installing what the thing needs to run at all.
ask_yes() {
	have_tty || return 0
	printf '  %s [Y/n] ' "$1" >/dev/tty
	read -r reply </dev/tty || reply=
	case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

# The nearest ancestor of a path that exists, which is the one that decides whether it can be made.
nearest() {
	found=$1
	while [ ! -e "$found" ] && [ "$found" != "/" ] && [ "$found" != "." ]; do
		found=$(dirname "$found")
	done
	printf '%s' "$found"
}

# Root for what the paths need, rather than for its own sake.
#
# On a server everything here is root's: /opt, /var/lib and the Docker socket. On a laptop, with the
# directories under $HOME and a Docker that answers to this user, none of it is — and a password
# prompt in front of an install that does not need one is a precondition invented for nothing.
SUDO=
if [ "$(id -u)" -ne 0 ] &&
	! { [ -w "$(nearest "$DIR")" ] && [ -w "$(nearest "$STATE")" ] && docker info >/dev/null 2>&1; }; then
	command -v sudo >/dev/null 2>&1 || die "Run this as root, or install sudo."
	SUDO=sudo
	sudo -v || die "Run this as root, or as a user sudo will let through."
fi

install_pkg() {
	if command -v apt-get >/dev/null 2>&1; then
		# Through `env`, because with $SUDO empty the assignment arrives as the result of an
		# expansion, and the shell looks for a command by that whole name rather than setting it.
		quietly $SUDO apt-get update -qq &&
			quietly $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
	elif command -v dnf >/dev/null 2>&1; then
		quietly $SUDO dnf install -y -q "$@"
	elif command -v yum >/dev/null 2>&1; then
		quietly $SUDO yum install -y -q "$@"
	elif command -v apk >/dev/null 2>&1; then
		quietly $SUDO apk add --quiet "$@"
	else
		die "No package manager I know. Install $* and run this again."
	fi || die "Could not install $*."
}

step "Checking what this machine already has"

for tool in curl git; do
	command -v "$tool" >/dev/null 2>&1 || { note "installing $tool"; install_pkg "$tool"; }
done
note "curl, git"

if ! $SUDO docker info >/dev/null 2>&1; then
	if command -v docker >/dev/null 2>&1; then
		die "Docker is installed but not running. Start it and run this again."
	fi
	ask_yes "Docker is not here. Install it from get.docker.com?" ||
		die "Nothing to run the agents in. Install Docker and run this again."
	note "installing Docker"
	curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
	$SUDO docker info >/dev/null 2>&1 || die "Docker installed but will not start."
fi
$SUDO docker compose version >/dev/null 2>&1 ||
	die "Docker has no compose plugin. Install docker-compose-plugin and run this again."
note "Docker, Compose"

if [ -d "$DIR/.git" ]; then
	step "Updating $DIR"
	$SUDO git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH"
	$SUDO git -C "$DIR" reset --quiet --hard "origin/$BRANCH"
else
	step "Fetching agent-dive into $DIR"
	$SUDO mkdir -p "$(dirname "$DIR")"
	$SUDO git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
note "$($SUDO git -C "$DIR" log -1 --format='%h  %s')"

# Asked before anything is built, because the build takes minutes and coming back to a question is
# how an install ends up half-done overnight.
if [ ! -f "$DIR/deploy/.env" ]; then
	step "The keys the proxy will hold"
	note "They go in $DIR/deploy/.env, which only root can read, and the agents never see them:"
	note "a request leaves a sandbox with no credential and is given one on its way out."
	note "Every one of these can be skipped and given later on the setup screen in \`agent\`."
	printf '\n'

	if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
		note "A DeepSeek key is what the agents think with. Without one everything still runs,"
		note "and turns fail at the model until a key is given."
		ask_secret "DeepSeek API key (enter to skip): "
		DEEPSEEK_API_KEY=$ANSWER
	fi
	if [ -z "${OPENAI_API_KEY:-}" ]; then
		printf '\n'
		note "An OpenAI key is how an agent searches the web, and what the gpt-5 model costs against."
		note "Optional: without it the search tool says so when it is used, which beats an agent"
		note "inventing the answer."
		ask_secret "OpenAI API key (enter to skip): "
		OPENAI_API_KEY=$ANSWER
	fi
	if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
		printf '\n'
		note "An Anthropic key is the other model the config starts with. Optional in the same way:"
		note "\`/model sonnet\` is refused at the proxy until this plane holds one."
		ask_secret "Anthropic API key (enter to skip): "
		ANTHROPIC_API_KEY=$ANSWER
	fi

	# Generated rather than asked. It is not an account anywhere — it is the shared secret a sender
	# signs webhooks with, and one nobody chose is one nobody reused.
	HOOK_SECRET=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')

	umask 077
	$SUDO tee "$DIR/deploy/.env" >/dev/null <<ENV
# Written by deploy/install.sh. The values behind the names in config.yaml: the file names them,
# this process holds them, and the agents are never given either.
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
# Verifies the signature on POST /hooks/ping, and signs replies back.
HOOK_SECRET=$HOOK_SECRET
# Where the state lives, which compose reads from here to know what to mount and what to label the
# plane with. It is also handed to the plane, so \`agent\` inside the container looks where the
# socket actually is rather than where a server would have put it.
AGENT_DIVE_STATE=$STATE
ENV
	$SUDO chmod 600 "$DIR/deploy/.env"
	umask 022
fi

# Never rewritten. Everything an agent is allowed to do is in here, so a re-run that regenerated it
# would be an update quietly taking capabilities away.
if [ ! -f "$DIR/deploy/config.yaml" ]; then
	step "What the agents may reach"
	# Two writes because only the first line of this file depends on the machine, and the rest is
	# full of backticks and dollars that an expanding heredoc would eat.
	$SUDO tee "$DIR/deploy/config.yaml" >/dev/null <<CONFIG
# Every capability an agent has is in this file. Nothing here is a secret — the tokens are named,
# not written — so commit it and review changes to it: a grant nobody noticed being added is the
# whole failure mode.
#
# deploy/config.example.yaml has the rest of what can go here, commented.

stateDir: $STATE
CONFIG
	$SUDO tee -a "$DIR/deploy/config.yaml" >/dev/null <<'YAML'

# Everything the agents here may think with. Naming a provider is the whole of configuring it:
# where it lives and what its key is called are facts about the provider, not decisions. The key
# itself is never here — it is read from that name in this plane's environment and written onto
# the request at the proxy, so no agent ever holds it.
#
# Every model on this list is reachable by every agent, which is what makes `/model` in the console
# a choice rather than a grant. A model whose key this plane does not hold is listed and refused at
# the proxy until it does: the setup screen in `agent` says which of these are waiting on one, and
# takes it.
#
# That screen adds models as well, and keeps them beside this file rather than in it. So this is
# where a model goes to survive a redeploy, and the console is where one goes to hold on the next
# turn — and what is written here the console will read and refuse to change.
models:
  - id: deepseek-v4-flash
    provider: deepseek

  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6

  - id: gpt-5
    provider: openai

# What every agent starts from, and the whole of what an agent made later at the keyboard is.
defaults:
  # One of the ids above. `/model` moves a single agent onto another without editing this file.
  model: deepseek-v4-flash

  # US dollars a day, counted across every turn and reset at midnight UTC. An agent can book its
  # own next turn, so this is what decides how much a loop costs before somebody notices. Here
  # rather than on one agent, so it also covers the ones made later, which are exactly the ones
  # nobody remembers to put a ceiling on.
  limitUsd: 5

  grants:
    # How an agent reaches the web at all: both the searching and the reading of what it finds
    # happen on the far side of this one host. Scoped to the endpoint that searches, because the
    # same key against the rest of that API is a second model to think with.
    - id: search
      host: api.openai.com
      pathPrefix: /v1/responses
      methods: [POST]
      injection:
        kind: bearer
        token: { ref: OPENAI_API_KEY }

agents:
  - id: scout
    # Only read the first time it boots, to write its soul.md. After that who it is belongs to the
    # agent's own repository and this line stops having an opinion.
    description: A first agent. Say what it should watch, and give it what it needs to.

# An HMAC-signed endpoint at POST /hooks/ping on port 8787.
hooks:
  - id: ping
    agentId: scout
    # The name of an environment variable, not the secret itself.
    secretEnv: HOOK_SECRET
    # A signature proves which system sent the request, never that a human meant what is inside
    # it, so operator trust is refused here.
    trust: participant
YAML
	note "wrote $DIR/deploy/config.yaml — one agent, a ceiling of \$5 a day"
fi

# Always, not "if the tag is missing". Both images copy the sources in, so an existing tag is not a
# current one, and an update that silently kept last month's code is worse than one that takes a
# minute. The layer cache makes it nearly free when nothing has changed.
step "Building"
note "the sandbox image, which is what an agent runs inside"
quietly $SUDO docker build -t agent-dive/sandbox:dev "$DIR/packages/sandbox/image" ||
	die "The sandbox image would not build."
note "the control plane"
$SUDO mkdir -p "$STATE"
cd "$DIR/deploy"
# Exported as well as written into .env, because an .env from an older install has no line for it
# and the mount it would fall back to is not the one this run just made.
quietly $SUDO env AGENT_DIVE_STATE="$STATE" docker compose up -d --build ||
	die "The control plane would not start."

# The reason the machine is driven by typing `agent`, and the door a console on another computer
# comes through: `ssh vps agent relay` lands here. The control surface is a unix socket inside the
# state directory and there is nothing to authenticate to, so reaching it is exactly holding a file
# root owns — which is what being on this machine already means.
#
# Skipped where the client that ran this is already the local `agent`. Writing over it there would
# leave a shim that reaches this plane by name in place of the command that knows about every plane
# the operator has.
if [ "$SHIM" = "yes" ]; then
	$SUDO tee /usr/local/bin/agent >/dev/null <<AGENT
#!/bin/sh
# Written by agent-dive's installer. The console, the log feed and every subcommand come through
# here; it is the same line you would otherwise type by hand.
cd "$DIR/deploy" || exit 1
# Decided here rather than baked in when this was written, because the operator who installed it
# and the ones who use it are not the same people, and a \`sudo\` nobody needs is a password
# prompt in front of a command typed twenty times a day. Asking the socket is asking the only
# question that matters, and it costs nothing.
[ -r /var/run/docker.sock ] || AS_ROOT=sudo
# Without a terminal there is nothing to allocate one for, and asking for one anyway is what makes
# \`ssh vps agent ls\` fail where \`ssh -t vps agent\` works. It is also what \`agent relay\` needs:
# a pty would rewrite the bytes of the protocol on their way past.
[ -t 0 ] || NO_TTY=-T
exec \${AS_ROOT:-} docker compose exec \${NO_TTY:-} control-plane agent "\$@"
AGENT
	$SUDO chmod 755 /usr/local/bin/agent
fi

step "Up"
$SUDO docker ps --filter label=com.docker.compose.project=agent-dive \
	--format '  {{.Names}}  {{.Status}}'

ADDR=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $3}')
[ -n "$ADDR" ] || ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ADDR" ] || ADDR=$(hostname 2>/dev/null || echo your-vps)

if [ "$SHIM" = "yes" ]; then
	step "Driving it"
	note "agent                    on this machine, the console"
	note "agent ls                 what each agent is and whether it is up"
	note "agent logs               what every agent runs, answers and spends"
	printf '\n'
	note "From your own computer, the console is a package and this machine is an answer it keeps:"
	note "  npm install -g agent-dive && agent"
	printf '\n'
	note "It asks where the plane should be and $(id -un)@$ADDR is the answer. Everything after"
	note "that travels the SSH connection you already have here, so there is nothing to open on"
	note "this machine and nothing new to log into."
fi

step "Where things are"
note "$DIR/deploy/config.yaml   what each agent may reach"
note "$DIR/deploy/.env          the keys, root-readable only"
note "$STATE   the state, and the socket the console speaks over"
printf '\n'
note "The config is read when the plane starts, so an edit takes hold on:"
note "  cd $DIR/deploy && docker compose restart control-plane"
printf '\n'
note "And this same command again, any time, is the update: it pulls, rebuilds and swaps the"
note "plane in, and never touches config.yaml or .env."
printf '\n'
