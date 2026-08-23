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
    && mkdir -p /etc/agent-dive /home/agent/.self \
    && chown -R agent:agent /home/agent

USER agent
WORKDIR /home/agent
CMD ["sleep", "infinity"]
