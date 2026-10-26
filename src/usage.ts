export const INSTRUCTIONS = `This server is scoped to one authenticated athlete's Strava mirror. Start with strava_sync_status and strava_schema (or strava://mirror/status and strava://mirror/schema), then use bounded strava_query aggregates: local reads cost zero API calls. Coverage is partial until backfill finishes; an empty result does not prove no activity. SQL uses one engine-enforced read-only transaction, at most 5000 rows and 30 seconds; external file/network access is disabled.
Other read tools/resources are cache-first and can refresh from Strava. Prompt retrieval uses only stored data and never starts sync. Preserve source, fetched_at, stale and truncation notices in analyses. Text is capped at 25000 characters; use smaller windows/pages or SQL aggregates. Stream tools downsample to max_points, not full-resolution analysis.
Check strava://mirror/budget before expensive remote reads. Overall and GET/read quotas have separate 15-minute/daily pools, header-driven allowances and background reserves. Missing headers mean unknown accounting, NOT free calls; local estimates cannot see other clients. Single-object refreshes normally cost one request; complete-list refreshes may traverse every upstream page even when requesting one local page. Each Strava API attempt, including a 401 retry, reserves known pools. OAuth token refresh is separate; its allowance is unknown. 429 pauses all priorities until the applicable window reset or later Retry-After; interactive waits are capped at 20 seconds and may serve stale data. Do not tight-loop retries or upload-status polling.
Create/update/upload/star tools write to Strava and require the athlete's intent and scope. Hints are descriptive, not approval gates. Only explicit 401 responses are retried once after token refresh; lost responses/5xx/429 are not automatically replayed. Reconcile an ambiguous write with a read before retrying; duplicate creation is possible.`;

/** Static discovery must remain useful when a client hides templates or initialize instructions. */
export const USAGE_GUIDE = `${INSTRUCTIONS}

Discoverable resources (read via resources/read):
- strava://mirror/schema — table/view list, local only, zero API calls.
- strava://mirror/status — local coverage/queue and cached budget/webhook state; zero API calls, never syncs.
- strava://mirror/budget — authoritative header observations versus local estimates, reserve shares, reset/cooldown times; zero API calls.
- strava://reference/sport-types and strava://reference/stream-types — local reference lists, zero API calls.
- strava://athlete/profile and strava://athlete/stats — cache-first; normally one API request per refresh, with source/fetched_at/stale context.

Resource URI templates (some clients do not list templates):
- strava://mirror/schema/{table}, e.g. strava://mirror/schema/activity — local column types/units/comments, zero API calls; table must be a lowercase identifier.
- strava://activity/{activityId}, e.g. strava://activity/123 — one numeric activity's detail; cache-first, normally one API request on refresh.
- strava://segment/{segmentId}, e.g. strava://segment/123 — one numeric segment's detail; cache-first, normally one API request on refresh.
- strava://route/{routeId}/gpx, e.g. strava://route/123/gpx — cache-first GPX, normally one API request on refresh; returns content, never writes a file.
IDs in examples are placeholders, not instructions to fetch another athlete's data. Resource bodies are limited to 25000 characters and reject oversized JSON/XML rather than silently truncating; query a few stored fields instead.

Workflow prompts (prompts/get; all local only, zero API calls, never queue sync):
- weekly-summary {"week_start":"2026-10-19"} — a seven-day UTC window, strict YYYY-MM-DD; defaults to this Monday UTC, at most 200 stored activities.
- training-plan-review {"days":"30"} — integer string 1-365 days, at most 200 stored activities; defaults to 30.
- race-readiness {"distance":"10k"} — stored profile/stats and up to 200 activities from 90 days; distance is optional, at most 200 characters. Displays only the 10 most recent activities separately.
- activity-analysis {"activity_id":"123"} — one stored detail with optional stream summaries; missing streams are disclosed, not fetched.
- segment-comparison {"segment_id":"123"} — one stored segment and at most 200 stored segment-effort rows (from details or fetched effort lists).
Prompt bodies are capped at 25000 characters with a truncation notice. A cap or incomplete backfill means totals are partial; check status before interpreting empty or sparse history. Missing stored context fails with refresh guidance. Refresh intentionally via the matching read tools only when budget permits: each detail/profile/stats/stream is normally one request, while activity/effort/list refreshes can traverse all pages.

Bounded local-first example: strava_schema {"table":"activity"}, then strava_query {"sql":"SELECT sport_type, count(*) AS activities, sum(distance) AS meters FROM activity WHERE deleted_at IS NULL AND start_date >= now() - INTERVAL 30 DAY GROUP BY sport_type","max_rows":20}. This costs zero API calls; report local coverage alongside the totals. Prefer this to fetching hundreds of details.`;
