FROM node:24-bookworm-slim

RUN corepack enable

WORKDIR /srv/squad
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages

# Node runs the TypeScript sources directly, so there is nothing to build and nothing that needs a
# compiler at runtime. Only the production dependencies are installed.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

# So `docker compose exec control-plane agent ls` works: the socket is in the state directory,
# which is reachable from inside the container as well as from the host.
RUN ln -s /srv/squad/packages/control-plane/bin/agent.mjs /usr/local/bin/agent

ENTRYPOINT ["node", "packages/control-plane/bin/agent.mjs"]
# Overridable, so the same image serves the other subcommands: `docker exec ... ls`, `chat`, `wake`.
CMD ["run", "/etc/squad/config.yaml"]
