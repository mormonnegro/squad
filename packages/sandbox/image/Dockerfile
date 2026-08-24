FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      openssl \
      procps \
      ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent@0.84.2 && npm cache clean --force

# The node image already owns uid 1000. Replace it so the sandbox user is named and homed
# predictably, and pre-create /home/agent/.self owned by that user: Docker seeds an empty named
# volume from the image's mount point, and without this a non-root agent cannot write its own
# repository on first boot.
RUN userdel -r node \
    && useradd --uid 1000 --user-group --create-home --home-dir /home/agent --shell /bin/bash agent \
    && mkdir -p /etc/agent-dive /home/agent/.self /home/agent/.run \
    && chown -R agent:agent /home/agent

COPY relay.mjs /usr/local/lib/agent-dive/relay.mjs

# The plane's own extensions, kept here rather than in the agent's repository: that repository is
# written once and is the agent's from then on, so anything shipped into it could never be fixed.
COPY wake.ts /usr/local/lib/agent-dive/extensions/wake.ts
COPY search.ts /usr/local/lib/agent-dive/extensions/search.ts
COPY mcp.ts /usr/local/lib/agent-dive/extensions/mcp.ts

USER agent
WORKDIR /home/agent
CMD ["sleep", "infinity"]
