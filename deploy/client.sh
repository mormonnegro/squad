#!/bin/sh
#
# Puts the console on the computer you sit at:
#
#   curl -fsSL https://raw.githubusercontent.com/mormonnegro/squad/main/deploy/client.sh | sh
#
# This is the half you type at, and it is the one that asks where the agents should live. It puts
# no containers here and needs no Docker: the first `squad` asks that question, and installs a plane
# on this computer or on a server you have SSH to depending on the answer.
#
# Not an npm package, because the console is eight workspace packages that only mean anything
# together, and publishing eight names in lockstep to distribute one command is a release process
# standing in for a download. The tree is fetched whole and its dependencies installed in place —
# there is no build step, so what lands here is what runs.
#
# Run it again to update. The tree is replaced and the answer about where your agents live, which
# lives beside it rather than in it, is left alone.
#
set -eu

# Beside the client's own directory rather than in it: ~/.squad holds the answers this program keeps
# — which plane you chose, the state of one living here — and those outlive any version of it.
DIR=${SQUAD_CLIENT_DIR:-"$HOME/.squad/client"}
REPO=${SQUAD_REPO_URL:-https://github.com/mormonnegro/squad}
BRANCH=${SQUAD_BRANCH:-main}

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
dim() { printf '  \033[2m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

step "Checking what this computer already has"

# A door rather than a refusal. Whoever runs this is one install away from the thing they came for,
# and "install Node and run this again" with nowhere to go is a precondition dressed as an error.
node_door() {
	printf '\n'
	note "$1"
	printf '\n'
	note "  brew install node        on a Mac with Homebrew"
	note "  nodejs.org/download      the installer, anywhere"
	dim "fnm or nvm do it without root, and let you keep the version you already have."
	printf '\n'
	die "Nothing to run the console with."
}

command -v node >/dev/null 2>&1 ||
	node_door "squad is a Node program, and this computer has none."

# Asked about the capability rather than the version, because that is the thing that decides it and
# it arrived in two release lines at different numbers: 22.18 and 23.6. Without it the console's
# first import fails with a message about an unknown file extension, which says nothing about what
# to do.
node -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null ||
	node_door "squad runs its own TypeScript, which needs Node 22.18 or 23.6 or newer. This is $(node -v)."

command -v npm >/dev/null 2>&1 || node_door "This Node has no npm, and the install needs one."
note "Node $(node -v), npm $(npm -v)"

# Whole and into a directory of its own, so a failure anywhere below leaves the console that is
# already installed exactly where it was.
NEW="$DIR.incoming"
trap 'rm -rf "$NEW"' EXIT
rm -rf "$NEW"
mkdir -p "$NEW"

step "Fetching squad"
curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz --strip-components=1 -C "$NEW"
# What came out, rather than what the pipeline returned. A pipeline answers for its last command,
# and tar unpacks an empty stream without complaint, so a 404 arrives here looking like a success
# and would swap a tree with nothing in it over a console that works.
[ -f "$NEW/packages/client/bin/squad.mjs" ] ||
	die "Could not fetch $REPO at $BRANCH."
note "$BRANCH, from $REPO"

step "Installing what the console needs"
note "ink, react and the rest. There is no build: this is the tree that runs."
# The version the repository itself pins, so this follows the tree rather than having an opinion
# about it. Fetched per-install rather than installed globally, because a package manager on this
# PATH is a decision about this computer and not one an install of ours gets to make.
PNPM=$(node -e 'process.stdout.write(require("./package.json").packageManager || "pnpm@10")' \
	--input-type=commonjs 2>/dev/null || printf 'pnpm@10')
cd "$NEW"
# By path rather than by name: the package's name is not settled, and a filter that reads one is a
# filter that breaks on the day it changes. The braces are what make pnpm read this as a directory,
# and the trailing dots are what bring in the seven workspace packages the console is made of.
npm exec --yes "$PNPM" -- install --prod --frozen-lockfile --filter "{./packages/client}..." ||
	die "The dependencies would not install. What it printed is above."
cd - >/dev/null

# The swap, once there is something worth swapping in. The old tree is kept until the new one is in
# place, so the window where this computer has no console is a rename wide.
mkdir -p "$(dirname "$DIR")"
if [ -d "$DIR" ]; then
	rm -rf "$DIR.previous"
	mv "$DIR" "$DIR.previous"
fi
mv "$NEW" "$DIR"
rm -rf "$DIR.previous"
trap - EXIT

# The first writable one, and no sudo. On a laptop the directories are the operator's own and Docker
# is not involved, so a password prompt here would be a precondition invented for nothing.
step "Putting squad on your PATH"
BIN=
for candidate in ${SQUAD_BIN:-} /usr/local/bin "$HOME/.local/bin"; do
	[ -n "$candidate" ] || continue
	mkdir -p "$candidate" 2>/dev/null || true
	if [ -w "$candidate" ]; then
		BIN=$candidate
		break
	fi
done
[ -n "$BIN" ] || die "Nothing writable to put it in. Set SQUAD_BIN to a directory on your PATH."

cat >"$BIN/squad" <<SHIM
#!/bin/sh
# Written by squad's client installer. The console, and every subcommand of it.
exec node "$DIR/packages/client/bin/squad.mjs" "\$@"
SHIM
chmod 755 "$BIN/squad"
note "$BIN/squad"

case ":$PATH:" in
*":$BIN:"*) ;;
*)
	printf '\n'
	note "$BIN is not on your PATH. This puts it there:"
	note "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && exec \$SHELL"
	;;
esac

step "Type its name"
note "squad          the console, and on the first run the one question it asks:"
dim "whether the agents live on this computer or on a server you have SSH to"
printf '\n'
note "squad update   this again, and the plane wherever it is"
printf '\n'
