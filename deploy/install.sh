#!/bin/sh
#
# Puts a plane on a machine that has nothing on it yet:
#
#   curl -fsSL https://squad.mormon.garden/install.sh | sh
#
# Installs Docker if there is none, puts the repository in /opt/squad, writes a config that already
# works, starts the plane, and leaves `squad` on the PATH so the machine is driven by typing its
# name. It asks nothing: the keys a plane spends are given to it at a console while it runs.
#
# What it prints is what happened and the two moves that get somebody in. The rest — every path,
# every file it wrote, and what the build was doing for those minutes — is behind --verbose:
#
#   curl -fsSL https://squad.mormon.garden/install.sh | sh -s -- --verbose
#
# This is the server half, and it does not know which machine it landed on: a VPS reached over SSH
# and the laptop the operator is sitting at run the same script. What differs is where things go,
# and that is three variables — SQUAD_DIR, SQUAD_STATE, and SQUAD_SHIM for whether
# to take the name `squad` on this PATH. The client passes them when the plane is going to live
# alongside it; a server takes the defaults.
#
# The one thing it can ask — whether to install what is missing — is read from /dev/tty, not stdin:
# arriving down a pipe, stdin is this script. With no terminal it answers itself yes, because an
# unattended install that blocks on a question is an install that hangs.
#
# Run it again to update. The repository is pulled, the images rebuilt and the plane swapped in,
# and .env and config.yaml are left exactly as they are — the second run is the one that would
# quietly undo a grant somebody added.
#
set -eu

# Read before anything else, because everything below is derived from these and a flag that arrives
# after the ports have been worked out from the name is a flag that does nothing.
#
# Flags and not only variables because of how this is run. `SQUAD_NAME=casa curl … | sh` puts the
# variable on curl and not on the shell that reads this, so the install quietly goes somewhere other
# than where it was told — which is the kind of mistake that is invisible until there are two
# deployments and one of them is the wrong one. A flag survives the pipe.
ARG_NAME=
ARG_DOMAIN=
ARG_DOMAIN_GIVEN=
ARG_RELAY=
ARG_RELAY_GIVEN=
ARG_OPEN=
ARG_VERBOSE=
ARG_BUILD=
for arg in "$@"; do
	case "$arg" in
	-v | --verbose) ARG_VERBOSE=1 ;;
	--name=*) ARG_NAME=${arg#--name=} ;;
	--domain=*)
		ARG_DOMAIN=${arg#--domain=}
		ARG_DOMAIN_GIVEN=1
		;;
	--relay=*)
		ARG_RELAY=${arg#--relay=}
		ARG_RELAY_GIVEN=1
		;;
	--open) ARG_OPEN=yes ;;
	--open=*) ARG_OPEN=${arg#--open=} ;;
	--build) ARG_BUILD=yes ;;
	*) ;;
	esac
done

# What this deployment is called, and the first word of everything it makes: the compose project, the
# two networks, and every container and volume an agent gets. Two on one machine share nothing but
# the Docker daemon.
#
# `squad` unless somebody says otherwise, which is what every install before this called them — so
# running this again over an existing one renames nothing and takes nothing away.
NAME=${ARG_NAME:-${SQUAD_NAME:-squad}}

# Everything a second one has to move off, derived from the name rather than asked for separately: a
# person naming their second environment should not also have to pick three port numbers. The first
# one keeps the numbers it always had.
if [ "$NAME" = "squad" ]; then
	HOOK_PORT=${SQUAD_HOOK_PORT:-8787}
	OAUTH_PORT=${SQUAD_OAUTH_PORT:-8788}
	WEB_PORT=${SQUAD_WEB_PORT:-8789}
else
	# A stable number per name rather than the next free one, so a deployment answers where it
	# answered yesterday. Collisions between two names are possible and are said out loud below.
	OFFSET=$(printf '%s' "$NAME" | cksum | awk '{print ($1 % 60) * 10 + 100}')
	HOOK_PORT=${SQUAD_HOOK_PORT:-$((8787 + OFFSET))}
	OAUTH_PORT=${SQUAD_OAUTH_PORT:-$((8788 + OFFSET))}
	WEB_PORT=${SQUAD_WEB_PORT:-$((8789 + OFFSET))}
fi

# Where this lands, which is a different answer on a laptop than on a server.
#
# A Mac is not a smaller server. /opt and /var/lib both want root, so the install asks for a password
# it does not need — and worse, Docker Desktop shares /Users and a short list of others with the VM
# and does not share /var/lib at all, so a state directory there is a bind mount the daemon cannot
# resolve and a plane that starts and finds nothing. Under $HOME both problems are the same problem
# and neither exists.
case "$(uname -s)" in
Darwin)
	DIR=${SQUAD_DIR:-$HOME/.squad/$NAME/app}
	STATE=${SQUAD_STATE:-$HOME/.squad/$NAME/state}
	;;
*)
	DIR=${SQUAD_DIR:-/opt/$NAME}
	STATE=${SQUAD_STATE:-/var/lib/$NAME}
	;;
esac
REPO=${SQUAD_REPO:-https://github.com/mormonnegro/squad.git}
# Where the console this project publishes lives. A plane trusts it out of the box so that a fresh
# install can be driven from a browser without editing anything; SQUAD_WEB_ORIGINS overrides it.
CONSOLE=${SQUAD_CONSOLE:-https://squad.mormon.garden}
# The page itself, which the origin above is only the first half of. Separate because the origin is
# what the plane checks a request against and a check never sees a path, while this is a thing a
# person opens. A console hosted somewhere that serves it at the root overrides it.
CONSOLE_AT=${SQUAD_CONSOLE_AT:-$CONSOLE/app/}
BRANCH=${SQUAD_BRANCH:-main}
# Which published build to run, and where the published builds are.
#
# Pulling rather than building is the difference between an install that takes half a minute and one
# that takes several. Building here means a dependency tree and a bundler running on the target, and
# the target is often a $5 VPS with a gigabyte of memory — where it is not slow, it is killed, and
# it is killed in the middle of a build, which is the worst place for this to stop.
VERSION=${SQUAD_VERSION:-latest}
REGISTRY=${SQUAD_REGISTRY:-ghcr.io/mormonnegro}
IMAGE=${SQUAD_IMAGE:-$REGISTRY/squad:$VERSION}
SANDBOX_IMAGE=${SQUAD_SANDBOX_IMAGE:-$REGISTRY/squad-sandbox:$VERSION}
# Build anyway. For anyone working on the sources, and the automatic answer when no published image
# can be had — a registry that is down or a tag that does not exist yet is a reason to fall back, not
# a reason to stop.
BUILD=${ARG_BUILD:-${SQUAD_BUILD:-}}
# Whether the console answers on this machine's own address as well as on its loopback.
#
# A server with no name of its own has nothing to forward a port from, so loopback there means the
# console is reachable only by somebody already holding an SSH session — which is a real way in and
# a poor default, because it is the one that ends with a terminal left open forever. So on a server
# it answers on the address the machine has, and the install says plainly what that means: the token
# becomes the only thing between a stranger and these agents, and on http it crosses the internet
# where it can be read. The line that fixes that is printed directly underneath, and needs no domain.
#
# Not on a laptop. There the console is already here, the address is already reachable, and opening
# it would put the whole control surface on whatever wifi the machine is on — a change nobody asked
# for to solve a problem nobody has.
case "$(uname -s)" in
Darwin) OPEN_DEFAULT=no ;;
*) OPEN_DEFAULT=yes ;;
esac
OPEN=${ARG_OPEN:-${SQUAD_OPEN:-$OPEN_DEFAULT}}

# A rendezvous this plane meets a console at, if the operator wants one.
#
# The third way in, for a machine with neither a forwarded port nor a domain: the plane dials out and
# stays there, so nothing is published and a NAT is not in the way. What crosses it is sealed with a
# key derived from this plane's token, and the relay is handed only a room number derived one way
# from the same token — so it pairs two sockets and can read neither. Off unless asked for, because
# a plane that phoned somewhere by default would be one whose operator did not choose it.
if [ -n "$ARG_RELAY_GIVEN" ]; then
	RELAY=$ARG_RELAY
	RELAY_GIVEN=1
else
	RELAY=${SQUAD_RELAY:-}
	RELAY_GIVEN=${SQUAD_RELAY+1}
fi

# The name this plane answers to on the internet, if it has one. With it, the console is reached at
# https://that/ and nothing has to be forwarded; without it, the web port stays on this machine's
# loopback and the way in is an SSH forward. It is the whole difference between the two, and it is
# one flag.
# Whether this run was told, as opposed to what it was told. The two differ in exactly the case that
# matters: `--domain=` with nothing after it is how a plane gives its name back and goes to being
# reached over a forwarded port, and an empty value that means "not mentioned" cannot express that.
if [ -n "$ARG_DOMAIN_GIVEN" ]; then
	DOMAIN=$ARG_DOMAIN
	DOMAIN_GIVEN=1
else
	DOMAIN=${SQUAD_DOMAIN:-}
	DOMAIN_GIVEN=${SQUAD_DOMAIN+1}
fi
# Whether to leave `squad` on this machine's PATH. On a server it is how the machine is driven, and
# it is the door a console elsewhere comes through. On the computer the operator sits at, `squad` is
# already the client that ran this, and a shim written over it would take the console away from the
# thing that opened it.
SHIM=${SQUAD_SHIM:-yes}
# Named rather than written out twice: whether this can be installed and where it goes are the same
# fact, and two literals that have to agree are two literals that eventually do not.
SHIM_AT=${SQUAD_SHIM_AT:-/usr/local/bin/squad}
# Whether there is anyone to ask. Piped into a VPS there is no terminal and this is already no. What
# is left behind it is one question — whether to install what is missing — because a machine with no
# Docker cannot be told about it later, while everything else this needs can.
ASK=${SQUAD_ASK:-yes}

# Whether to print the half of this that is explanation rather than news.
#
# An install is read once, in the thirty seconds after it finishes, by somebody who wants to know
# whether it worked and what to do next. Every other true thing it could say — which file holds
# what, why a path is that path, what the build did — competes with those two, and the result was
# forty-five lines where the address you actually need sits somewhere in the middle. So it is one
# flag away instead, and the flag is printed at the end where somebody who wants it will look.
VERBOSE=${ARG_VERBOSE:-${SQUAD_VERBOSE:-}}
# Written after the loop rather than inside it, because a domain is the only thing here that changes
# what another variable means: a plane with a name of its own is reached at that name, so that name
# is a console allowed to drive it.
if [ -n "$DOMAIN" ]; then CONSOLE_AT="https://$DOMAIN/"; fi

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() {
	if [ -z "$*" ]; then printf '\n'; else printf '  %s\n' "$*"; fi
}
# For the one thing an install can find that is wrong and still finish. Red, because everything
# above it said something worked and this says the next thing will not.
warn() { printf '  \033[31m%s\033[0m\n' "$*"; }
# Dimmed as well as optional: where it does print, it is the background to the line above it and not
# a thing to be read in its own right.
aside() {
	[ -n "$VERBOSE" ] && printf '  \033[2m%s\033[0m\n' "$*"
	return 0
}
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# A build that worked is a progress bar nobody reads, and one that failed is the only thing on the
# screen worth having. So it is kept until it is needed, and then it is all there.
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
quietly() {
	# Unless it was asked for, in which case the reason to hold it back is gone: somebody watching a
	# build wants it while it happens, not collected and handed over once it is too late to read.
	if [ -n "$VERBOSE" ]; then "$@"; return $?; fi
	"$@" >"$LOG" 2>&1 && return 0
	cat "$LOG" >&2
	return 1
}

# Echoed, unlike the one this used to have. What it takes is a hostname, and a hostname typed blind
# is a hostname typed wrong.
TYPED=
ask_line() {
	TYPED=
	have_tty || return 0
	printf '  %s' "$1" >/dev/tty
	read -r TYPED </dev/tty || TYPED=
}

# Where a name actually points, asked of whatever this machine has to ask with.
#
# Three tools because there is not one a server is guaranteed to have: getent comes with glibc, dig
# and host come with packages somebody chose to install, and a machine with none of them gets no
# answer rather than a wrong one.
resolves_to() {
	if command -v getent >/dev/null 2>&1; then
		getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u
	elif command -v dig >/dev/null 2>&1; then
		dig +short A "$1" 2>/dev/null | grep -E '^[0-9]+\.'
	elif command -v host >/dev/null 2>&1; then
		host -t A "$1" 2>/dev/null | awk '/has address/ {print $NF}'
	fi
}

# Tried, rather than required. `quietly` prints what went wrong, which is right when nothing else
# can be done about it — and wrong when the caller already has an answer for failing. A registry with
# nothing published yet is not an error anybody needs to read.
silently() { "$@" >/dev/null 2>&1; }

# Opened rather than tested for. A container has a /dev/tty that stats like any other device and
# fails at open with ENXIO, so the readable ones and the usable ones are not the same set.
have_tty() { [ "$ASK" = yes ] && (true >/dev/tty) 2>/dev/null; }

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

# Docker is asked as whoever it already answers, which on a laptop is not root.
#
# Two questions, and this script used to ask them as one: /opt needs root, and Docker Desktop's
# socket does not. Handing Docker to root anyway breaks the build on a Mac — the credential helper
# is the login keychain, root has no key to it, and what comes back is `error getting credentials`
# against an image that needed no credentials at all.
DOCKER=$SUDO
if docker info >/dev/null 2>&1; then DOCKER=; fi

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

# Which machine this is, from the connection that carried the install where there is one and from the
# machine's own idea of itself where there is not. Worked out before anything else, because the
# question below is about this address, and a question that cannot name what it is asking about is
# one nobody can answer.
ADDR=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $3}')
[ -n "$ADDR" ] || ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ADDR" ] || ADDR=$(hostname 2>/dev/null || echo your-vps)

step "Checking this machine"

for tool in curl git; do
	command -v "$tool" >/dev/null 2>&1 || { note "installing $tool"; install_pkg "$tool"; }
done

if ! $DOCKER docker info >/dev/null 2>&1; then
	if command -v docker >/dev/null 2>&1; then
		die "Docker is installed but not running. Start it and run this again."
	fi
	ask_yes "Docker is not here. Install it from get.docker.com?" ||
		die "Nothing to run the agents in. Install Docker and run this again."
	note "installing Docker"
	curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
	$DOCKER docker info >/dev/null 2>&1 || die "Docker installed but will not start."
fi
$DOCKER docker compose version >/dev/null 2>&1 ||
	die "Docker has no compose plugin. Install docker-compose-plugin and run this again."
note "curl, git, Docker, Compose"
aside "$DIR — the code"
aside "$STATE — the state"
aside "ports $HOOK_PORT webhooks, $OAUTH_PORT logins coming back, $WEB_PORT the console"

if [ -d "$DIR/.git" ]; then
	step "Updating $DIR"
	# Pointed at $REPO first, because otherwise the two halves of this disagree: a fresh install
	# comes from wherever SQUAD_REPO says, and an existing one came from wherever it was cloned from
	# months ago. What that looked like was a re-run with SQUAD_REPO set that fetched the old place,
	# reported the old commit, and left somebody reading the same output wondering what they had
	# missed. Same value, both paths, so "where this comes from" is one answer.
	$SUDO git -C "$DIR" remote set-url origin "$REPO"
	$SUDO git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH"
	$SUDO git -C "$DIR" reset --quiet --hard "origin/$BRANCH"
else
	step "Fetching squad into $DIR"
	$SUDO mkdir -p "$(dirname "$DIR")"
	$SUDO git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
note "$($SUDO git -C "$DIR" log -1 --format='%h  %s')"

# What this machine already answered, read before anything asks it again.
#
# A re-run is the update, and an update that re-opens a settled question is one that asks the
# operator to defend a decision they made months ago — from a prompt whose default is to undo it.
# Read here rather than where it used to be, two hundred lines down and after the build, which was
# late enough that the question had already been asked.
if [ -f "$DIR/deploy/.env" ]; then
	[ -n "$DOMAIN_GIVEN" ] || DOMAIN=$($SUDO sed -n 's/^SQUAD_DOMAIN=//p' "$DIR/deploy/.env" | head -1)
	[ -n "$RELAY_GIVEN" ] || RELAY=$($SUDO sed -n 's/^SQUAD_RELAY=//p' "$DIR/deploy/.env" | head -1)
	[ -z "$DOMAIN" ] || CONSOLE_AT="https://$DOMAIN/"
fi

# Asked, and asked before anything is built.
#
# The keys were taken out of this install because a key is not a prerequisite: the plane accepts one
# while it runs, and the console has a screen for it. A name is the opposite kind of thing. It is not
# a secret, it decides what this machine is reachable at, and it cannot be handed over later from
# inside — the flag exists, but a flag nobody knows about is a default nobody chose. Left unasked,
# every server installed this way ends up serving its own control surface over http with the token
# in the clear, which is a decision made by silence.
#
# Only where there is somebody to ask. Piped into a machine with no terminal, or told not to, it
# keeps the behaviour it had, because an unattended install that blocks on a question is one that
# hangs.
if [ -z "$DOMAIN" ] && [ -z "$RELAY" ] && [ "$OPEN" = yes ] && have_tty; then
	step "Where this will be reached"
	note "Without a name it answers at http://$ADDR:$WEB_PORT, and the token that opens it"
	note "crosses the internet in the clear."
	note ""
	note "With one, a certificate is obtained and renewed here and nothing is in the clear."
	case "$ADDR" in
	[0-9]*.[0-9]*.[0-9]*.[0-9]*)
		note "Point a name you own at $ADDR, or use this one, which needs nothing registered:"
		note ""
		note "  $(printf '%s' "$ADDR" | tr '.' '-').sslip.io"
		;;
	*)
		note "Point a name you own at this machine and type it here."
		;;
	esac
	note ""
	ask_line "Domain (enter for none): "
	# Trimmed of what a paste brings with it: a scheme, a trailing slash, a path. All three are
	# things somebody hands over without thinking, and none of them is a hostname.
	DOMAIN=$(printf '%s' "$TYPED" | tr -d ' \t' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##')
	if [ -n "$DOMAIN" ]; then
		DOMAIN_GIVEN=1
		CONSOLE_AT="https://$DOMAIN/"
		note ""
		note "Make sure $DOMAIN resolves to $ADDR before this finishes, or the certificate"
		note "cannot be issued. Ports 80 and 443 have to be free and reachable here as well."
	fi
fi

# Written without asking anything, because nothing in it is this install's question. The ports come
# from the name, the secret is generated, and the keys belong to the console: a plane can be handed
# one while it runs, so stopping the install for three secrets buys nothing and costs the install.
# An empty key here is not a missing key, it is a key that has not been typed yet, and the screen
# that takes it is the first one the operator sees.
if [ ! -f "$DIR/deploy/.env" ]; then
	aside "wrote $DIR/deploy/.env — the ports, the name, the webhook secret and which"
	aside "consoles may drive this plane. Root-readable only. Never rewritten by a re-run."

	# Read from the environment when the environment has them, so `DEEPSEEK_API_KEY=… sh install.sh`
	# still works and a machine that exports its keys installs with them already in place. Never
	# prompted for: layered underneath whatever the console is later given, which wins because it is
	# the more recent answer to the same question.

	# The consoles allowed in: the one this project publishes, and this plane's own name where it
	# has one. Its own name matters because with a domain the page and the plane are one origin and
	# the check never comes up — until somebody opens the hosted console instead, which is exactly
	# the case having both is for.
	ORIGINS=$CONSOLE
	[ -z "$DOMAIN" ] || ORIGINS="$CONSOLE,https://$DOMAIN"

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
SQUAD_STATE=$STATE
# The name, read by compose to name the project and the networks and by the plane to name every
# container and volume. One value, two readers, so they cannot disagree.
SQUAD_NAME=$NAME
# Published on the same number inside the container and out, because these are written into things
# the plane hands out: a redirect URI, and the address it prints for its own console.
SQUAD_HOOK_PORT=$HOOK_PORT
SQUAD_OAUTH_PORT=$OAUTH_PORT
SQUAD_WEB_PORT=$WEB_PORT
# Which consoles hosted somewhere else may drive this plane from a browser. The one this project
# publishes is here by default so a fresh install is reachable from it; anything else is the
# operator's to add, and an empty value means only the console this plane serves itself.
SQUAD_WEB_ORIGINS=${SQUAD_WEB_ORIGINS:-$ORIGINS}
ENV
	$SUDO chmod 600 "$DIR/deploy/.env"
	umask 022
fi

# Never rewritten. Everything an agent is allowed to do is in here, so a re-run that regenerated it
# would be an update quietly taking capabilities away.
if [ ! -f "$DIR/deploy/config.yaml" ]; then

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
# the proxy until it does: the setup screen in `squad` says which of these are waiting on one, and
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
	step "Writing a config that already works"
	note "one agent, a ceiling of \$5 a day"
	aside "$DIR/deploy/config.yaml — what each agent may reach, and the only place that says so."
	aside "Never rewritten by a re-run, so a grant added later is never quietly taken away."
fi

# Pulled if there is something to pull, and built if there is not.
#
# Both images copy the sources in, so a tag that exists is not a tag that is current — which is why
# the build path rebuilds every time rather than checking. Pulling has the same property for free:
# the registry's `latest` moves, and `docker pull` is how this machine finds out.
if [ -z "$BUILD" ]; then
	step "Fetching the images"
	aside "$IMAGE"
	aside "$SANDBOX_IMAGE"
	if silently $DOCKER docker pull -q "$SANDBOX_IMAGE" && silently $DOCKER docker pull -q "$IMAGE"; then
		note "pulled, nothing to build"
	else
		# Not a failure. A registry that is unreachable, a tag that does not exist yet, a fork that
		# publishes nothing — all of them mean the same thing here, which is that the sources are
		# right there and this machine can make them itself.
		note "nothing published to pull — building from the sources instead"
		BUILD=yes
	fi
fi

if [ -n "$BUILD" ]; then
	step "Building"
	note "the sandbox image, then the control plane"
	aside "Always, rather than only when a tag is missing: both images copy the sources in, so an"
	aside "existing tag is not a current one. The layer cache makes it nearly free when nothing moved."
	# Under the names compose is about to look for, so that what was built is what comes up.
	IMAGE=${SQUAD_IMAGE:-squad/control-plane:dev}
	SANDBOX_IMAGE=${SQUAD_SANDBOX_IMAGE:-squad/sandbox:dev}
	quietly $DOCKER docker build -t "$SANDBOX_IMAGE" "$DIR/packages/sandbox/image" ||
		die "The sandbox image would not build."
fi

$SUDO mkdir -p "$STATE"
cd "$DIR/deploy"

# Added to a file that is otherwise never rewritten. Nothing already in it is touched — an operator's
# edits, and the keys an older install was given, survive exactly as they are. What this covers is
# the case an install from before a setting existed: without it, a plane updated today would read a
# .env written last month and fall back to a default that is no longer what this run just set up.
ensure_env() {
	$SUDO grep -q "^$1=" .env 2>/dev/null && return 0
	printf '%s=%s\n' "$1" "$2" | $SUDO tee -a .env >/dev/null
}

# The one line here that is changed rather than only added, and only when this run was told to.
#
# A domain is not an operator's edit to be protected, it is what this install is: the difference
# between a plane behind a certificate and a plane behind a forwarded port. Leaving a stale value
# would mean a `docker compose up` by hand later disagreeing with the install that just ran, which
# is a proxy that stops coming up for no reason anybody can see.
set_env() {
	scratch=$(mktemp)
	$SUDO grep -v "^$1=" .env >"$scratch" 2>/dev/null || true
	printf '%s=%s\n' "$1" "$2" >>"$scratch"
	# `cp` over the file rather than `mv` onto it, so the mode it already has — 600, root's — is the
	# mode it keeps.
	$SUDO cp "$scratch" .env
	rm -f "$scratch"
}

# A plane behind its own name is reached through the proxy, so opening the port as well would be
# publishing the thing the proxy exists to stand in front of.
[ -z "$DOMAIN" ] || OPEN=no
BIND=127.0.0.1
[ "$OPEN" != yes ] || BIND=0.0.0.0
set_env SQUAD_WEB_BIND "$BIND"

# Both were settled above — by a flag, by the answer to the question, or by what the file already
# said. Written down here because here is where the file can be written to.
[ -z "$RELAY_GIVEN" ] || set_env SQUAD_RELAY "$RELAY"
if [ -n "$DOMAIN_GIVEN" ]; then
	set_env SQUAD_DOMAIN "$DOMAIN"
	[ -n "$DOMAIN" ] || note "the domain is given back — this plane goes back to loopback only"
fi

# Set rather than added, for the same reason the domain is: which image this plane runs is what this
# install did, not an operator's edit to be preserved. A run that pulled and a file that still names
# a locally built tag is a `docker compose up` by hand that quietly starts last month's code.
set_env SQUAD_IMAGE "$IMAGE"
set_env SQUAD_SANDBOX_IMAGE "$SANDBOX_IMAGE"
ensure_env SQUAD_DOMAIN "$DOMAIN"
ensure_env SQUAD_RELAY "$RELAY"

# The proxy is a service under a profile, so a machine with no domain never starts it and never
# takes port 80 waiting for a certificate that is not coming.
PROFILE=
if [ -n "$DOMAIN" ]; then
	PROFILE="--profile tls"
else
	# `up` only starts what its profiles name, and leaves everything else exactly as it found it — so
	# without this a proxy started last week keeps holding 80 and 443 forever, on a plane whose
	# certificate is gone.
	silently $DOCKER docker compose --profile tls rm -sf caddy
fi
# Exported as well as written into .env, because an .env from an older install has no line for it
# and the mount it would fall back to is not the one this run just made.
BUILD_TOO=
[ -z "$BUILD" ] || BUILD_TOO=--build
quietly $DOCKER env SQUAD_STATE="$STATE" SQUAD_IMAGE="$IMAGE" \
	SQUAD_SANDBOX_IMAGE="$SANDBOX_IMAGE" SQUAD_DOMAIN="$DOMAIN" SQUAD_RELAY="$RELAY" \
	SQUAD_WEB_BIND="$BIND" \
	docker compose $PROFILE up -d $BUILD_TOO ||
	die "The control plane would not start."

# The reason the machine is driven by typing `squad`, and the door a console on another computer
# comes through: `ssh vps squad relay` lands here. The control surface is a unix socket inside the
# state directory and there is nothing to authenticate to, so reaching it is exactly holding a file
# root owns — which is what being on this machine already means.
#
# Skipped where the client that ran this is already the local `squad`. Writing over it there would
# leave a shim that reaches this plane by name in place of the command that knows about every plane
# the operator has.
# Somewhere this user can write, rather than one place and a shrug.
#
# /usr/local/bin is the right answer on a server and the wrong one on a Mac, where it belongs to
# whoever installed Homebrew and this user is not root. Skipping it there was defensible while the
# command was only the terminal console — the address in a browser is the way in — and stopped being
# defensible the moment `squad` became how you find out what is running on this machine at all.
# Without it, the answer to "what have I got" is a pipeline into a shell, per deployment, every time.
#
# So: the named place if it can be written, and otherwise ~/.local/bin, which is this decade's answer
# to exactly this and is already on the PATH of most shells that ship with one.
if [ "$SHIM" = "yes" ] && [ -z "$SUDO" ] && [ ! -w "$(nearest "$SHIM_AT")" ]; then
	SHIM_AT=$HOME/.local/bin/squad
	mkdir -p "$(dirname "$SHIM_AT")"
	# Said where it is true, because a command installed somewhere the shell does not look is a
	# command that does not exist — and what that reads as is "it did not install".
	case ":$PATH:" in
	*":$(dirname "$SHIM_AT"):"*) ;;
	*) NOT_ON_PATH=$(dirname "$SHIM_AT") ;;
	esac
fi

if [ "$SHIM" = "yes" ]; then
	# Copied, not generated. It used to be a here-document with one deployment's directory baked into
	# it, which made `squad` mean whichever plane was installed last — and made a second install
	# quietly take the command away from the first. What goes here now knows about every plane on the
	# machine, because it asks Docker rather than having been told once.
	$SUDO cp "$DIR/deploy/squad.sh" "$SHIM_AT"
	$SUDO chmod 755 "$SHIM_AT"
fi

step "Up"
$DOCKER docker ps --filter "label=com.docker.compose.project=$NAME" \
	--format '{{.Names}}  {{.Status}}' | while IFS= read -r line; do note "$line"; done

# The line that connects this machine to a console, printed here because here is where somebody
# already is. A second command to fetch it would be a second thing to know about, and the whole of
# what it would print is two facts this script is holding right now.
#
# The token is written by the plane on the way up, and the way up is a container starting, so it is
# Which machine this is, from the connection that carried the install where there is one and from the
# machine's own idea of itself where there is not. Worked out here because the first line that needs
# it is the ssh below: it used to be derived further down, after that line had already been printed
# with an empty host, which is the one line on a server nobody can supply for themselves.
# A port to suggest when theirs is taken, which is the common case for anyone running a second
# plane: the first one already holds this number on their side of the tunnel. Ten thousand up rather
# than one digit prepended, which would go past 65535 and be no port at all.
ALT_PORT=$((WEB_PORT + 10000))

# waited for rather than assumed. A plane that never writes one is a plane that did not start, which
# the lines above have already said.
step "Getting in"
WAITED=0
while [ ! -f "$STATE/web.token" ] && [ "$WAITED" -lt 30 ]; do
	sleep 1
	WAITED=$((WAITED + 1))
done

if [ -f "$STATE/web.token" ]; then
	TOKEN=$($SUDO cat "$STATE/web.token" | tr -d ' \n\r')
	if [ -n "$RELAY" ]; then
		# The same code the console's own picker hands out, built here because here is where both
		# halves of it are: the rendezvous this plane dials, and the token that opens it. The relay is
		# never given the token, and this string never goes near the relay.
		CODE="squad_$(printf '{"o":"http://127.0.0.1:%s","t":"%s","r":"%s"}' "$WEB_PORT" "$TOKEN" "$RELAY" |
			base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
		note "Paste this into $CONSOLE_AT:"
		note ""
		note "     $CODE"
		note ""
		note "Nothing is published here and nothing has to be forwarded: this plane dials out to"
		note "$RELAY and meets a console there. What crosses it is sealed with a key"
		note "derived from the token above, which the relay is never given — it is handed a room"
		note "number instead, and pairing two sockets is all it can do with one."
		note ""
		note "That code is the key. Whoever holds it drives these agents, so it is pasted and not"
		note "posted."
	elif [ -n "$DOMAIN" ]; then
		# Nothing to forward and nothing to paste anywhere else: the plane is at a name, the name has
		# a certificate, and the address below is the whole of it. This is what a domain buys.
		note "Open this:"
		note ""
		note "     https://$DOMAIN/?t=$TOKEN"
		note ""
		# Checked rather than hoped for, because the way this fails is a page that blames the wrong
		# machine. A name behind a proxy answers on somebody else's address, so the challenge for the
		# certificate is sent there and never arrives here — and what the operator is shown is an
		# error naming this host, which is the one part that is working.
		POINTS=$(resolves_to "$DOMAIN" | tr '\n' ' ' | sed 's/ *$//')
		if [ -z "$POINTS" ]; then
			note "Nothing here could look $DOMAIN up, so this is unchecked. If it does not open, make"
			note "sure that name resolves to $ADDR."
		elif printf '%s' " $POINTS " | grep -q " $ADDR "; then
			note "$DOMAIN points here, so the certificate is obtained on the first request — give it"
			note "a few seconds."
		else
			warn "But $DOMAIN does not point at this machine. It resolves to:"
			note ""
			note "  $POINTS"
			note ""
			note "and this machine is $ADDR. Let's Encrypt sends its challenge to that address, so it"
			note "never arrives here and no certificate is issued. A browser then shows an error"
			note "naming this host, which is the one part that is working."
			note ""
			note "On Cloudflare that is the orange cloud: set the record to DNS only and it works"
			note "within the minute. Anywhere else it is a record pointing somewhere else."
		fi
		note ""
		note "That address is the key. Whoever holds it drives these agents, so it is pasted and"
		note "not posted."
	elif [ "$OPEN" = yes ]; then
		# The machine's own address, because that is what it is answering on. Dashes rather than dots
		# in the sslip.io name below: both forms resolve, and the dashed one is the one that works as
		# a single label under a wildcard certificate.
		note "Open this:"
		note ""
		note "     http://$ADDR:$WEB_PORT/?t=$TOKEN"
		note ""
		note "This machine is answering on its own address, so anyone who can reach it can knock."
		note "The token is what turns them away, and over http it crosses the internet in the clear."
		# Only where there is an address to build a name out of. Offered against a hostname it would
		# be a command that resolves to nothing, printed with the confidence of one that works.
		case "$ADDR" in
		[0-9]*.[0-9]*.[0-9]*.[0-9]*)
			note "One line puts a real certificate in front of it, with no domain to buy:"
			note ""
			note "     curl -fsSL $CONSOLE/install.sh | sh -s -- --domain=$(printf '%s' "$ADDR" | tr '.' '-').sslip.io"
			note ""
			note "sslip.io resolves any address-shaped name to that address, so Let's Encrypt issues"
			note "for it and nothing has to be registered. Its rate limit is shared with everyone"
			note "using it, so it can refuse — a name of your own never does."
			;;
		*)
			note "A domain in front of it is what fixes that: --domain=agents.example.com."
			;;
		esac
		note ""
		note "--open=no puts this back on loopback, reached by forwarding a port over SSH."
	elif [ -n "${SSH_CONNECTION:-}" ]; then
		# Whether the person reading this is at the machine, asked of the connection that carried them
		# here rather than of whether a command got installed.
		#
		# It used to key off the shim, which meant "a server" only for as long as installing the shim
		# was something that failed on a laptop. The moment the command started installing everywhere,
		# a Mac began printing an SSH forward to itself — the one machine where nothing needs
		# forwarding, since the address below is already on its loopback and the operator is sitting
		# in front of it.
		# Numbered, because they are done in order and the order is the whole instruction. What sent
		# somebody looking for a missing piece was a paragraph holding two commands and an address
		# that is only true after one of them has been run.
		# "Not on this one" out loud, because this is printed in a terminal on the server and the
		# thing in front of somebody reading it is a prompt on the server. The first person to meet
		# this pasted it where they were standing and got `Address already in use`, which is exactly
		# right — that port is taken here by the plane — and reads as the install being broken.
		note "1  on your own computer — not on this one — forward the port:"
		note ""
		note "     ssh -N -L $WEB_PORT:127.0.0.1:$WEB_PORT $(id -un)@$ADDR"
		note ""
		note "   Any free port on your side does: -L $ALT_PORT:127.0.0.1:$WEB_PORT if $WEB_PORT is"
		note "   taken there, and then say $ALT_PORT in the address below instead."
		note ""
		note "2  open $CONSOLE_AT and paste this:"
		note ""
		note "     http://127.0.0.1:$WEB_PORT/?t=$TOKEN"
		note ""
		# The question this output kept being asked, answered where it is asked: the address names a
		# loopback and the machine is at an address, and both of those are right.
		note "Nothing is published on this machine, which is why that address says 127.0.0.1"
		note "rather than $ADDR — after step 1, this machine is what answers there."
		note "It is the key as well, so paste it and do not post it."
	else
		note "Open this, or paste it into a console you host yourself:"
		note ""
		note "  http://127.0.0.1:$WEB_PORT/?t=$TOKEN"
		note ""
		note "That address is the key. Whoever holds it drives these agents, so it is pasted and"
		note "not posted."
	fi
	aside "It does not change when the plane restarts, and \`squad web\` prints it again."
else
	note "The plane has not written its web token yet. \`squad web\` prints it once it has."
fi

if [ "$SHIM" = "yes" ]; then
	printf '\n'
	note "squad            every plane on this machine, and the address that opens each"
	note "squad update     this again, later, without the pipeline"
	aside "squad open       that address, in a browser"
	aside "squad logs       what the plane itself is saying"
	aside "squad console    the console in a terminal, inside the plane"
	aside ""
	aside "From your own computer the console is one line, and this machine is an answer it keeps:"
	aside "  curl -fsSL https://squad.mormon.garden/client.sh | sh"
	aside "  squad"
	aside "It asks where the plane should be and $(id -un)@$ADDR is the answer. Everything after"
	aside "that travels the SSH connection you already have, so there is nothing to open here and"
	aside "nothing new to log into."
	# Where the shell will not find it, which is the same as not having installed it.
	if [ -n "${NOT_ON_PATH:-}" ]; then
		note ""
		note "$NOT_ON_PATH is not on your PATH, so add it and the command is there in every shell:"
		note ""
		note "  echo 'export PATH=\"$NOT_ON_PATH:\$PATH\"' >> ~/.zshrc && exec zsh"
	fi
fi

if [ -n "$VERBOSE" ]; then
	step "Where things are"
	note "$DIR/deploy/config.yaml   what each agent may reach"
	note "$DIR/deploy/.env          what the plane starts with, root-readable only"
	note "$STATE   the state, and the socket the console speaks over"
	printf '\n'
	note "The config is read when the plane starts, so an edit takes hold on:"
	note "  cd $DIR/deploy && docker compose restart control-plane"
	printf '\n'
	note "And this same command again, any time, is the update: it pulls, rebuilds and swaps the"
	note "plane in, and never touches config.yaml or .env. \`squad update\`, from the console on"
	note "your own computer, runs it here for you."
else
	# The last line, because somebody who wants more looks at the bottom. Written out whole rather
	# than as "pass --verbose", since the form it has to take through a pipe is not the obvious one.
	printf '\n'
	note "Everything this did, every path and the build itself:"
	note "  curl -fsSL $CONSOLE/install.sh | sh -s -- --verbose"
fi
printf '\n'
