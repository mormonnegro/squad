#!/bin/sh
#
# Every plane on this machine, and the things you do to one.
#
# Written because the alternative was a pipeline into a shell for each of them, every time, with the
# deployment's name spelled as a flag in a position that is easy to get wrong — and because an
# address with a key on the end of it is not something anybody should be asked to keep in a
# scrollback. What this is for is the two questions somebody actually has: what is running here, and
# how do I open it.
#
# It asks Docker rather than the filesystem. A running plane already says who it is — the compose
# project is its name, and the labels carry where its state and its directory are — so there is no
# convention here to drift from where things were actually put. A plane that is not running is a
# plane this cannot see, which is the honest answer to "what is running here".
set -eu

DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { if [ -z "$*" ]; then printf '\n'; else printf '  %s\n' "$*"; fi; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# The control planes, one per line: name, container, state directory, deploy directory.
planes() {
	$DOCKER ps -a \
		--filter "label=squad.state" \
		--format '{{.Label "com.docker.compose.project"}}	{{.Names}}	{{.Label "squad.state"}}	{{.Label "com.docker.compose.project.working_dir"}}	{{.State}}'
}

# Asked of the container rather than of a file, so that what this prints is what the plane is
# actually running under and not what somebody meant to write down.
env_of() {
	$DOCKER inspect "$1" --format "{{range .Config.Env}}{{println .}}{{end}}" 2>/dev/null |
		sed -n "s/^$2=//p" | head -1
}

# The address that opens it, which is the whole reason anybody runs this.
address_of() {
	container=$1
	state=$2
	port=$(env_of "$container" SQUAD_WEB_PORT)
	[ -n "$port" ] || port=8789
	domain=$(env_of "$container" SQUAD_DOMAIN)
	token=$(cat "$state/web.token" 2>/dev/null || sudo cat "$state/web.token" 2>/dev/null || true)
	if [ -z "$token" ]; then
		printf 'no token yet — the plane writes one as it comes up'
	elif [ -n "$domain" ]; then
		printf 'https://%s/?t=%s' "$domain" "$token"
	else
		printf 'http://127.0.0.1:%s/?t=%s' "$port" "$token"
	fi
}

list() {
	rows=$(planes)
	if [ -z "$rows" ]; then
		step "No planes on this machine"
		note "curl -fsSL https://squad.mormon.garden/install.sh | sh"
		note ""
		note "and --name=something for a second one, which shares nothing with the first."
		return 0
	fi
	step "Planes on this machine"
	# The name and the address, and nothing else. Counting an agent's containers was the obvious
	# thing to add and says nothing true: a plane makes one when a turn needs it and takes it away
	# when the image under it moves, so an idle plane with four agents shows none and looks empty.
	printf '%s\n' "$rows" | while IFS='	' read -r name container state dir running; do
		if [ "$running" != "running" ]; then
			note "$name — stopped.  squad start $name"
			continue
		fi
		note "$name"
		note "  $(address_of "$container" "$state")"
	done
	printf '\n'
	note "squad open <name>     in a browser        squad update [name]   pull and swap the plane"
	note "squad stop <name>     and squad start     squad console <name>  the console in a terminal"
}

# The plane to act on, put in the current shell rather than handed back.
#
# A substitution runs in a child, so a `die` inside one kills the child and leaves the parent holding
# an empty string — which it then complains about a second time, for a different reason, and the two
# messages between them describe nothing that happened. Everything this needs is a variable here.
PLANE_NAME= PLANE_CONTAINER= PLANE_STATE= PLANE_DIR=
pick() {
	PLANE_NAME=${1:-}
	if [ -z "$PLANE_NAME" ]; then
		names=$(planes | cut -f1)
		count=$(printf '%s\n' "$names" | grep -c . || true)
		# Naming it is the cost of having two. Not having to is the point of having one.
		[ "$count" = 1 ] ||
			die "There are $count planes here, so this needs a name. \`squad\` lists them."
		PLANE_NAME=$names
	fi
	row=$(planes | awk -F'\t' -v n="$PLANE_NAME" '$1 == n')
	[ -n "$row" ] || die "No plane here is called \"$PLANE_NAME\". \`squad\` lists the ones there are."
	PLANE_CONTAINER=$(printf '%s' "$row" | cut -f2)
	PLANE_STATE=$(printf '%s' "$row" | cut -f3)
	PLANE_DIR=$(printf '%s' "$row" | cut -f4)
}

case "${1:-}" in
"" | ls | list) list ;;
url)
	pick "${2:-}"
	printf '%s\n' "$(address_of "$PLANE_CONTAINER" "$PLANE_STATE")"
	;;
open)
	pick "${2:-}"
	at=$(address_of "$PLANE_CONTAINER" "$PLANE_STATE")
	case "$at" in
	http*)
		# Printed as well as opened, because a browser that did not come to the front leaves somebody
		# looking at a terminal that said nothing.
		note "$at"
		(open "$at" || xdg-open "$at") >/dev/null 2>&1 || true
		;;
	*) die "$at" ;;
	esac
	;;
update)
	if [ -n "${2:-}" ]; then
		pick "$2"
		rows=$(planes | awk -F'\t' -v n="$PLANE_NAME" '$1 == n')
	else
		rows=$(planes)
	fi
	[ -n "$rows" ] || die "Nothing here to update."
	printf '%s\n' "$rows" | while IFS='	' read -r name container state dir running; do
		# The installer that put it there, run again under its own name. It is the update: it fetches,
		# pulls, swaps the plane in, and leaves config.yaml and every key exactly as they are.
		if [ ! -f "$dir/install.sh" ]; then
			note "$name was not put here by the installer, so this cannot update it."
			continue
		fi
		step "Updating $name"
		sh "$dir/install.sh" --name="$name" </dev/null
	done
	;;
stop)
	pick "${2:-}"
	$DOCKER compose --project-directory "$PLANE_DIR" --profile tls stop
	note "$PLANE_NAME is stopped. squad start $PLANE_NAME brings it back."
	;;
start)
	pick "${2:-}"
	$DOCKER compose --project-directory "$PLANE_DIR" --profile tls start
	list
	;;
logs)
	pick "${2:-}"
	$DOCKER logs -f "$PLANE_CONTAINER"
	;;
console)
	pick "${2:-}"
	# The other console, the one in a terminal. Without a tty there is nothing to draw on, and asking
	# for one anyway is what makes this fail over ssh where `ssh -t` works.
	[ -t 0 ] || NO_TTY=-T
	$DOCKER compose --project-directory "$PLANE_DIR" exec ${NO_TTY:-} control-plane squad
	;;
-h | --help | help)
	step "squad"
	note "squad                 what is running on this machine, and the address that opens each"
	note "squad open [name]     that address, in a browser"
	note "squad url  [name]     that address, printed"
	note "squad update [name]   pull and swap the plane in; keeps config.yaml and every key"
	note "squad stop [name]     and squad start [name]"
	note "squad logs [name]     what the plane itself is saying"
	note "squad console [name]  the console in a terminal, inside the plane"
	printf '\n'
	note "The name can be left out wherever there is only one plane here."
	;;
*) die "No \`squad $1\`. \`squad help\` is the list." ;;
esac
