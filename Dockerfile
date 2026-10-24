# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
# pnpm at the version and checksum package.json's packageManager names.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The install re-checks every lockfile entry against the release cooldown in
# pnpm-workspace.yaml. --ignore-scripts: `prepare` builds, and the sources are not copied in yet.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod --ignore-scripts

FROM node:24-alpine
# Memory: DuckDB keeps its buffers under DUCKDB_MEMORY_LIMIT, and the process needs
# roughly 300 MB on top of it (Node, JSON parsing, allocator slack). With 384 MB the
# server peaks under 500 MB of RSS on a mirror of ~2,000 activities with full streams;
# see docs/operations.md for the measurements and when to raise it.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=8000 \
    STRAVA_DB_PATH=/data/strava.duckdb \
    STRAVA_TOKEN_FILE=/data/tokens.json \
    DUCKDB_MEMORY_LIMIT=384MB \
    DUCKDB_THREADS=2
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The mirror (strava.duckdb), its snapshots (snapshot/) and the token store; a named volume
# mounted here inherits the ownership.
RUN mkdir /data && chown node:node /data \
    && ln -s /app/dist/auth-cli.js /usr/local/bin/strava-mcp-auth && chmod +x /app/dist/auth-cli.js /app/dist/index.js
USER node
EXPOSE 8000
# A long start period: the first start after an upgrade may migrate the mirror for a
# minute or two before it listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/index.js"]
