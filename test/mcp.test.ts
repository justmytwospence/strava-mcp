import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { CHARACTER_LIMIT } from "../src/constants.js";
import { setMirror } from "../src/context.js";
import { Database } from "../src/db/database.js";
import { land, landMany } from "../src/db/raw.js";
import { jsonResult, mirrorResult } from "../src/format.js";
import { Mirror } from "../src/mirror.js";
import { createServer } from "../src/server.js";
import { SyncEngine } from "../src/sync/engine.js";

interface Fixture {
  type: string;
  key: string;
  body: Record<string, unknown>;
}
interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}
interface ResourceResult {
  _meta?: { provenance: unknown };
  contents: { uri: string; text: string; mimeType: string }[];
}
interface PromptResult {
  messages: { content: { text: string } }[];
}
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/payloads.json", import.meta.url), "utf8"));

async function wire() {
  const server = createServer();
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  client.onmessage = (message: JSONRPCMessage) => {
    if (!("id" in message) || typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if ("error" in message) waiter.reject(new Error(message.error.message));
    else if ("result" in message) waiter.resolve(message.result);
  };
  await client.start();
  await server.connect(transport);
  let id = 0;
  function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve: (r) => resolve(r as T), reject });
      void client.send({ jsonrpc: "2.0", id: next, method, params }).catch(reject);
    });
  }
  return { request, close: () => server.close() };
}

test("offline MCP wire contracts and local-only discovery/context", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "strava-mcp-contract-"));
  const db = await Database.open({ path: ":memory:", snapshotDir: dir });
  const m = new Mirror(db, new SyncEngine(db));
  const originalFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => {
    network++;
    throw new Error("No network permitted in contract tests");
  };
  setMirror(m);
  const client = await wire();
  const call = (name: string, args = {}) => client.request<ToolResult>("tools/call", { name, arguments: args });
  const resource = (uri: string) => client.request<ResourceResult>("resources/read", { uri });
  const prompt = (name: string, args = {}) => client.request<PromptResult>("prompts/get", { name, arguments: args });
  try {
    for (const f of fixtures) await db.transaction((tx) => land(tx, f.type, f.key, JSON.stringify(f.body)));
    const summary = fixtures.find((f) => f.type === "activity_summary")!;
    const now = new Date().toISOString();
    await db.transaction((tx) =>
      landMany(
        tx,
        "activity_summary",
        Array.from({ length: 205 }, (_, i) => ({
          key: String(800000 + i),
          body: JSON.stringify({ ...summary.body, id: 800000 + i, start_date: now, start_date_local: now }),
        })),
      ),
    );

    await t.test(
      "initialize advertises instructions and exactly the existing workflow surfaces plus local context",
      async () => {
        const init = await client.request<{ instructions: string; capabilities: Record<string, unknown> }>(
          "initialize",
          {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "offline-test", version: "0" },
          },
        );
        assert.match(init.instructions, /Missing headers mean unknown/);
        assert.match(init.instructions, /Prompt retrieval uses only stored data/);
        assert.ok(init.capabilities.tools && init.capabilities.resources && init.capabilities.prompts);
        const { tools } = await client.request<{
          tools: { name: string; title: string; annotations: Record<string, boolean>; outputSchema?: unknown }[];
        }>("tools/list");
        const writes = new Set([
          "strava_create_activity",
          "strava_update_activity",
          "strava_create_upload",
          "strava_star_segment",
        ]);
        const local = new Set(["strava_query", "strava_schema", "strava_sync_status"]);
        assert.equal(tools.length, 33);
        for (const tool of tools) {
          assert.ok(tool.title, tool.name);
          for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
            assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name}.${hint}`);
          assert.equal(tool.annotations.readOnlyHint, !writes.has(tool.name), tool.name);
          assert.equal(tool.annotations.openWorldHint, !local.has(tool.name), tool.name);
          assert.equal(
            tool.annotations.destructiveHint,
            ["strava_update_activity", "strava_star_segment"].includes(tool.name),
            tool.name,
          );
          assert.equal(
            tool.annotations.idempotentHint,
            !["strava_create_activity", "strava_create_upload"].includes(tool.name),
            tool.name,
          );
        }
        assert.ok(tools.find((v) => v.name === "strava_query")?.outputSchema);
        assert.ok(tools.find((v) => v.name === "strava_schema")?.outputSchema);
        const resources = await client.request<{ resources: { uri: string }[] }>("resources/list");
        assert.ok(resources.resources.some((r) => r.uri === "strava://mirror/budget"));
        const templates = await client.request<{ resourceTemplates: { uriTemplate: string }[] }>(
          "resources/templates/list",
        );
        assert.equal(templates.resourceTemplates.length, 4);
        const prompts = await client.request<{ prompts: { name: string }[] }>("prompts/list");
        assert.equal(prompts.prompts.length, 5);
        // Hermes may hide templates/list and ignore initialize instructions: the static guide must stand alone.
        const guide = (await resource("strava://reference/usage")).contents[0]!.text;
        for (const template of templates.resourceTemplates)
          assert.ok(guide.includes(template.uriTemplate), template.uriTemplate);
        for (const workflow of prompts.prompts) assert.ok(guide.includes(workflow.name), workflow.name);
        assert.match(guide, /zero API calls/);
        assert.match(guide, /"max_rows":20/);
        assert.match(guide, /Missing headers mean unknown accounting/);
        assert.equal(network, 0);
      },
    );

    await t.test("local resources and SQL success/error shapes never fetch or mutate", async () => {
      for (const uri of [
        "strava://reference/usage",
        "strava://mirror/schema",
        "strava://mirror/schema/activity",
        "strava://mirror/status",
        "strava://mirror/budget",
        "strava://reference/sport-types",
        "strava://reference/stream-types",
      ]) {
        const result = await resource(uri);
        assert.ok(result.contents[0]!.text.length <= CHARACTER_LIMIT, uri);
      }
      const query = await call("strava_query", { sql: "SELECT * FROM range(5)", max_rows: 2 });
      assert.equal(query.isError, undefined);
      assert.deepEqual(query.structuredContent?.rows, [{ range: "0" }, { range: "1" }]);
      assert.equal(query.structuredContent?.truncated, true);
      assert.deepEqual(JSON.parse(query.content[0]!.text), query.structuredContent);
      const huge = await call("strava_query", { sql: "SELECT repeat('x', 50000) AS huge" });
      assert.equal(huge.structuredContent?.truncated, true);
      assert.deepEqual(huge.structuredContent?.rows, []);
      for (const args of [{}, { table: "activity" }]) assert.ok((await call("strava_schema", args)).structuredContent);
      assert.equal((await call("strava_schema", { table: "missing" })).isError, true);
      assert.equal((await call("strava_query", { sql: "EXPLAIN ANALYZE DELETE FROM activity" })).isError, true);
      assert.equal(network, 0);
    });

    await t.test("invalid inputs and URIs fail before reaching any account handler", async () => {
      for (const [name, args] of [
        ["strava_get_activity", { activity_id: -1 }],
        ["strava_get_club", { club_id: 0 }],
        ["strava_get_route", { route_id: "1/../../athlete" }],
        ["strava_get_segment_effort", { effort_id: "-1" }],
        ["strava_get_gear", { gear_id: "b1?path=bad" }],
        ["strava_get_upload", { upload_id: 1.5 }],
        ["strava_list_activities", { after: 10, before: 1 }],
        ["strava_list_segment_efforts", { segment_id: 1, start_date_local: "2026-02-30" }],
        [
          "strava_list_segment_efforts",
          { segment_id: 1, start_date_local: "2026-02-02", end_date_local: "2026-01-01" },
        ],
        ["strava_get_activity_streams", { activity_id: 1, keys: ["time"], max_points: 2001 }],
        ["strava_create_upload", { file_content: "!!!!", data_type: "fit" }],
        ["strava_create_activity", { name: "test", sport_type: "Run", start_date_local: "yesterday", elapsed_time: 1 }],
      ] as const)
        assert.equal((await call(name, args)).isError, true, name);
      for (const uri of [
        "strava://activity/not-an-id",
        "strava://segment/-1",
        "strava://route/1%2Fbad/gpx",
        "strava://mirror/schema/activity%27",
      ])
        await assert.rejects(resource(uri));
      for (const days of ["0", "-1", "366", "1.5", "10days", "Infinity"])
        await assert.rejects(prompt("training-plan-review", { days }));
      for (const week_start of ["not-a-date", "2026-02-30", "2026-01-01T00:00:00Z"])
        await assert.rejects(prompt("weekly-summary", { week_start }));
      await assert.rejects(prompt("activity-analysis", { activity_id: "1/other" }));
      assert.equal(network, 0);
    });

    await t.test("existing resources preserve bodies and stale provenance; stream cap is strict", async () => {
      const meta = { source: "mirror" as const, fetched_at: "2026-01-01T00:00:00Z", stale: "synthetic cooldown" };
      m.activity = async () => ({ data: { id: 1, name: "synthetic" }, meta });
      m.segment = async () => ({ data: { id: 1, name: "synthetic" }, meta });
      m.athlete = async () => ({ data: { id: 1 }, meta });
      m.athleteStats = async () => ({ data: { totals: 1 }, meta });
      m.routeExport = async () => ({ data: "<gpx>synthetic</gpx>", meta });
      for (const uri of [
        "strava://activity/1",
        "strava://segment/1",
        "strava://athlete/profile",
        "strava://athlete/stats",
        "strava://route/1/gpx",
      ]) {
        const result = await resource(uri);
        assert.deepEqual(result._meta?.provenance, meta);
        assert.match(result.contents[1]!.text, /synthetic cooldown/);
        if (uri.endsWith("gpx")) assert.equal(result.contents[0]!.text, "<gpx>synthetic</gpx>");
      }
      m.activity = async () => ({ data: { large: "x".repeat(CHARACTER_LIMIT + 1) }, meta });
      await assert.rejects(resource("strava://activity/1"), /not silently truncated/);
      m.activityStreams = async () => ({ data: { time: { data: Array.from({ length: 1000 }, (_, i) => i) } }, meta });
      const streams = await call("strava_get_activity_streams", { activity_id: 1, keys: "time", max_points: 500 });
      const data = streams.structuredContent?.data as {
        streams: { time: { data: number[] } };
        _meta: { returned_points: number };
      };
      assert.ok(data._meta.returned_points <= 500);
      assert.equal(data.streams.time.data.at(-1), 999);
      assert.deepEqual(streams.structuredContent?._provenance, meta);
      assert.equal(network, 0);
    });

    await t.test(
      "all prompt retrieval is local, bounded, and carries coverage/provenance including empty windows",
      async () => {
        const activity = fixtures.find((f) => f.type === "activity_detail")!;
        const segment = fixtures.find((f) => f.type === "segment")!;
        for (const [name, args] of [
          ["weekly-summary", {}],
          ["training-plan-review", { days: "30" }],
          ["race-readiness", {}],
          ["activity-analysis", { activity_id: activity.key }],
          ["segment-comparison", { segment_id: segment.key }],
          ["weekly-summary", { week_start: "2000-01-03" }],
        ] as const) {
          const result = await prompt(name, args);
          const text = result.messages[0]!.content.text;
          assert.ok(text.length <= CHARACTER_LIMIT, name);
          assert.match(text, /local mirror/, name);
          if (name === "training-plan-review" || name === "race-readiness")
            assert.match(text, /Results truncated/, name);
          if (name === "weekly-summary" || name === "segment-comparison") assert.match(text, /coverage:/, name);
        }
        const jobs = await db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM sync_job");
        assert.equal(jobs?.n, 0, "prompts must not queue work");
        assert.equal(network, 0);
      },
    );

    await t.test("text compatibility and bounded structured results", () => {
      const data = { field: 1 };
      const meta = { source: "mirror" as const, fetched_at: null };
      assert.deepEqual(JSON.parse(mirrorResult(data, meta).content[0]!.text), data);
      assert.deepEqual(mirrorResult(data, meta).structuredContent, { data, _provenance: meta });
      const capped = jsonResult({ large: "x".repeat(CHARACTER_LIMIT + 1) });
      assert.match(capped.content[0]!.text, /Response truncated/);
      assert.equal(capped.structuredContent, undefined);
    });
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
