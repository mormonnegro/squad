#!/bin/sh
#
# Puts `agent` on the computer you drive from:
#
#   curl -fsSL https://raw.githubusercontent.com/agent-dive/agent-dive/main/deploy/connect.sh | sh
#
# The console itself stays on the machine the agents are on — this installs the connection to it
# under a name worth typing. The first `agent` asks which machine that is and remembers the answer,
# so every one after it is the console and nothing else.
#
# It authenticates with nothing of its own. SSH already decides who may touch that host, and
# touching that host is the whole of what reaching the control socket means, so a second password
# here would be a second thing to lose rather than a second thing to pass.
#
# Give it the address to skip the question, which is what the installer on the VPS prints:
#
#   curl -fsSL .../deploy/connect.sh | sh -s root@203.0.113.9
#
set -eu

TARGET=${1:-}
HOME_DIR=${AGENT_DIVE_HOME:-$HOME/.agent-dive}

command -v ssh >/dev/null 2>&1 || {
	printf 'This needs ssh, and there is none on the PATH.\n' >&2
	exit 1
}

# Somewhere already on the PATH, because a command that needs a line in .zshrc before it runs is a
# command the person installing it has to come back to. Ordered by how little it costs to write:
# a directory of theirs first, /usr/local/bin second, sudo only if neither is theirs to write in.
BIN=
for dir in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
	case ":$PATH:" in *":$dir:"*) ;; *) continue ;; esac
	[ -d "$dir" ] && [ -w "$dir" ] || continue
	BIN=$dir
	break
done

SUDO=
if [ -z "$BIN" ]; then
	if [ -d /usr/local/bin ] && command -v sudo >/dev/null 2>&1; then
		BIN=/usr/local/bin
		SUDO=sudo
	else
		BIN=$HOME/.local/bin
		mkdir -p "$BIN"
	fi
fi

$SUDO mkdir -p "$BIN"
$SUDO tee "$BIN/agent" >/dev/null <<SHIM
#!/bin/sh
# Written by agent-dive's connect.sh. The console runs on the machine the agents are on; this is
# the connection to it. Everything travels it: the agent list, the log feed, the conversation, the
# slash commands, and \`!\` into the sandbox.
set -eu

PLANE=\${AGENT_DIVE_HOME:-\$HOME/.agent-dive}/plane

# \`connect\` is this file's own, and never reaches the plane: the plane has no opinion about which
# computers drive it. With no address it asks, which is also what a first run does.
if [ "\${1:-}" = "connect" ]; then
	shift
	TARGET=\${1:-}
	if [ -z "\$TARGET" ]; then
		printf 'Which machine is your plane on? ' >&2
		read -r TARGET
	fi
	[ -n "\$TARGET" ] || exit 1
	case "\$TARGET" in *@*) ;; *) TARGET="root@\$TARGET" ;; esac
	mkdir -p "\$(dirname "\$PLANE")"
	printf '%s\n' "\$TARGET" >"\$PLANE"
	printf 'Saved. Type \`agent\` for the console.\n' >&2
	exit 0
fi

FIRST=
if [ ! -s "\$PLANE" ]; then
	# Nothing to fall back on and nobody to ask. Said rather than left as ssh failing to resolve an
	# empty host, because the fix is one command and the error should be it.
	[ -t 0 ] || {
		printf 'agent: no plane yet. Run \`agent connect user@host\` on a terminal first.\n' >&2
		exit 1
	}
	printf 'Which machine is your plane on? ' >&2
	read -r TARGET </dev/tty
	[ -n "\$TARGET" ] || exit 1
	# A bare address is the common case, and root is who the installer runs as. Typing the user is
	# for the machines where it is somebody else.
	case "\$TARGET" in *@*) ;; *) TARGET="root@\$TARGET" ;; esac
	mkdir -p "\$(dirname "\$PLANE")"
	printf '%s\n' "\$TARGET" >"\$PLANE"
	FIRST=1
fi
TARGET=\$(cat "\$PLANE")

# A pty when there is a screen to draw on, and none when the output is going somewhere else:
# \`agent logs | grep\` should be lines, not a terminal recording.
if [ -t 1 ]; then TTY=-t; else TTY=-T; fi

# ssh joins its command arguments with spaces and hands the result to a shell, so a word with a
# space in it arrives as two. \`agent wake "check the open issues"\` is the everyday case of that,
# and it is quoted back into one here.
REMOTE=agent
for word in "\$@"; do
	REMOTE="\$REMOTE '\$(printf '%s' "\$word" | sed "s/'/'\\\\\\\\''/g")'"
done

if [ -z "\$FIRST" ]; then exec ssh \$TTY "\$TARGET" "\$REMOTE"; fi

# On the run that saved the address, a connection that never opened is a typo rather than a plane
# that is down, and keeping it would mean every later \`agent\` failing the same way with no
# question in front of it. 255 is ssh's own code for that, and only that.
set +e
ssh \$TTY "\$TARGET" "\$REMOTE"
STATUS=\$?
set -e
if [ \$STATUS -eq 255 ]; then
	rm -f "\$PLANE"
	printf 'agent: could not reach %s, so nothing was saved.\n' "\$TARGET" >&2
fi
exit \$STATUS
SHIM
$SUDO chmod 755 "$BIN/agent"

mkdir -p "$HOME_DIR"
if [ -n "$TARGET" ]; then
	case "$TARGET" in *@*) ;; *) TARGET="root@$TARGET" ;; esac
	printf '%s\n' "$TARGET" >"$HOME_DIR/plane"
fi

printf '\n\033[1magent is at %s/agent\033[0m\n\n' "$BIN"
if [ -n "$TARGET" ]; then
	printf '  Pointed at %s. Type `agent` for the console.\n\n' "$TARGET"
else
	printf '  Type `agent`. The first one asks which machine your plane is on.\n\n'
fi
