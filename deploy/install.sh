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

# What this deployment is called, and the first word of everything it makes: the compose project, the
# two networks, and every container and volume an agent gets. Two on one machine share nothing but
# the Docker daemon.
#
# `squad` unless somebody says otherwise, which is what every install before this called them — so
# running this again over an existing one renames nothing and takes nothing away.
NAME=${SQUAD_NAME:-squad}

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
VERBOSE=${SQUAD_VERBOSE:-}
for arg in "$@"; do
	case "$arg" in
	-v | --verbose) VERBOSE=1 ;;
	*) ;;
	esac
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() {
	if [ -z "$*" ]; then printf '\n'; else printf '  %s\n' "$*"; fi
}
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
SQUAD_WEB_ORIGINS=${SQUAD_WEB_ORIGINS:-$CONSOLE}
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

# Always, not "if the tag is missing". Both images copy the sources in, so an existing tag is not a
# current one, and an update that silently kept last month's code is worse than one that takes a
# minute. The layer cache makes it nearly free when nothing has changed.
step "Building"
note "the sandbox image, then the control plane"
aside "Always, rather than only when a tag is missing: both images copy the sources in, so an"
aside "existing tag is not a current one. The layer cache makes it nearly free when nothing moved."
quietly $DOCKER docker build -t squad/sandbox:dev "$DIR/packages/sandbox/image" ||
	die "The sandbox image would not build."
$SUDO mkdir -p "$STATE"
cd "$DIR/deploy"
# Exported as well as written into .env, because an .env from an older install has no line for it
# and the mount it would fall back to is not the one this run just made.
quietly $DOCKER env SQUAD_STATE="$STATE" docker compose up -d --build ||
	die "The control plane would not start."

# The reason the machine is driven by typing `squad`, and the door a console on another computer
# comes through: `ssh vps squad relay` lands here. The control surface is a unix socket inside the
# state directory and there is nothing to authenticate to, so reaching it is exactly holding a file
# root owns — which is what being on this machine already means.
#
# Skipped where the client that ran this is already the local `squad`. Writing over it there would
# leave a shim that reaches this plane by name in place of the command that knows about every plane
# the operator has.
# Written where it can be, and skipped out loud where it cannot.
#
# This is the console, and the console is no longer the way in — the address printed below is. So a
# directory this user cannot write is not a reason to stop, and it is certainly not a reason to put
# a password prompt in front of an install that had needed none: it is one line of output saying
# what was not done and how to do it. What would be wrong is failing here quietly, which is what
# `tee: Permission denied` in the middle of a build amounts to.
if [ "$SHIM" = "yes" ] && [ -z "$SUDO" ] && [ ! -w "$(nearest "$SHIM_AT")" ]; then
	step "Leaving \`squad\` off this machine's PATH"
	note "$(dirname "$SHIM_AT") is not yours to write, and nothing here needs it: the plane is up"
	note "and the address below drives it from a browser. To have the command as well:"
	note ""
	note "  sudo env SQUAD_NAME=$NAME sh $DIR/deploy/install.sh"
	# Said now so that everything printed after it is true. The closing sections describe a machine
	# driven by typing `squad`, and this is not one.
	SHIM=no
fi

if [ "$SHIM" = "yes" ]; then
	$SUDO tee "$SHIM_AT" >/dev/null <<SQUAD
#!/bin/sh
# Written by squad's installer. The console, the log feed and every subcommand come through
# here; it is the same line you would otherwise type by hand.
cd "$DIR/deploy" || exit 1
# Decided here rather than baked in when this was written, because the operator who installed it
# and the ones who use it are not the same people, and a \`sudo\` nobody needs is a password
# prompt in front of a command typed twenty times a day. Asking the socket is asking the only
# question that matters, and it costs nothing.
[ -r /var/run/docker.sock ] || AS_ROOT=sudo
# Without a terminal there is nothing to allocate one for, and asking for one anyway is what makes
# \`ssh vps squad ls\` fail where \`ssh -t vps squad\` works. It is also what \`squad relay\` needs:
# a pty would rewrite the bytes of the protocol on their way past.
[ -t 0 ] || NO_TTY=-T
exec \${AS_ROOT:-} docker compose exec \${NO_TTY:-} control-plane squad "\$@"
SQUAD
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
ADDR=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $3}')
[ -n "$ADDR" ] || ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ADDR" ] || ADDR=$(hostname 2>/dev/null || echo your-vps)

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
	if [ "$SHIM" = "yes" ]; then
		# Numbered, because they are done in order and the order is the whole instruction. What sent
		# somebody looking for a missing piece was a paragraph holding two commands and an address
		# that is only true after one of them has been run.
		note "1  from your own computer, forward the port:"
		note ""
		note "     ssh -N -L $WEB_PORT:127.0.0.1:$WEB_PORT $(id -un)@$ADDR"
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
	note "squad     drives the same plane from this machine"
	aside "squad ls    what each agent is and whether it is up"
	aside "squad logs  what every agent runs, answers and spends"
	aside ""
	aside "From your own computer the console is one line, and this machine is an answer it keeps:"
	aside "  curl -fsSL https://squad.mormon.garden/client.sh | sh"
	aside "  squad"
	aside "It asks where the plane should be and $(id -un)@$ADDR is the answer. Everything after"
	aside "that travels the SSH connection you already have, so there is nothing to open here and"
	aside "nothing new to log into."
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
