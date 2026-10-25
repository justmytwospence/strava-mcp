import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Database } from "../src/db/database.js";
import { SyncEngine } from "../src/sync/engine.js";
import { StravaWebhook, type WebhookEvent } from "../src/webhook.js";

const CALLBACK = "https://strava.mcp.example.com/webhook/s3cret";
let dir: string;
let db: Database;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "strava-webhook-"));
  db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  await db.run("INSERT INTO athlete (id, fetched_at) VALUES (42, now())");
});
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake Strava push_subscriptions API holding at most one subscription. */
function fakeStrava(existing: Array<{ id: number; callback_url: string }> = []) {
  const subs = [...existing];
  const calls: string[] = [];
  let webhook: StravaWebhook | null = null;
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const id = Number(url.pathname.split("/").pop());
    if (method === "GET") return Response.json(subs);
    if (method === "DELETE") {
      subs.splice(
        subs.findIndex((s) => s.id === id),
        1,
      );
      return new Response(null, { status: 204 });
    }
    // Strava validates the callback before creating the subscription.
    const form = new URLSearchParams(String(init?.body));
    const check = webhook!.validate(
      new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.challenge": "c1",
        "hub.verify_token": form.get("verify_token")!,
      }),
    );
    if (check.status !== 200 || check.body["hub.challenge"] !== "c1")
      return new Response("callback not verified", { status: 400 });
    subs.push({ id: 99, callback_url: form.get("callback_url")! });
    return Response.json({ id: 99 }, { status: 201 });
  }) as typeof fetch;
  return { subs, calls, http, bind: (w: StravaWebhook) => (webhook = w) };
}

async function registered(api: ReturnType<typeof fakeStrava>) {
  const engine = new SyncEngine(db);
  const w = new StravaWebhook(db, engine, CALLBACK, { clientId: "1", clientSecret: "x" }, api.http);
  api.bind(w);
  w.start();
  for (let i = 0; i < 50 && !w.active && (await w.status()).state === "registering"; i++)
    await new Promise((r) => setTimeout(r, 10));
  return { w, engine };
}

test("creates a subscription, answering Strava's validation", async () => {
  const api = fakeStrava();
  const { w } = await registered(api);
  assert.equal(w.active, true);
  assert.deepEqual(api.subs, [{ id: 99, callback_url: CALLBACK }]);
  assert.equal((await w.status()).callback_url, "https://strava.mcp.example.com/webhook/<secret>");
  w.stop();
});

test("reuses our subscription and replaces one that points elsewhere", async () => {
  const same = fakeStrava([{ id: 7, callback_url: CALLBACK }]);
  const a = await registered(same);
  assert.equal((await a.w.status()).subscription_id, 7);
  assert.deepEqual(same.calls, ["GET /api/v3/push_subscriptions"]);
  a.w.stop();
  const other = fakeStrava([{ id: 8, callback_url: "https://old.example.com/cb" }]);
  const b = await registered(other);
  assert.deepEqual(other.subs, [{ id: 99, callback_url: CALLBACK }]);
  b.w.stop();
});

test("rejects a validation with the wrong token", () => {
  const w = new StravaWebhook(db, new SyncEngine(db), CALLBACK, { clientId: "1", clientSecret: "x" });
  assert.equal(
    w.validate(new URLSearchParams({ "hub.mode": "subscribe", "hub.challenge": "c", "hub.verify_token": "nope" }))
      .status,
    403,
  );
  assert.equal(w.path, "/webhook/s3cret");
});

test("events queue re-fetches; foreign events are ignored", async () => {
  const api = fakeStrava();
  const { w } = await registered(api);
  const ev = (o: Partial<WebhookEvent>): WebhookEvent => ({
    object_type: "activity",
    object_id: 555,
    aspect_type: "create",
    owner_id: 42,
    subscription_id: 99,
    event_time: 1_800_000_000,
    ...o,
  });
  assert.match(await w.handle(ev({})), /queued activity 555/);
  const jobs = await db.all<{ kind: string; priority: number }>(
    "SELECT kind, priority FROM sync_job WHERE key = '555' ORDER BY kind",
  );
  assert.deepEqual(
    jobs.map((j) => [j.kind, j.priority]),
    [
      ["activity_detail", 5],
      ["activity_streams", 5],
    ],
  );
  assert.equal(await w.handle(ev({ owner_id: 1 })), "ignored: other athlete");
  assert.equal(await w.handle(ev({ subscription_id: 1 })), "ignored: other subscription");
  assert.equal(
    await w.handle(
      ev({ object_type: "athlete", object_id: 42, aspect_type: "update", updates: { authorized: "false" } }),
    ),
    "athlete deauthorized the app",
  );
  assert.equal((await w.status()).events_24h, 2);
  w.stop();
});

test("an active subscription slows the activity-list poll to a safety net", async () => {
  const engine = new SyncEngine(db);
  await db.run("DELETE FROM sync_job");
  await db.run("INSERT OR REPLACE INTO sync_state (name, value, updated_at) VALUES ('last:list_recent', $1, now())", [
    new Date(Date.now() - 30 * 60_000).toISOString(),
  ]);
  engine.setPushActive(true);
  await engine.schedule();
  assert.equal((await db.all("SELECT 1 FROM sync_job WHERE kind = 'list_recent'")).length, 0);
  engine.setPushActive(false);
  await engine.schedule();
  assert.equal((await db.all("SELECT 1 FROM sync_job WHERE kind = 'list_recent'")).length, 1);
});
