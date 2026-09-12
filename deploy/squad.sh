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

# One keypress, as a number, so an arrow and a letter are the same kind of thing to compare against.
# An escape sequence is read to its end here rather than left in the buffer to arrive later as two
# stray letters.
keypress() {
	first=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d ' \n')
	if [ "$first" = 27 ]; then
		dd bs=1 count=1 >/dev/null 2>&1
		printf 'arrow-%s' "$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d ' \n')"
		return 0
	fi
	printf '%s' "$first"
}

# The menu.
#
# `squad` used to be the terminal console of whichever plane was installed last, which is a strange
# thing for the bare command to be once there is more than one plane and the way into each is a
# browser. What somebody has when they type it is a question — which of these, and what do I want to
# do with it — so what they get is the list, with the answer one key away.
#
# Drawn by rewriting the same block: the cursor goes back up as many lines as were printed, which is
# why the count is kept rather than guessed at.
DRAWN=0
draw_menu() {
	[ "$DRAWN" = 0 ] || printf '\033[%dA' "$DRAWN"
	lines=0
	printf '\033[2K\n'
	printf '\033[2K\033[1m  Planes on this machine\033[0m\n'
	printf '\033[2K\n'
	lines=$((lines + 3))
	i=0
	printf '%s\n' "$MENU_ROWS" | while IFS='	' read -r name container state dir running; do
		i=$((i + 1))
		printf '\033[2K'
		if [ "$i" = "$PICKED" ]; then printf '  \033[36m▸\033[0m '; else printf '    '; fi
		if [ "$running" != "running" ]; then
			printf '\033[1m%-14s\033[0m \033[2mstopped\033[0m\n' "$name"
		else
			printf '\033[1m%-14s\033[0m \033[2m%s\033[0m\n' "$name" "$(where_of "$container")"
		fi
	done
	lines=$((lines + MENU_COUNT))
	printf '\033[2K\n'
	printf '\033[2K'
	if [ "$PICKED" = "$((MENU_COUNT + 1))" ]; then printf '  \033[36m▸\033[0m '; else printf '    '; fi
	printf '+ a new environment\n'
	printf '\033[2K\n'
	printf '\033[2K\033[2m  ↑↓ move   ⏎ open in a browser   c console   u update   q quit\033[0m\n'
	DRAWN=$((lines + 4))
}

# Where a plane answers, without its key. The address with the key on it is a thing somebody asks
# for; a list of them is a screenful of credentials nobody asked to have on their screen.
where_of() {
	port=$(env_of "$1" SQUAD_WEB_PORT)
	[ -n "$port" ] || port=8789
	domain=$(env_of "$1" SQUAD_DOMAIN)
	if [ -n "$domain" ]; then printf 'https://%s' "$domain"; else printf '127.0.0.1:%s' "$port"; fi
}

menu() {
	MENU_ROWS=$(planes)
	if [ -z "$MENU_ROWS" ]; then
		list
		return 0
	fi
	# Without a terminal there is nothing to move a cursor around, and a menu drawn into a pipe is a
	# screenful of escape codes. The list is what this is when nobody is watching.
	if [ ! -t 0 ] || [ ! -t 1 ]; then
		list
		return 0
	fi

	MENU_COUNT=$(printf '%s\n' "$MENU_ROWS" | grep -c .)
	PICKED=1
	saved=$(stty -g 2>/dev/null || true)
	# Restored however this ends, including the ways that are not this function returning. A terminal
	# left in raw mode is a shell that no longer echoes what is typed into it.
	trap 'stty "$saved" 2>/dev/null || true; printf "\033[?25h\n"' EXIT INT TERM
	stty -echo -icanon min 1 time 0 2>/dev/null || true
	printf '\033[?25l'

	while :; do
		draw_menu
		key=$(keypress)
		case "$key" in
		arrow-65 | 107) PICKED=$((PICKED > 1 ? PICKED - 1 : MENU_COUNT + 1)) ;;
		arrow-66 | 106) PICKED=$((PICKED < MENU_COUNT + 1 ? PICKED + 1 : 1)) ;;
		113 | 3) chosen=quit; break ;;
		13 | 10) chosen=open; break ;;
		99) chosen=console; break ;;
		117) chosen=update; break ;;
		110) PICKED=$((MENU_COUNT + 1)); chosen=open; break ;;
		[1-9]) PICKED=$((key - 48)); [ "$PICKED" -le "$MENU_COUNT" ] || PICKED=$MENU_COUNT ;;
		*) ;;
		esac
	done

	stty "$saved" 2>/dev/null || true
	printf '\033[?25h'
	trap - EXIT INT TERM
	printf '\n'

	[ "$chosen" != quit ] || return 0
	if [ "$PICKED" = "$((MENU_COUNT + 1))" ]; then
		make_one
		return 0
	fi
	name=$(printf '%s\n' "$MENU_ROWS" | sed -n "${PICKED}p" | cut -f1)
	case "$chosen" in
	open) exec "$0" open "$name" ;;
	console) exec "$0" console "$name" ;;
	update) exec "$0" update "$name" ;;
	esac
}

# A second plane, which shares nothing with the first but the Docker daemon.
make_one() {
	step "A new environment"
	note "Its own containers, volumes, networks, state and agents, on ports derived from its name."
	note ""
	printf '  Name it: '
	read -r fresh || fresh=
	fresh=$(printf '%s' "$fresh" | tr -cd 'a-z0-9-')
	[ -n "$fresh" ] || die "A name is lowercase letters, digits and dashes."
	planes | cut -f1 | grep -qx "$fresh" && die "There is already a plane here called \"$fresh\"."
	step "Installing $fresh"
	# The installer this machine already has, which is the one that put every other plane here.
	any=$(planes | head -1 | cut -f4)
	if [ -n "$any" ] && [ -f "$any/install.sh" ]; then
		sh "$any/install.sh" --name="$fresh" </dev/tty
	else
		curl -fsSL https://squad.mormon.garden/install.sh | sh -s -- --name="$fresh"
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
"") menu ;;
ls | list) list ;;
new) make_one ;;
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
