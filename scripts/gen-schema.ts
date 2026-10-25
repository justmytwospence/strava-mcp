/**
 * Generate docs/data/schema.md from the DuckDB catalog of a freshly migrated, empty
 * mirror: every table and view with its comment, columns, types and column comments,
 * plus Mermaid entity-relationship diagrams of the typed layer and of the raw store.
 *
 *   npx tsx scripts/gen-schema.ts
 *
 * Keys and joins are logical: the point tables and raw_blob carry no DuckDB constraint
 * (see Table.keyEnforced), and foreign keys are never declared. CI regenerates the file
 * and fails when it differs from the committed one.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "../src/db/database.js";
import { TABLES } from "../src/db/tables.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "data", "schema.md");

interface Column {
  name: string;
  type: string;
  comment: string | null;
}
interface Entity {
  name: string;
  kind: "table" | "view";
  comment: string | null;
  columns: Column[];
  /** Logical key columns. */
  key: string[];
}

/** Logical joins: [child, column, parent, label]. */
type Join = [string, string, string, string | null];

const RAW_TABLES = [
  "raw_payload",
  "raw_blob",
  "raw_latest",
  "raw_current",
  "sync_job",
  "sync_log",
  "sync_state",
  "rate_sample",
  "schema_migration",
];

/** Keys of the tables that are not generated from tables.ts. */
const RAW_KEYS: Record<string, string[]> = {
  raw_payload: ["object_type", "object_key", "content_hash"],
  raw_blob: ["object_type", "object_key", "content_hash", "chunk_no"],
  raw_latest: ["object_type", "object_key"],
  raw_current: ["object_type", "object_key"],
  sync_job: ["kind", "key"],
  sync_state: ["name"],
  schema_migration: ["version"],
};

/** The same relationship rules as the original ERD script, plus the raw_blob chunks. */
function joins(entities: Entity[]): Join[] {
  const out: Join[] = [];
  for (const e of entities) {
    if (
      e.name !== "activity" &&
      e.name !== "activity_zone_bucket" &&
      e.columns.some((c) => c.name === "activity_id") &&
      !RAW_TABLES.includes(e.name)
    ) {
      out.push([e.name, "activity_id", "activity", null]);
    }
  }
  out.push(
    ["activity", "athlete_id", "athlete", null],
    ["activity", "gear_id", "gear", null],
    ["activity_segment_effort", "segment_id", "segment", null],
    ["segment_stream_point", "segment_id", "segment", null],
    ["segment_effort_stream_point", "effort_id", "activity_segment_effort", null],
    ["route_point", "route_id", "route", null],
    ["route", "athlete_id", "athlete", null],
    ["activity_best_effort", "athlete_id", "athlete", null],
    ["activity_zone_bucket", "activity_id", "activity_zone", null],
    ["raw_latest", "content_hash", "raw_payload", "current version"],
    ["raw_blob", "content_hash", "raw_payload", "chunks of"],
    ["raw_current", "object_key", "raw_latest", "one row per"],
    ["sync_log", "kind", "sync_job", "outcome of"],
  );
  return out;
}

function mermaidType(t: string): string {
  return t
    .replace("TIMESTAMP WITH TIME ZONE", "timestamptz")
    .replace(/\[\]/g, "_list")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .replace(/\W/g, "");
}

function diagram(entities: Entity[], names: string[], allJoins: Join[]): string {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const lines = ["erDiagram"];
  for (const name of names) {
    const e = byName.get(name);
    if (!e) continue;
    const fkCols = new Set(allJoins.filter(([child]) => child === name).map(([, col]) => col));
    lines.push(`  ${name} {`);
    for (const c of e.columns) {
      const tags = [e.key.includes(c.name) ? "PK" : "", fkCols.has(c.name) ? "FK" : ""].filter(Boolean);
      if (tags.length) lines.push(`    ${mermaidType(c.type)} ${c.name} ${tags.join(",")}`);
    }
    lines.push(`    _ more "${e.columns.length} columns total"`);
    lines.push("  }");
  }
  for (const [child, col, parent, label] of allJoins) {
    if (names.includes(child) && names.includes(parent) && byName.has(child) && byName.has(parent)) {
      lines.push(`  ${parent} ||--o{ ${child} : "${label ?? col}"`);
    }
  }
  return lines.join("\n");
}

function cell(text: string | null | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "strava-schema-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  try {
    const tables = await db.all<{ name: string; comment: string | null }>(
      "SELECT table_name AS name, comment FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal AND NOT temporary ORDER BY table_name",
    );
    const views = await db.all<{ name: string; comment: string | null }>(
      "SELECT view_name AS name, comment FROM duckdb_views() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal AND NOT temporary ORDER BY view_name",
    );
    const columns = await db.all<Column & { table: string }>(
      "SELECT table_name AS \"table\", column_name AS name, data_type AS type, comment FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal ORDER BY table_name, column_index",
    );
    const typedKeys = new Map(TABLES.map((t) => [t.name, t.primaryKey]));
    const entities: Entity[] = [
      ...tables.map(
        (t): Entity => ({
          name: t.name,
          kind: "table",
          comment: t.comment,
          columns: columns.filter((c) => c.table === t.name),
          key: typedKeys.get(t.name) ?? RAW_KEYS[t.name] ?? [],
        }),
      ),
      ...views.map(
        (v): Entity => ({
          name: v.name,
          kind: "view",
          comment: v.comment,
          columns: columns.filter((c) => c.table === v.name),
          key: RAW_KEYS[v.name] ?? [],
        }),
      ),
    ];
    const allJoins = joins(entities);
    const domain = entities.filter((e) => !RAW_TABLES.includes(e.name)).map((e) => e.name);
    const rawStore = ["raw_payload", "raw_blob", "raw_latest", "raw_current"];
    const sync = ["sync_job", "sync_log", "sync_state", "rate_sample", "schema_migration"];

    const md: string[] = [
      "# Schema reference",
      "",
      "<!-- Generated by scripts/gen-schema.ts from the DuckDB catalog of a migrated empty mirror; do not edit by hand. -->",
      "",
      `The mirror has ${tables.length} tables and ${views.length} view. The typed tables are declared once in \`src/db/tables.ts\` (columns, comments and the JSON each column is read from); the raw store and the sync bookkeeping are declared in \`src/db/schema.ts\`. The same comments are available inside the database (\`strava_schema\`, or \`duckdb_columns()\` on the snapshot).`,
      "",
      "Units follow Strava: meters, seconds, meters per second, degrees Celsius, watts, beats per minute. Timestamps are UTC (`TIMESTAMP WITH TIME ZONE`) except the `*_local` wall-clock columns.",
      "",
      "## Entity-relationship diagrams",
      "",
      "Each entity lists its key and join columns and its total column count. Keys and joins are logical: DuckDB enforces a primary key only on the small tables, and no foreign keys are declared.",
      "",
      "### Activities, athlete, gear, segments, routes, clubs",
      "",
      "```mermaid",
      diagram(entities, domain, allJoins),
      "```",
      "",
      "### Raw store",
      "",
      "```mermaid",
      diagram(entities, rawStore, allJoins),
      "```",
      "",
      "### Sync bookkeeping",
      "",
      "```mermaid",
      diagram(entities, sync, allJoins),
      "```",
      "",
      "## Tables",
      "",
    ];
    for (const e of entities) {
      md.push(`### ${e.name}`, "");
      if (e.kind === "view") md.push("*View.*", "");
      if (e.comment) md.push(e.comment, "");
      if (e.key.length) md.push(`Key: ${e.key.map((k) => `\`${k}\``).join(", ")}`, "");
      md.push("| Column | Type | Description |", "|---|---|---|");
      for (const c of e.columns) md.push(`| \`${c.name}\` | ${cell(c.type)} | ${cell(c.comment)} |`);
      md.push("");
    }
    writeFileSync(out, md.join("\n"));
    console.log(`wrote ${out}: ${tables.length} tables, ${views.length} views`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
