# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` builds, and the sources are not copied in yet.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

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
