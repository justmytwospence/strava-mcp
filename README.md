# Strava MCP Server

An MCP (Model Context Protocol) server that provides tools for interacting with the [Strava API v3](https://developers.strava.com/docs/reference/). Built with TypeScript and the [MCP SDK](https://modelcontextprotocol.io/).

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

### 4. Add to Claude Desktop

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
