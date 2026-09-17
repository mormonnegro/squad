FROM node:22-bookworm-slim

# Chromium from Debian rather than from a download, because this image is built on the machine it
# runs on and half of those machines are a Raspberry Pi: the packaged build is the one that exists
# for arm64 as well as for amd64, and an image that only builds on a laptop is not one this project
# can ship.
#
# The fonts are not decoration. Without them a headless browser renders every page in tofu, which
# the operator sees as a screen full of boxes and the agent reads as a page whose text is fine —
# because the text is fine, and only the picture of it is not.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      curl \
      fonts-liberation \
      fonts-noto-color-emoji \
      gnupg \
      libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

# The 1Password CLI, which is how a password gets into a page without anybody typing it and without
# it ever being in the sandbox. It reads a service-account token this container is given and the
# agent has no path to; without that token it is an unused binary.
#
# Allowed to fail. This image is built on the machine that runs it, which is somebody's laptop or a
# Pi on a home connection, and a screen that would not build because a third party's apt repository
# was down for an hour is a browser nobody can use for an hour. What comes of skipping it is one
# feature that says so in words when it is asked for.
RUN (curl -sS https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" \
      > /etc/apt/sources.list.d/1password.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends 1password-cli) \
    || echo "1Password CLI not installed: signing in from a vault will say so when it is asked for." \
    ; rm -rf /var/lib/apt/lists/*

# The same uid the sandbox uses, for the same reason: the profile volume is written by this user and
# read by nobody, and a container that came back as a different uid would find its own login
# unreadable.
RUN userdel -r node \
    && useradd --uid 1000 --user-group --create-home --home-dir /home/screen --shell /bin/bash screen \
    && mkdir -p /etc/squad /home/screen/profile /usr/local/lib/squad/screen \
    && chown -R screen:screen /home/screen

# Node runs the TypeScript directly, as the control plane does. Nothing here is built.
# Every file the program imports has to be on this line. A missing one is not a missing feature:
# node fails the import, the container exits at once, and what the console shows is a screen that
# will not come up with nothing saying why. The test beside this one walks the imports and fails
# with the name to add.
COPY browser.ts cdp.ts forward.ts keyboard.ts logins.ts page.ts reading.ts screen.ts token.ts \
     verbs.ts waiting.ts /usr/local/lib/squad/screen/

# The plane's way in, which is the same program the sandbox image carries and has to stay the same
# program: the control plane execs it by path in whichever container it is tunnelling into. A test
# in this package asserts the two files are identical, because the way this drifts is somebody
# fixing a bug in one of them.
COPY relay.mjs /usr/local/lib/squad/relay.mjs

COPY start.sh /usr/local/bin/screen-start
RUN chmod 755 /usr/local/bin/screen-start

USER screen
WORKDIR /home/screen
CMD ["screen-start"]
