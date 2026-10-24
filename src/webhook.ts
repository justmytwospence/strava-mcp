/**
 * Strava push subscriptions (webhooks): Strava calls us when an activity is created,
 * edited or deleted, or the athlete changes or deauthorizes, so the mirror learns of new
 * activities without polling the activity list.
 *
 * The callback URL (STRAVA_WEBHOOK_URL) is public, so its path carries a secret, and an
 * event is only a hint: it queues a re-fetch from the API, it is never stored as data.
 * Events for another subscription or athlete are ignored. Strava expects a 200 within
 * two seconds, so events are acknowledged first and handled afterwards.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "./db/database.js";
import type { SyncEngine } from "./sync/engine.js";
import { STRAVA_API_BASE } from "./constants.js";

/** On-demand priority: an event is about something that just changed. */
const EVENT_PRIORITY = 5;
const RECHECK_MS = 6 * 3_600_000;
const RETRY_MS = [30_000, 120_000, 600_000, 3_600_000];

export interface WebhookEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  owner_id: number;
  subscription_id: number;
  event_time: number;
  updates?: Record<string, string>;
}

export interface WebhookStatus {
  callback_url: string;
  subscription_id: number | null;
  state: "registering" | "active" | "failed";
  error: string | null;
  last_event_at: string | null;
  events_24h: number;
}

type Fetch = typeof fetch;

export class StravaWebhook {
  readonly path: string;
  private readonly verifyToken = randomBytes(16).toString("hex");
  private subscriptionId: number | null = null;
  private state: WebhookStatus["state"] = "registering";
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly engine: SyncEngine,
    readonly callbackUrl: string,
    private readonly credentials: { clientId: string; clientSecret: string },
    private readonly http: Fetch = fetch,
  ) {
    this.path = new URL(callbackUrl).pathname;
  }

  /** Strava's subscription validation: echo the challenge if the token is ours. */
  validate(query: URLSearchParams): { status: number; body: Record<string, string> } {
    if (query.get("hub.mode") === "subscribe" && query.get("hub.verify_token") === this.verifyToken) {
      return { status: 200, body: { "hub.challenge": query.get("hub.challenge") ?? "" } };
    }
    return { status: 403, body: { error: "verify token mismatch" } };
  }

  /** Handle one event. Returns what was queued (for logs and tests). */
  async handle(event: WebhookEvent): Promise<string> {
    if (this.subscriptionId !== null && event.subscription_id !== this.subscriptionId) return "ignored: other subscription";
    const athlete = await this.db.one<{ id: number | bigint }>("SELECT id FROM athlete LIMIT 1");
    if (athlete && Number(athlete.id) !== Number(event.owner_id)) return "ignored: other athlete";
    const key = String(event.object_id);
    let outcome: string;
    if (event.object_type === "activity") {
      // A detail re-fetch covers create, edit and delete (a 404 marks the activity deleted);
      // the planner then queues streams, zones and the rest for a new activity.
      await this.engine.enqueue("activity_detail", key, EVENT_PRIORITY, event.event_time);
      if (event.aspect_type === "create") await this.engine.enqueue("activity_streams", key, EVENT_PRIORITY, event.event_time);
      outcome = `queued activity ${key} (${event.aspect_type})`;
    } else if (event.updates?.authorized === "false") {
      outcome = "athlete deauthorized the app";
      console.error("strava webhook: the athlete deauthorized the app; sync will fail until re-authorized");
    } else {
      await this.engine.enqueue("athlete", "self", EVENT_PRIORITY);
      outcome = "queued athlete";
    }
    await this.db.run(
      "INSERT INTO sync_log (logged_at, kind, key, outcome, detail) VALUES (now(), 'webhook', $1, 'ok', $2)",
      [`${event.object_type}:${event.aspect_type}:${key}`, outcome],
    );
    return outcome;
  }

  /** Make sure Strava's one subscription for this app points at our callback, retrying until it does. */
  start(): void {
    void this.register(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get active(): boolean {
    return this.state === "active";
  }

  async status(): Promise<WebhookStatus> {
    const row = await this.db.one<{ last: string | null; n: number }>(
      `SELECT max(logged_at)::VARCHAR AS last, count(*) FILTER (WHERE logged_at > now() - INTERVAL 1 DAY)::INTEGER AS n
       FROM sync_log WHERE kind = 'webhook'`,
    );
    return {
      callback_url: this.callbackUrl.replace(this.path, "/webhook/<secret>"),
      subscription_id: this.subscriptionId,
      state: this.state,
      error: this.error,
      last_event_at: row?.last ?? null,
      events_24h: row?.n ?? 0,
    };
  }

  private async register(attempt: number): Promise<void> {
    try {
      this.subscriptionId = await this.ensureSubscription();
      this.state = "active";
      this.error = null;
      this.engine.setPushActive(true);
      if (attempt >= 0) console.error(`strava webhook: subscription ${this.subscriptionId} active`);
      // Re-check now and then: a deleted subscription would otherwise go unnoticed.
      this.timer = setTimeout(() => void this.register(-1), RECHECK_MS);
    } catch (err) {
      this.state = "failed";
      this.error = err instanceof Error ? err.message : String(err);
      this.engine.setPushActive(false);
      const wait = RETRY_MS[Math.min(Math.max(attempt, 0), RETRY_MS.length - 1)];
      console.error(`strava webhook: registration failed (${this.error}); retrying in ${wait / 1000}s`);
      this.timer = setTimeout(() => void this.register(Math.max(attempt, 0) + 1), wait);
    }
  }

  private async ensureSubscription(): Promise<number> {
    const { clientId, clientSecret } = this.credentials;
    const url = `${STRAVA_API_BASE}/push_subscriptions`;
    const auth = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
    const list = await this.http(`${url}?${auth}`);
    if (!list.ok) throw new Error(`listing subscriptions: HTTP ${list.status} ${await list.text()}`);
    const subs = (await list.json()) as Array<{ id: number; callback_url: string }>;
    const ours = subs.find((s) => s.callback_url === this.callbackUrl);
    if (ours) return ours.id;
    // An app has at most one subscription: replace one that points elsewhere.
    for (const s of subs) {
      const del = await this.http(`${url}/${s.id}?${auth}`, { method: "DELETE" });
      if (!del.ok && del.status !== 404) throw new Error(`deleting subscription ${s.id}: HTTP ${del.status}`);
    }
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      callback_url: this.callbackUrl,
      verify_token: this.verifyToken,
    });
    // Strava validates the callback (GET with hub.challenge) before answering this POST.
    const created = await this.http(url, { method: "POST", body: form });
    if (!created.ok) throw new Error(`creating subscription: HTTP ${created.status} ${await created.text()}`);
    return ((await created.json()) as { id: number }).id;
  }
}
