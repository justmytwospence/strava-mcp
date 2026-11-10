# Export API

`GET /export/sync` returns a small JSON document for other services that act on what the mirror knows: the starred routes, and the activities that started since a given time. It is computed live from the mirror on every request, so a consumer sees a change as soon as the sync has it, without waiting for the next [snapshot](../data/index.md#the-snapshot). It costs no Strava request and is a few kilobytes.

The first consumer is [garmin-mcp's Strava sync](../integrations/garmin-mcp.md), which renames Garmin activities after their Strava names and deletes the courses Strava made for routes that are no longer starred. Anything else may read it; the contract below is stable within a major version.

## Canonical activity export

With `STRAVA_EXPORT=canonical`, every activity's recorded stream is also written as one Parquet file (one row per whole second: `t`, `lat`, `lng`, `alt`, `dist`, `hr`, `power`, `cadence`) plus a `manifest.json`, in the canonical-v1 format of the Effort Curve app (the same as garmin-mcp's). It is rebuilt from each published snapshot and served at `GET /export/canonical/v1/manifest.json` and `GET /export/canonical/v1/activities/strava-<id>.parquet` with the bearer `EXPORT_TOKEN` (not `SNAPSHOT_TOKEN`; the route is disabled without it). `EXPORT_CORS_ORIGINS` lists the browser origins allowed to read it. Manual activities and activities without streams are left out; `power` is exported only when it came from a power meter; cadence is as Strava reports it (runs: one-leg steps per minute). Each manifest entry has `tags`, from the activity's workout type: `race` (run 1, ride 11), `long_run` (run 2) or `workout` (run 3, ride 12), else none.

### Signing in from a browser app

Effort Curve connects with an OAuth 2.1 authorization-code flow (PKCE), so the user never pastes a token into the app. `GET /export/canonical/v1/auth` (no authentication, CORS) describes the sign-in: `{mode, issuer, authorization_endpoint, token_endpoint, client_id, scope}`.

- **Built-in** (default): `/export/canonical/v1/oauth/authorize` shows a one-page approval where the user enters `EXPORT_TOKEN` once; `/export/canonical/v1/oauth/token` issues signed access (1 h) and refresh (90 days, rotated) tokens. The redirect must be `<origin>/oauth/callback` with the origin in `EXPORT_CORS_ORIGINS`. Changing `EXPORT_TOKEN` revokes every token.
- **OIDC**: set `EXPORT_OIDC_ISSUER` (and optionally `EXPORT_OIDC_CLIENT_ID`, default `effortcurve`). The app signs in at your provider and the export accepts its JWTs whose `client_id` or `azp` is that client. Register a public PKCE client with the redirect `https://effortcurve.com/oauth/callback`, scopes `openid offline_access`, and allow the app's origin in the provider's CORS settings for the token endpoint.

`Bearer EXPORT_TOKEN` keeps working for proxies and scripts.

## Request

```text
GET /export/sync?since=<time>
Authorization: Bearer <SNAPSHOT_TOKEN>
```

| | |
|---|---|
| Path | `/export/sync`. `/export/garmin-sync` is an alias (the name in 4.2) and answers identically. |
| Authentication | The `SNAPSHOT_TOKEN` bearer, the same token that serves `/snapshot.duckdb`. With `SNAPSHOT_TOKEN` unset the endpoint answers `404`; with a wrong token, `401`. |
| `since` | Optional. An ISO 8601 date or timestamp (`2026-10-01`, `2026-10-01T06:00:00Z`); anything `new Date()` parses. Activities that started at or after it are returned, in chronological order. Without `since`, `activities` is empty. An unparseable value answers `400`. |
| Transport | Only over the HTTP transport (`MCP_TRANSPORT=http`). With the `oauth` profile the gateway does not proxy this path; call the server's own port, as the snapshot. |

## Response

`200` with `Content-Type: application/json`:

```json
{
  "generated_at": "2026-10-25T06:12:40.118Z",
  "route_list_checked_at": "2026-10-25T06:00:03.512Z",
  "activity_list_checked_at": "2026-10-25T06:10:11.907Z",
  "starred_routes": [
    {
      "id": "3302612345678901234",
      "name": "Sunday loop",
      "distance": 64210.5,
      "start": [47.3769, 8.5417]
    }
  ],
  "activities": [
    {
      "id": "16012345678",
      "name": "Coffee ride",
      "start_date": "2026-10-24T07:02:15.000Z",
      "elapsed_time": 5421
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `generated_at` | string, ISO 8601 UTC | When this response was computed. |
| `route_list_checked_at` | string or null | When the route list, and so the `starred` flags, was last fetched from Strava. `null` before the first fetch. |
| `activity_list_checked_at` | string or null | When the recent activity list was last fetched. Webhook events update individual activities between listings, so an activity can be newer than this. `null` before the first listing. |
| `starred_routes` | array | Every route of the athlete with `starred` true in the mirror, ordered by id. Unstarred and deleted routes are absent. |
| `starred_routes[].id` | string | The route id, **as a string**: route ids exceed 2^53 and would lose precision as a JSON number in most parsers. Compare it as text. |
| `starred_routes[].name` | string | The route's name; an empty string when Strava reported none. |
| `starred_routes[].distance` | number or null | Length in meters. |
| `starred_routes[].start` | `[lat, lng]` or null | First point of the route's summary polyline, decimal degrees; `null` for a route without a polyline. |
| `activities` | array | Activities not deleted on Strava whose `start_date` is at or after `since`, oldest first. Empty without `since`. |
| `activities[].id` | string | The activity id, as a string, for the same reason as routes. |
| `activities[].name` | string | The activity's current name in the mirror. |
| `activities[].start_date` | string, ISO 8601 UTC | Start time in UTC (Strava's `start_date`, not the local wall-clock `start_date_local`). |
| `activities[].elapsed_time` | number or null | Elapsed seconds. |

## Freshness

The response reflects the mirror, not Strava, at the moment of the request:

- **Names and new activities** arrive through the webhook within seconds when `STRAVA_WEBHOOK_URL` is set, otherwise through the activity-list poll every 15 minutes. `activity_list_checked_at` says when that poll last ran.
- **Starred flags** come only from the route-list poll, since Strava sends no event for starring or unstarring: every `STRAVA_ROUTES_INTERVAL_MINUTES` (an hour by default, five at the lowest). `route_list_checked_at` says when it last ran. A consumer that deletes things based on the starred flag should lower the interval and should treat an old `route_list_checked_at` as a reason to wait, not to act.
- **Deleted activities** disappear from `activities` as soon as the mirror learns of the deletion (webhook event, or the daily 90-day relisting and the weekly full relisting).

## Example

```sh
curl -s -H "Authorization: Bearer $SNAPSHOT_TOKEN" \
  'http://<host>:8000/export/sync?since=2026-10-01T00:00:00Z' | jq '.activities[] | {id, name}'
```

## Compatibility

Fields are only added, never renamed or removed, within a major version; a consumer should ignore fields it does not know. The `/export/garmin-sync` alias stays until the next major version.
