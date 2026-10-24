# Contributing

Thanks for looking into strava-mcp. Bug reports, questions and pull requests are welcome through the GitHub issue templates and pull requests.

## Setup

Node 24 (the image), Node 22 works for development.

```sh
npm install
npm run dev          # tsx watch src/index.ts (stdio transport)
npm run build        # tsc into dist/
npm test             # node:test through tsx, about a minute
npx tsc --noEmit     # type check only
```

To run the HTTP server locally with a throw-away mirror and no sync:

```sh
STRAVA_CLIENT_ID=x STRAVA_CLIENT_SECRET=x STRAVA_REFRESH_TOKEN=x STRAVA_SYNC=off \
MCP_TRANSPORT=http STRAVA_DB_PATH=/tmp/strava-dev/strava.duckdb npm start
```

With real credentials, `STRAVA_TOKEN_FILE=./state/tokens.json npx tsx src/auth-cli.ts` authorizes against your own API application; the mirror then fills in `./state/`.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point: opens the mirror, starts sync and snapshots, serves stdio or HTTP; `auth` subcommand |
| `src/server.ts` | Registers tools, resources and prompts on an `McpServer` |
| `src/mirror.ts` | Cache-first reads: freshness rules and provenance |
| `src/strava-client.ts`, `src/token-store.ts` | HTTP client with token refresh, the token file |
| `src/auth.ts`, `src/auth-cli.ts` | The authorization command |
| `src/db/schema.ts` | Raw store DDL and migrations (append-only) |
| `src/db/tables.ts` | The typed layer: every table, column, comment and the JSON it is read from |
| `src/db/projections.ts` | Raw payloads to typed rows, and the drift check |
| `src/db/raw.ts` | Landing payloads: hashing, versions, chunking |
| `src/db/database.ts` | The DuckDB instance, the writer mutex, migrations, fatal-error handling |
| `src/sync/` | Rate limiter, fetchers, the engine (queue, planner, scheduler) |
| `src/snapshot.ts`, `src/webhook.ts` | Snapshot publishing and the Strava push subscription |
| `src/tools/`, `src/resources/`, `src/prompts/` | The MCP surface |
| `test/` | Tests; `test/fixtures/payloads.json` holds scrubbed real payloads of every type |
| `scripts/` | Doc generators and the memory benchmark |
| `deploy/` | Compose profile assets: the gateway config, Grafana provisioning and dashboard, the notebook |
| `docs/`, `mkdocs.yml` | The documentation site |

## Adding a column

1. Add it to the table's column list in `src/db/tables.ts`: `col("name", "TYPE", "Description with unit.")` reads the JSON key of the same name; `expr(...)` takes any SQL over `b` (the JSON object) and names the key it consumes, so the drift check knows the key is mapped.
2. Append a migration in `src/db/schema.ts` (`ALTER TABLE ... ADD COLUMN ...` plus `COMMENT ON COLUMN`). Never edit a shipped migration.
3. Backfill from the raw store: a reprojection of the type (`project(tx, type, null)`) can be a migration step for small types; for large ones leave the column null until payloads are refreshed.
4. `npm test`: the schema test fails if the live columns differ from the definition, and the drift test if a fixture key is left unmapped. Extend `test/fixtures/payloads.json` with scrubbed data if the field is not in it (no real ids, names or coordinates).
5. `npm run docs:gen` and commit `docs/data/schema.md`.

## Adding a table or a payload type

A new raw type needs a fetcher in `src/sync/fetchers.ts`, a projection in `src/db/projections.ts` (statements over `scopedRaw(type)` plus `shapes` for the drift check), its table in `tables.ts` with DDL in a new migration, a freshness rule in `src/mirror.ts` if tools read it, and planner rules in `src/sync/engine.ts` if the sync should fetch it. Point-like tables with millions of rows should set `keyEnforced: false` (see the comment on `Table`).

## Generated documentation

`docs/reference/tools.md` and `docs/data/schema.md` are generated: `npm run build && npm run docs:gen`. CI regenerates them and fails when the committed files differ. The site builds with `uvx --from mkdocs-material==9.7.7 mkdocs build --strict` (or `pip install -r requirements-docs.txt && mkdocs build --strict`); `mkdocs serve` previews it.

## Memory benchmark

`scripts/bench-memory.ts` measures the peak resident memory of one operation (open, drift, plan, project-streams, read-streams, snapshot) in a fresh process, on a copy of a mirror. Run it on the compiled code, ideally inside the image, since that is what ships:

```sh
npm run build
cp /path/to/strava.duckdb /tmp/bench.duckdb
DUCKDB_MEMORY_LIMIT=384MB node scripts/bench-memory.ts drift /tmp/bench.duckdb
docker build -t strava-mcp:bench . && docker run --rm --entrypoint node \
  -v /tmp:/bench -v $PWD/scripts/bench-memory.ts:/app/scripts/bench-memory.ts:ro \
  -e DUCKDB_MEMORY_LIMIT=384MB strava-mcp:bench scripts/bench-memory.ts drift /bench/bench.duckdb
```

Opening a 3.x mirror runs the migration, so `open` on such a copy measures it.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `build:`, `ci:`), one logical change each; `!` or a `BREAKING CHANGE:` footer for breaking ones.
- No emojis in code or documentation. Comments explain why, not what.
- SQL in projections must stay bounded in memory: scope reads to the keys in `_scope`, never scan a whole type's bodies, and read bodies through `bodyExpr` so chunked payloads work.
- Tests use synthetic data or the scrubbed fixtures; never commit anything from a real account.

## Releasing

Bump `package.json`, add the version to `CHANGELOG.md`, commit `chore: release X.Y.Z`, tag `vX.Y.Z` and push the tag. The release workflow builds and pushes the image for amd64 and arm64 with the `X.Y.Z`, `X.Y` and `X` tags; `npm publish` publishes the package.
