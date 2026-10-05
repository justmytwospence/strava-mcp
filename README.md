# Strava MCP Server

An MCP (Model Context Protocol) server for the [Strava API v3](https://developers.strava.com/docs/reference/). Exposes Strava data through MCP tools, resources, and prompts. Built with TypeScript and the [MCP SDK](https://modelcontextprotocol.io/).

## Tools

### Activities
- **strava_list_activities** - List the authenticated athlete's activities with date range filtering and pagination
- **strava_get_activity** - Get detailed activity info including splits, laps, segment efforts, and gear
- **strava_create_activity** - Create a manual activity entry
- **strava_update_activity** - Update an activity's mutable properties
- **strava_list_activity_comments** - List comments on an activity
- **strava_list_activity_kudoers** - List athletes who gave kudos
- **strava_list_activity_laps** - List laps with distance, time, speed, heart rate, watts, and elevation
- **strava_list_activity_zones** - Get heart rate and power zone distribution

### Athletes
- **strava_get_authenticated_athlete** - Get the authenticated athlete's profile
- **strava_get_athlete_zones** - Get heart rate and power zones
- **strava_get_athlete_stats** - Get year-to-date and all-time totals for runs, rides, and swims

### Segments
- **strava_get_segment** - Get segment details including distance, elevation, grade, and effort count
- **strava_list_segment_efforts** - List efforts on a segment with date range filtering
- **strava_get_segment_effort** - Get a specific segment effort with achievements
- **strava_explore_segments** - Find popular segments within a geographic bounding box
- **strava_star_segment** - Star or unstar a segment

### Routes
- **strava_list_athlete_routes** - List routes created by an athlete
- **strava_get_route** - Get detailed route information
- **strava_export_route_gpx** - Export a route as GPX
- **strava_export_route_tcx** - Export a route as TCX

### Streams (Time-Series Data)
- **strava_get_activity_streams** - Get activity streams (heart rate, power, cadence, altitude, GPS, etc.)
- **strava_get_segment_effort_streams** - Get segment effort streams
- **strava_get_segment_streams** - Get segment GPS/altitude data
- **strava_get_route_streams** - Get route GPS/altitude data

### Clubs
- **strava_list_athlete_clubs** - List clubs the athlete belongs to
- **strava_get_club** - Get club details
- **strava_list_club_activities** - List recent club member activities
- **strava_list_club_members** - List club members
- **strava_list_club_admins** - List club admins

### Gear
- **strava_get_gear** - Get equipment details (bikes, shoes)

### Uploads
- **strava_create_upload** - Upload a FIT/TCX/GPX file to create an activity
- **strava_get_upload** - Check upload processing status

## Resources

Resources provide read-only context data that clients can pull into conversations.

### Static Resources

| URI | Description |
|---|---|
| `strava://athlete/profile` | Current authenticated athlete profile (name, location, bikes, shoes) |
| `strava://athlete/stats` | Year-to-date and all-time activity totals for runs, rides, and swims |
| `strava://reference/sport-types` | Valid `sport_type` values for create/update activity |
| `strava://reference/stream-types` | Available stream keys, descriptions, and which tools accept them |

### Template Resources

| URI Template | Description |
|---|---|
| `strava://activity/{activityId}` | Detailed activity by ID |
| `strava://segment/{segmentId}` | Detailed segment by ID |
| `strava://route/{routeId}/gpx` | Export a route as GPX |

## Prompts

Prompts are user-triggered prompt templates that fetch relevant Strava data and ask the LLM for analysis.

| Prompt | Arguments | Description |
|---|---|---|
| `weekly-summary` | `week_start?` (ISO date) | Summarize training for a given week |
| `activity-analysis` | `activity_id` (required) | Deep analysis of pacing, effort, and performance for a single activity |
| `training-plan-review` | `days?` (default 30) | Review training load, volume progression, and overtraining risk |
| `segment-comparison` | `segment_id` (required) | Compare all efforts on a segment to identify trends |
| `race-readiness` | `distance?` (e.g. "marathon") | Assess fitness and race readiness based on recent training |

## Setup

### 1. Create a Strava API Application

Go to [Strava API Settings](https://www.strava.com/settings/api) and create an application. Note your Client ID and Client Secret.

### 2. Get an Access Token

You need an access token with the appropriate scopes. For read-only access use `read,activity:read_all`. For write access add `activity:write`.

You can obtain tokens through Strava's [OAuth flow](https://developers.strava.com/docs/authentication/). The server will automatically refresh expired tokens if `STRAVA_REFRESH_TOKEN`, `STRAVA_CLIENT_ID`, and `STRAVA_CLIENT_SECRET` are set.

### 3. Configure Environment Variables

```sh
export STRAVA_CLIENT_ID="your_client_id"
export STRAVA_CLIENT_SECRET="your_client_secret"
export STRAVA_ACCESS_TOKEN="your_access_token"
export STRAVA_REFRESH_TOKEN="your_refresh_token"
```

Optionally set `STRAVA_UNITS` to `metric` or `imperial` to control how distances, paces, and elevations are formatted in prompts. If unset, the server uses the athlete's Strava measurement preference, falling back to metric.

### 4. Run it as a service (Docker)

```sh
cp .env.example .env   # fill in the STRAVA_* values
docker compose up -d
```

The server speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28)
at `http://<host>:8000/mcp` (also at `/`), with a health check at `/health`, and serves both
2026-07-28 and older session-based clients:

```json
{ "mcpServers": { "strava": { "type": "http", "url": "http://localhost:8000/mcp" } } }
```

| Variable | Default | Meaning |
|---|---|---|
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | (required) | Your Strava API application |
| `STRAVA_REFRESH_TOKEN` / `STRAVA_ACCESS_TOKEN` | (one required) | OAuth tokens; access tokens are refreshed automatically |
| `STRAVA_TOKEN_FILE` | (unset; `/data/tokens.json` in compose) | Where rotated tokens are persisted, so a restart never needs a new OAuth flow |
| `STRAVA_UNITS` | athlete preference | `metric` or `imperial` |
| `MCP_TRANSPORT` | `stdio` (`http` in the image) | `stdio` or `http` |
| `PORT` | `8000` | HTTP port |
| `MCP_ALLOWED_HOSTS` | (any) | Comma-separated hostnames allowed in the `Host` header (set it behind a reverse proxy) |

Images: `ghcr.io/justmytwospence/strava-mcp`, published for amd64 and arm64 by pushing a
`vX.Y.Z` tag.

### 5. Or run it over stdio (Claude Desktop)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "strava": {
      "command": "npx",
      "args": ["-y", "strava-mcp-server"],
      "env": {
        "STRAVA_CLIENT_ID": "your_client_id",
        "STRAVA_CLIENT_SECRET": "your_client_secret",
        "STRAVA_ACCESS_TOKEN": "your_access_token",
        "STRAVA_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

Or if installed locally:

```json
{
  "mcpServers": {
    "strava": {
      "command": "node",
      "args": ["/path/to/strava-mcp/dist/index.js"],
      "env": {
        "STRAVA_CLIENT_ID": "your_client_id",
        "STRAVA_CLIENT_SECRET": "your_client_secret",
        "STRAVA_ACCESS_TOKEN": "your_access_token",
        "STRAVA_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

## Development

```sh
npm install
npm run build
npm run dev    # watch mode with tsx
```

## License

MIT
