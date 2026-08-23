FROM node:24-bookworm-slim

RUN corepack enable

WORKDIR /srv/agent-dive
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages

# Node runs the TypeScript sources directly, so there is nothing to build and nothing that needs a
# compiler at runtime. Only the production dependencies are installed.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

ENTRYPOINT ["node", "packages/control-plane/src/cli.ts"]
CMD ["/etc/agent-dive/config.yaml"]
