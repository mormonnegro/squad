#!/bin/sh
#
# Starts something that outlives the turn that started it.
#
#   keep web npm run dev
#
# A command backgrounded with `&` inside a turn keeps the stdout it was born with, and that stdout
# is a pipe the turn owns. pi exits when the turn ends and the pipe loses its reader, so the first
# line the command writes after that is an EPIPE — which for Node is fatal. A dev server started
# that way survives exactly until somebody visits the page it logs, and what that looks like from
# outside is a link that worked once and then stopped, with nothing anywhere saying why.
#
# A session of its own and a file for its output is the whole of the fix. The log sits beside the
# project rather than in /tmp, because the turn that has to find out why something stopped is a
# later one than the turn that started it.
set -eu

if [ $# -lt 2 ]; then
	printf 'usage: keep <name> <command> [args...]\n\n  keep web npm run dev\n' >&2
	exit 2
fi

name=$1
shift

mkdir -p .keep
log=.keep/$name.log
# Appended rather than truncated: a server restarted after a crash would otherwise take the reason
# for the crash with it, and that reason is the only thing anybody wanted the log for.
setsid "$@" </dev/null >>"$log" 2>&1 &
pid=$!

# Read out of /proc rather than asked with `kill -0`, because this shell is the parent and a child
# that has already died is a zombie until it is waited on — and a zombie answers a signal check as
# alive. Reporting a pid for a command that was gone before this line is the failure mode worth a
# third of a second to rule out: any other way of finding out costs a whole turn.
sleep 0.3
if ! grep -qs '^State:[[:space:]]*[^Z]' "/proc/$pid/status"; then
	printf '%s exited immediately. Its last words:\n' "$name" >&2
	tail -n 20 "$log" >&2
	exit 1
fi

printf '%s is pid %s, writing to %s/%s\n' "$name" "$pid" "$(pwd)" "$log"
