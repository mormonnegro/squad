#!/bin/sh
set -e

# Chromium does not read the environment variables every other runtime here reads, and it does not
# read the system certificate store either: it has an NSS database of its own, in the home
# directory, and a certificate absent from it is a certificate that does not exist. The egress proxy
# opens every TLS connection this browser makes, so without this line the browser reaches nothing
# and says only that the connection is not private — which reads, from the agent's side, as the
# whole web being down for it alone.
#
# Done at start rather than in the image because the certificate is the deployment's: it is mounted
# in, it is different on every install, and an image with one baked in would be an image that trusts
# somebody else's proxy.
#
# Not fatal when it fails, which is the one thing worth being careful about here. A certificate that
# will not import is a browser whose HTTPS pages all say the connection is not private — bad, and
# visible on the live view, and something an operator can act on. A container that refuses to start
# over it is a screen that is simply never there, explained by one line of NSS jargon in a log
# nobody is tailing, restarting every ten seconds forever.
if [ -r "${SQUAD_SCREEN_CA:-/etc/squad/ca.crt}" ]; then
	mkdir -p "$HOME/.pki/nssdb"
	if [ ! -f "$HOME/.pki/nssdb/cert9.db" ]; then
		certutil -N --empty-password -d "sql:$HOME/.pki/nssdb" || true
	fi
	certutil -A -n squad-egress -t "C,," \
		-i "${SQUAD_SCREEN_CA:-/etc/squad/ca.crt}" -d "sql:$HOME/.pki/nssdb" ||
		echo "screen: the egress certificate would not import, so HTTPS pages will be refused by the browser" >&2
fi

# The lock the last browser left behind, which is the one thing standing between a profile that
# survives and a screen that does.
#
# Chromium marks a profile as in use with three symlinks naming the host that holds it, and a
# container's host name is its id — so every replaced container finds a profile locked by a machine
# that no longer exists. What it does about that is not to carry on: it tries to put a dialog on
# the screen saying the profile is in use, cannot find a display to put it on, and exits. The
# container restarts, finds the same lock, and does it again, forever.
#
# Safe to clear, and only here: one browser uses this volume, and if this script is running then
# whatever held that lock was replaced by the daemon before this container existed.
rm -f "${SQUAD_SCREEN_PROFILE:-/home/screen/profile}/SingletonLock" \
	"${SQUAD_SCREEN_PROFILE:-/home/screen/profile}/SingletonCookie" \
	"${SQUAD_SCREEN_PROFILE:-/home/screen/profile}/SingletonSocket"

exec node /usr/local/lib/squad/screen/screen.ts
