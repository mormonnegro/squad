# The web console is the one thing here that is compiled, so it is compiled somewhere else.
#
# A browser cannot be handed TypeScript and a directory of workspace packages, which is what the
# plane itself runs on. So this stage exists to turn one package into a handful of files, and
# nothing it needed to do that — vite, react, the type definitions — reaches the image below.
FROM node:24-bookworm-slim AS web

RUN corepack enable
WORKDIR /srv/squad
# The base tsconfig comes too: the web package extends it, and esbuild resolves that `extends` while
# it transforms — so without it the build fails inside vite rather than at a missing file.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @squad/web... \
	&& pnpm --filter @squad/web build

FROM node:24-bookworm-slim

RUN corepack enable

WORKDIR /srv/squad
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages

# Node runs the TypeScript sources directly, so there is nothing to build and nothing that needs a
# compiler at runtime. Only the production dependencies are installed.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

# The built console, and only the built console. Everything the browser needs is inside these files,
# which is why @squad/web declares no runtime dependencies for this install to have found.
COPY --from=web /srv/squad/packages/web/dist ./packages/web/dist

# So `docker compose exec control-plane squad ls` works: the socket is in the state directory,
# which is reachable from inside the container as well as from the host.
RUN ln -s /srv/squad/packages/control-plane/bin/squad.mjs /usr/local/bin/squad

ENTRYPOINT ["node", "packages/control-plane/bin/squad.mjs"]
# Overridable, so the same image serves the other subcommands: `docker exec ... ls`, `chat`, `wake`.
CMD ["run", "/etc/squad/config.yaml"]
