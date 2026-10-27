# Contributing

Thanks for looking into strava-mcp. Bug reports and questions are welcome through the GitHub issue templates. Outside contributions require agreeing to a contributor license agreement; open an issue before sending a pull request.

## Setup

Node 22 or later (the image uses 24) and pnpm at the version `packageManager` in `package.json` names (`corepack enable` provides it).

```sh
pnpm install
pnpm run dev         # tsx watch src/index.ts (stdio transport)
pnpm run build       # tsc into dist/
pnpm run lint        # Biome: lint, format check, import order (pnpm run lint:fix applies)
pnpm run typecheck   # tsc over src/, and over test/ and scripts/ (tsx --test does not type-check)
pnpm test            # node:test through tsx, about a minute
```

CI runs lint, build, typecheck, the tests and the generated-docs check on every push and pull request; publication is gated on the same checks for release tags. The pull request template lists the same. Tests use synthetic/scrubbed fixtures and fake transports, never live account calls; SQL regressions exercise the pinned Node driver on throw-away memory/file mirrors.

Dependencies follow a seven-day release cooldown: pnpm installs a version only once it is a week old (`minimumReleaseAge` in `pnpm-workspace.yaml`), and every install, CI and the Docker build included, re-checks the lockfile against it. To take one release early, add `<package>@<version>` under `minimumReleaseAgeExclude` in the same change; it covers that version only. No dependency runs install scripts (`allowBuilds`).

To run the HTTP server locally with a throw-away mirror and no sync:

```sh
STRAVA_CLIENT_ID=x STRAVA_CLIENT_SECRET=x STRAVA_REFRESH_TOKEN=x STRAVA_SYNC=off \
MCP_TRANSPORT=http STRAVA_DB_PATH=/tmp/strava-dev/strava.duckdb STRAVA_TOKEN_FILE=/tmp/strava-dev/tokens.json pnpm start
```

With real credentials, `pnpm exec tsx src/auth-cli.ts` authorizes against your own API application and writes `./state/tokens.json`; the mirror then fills in `./state/` (ignored by Git).

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point: opens the mirror, starts sync and snapshots, picks the transport; `auth` subcommand |
| `src/http.ts` | The HTTP app: `/mcp`, `/health`, `/snapshot.duckdb`, `/export/sync`, the webhook callback, bearer checks |
| `src/server.ts` | Registers tools, resources and prompts on an `McpServer`; environment validation |
| `src/mirror.ts` | Cache-first reads: freshness rules and provenance; pass-through reads and writes |
| `src/export.ts` | The live export payload for other services ([Export API](docs/reference/export.md)) |
| `src/strava-client.ts`, `src/token-store.ts` | HTTP client with token refresh, the token file |
| `src/auth.ts`, `src/auth-cli.ts` | The authorization command |
| `src/constants.ts`, `src/time.ts` | API base, default paths, sport and stream types; duration constants |
| `src/db/schema.ts` | Raw store DDL and migrations (append-only) |
| `src/db/tables.ts` | The typed layer: every table, column, comment and the JSON it is read from |
| `src/db/projections.ts` | Raw payloads to typed rows, and the drift check |
| `src/db/raw.ts` | Landing payloads: hashing, versions, chunking |
| `src/db/database.ts` | The DuckDB instance, the writer mutex, migrations, fatal-error handling |
| `src/sync/` | Rate limiter, fetchers, the engine (queue, planner, scheduler) |
| `src/snapshot.ts`, `src/webhook.ts` | Snapshot publishing and the Strava push subscription |
| `src/tools/`, `src/resources/`, `src/prompts/` | The MCP surface; `src/tools/annotations.ts` holds the shared tool annotations |
| `src/format.ts`, `src/pagination.ts`, `src/errors.ts` | Result formatting in the athlete's units, paging, error messages |
| `test/` | Tests; `test/fixtures/payloads.json` holds scrubbed real payloads of every type |
| `scripts/` | Doc generators, the changelog-section extractor used by releases, the memory benchmark |
| `deploy/` | Compose profile assets: the gateway config, Grafana provisioning and dashboard, the notebook |
| `docs/`, `mkdocs.yml` | The documentation site |
| `.agents/skills/` | DuckDB skills from [duckdb/duckdb-skills](https://github.com/duckdb/duckdb-skills), used by coding agents during development (installed with `npx skills add`; `.claude/skills` links to them) |

## Adding a column

1. Add it to the table's column list in `src/db/tables.ts`: `col("name", "TYPE", "Description with unit.")` reads the JSON key of the same name; `expr(...)` takes any SQL over `b` (the JSON object) and names the key it consumes, so the drift check knows the key is mapped.
2. Append a migration in `src/db/schema.ts` (`ALTER TABLE ... ADD COLUMN ...` plus `COMMENT ON COLUMN`). Never edit a shipped migration.
3. Backfill from the raw store: a reprojection of the type (`project(tx, type, null)`) can be a migration step for small types; for large ones leave the column null until payloads are refreshed.
4. `pnpm test`: the schema test fails if the live columns differ from the definition, and the drift test if a fixture key is left unmapped. Extend `test/fixtures/payloads.json` with scrubbed data if the field is not in it (no real ids, names or coordinates).
5. `pnpm run docs:gen` and commit `docs/data/schema.md`.

## Adding a table or a payload type

A new raw type needs a fetcher in `src/sync/fetchers.ts`, a projection in `src/db/projections.ts` (statements over `scopedRaw(type)` plus `shapes` for the drift check), its table in `tables.ts` with DDL in a new migration, a freshness rule in `src/mirror.ts` if tools read it, and planner rules in `src/sync/engine.ts` if the sync should fetch it. Point-like tables with millions of rows should set `keyEnforced: false` (see the comment on `Table`).

## Adding a tool

Register it in the matching file under `src/tools/` with a `z.object` input schema (the handler's arguments are inferred from it) and one of the annotation constants from `src/tools/annotations.ts`. Reads go through `mirror()` so they are cached, paced and marked with provenance; writes through `mirror().write(...)` so the response is landed. Then `pnpm run build && pnpm run docs:gen` and commit `docs/reference/tools.md`.

## Generated documentation

`docs/reference/tools.md` and `docs/data/schema.md` are generated: `pnpm run build && pnpm run docs:gen`. CI regenerates them and fails when the committed files differ. The site builds with `UV_EXCLUDE_NEWER="7 days" uvx --with-requirements requirements-docs.txt mkdocs build --strict`, as CI does; `mkdocs serve` previews it. `docs/changelog.md` includes `CHANGELOG.md` through a snippet.

## Memory benchmark

`scripts/bench-memory.ts` measures the peak resident memory of one operation (open, drift, plan, project-streams, read-streams, snapshot) in a fresh process, on a copy of a mirror. Run it on the compiled code, ideally inside the image, since that is what ships:

```sh
pnpm run build
cp /path/to/strava.duckdb /tmp/bench.duckdb
DUCKDB_MEMORY_LIMIT=384MB node scripts/bench-memory.ts drift /tmp/bench.duckdb
docker build -t strava-mcp:bench . && docker run --rm --entrypoint node \
  -v /tmp:/bench -v $PWD/scripts/bench-memory.ts:/app/scripts/bench-memory.ts:ro \
  -e DUCKDB_MEMORY_LIMIT=384MB strava-mcp:bench scripts/bench-memory.ts drift /bench/bench.duckdb
```

Opening a 3.x mirror runs the migration, so `open` on such a copy measures it.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `build:`, `ci:`, `refactor:`, `style:`), one logical change each; `!` or a `BREAKING CHANGE:` footer for breaking ones.
- Biome's configuration in `biome.json` is the style; `pnpm run lint:fix` applies it. No emojis in code or documentation. Comments explain why, not what.
- SQL in projections must stay bounded in memory: scope reads to the keys in `_scope`, never scan a whole type's bodies, and read bodies through `bodyExpr` so chunked payloads work.
- Tests use synthetic data or the scrubbed fixtures; never commit anything from a real account.
- User-visible changes get an entry under `[Unreleased]` in `CHANGELOG.md`, and new settings a line in `.env.example` and `docs/configuration.md`.

## Releasing

1. Move the `[Unreleased]` entries of `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading, add its compare link at the bottom, and bump `version` in `package.json`.
2. Commit `chore: release X.Y.Z`, tag `vX.Y.Z` and push the branch and the tag.

The release workflow (`.github/workflows/release.yml`) then:

- builds and pushes `ghcr.io/justmytwospence/strava-mcp` for amd64 and arm64 with the `X.Y.Z`, `X.Y` and `X` tags;
- creates the GitHub Release, with the tag's changelog section (extracted by `scripts/changelog-section.mjs`, which fails the job when the section is missing) as the notes;
- publishes `@justmytwospence/strava-mcp` to npm with trusted publishing (OIDC, provenance), after checking that the tag matches `package.json`. The npm job continues on error so an unconfigured trusted publisher does not fail the release.

npm trusted publishing is configured once on npmjs.com, under the package's settings: publisher GitHub Actions, owner `justmytwospence`, repository `strava-mcp`, workflow `release.yml`, no environment.
