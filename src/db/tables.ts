/**
 * The typed layer: every table, its columns, their comments, and how each column is
 * read out of the raw JSON. DDL, projections and the drift check are all generated
 * from these definitions, so a column cannot be declared without a source or mapped
 * without a declaration.
 *
 * Expressions are DuckDB SQL over the alias `b` (the JSON object being projected)
 * plus whatever context aliases the table's projection provides (`src`, `p`, ...).
 * Units follow Strava: meters, seconds, meters per second, degrees Celsius, watts.
 */

export interface Column {
  name: string;
  type: string;
  comment: string;
  /** SQL producing the value. Defaults to a TRY_CAST of b->>'<key>'. */
  expr: string;
  /** Top-level JSON key this column consumes (for the drift check); null for context columns. */
  key: string | null;
}

export interface Table {
  name: string;
  comment: string;
  primaryKey: string[];
  columns: Column[];
}

function defaultExpr(key: string, type: string): string {
  if (type === "JSON") return `b->'${key}'`;
  if (type.endsWith("[]")) return `TRY_CAST(b->'${key}' AS ${type})`;
  if (type === "TIMESTAMP") return `TRY_CAST(left(b->>'${key}', 19) AS TIMESTAMP)`;
  if (type === "VARCHAR") return `b->>'${key}'`;
  return `TRY_CAST(b->>'${key}' AS ${type})`;
}

/** A column read straight from the JSON key of the same name. */
export function col(name: string, type: string, comment: string, key: string = name): Column {
  return { name, type, comment, expr: defaultExpr(key, type), key };
}

/** A column computed by an explicit expression; `key` names the JSON key it consumes. */
export function expr(name: string, type: string, comment: string, sql: string, key: string | null = null): Column {
  return { name, type, comment, expr: sql, key };
}

const fetchedAt = expr("fetched_at", "TIMESTAMPTZ", "When this row's source payload was fetched from Strava.", "src.fetched_at");

// ---------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------

/** Columns shared by SummaryActivity and DetailedActivity. */
const activitySummaryColumns: Column[] = [
  col("id", "BIGINT", "Strava activity id."),
  expr("athlete_id", "BIGINT", "Owning athlete id.", "TRY_CAST(b->'athlete'->>'id' AS BIGINT)", "athlete"),
  col("name", "VARCHAR", "Activity title."),
  col("sport_type", "VARCHAR", "Sport type (Run, Ride, TrailRun, ...); the precise successor of `type`."),
  col("type", "VARCHAR", "Legacy activity type (deprecated by Strava in favor of sport_type)."),
  col("workout_type", "INTEGER", "Workout tag: run 0 default, 1 race, 2 long run, 3 workout; ride 10 default, 11 race, 12 workout."),
  col("start_date", "TIMESTAMPTZ", "Start time (UTC)."),
  col("start_date_local", "TIMESTAMP", "Start time in the activity's local time zone (wall clock)."),
  col("timezone", "VARCHAR", "Strava time zone label, e.g. '(GMT-07:00) America/Denver'."),
  col("utc_offset", "DOUBLE", "Offset of local time from UTC at the start, in seconds."),
  col("distance", "DOUBLE", "Distance in meters."),
  col("moving_time", "INTEGER", "Moving time in seconds."),
  col("elapsed_time", "INTEGER", "Elapsed time in seconds."),
  col("total_elevation_gain", "DOUBLE", "Elevation gain in meters."),
  col("elev_high", "DOUBLE", "Highest elevation in meters."),
  col("elev_low", "DOUBLE", "Lowest elevation in meters."),
  col("average_speed", "DOUBLE", "Average speed in meters per second."),
  col("max_speed", "DOUBLE", "Maximum speed in meters per second."),
  col("average_cadence", "DOUBLE", "Average cadence (rpm; for runs Strava reports one-leg steps per minute)."),
  col("average_temp", "DOUBLE", "Average temperature in degrees Celsius (device sensor)."),
  col("average_watts", "DOUBLE", "Average power in watts (estimated when device_watts is false)."),
  col("weighted_average_watts", "DOUBLE", "Strava's weighted (normalized-power-like) average power in watts."),
  col("max_watts", "DOUBLE", "Maximum power in watts (power meter only)."),
  col("kilojoules", "DOUBLE", "Work done in kilojoules (rides)."),
  col("device_watts", "BOOLEAN", "True when power came from a power meter rather than Strava's estimate."),
  col("has_heartrate", "BOOLEAN", "Whether heart rate was recorded."),
  col("average_heartrate", "DOUBLE", "Average heart rate in bpm."),
  col("max_heartrate", "DOUBLE", "Maximum heart rate in bpm."),
  col("heartrate_opt_out", "BOOLEAN", "Athlete hid heart rate on this activity."),
  col("display_hide_heartrate_option", "BOOLEAN", "Whether Strava offers the hide-heart-rate option."),
  col("suffer_score", "DOUBLE", "Relative Effort score."),
  col("achievement_count", "INTEGER", "Number of achievements (PRs, KOMs, ...)."),
  col("pr_count", "INTEGER", "Number of personal records set."),
  col("kudos_count", "INTEGER", "Number of kudos."),
  col("comment_count", "INTEGER", "Number of comments."),
  col("athlete_count", "INTEGER", "Number of athletes who did this activity together (group size)."),
  col("photo_count", "INTEGER", "Number of Instagram photos (legacy)."),
  col("total_photo_count", "INTEGER", "Number of photos, all sources."),
  col("trainer", "BOOLEAN", "Recorded on a trainer / indoors."),
  col("commute", "BOOLEAN", "Marked as a commute."),
  col("manual", "BOOLEAN", "Entered manually (no file, no streams)."),
  col("private", "BOOLEAN", "Private activity (legacy flag; see visibility)."),
  col("visibility", "VARCHAR", "everyone, followers_only or only_me."),
  col("flagged", "BOOLEAN", "Flagged by Strava or other athletes."),
  col("from_accepted_tag", "BOOLEAN", "Created by accepting a group activity tag."),
  col("has_kudoed", "BOOLEAN", "Whether the authenticated athlete kudoed it."),
  col("gear_id", "VARCHAR", "Gear used (references gear.id)."),
  col("device_name", "VARCHAR", "Recording device, e.g. 'Garmin Fenix 7'."),
  col("external_id", "VARCHAR", "Identifier from the upload source (Garmin: garmin_ping_<id>, not the Garmin activity id)."),
  col("upload_id", "BIGINT", "Upload id (the bulk export names original files by it)."),
  col("upload_id_str", "VARCHAR", "Upload id as a string."),
  col("start_latlng", "DOUBLE[]", "Start [lat, lng]."),
  col("end_latlng", "DOUBLE[]", "End [lat, lng]."),
  col("location_city", "VARCHAR", "City (often null)."),
  col("location_state", "VARCHAR", "State (often null)."),
  col("location_country", "VARCHAR", "Country (often null)."),
  expr("map_id", "VARCHAR", "Map id.", "b->'map'->>'id'", "map"),
  expr("summary_polyline", "VARCHAR", "Google-encoded summary polyline.", "b->'map'->>'summary_polyline'", "map"),
  col("tags", "JSON", "Activity tags (WithPet, Recovery, Competition, ForACause, Commute)."),
];

/** Columns only DetailedActivity carries. */
const activityDetailColumns: Column[] = [
  col("description", "VARCHAR", "Activity description."),
  col("private_note", "VARCHAR", "Private note visible only to the athlete."),
  col("calories", "DOUBLE", "Calories (kilocalories) as Strava computes them."),
  col("perceived_exertion", "DOUBLE", "Perceived exertion (1-10) if entered."),
  col("prefer_perceived_exertion", "BOOLEAN", "Use perceived exertion instead of heart rate for Relative Effort."),
  col("hide_from_home", "BOOLEAN", "Muted from home feeds."),
  col("embed_token", "VARCHAR", "Token for embedding the activity."),
  expr("polyline", "VARCHAR", "Google-encoded full-resolution polyline.", "b->'map'->>'polyline'", "map"),
  col("available_zones", "VARCHAR[]", "Zone types available for this activity (heartrate, power, pace)."),
  col("stats_visibility", "JSON", "Per-stat visibility settings."),
  col("similar_activities", "JSON", "Strava's comparison with similar efforts (trend of speeds, PR rank)."),
  col("sport_image_visibility", "VARCHAR", "Visibility of the sport image."),
  expr("photos_summary", "JSON", "Primary photo and photo count as shown on the activity.", "b->'photos'", "photos"),
  expr("gear_summary", "JSON", "Gear as embedded in the activity (name, distance at fetch time).", "b->'gear'", "gear"),
];

const activityTable: Table = {
  name: "activity",
  comment:
    "One row per Strava activity of the athlete. Summary columns come from the newest of the list or detail payload; detail-only columns are null until the detail is fetched. Deleted activities are kept with deleted_at set.",
  primaryKey: ["id"],
  columns: [
    ...activitySummaryColumns,
    ...activityDetailColumns.map((c) => ({ ...c, expr: c.expr.replace(/\bb->/g, "d->") })),
    expr("summary_fetched_at", "TIMESTAMPTZ", "When the newest list (summary) payload was fetched.", "src.summary_fetched_at"),
    expr("detail_fetched_at", "TIMESTAMPTZ", "When the detail payload was fetched; null if never.", "src.detail_fetched_at"),
    expr("deleted_at", "TIMESTAMPTZ", "When the activity was found deleted on Strava; null while it exists.", "src.deleted_at"),
  ],
};

const segmentEffortColumns: Column[] = [
  col("id", "BIGINT", "Segment effort id."),
  expr("activity_id", "BIGINT", "Activity the effort belongs to.", "TRY_CAST(b->'activity'->>'id' AS BIGINT)", "activity"),
  expr("segment_id", "BIGINT", "Segment ridden or run.", "TRY_CAST(b->'segment'->>'id' AS BIGINT)", "segment"),
  expr("athlete_id", "BIGINT", "Athlete id.", "TRY_CAST(b->'athlete'->>'id' AS BIGINT)", "athlete"),
  col("name", "VARCHAR", "Segment name at the time of the effort."),
  col("start_date", "TIMESTAMPTZ", "Effort start (UTC)."),
  col("start_date_local", "TIMESTAMP", "Effort start, local wall clock."),
  col("elapsed_time", "INTEGER", "Elapsed time in seconds."),
  col("moving_time", "INTEGER", "Moving time in seconds."),
  col("distance", "DOUBLE", "Distance in meters."),
  col("start_index", "INTEGER", "Index into the activity's streams where the effort starts."),
  col("end_index", "INTEGER", "Index into the activity's streams where the effort ends."),
  col("average_cadence", "DOUBLE", "Average cadence."),
  col("average_watts", "DOUBLE", "Average power in watts."),
  col("device_watts", "BOOLEAN", "Power from a power meter."),
  col("average_heartrate", "DOUBLE", "Average heart rate in bpm."),
  col("max_heartrate", "DOUBLE", "Maximum heart rate in bpm."),
  col("pr_rank", "INTEGER", "1-3 when this effort was the athlete's 1st-3rd best at the time; null otherwise."),
  col("kom_rank", "INTEGER", "1-10 when this effort placed in the overall top 10 at the time; null otherwise."),
  col("achievements", "JSON", "Achievements earned ([{type_id, type, rank}])."),
  col("visibility", "VARCHAR", "Effort visibility."),
  col("hidden", "BOOLEAN", "Hidden effort (e.g. auto-hidden for being implausible)."),
  col("is_kom", "BOOLEAN", "Whether this effort is the current KOM/QOM (segment effort lists only)."),
  col("athlete_segment_stats", "JSON", "Athlete's PR and effort count on the segment (single-effort fetches only)."),
];

const bestEffortColumns: Column[] = [
  col("id", "BIGINT", "Best effort id."),
  expr("activity_id", "BIGINT", "Activity id.", "TRY_CAST(b->'activity'->>'id' AS BIGINT)", "activity"),
  expr("athlete_id", "BIGINT", "Athlete id.", "TRY_CAST(b->'athlete'->>'id' AS BIGINT)", "athlete"),
  col("name", "VARCHAR", "Effort name, e.g. '5k', '1 mile', 'Half-Marathon'."),
  col("distance", "DOUBLE", "Target distance in meters."),
  col("elapsed_time", "INTEGER", "Elapsed time in seconds."),
  col("moving_time", "INTEGER", "Moving time in seconds."),
  col("start_date", "TIMESTAMPTZ", "Start (UTC)."),
  col("start_date_local", "TIMESTAMP", "Start, local wall clock."),
  col("start_index", "INTEGER", "Stream index of the start."),
  col("end_index", "INTEGER", "Stream index of the end."),
  col("pr_rank", "INTEGER", "1-3 when this was a top-3 personal best at the time."),
  col("achievements", "JSON", "Achievements earned."),
];

const lapColumns: Column[] = [
  col("id", "BIGINT", "Lap id."),
  expr("activity_id", "BIGINT", "Activity id.", "TRY_CAST(b->'activity'->>'id' AS BIGINT)", "activity"),
  expr("athlete_id", "BIGINT", "Athlete id.", "TRY_CAST(b->'athlete'->>'id' AS BIGINT)", "athlete"),
  col("lap_index", "INTEGER", "1-based lap number."),
  col("split", "INTEGER", "Split number."),
  col("name", "VARCHAR", "Lap name."),
  col("start_date", "TIMESTAMPTZ", "Lap start (UTC)."),
  col("start_date_local", "TIMESTAMP", "Lap start, local wall clock."),
  col("elapsed_time", "INTEGER", "Elapsed time in seconds."),
  col("moving_time", "INTEGER", "Moving time in seconds."),
  col("distance", "DOUBLE", "Distance in meters."),
  col("start_index", "INTEGER", "Stream index of the start."),
  col("end_index", "INTEGER", "Stream index of the end."),
  col("total_elevation_gain", "DOUBLE", "Elevation gain in meters."),
  col("average_speed", "DOUBLE", "Average speed in m/s."),
  col("max_speed", "DOUBLE", "Max speed in m/s."),
  col("average_cadence", "DOUBLE", "Average cadence."),
  col("average_watts", "DOUBLE", "Average power in watts."),
  col("device_watts", "BOOLEAN", "Power from a power meter."),
  col("average_heartrate", "DOUBLE", "Average heart rate in bpm."),
  col("max_heartrate", "DOUBLE", "Max heart rate in bpm."),
  col("pace_zone", "INTEGER", "Pace zone of the lap (runs)."),
];

const splitColumns: Column[] = [
  expr("activity_id", "BIGINT", "Activity id.", "src.activity_id"),
  expr("units", "VARCHAR", "'metric' (1 km splits) or 'standard' (1 mile splits).", "src.units"),
  col("split", "INTEGER", "1-based split number."),
  col("distance", "DOUBLE", "Distance in meters (the last split is usually partial)."),
  col("elapsed_time", "INTEGER", "Elapsed time in seconds."),
  col("moving_time", "INTEGER", "Moving time in seconds."),
  col("elevation_difference", "DOUBLE", "Net elevation change in meters."),
  col("average_speed", "DOUBLE", "Average speed in m/s."),
  col("average_grade_adjusted_speed", "DOUBLE", "Grade-adjusted average speed in m/s."),
  col("average_heartrate", "DOUBLE", "Average heart rate in bpm."),
  col("pace_zone", "INTEGER", "Pace zone."),
];

const zoneColumns: Column[] = [
  expr("activity_id", "BIGINT", "Activity id.", "src.activity_id"),
  col("type", "VARCHAR", "heartrate or power."),
  col("score", "DOUBLE", "Strava's zone score for the activity."),
  col("points", "INTEGER", "Zone points."),
  col("sensor_based", "BOOLEAN", "Computed from sensor data."),
  col("custom_zones", "BOOLEAN", "Athlete uses custom zones."),
  col("max", "INTEGER", "Max value for the zone distribution."),
  col("distribution_buckets", "JSON", "Raw buckets; also unnested into activity_zone_bucket."),
];

const zoneBucketColumns: Column[] = [
  expr("activity_id", "BIGINT", "Activity id.", "src.activity_id"),
  expr("type", "VARCHAR", "heartrate or power.", "src.type"),
  expr("bucket_index", "INTEGER", "0-based zone index.", "src.bucket_index"),
  col("min", "DOUBLE", "Lower bound (bpm or watts)."),
  col("max", "DOUBLE", "Upper bound (bpm or watts); -1 means unbounded."),
  col("time", "DOUBLE", "Seconds spent in the zone."),
];

const kudoerColumns: Column[] = [
  expr("activity_id", "BIGINT", "Activity id.", "src.activity_id"),
  expr("idx", "INTEGER", "Position in Strava's kudos list.", "src.idx"),
  col("firstname", "VARCHAR", "Kudoer first name."),
  col("lastname", "VARCHAR", "Kudoer last initial."),
];

const commentColumns: Column[] = [
  col("id", "BIGINT", "Comment id."),
  col("activity_id", "BIGINT", "Activity id."),
  col("text", "VARCHAR", "Comment text."),
  col("created_at", "TIMESTAMPTZ", "When the comment was posted."),
  expr("athlete_firstname", "VARCHAR", "Commenter first name.", "b->'athlete'->>'firstname'", "athlete"),
  expr("athlete_lastname", "VARCHAR", "Commenter last name/initial.", "b->'athlete'->>'lastname'", "athlete"),
  col("reaction_count", "INTEGER", "Number of reactions."),
  col("has_reacted", "BOOLEAN", "Whether the athlete reacted."),
  col("mentions_metadata", "JSON", "Mentions in the text."),
  col("post_id", "BIGINT", "Post id (null for activity comments)."),
];

const photoColumns: Column[] = [
  col("unique_id", "VARCHAR", "Photo id."),
  col("activity_id", "BIGINT", "Activity id."),
  col("caption", "VARCHAR", "Caption."),
  col("type", "INTEGER", "Photo type."),
  col("source", "INTEGER", "1 Strava, 2 Instagram."),
  col("status", "INTEGER", "Processing status."),
  col("media_type", "INTEGER", "1 photo, 2 video."),
  col("uploaded_at", "TIMESTAMPTZ", "Upload time."),
  col("created_at", "TIMESTAMPTZ", "Capture time (UTC)."),
  col("created_at_local", "TIMESTAMP", "Capture time, local wall clock."),
  col("urls", "JSON", "CDN URLs by size (the 5000 size is full resolution)."),
  col("sizes", "JSON", "Pixel dimensions by size."),
  col("location", "DOUBLE[]", "[lat, lng] where taken."),
  col("default_photo", "BOOLEAN", "The activity's cover photo."),
  col("is_strava_strength", "BOOLEAN", "Strength-training media."),
  col("video_url", "VARCHAR", "Video URL for videos."),
  col("duration", "DOUBLE", "Video duration in seconds."),
];

const streamMetaColumns: Column[] = [
  expr("activity_id", "BIGINT", "Activity id.", "src.activity_id"),
  expr("stream_type", "VARCHAR", "Stream key: time, distance, latlng, altitude, velocity_smooth, heartrate, cadence, watts, temp, moving, grade_smooth.", "src.stream_type"),
  col("original_size", "INTEGER", "Number of points Strava holds for the stream."),
  col("resolution", "VARCHAR", "Resolution label Strava reports (high = full)."),
  col("series_type", "VARCHAR", "What the stream is indexed by (time or distance)."),
];

const STREAM_CHANNELS: Array<[string, string, string]> = [
  ["time", "INTEGER", "Seconds since the activity start."],
  ["distance", "DOUBLE", "Cumulative distance in meters."],
  ["lat", "DOUBLE", "Latitude (from the latlng stream)."],
  ["lng", "DOUBLE", "Longitude (from the latlng stream)."],
  ["altitude", "DOUBLE", "Altitude in meters."],
  ["velocity_smooth", "DOUBLE", "Smoothed speed in m/s."],
  ["heartrate", "INTEGER", "Heart rate in bpm."],
  ["cadence", "INTEGER", "Cadence (rpm; runs: one-leg steps per minute)."],
  ["watts", "INTEGER", "Power in watts."],
  ["temp", "INTEGER", "Temperature in degrees Celsius."],
  ["moving", "BOOLEAN", "Whether the athlete was moving."],
  ["grade_smooth", "DOUBLE", "Smoothed grade in percent."],
];

/** Stream-point tables are filled by a zip-unnest, so their columns read from `s`. */
function streamPointTable(name: string, idColumn: string, comment: string, channels = STREAM_CHANNELS): Table {
  return {
    name,
    comment,
    primaryKey: [idColumn, "idx"],
    columns: [
      expr(idColumn, "BIGINT", `Owning ${idColumn.replace(/_id$/, "")} id.`, `s.${idColumn}`),
      expr("idx", "INTEGER", "0-based point index (start_index/end_index of laps and efforts refer to it).", "s.idx"),
      ...channels.map(([n, t, c]) => expr(n, t, c, `s.${n}`)),
    ],
  };
}

// ---------------------------------------------------------------------------------
// Athlete, gear, segments, routes, clubs
// ---------------------------------------------------------------------------------

const athleteColumns: Column[] = [
  col("id", "BIGINT", "Athlete id."),
  col("username", "VARCHAR", "Username."),
  col("firstname", "VARCHAR", "First name."),
  col("lastname", "VARCHAR", "Last name."),
  col("bio", "VARCHAR", "Profile bio."),
  col("city", "VARCHAR", "City."),
  col("state", "VARCHAR", "State."),
  col("country", "VARCHAR", "Country."),
  col("sex", "VARCHAR", "M or F."),
  col("premium", "BOOLEAN", "Subscriber (legacy flag)."),
  col("summit", "BOOLEAN", "Subscriber."),
  col("created_at", "TIMESTAMPTZ", "Account creation."),
  col("updated_at", "TIMESTAMPTZ", "Profile last updated."),
  col("badge_type_id", "INTEGER", "Badge type."),
  col("weight", "DOUBLE", "Weight in kilograms."),
  col("ftp", "INTEGER", "Functional threshold power in watts."),
  col("profile_medium", "VARCHAR", "Avatar URL (medium)."),
  col("profile", "VARCHAR", "Avatar URL (large)."),
  col("follower_count", "INTEGER", "Followers."),
  col("friend_count", "INTEGER", "Athletes followed."),
  col("mutual_friend_count", "INTEGER", "Mutual follows."),
  col("athlete_type", "INTEGER", "0 cyclist, 1 runner."),
  col("date_preference", "VARCHAR", "Date format preference."),
  col("measurement_preference", "VARCHAR", "feet (imperial) or meters (metric)."),
  col("postable_clubs_count", "INTEGER", "Clubs the athlete may post in."),
  col("blocked", "BOOLEAN", "Blocked flag (relationship to self)."),
  col("can_follow", "BOOLEAN", "Follow flag (relationship to self)."),
  col("friend", "VARCHAR", "Relationship to self (null)."),
  col("follower", "VARCHAR", "Relationship to self (null)."),
  fetchedAt,
];

const gearColumns: Column[] = [
  col("id", "VARCHAR", "Gear id: b<digits> for bikes, g<digits> for shoes."),
  expr("kind", "VARCHAR", "bike or shoe (from the id prefix).", "CASE WHEN starts_with(b->>'id', 'b') THEN 'bike' ELSE 'shoe' END"),
  col("name", "VARCHAR", "Display name."),
  col("nickname", "VARCHAR", "Nickname."),
  col("primary", "BOOLEAN", "Default gear for its sport."),
  col("retired", "BOOLEAN", "Retired."),
  col("distance", "DOUBLE", "Total distance in meters."),
  col("converted_distance", "DOUBLE", "Total distance in the athlete's preferred unit."),
  col("brand_name", "VARCHAR", "Brand (detail only)."),
  col("model_name", "VARCHAR", "Model (detail only)."),
  col("frame_type", "INTEGER", "Bike frame type: 1 mtb, 2 cross, 3 road, 4 time trial, 5 gravel (detail only)."),
  col("description", "VARCHAR", "Description (detail only)."),
  col("weight", "DOUBLE", "Weight in kilograms (detail only)."),
  col("notification_distance", "DOUBLE", "Replacement reminder distance (detail only)."),
  expr("detail_fetched_at", "TIMESTAMPTZ", "When /gear/{id} was fetched; null if only seen embedded.", "src.detail_fetched_at"),
  fetchedAt,
];

const segmentColumns: Column[] = [
  col("id", "BIGINT", "Segment id."),
  col("name", "VARCHAR", "Segment name."),
  col("activity_type", "VARCHAR", "Ride or Run."),
  col("distance", "DOUBLE", "Length in meters."),
  col("average_grade", "DOUBLE", "Average grade in percent."),
  col("maximum_grade", "DOUBLE", "Maximum grade in percent."),
  col("elevation_high", "DOUBLE", "Highest elevation in meters."),
  col("elevation_low", "DOUBLE", "Lowest elevation in meters."),
  col("total_elevation_gain", "DOUBLE", "Elevation gain in meters (detail only)."),
  col("start_latlng", "DOUBLE[]", "Start [lat, lng]."),
  col("end_latlng", "DOUBLE[]", "End [lat, lng]."),
  col("climb_category", "INTEGER", "0 (none) to 5 (HC)."),
  col("city", "VARCHAR", "City."),
  col("state", "VARCHAR", "State."),
  col("country", "VARCHAR", "Country."),
  col("private", "BOOLEAN", "Private segment."),
  col("hazardous", "BOOLEAN", "Flagged hazardous."),
  col("starred", "BOOLEAN", "Starred by the athlete (as of the payload)."),
  col("starred_date", "TIMESTAMPTZ", "When starred (starred list only)."),
  col("pr_time", "INTEGER", "Athlete's PR in seconds (starred list only)."),
  col("athlete_pr_effort", "JSON", "Athlete's PR effort (starred list only)."),
  col("created_at", "TIMESTAMPTZ", "Segment creation (detail only)."),
  col("updated_at", "TIMESTAMPTZ", "Segment last update (detail only)."),
  expr("polyline", "VARCHAR", "Encoded polyline (detail only).", "b->'map'->>'polyline'", "map"),
  col("effort_count", "INTEGER", "Total efforts by everyone (detail only)."),
  col("athlete_count", "INTEGER", "Distinct athletes (detail only)."),
  col("star_count", "INTEGER", "Stars (detail only)."),
  col("athlete_segment_stats", "JSON", "Athlete's PR and effort count on the segment (detail only)."),
  col("xoms", "JSON", "Current KOM/QOM times (detail only)."),
  col("local_legend", "JSON", "Local Legend (detail only)."),
  col("elevation_profile", "VARCHAR", "Elevation profile image URL."),
  col("elevation_profiles", "JSON", "Elevation profile image URLs (light/dark)."),
  expr("detail_fetched_at", "TIMESTAMPTZ", "When /segments/{id} was fetched; null if only seen embedded.", "src.detail_fetched_at"),
  fetchedAt,
];

const routeColumns: Column[] = [
  col("id", "BIGINT", "Route id."),
  col("id_str", "VARCHAR", "Route id as a string (route ids exceed 2^53)."),
  expr("athlete_id", "BIGINT", "Creator.", "TRY_CAST(b->'athlete'->>'id' AS BIGINT)", "athlete"),
  col("name", "VARCHAR", "Route name."),
  col("description", "VARCHAR", "Description."),
  col("distance", "DOUBLE", "Length in meters."),
  col("elevation_gain", "DOUBLE", "Elevation gain in meters."),
  col("type", "INTEGER", "1 ride, 2 run."),
  col("sub_type", "INTEGER", "1 road, 2 mtb, 3 cross, 4 trail, 5 mixed."),
  col("private", "BOOLEAN", "Private route."),
  col("starred", "BOOLEAN", "Starred."),
  col("created_at", "TIMESTAMPTZ", "Created."),
  col("updated_at", "TIMESTAMPTZ", "Last updated."),
  col("timestamp", "BIGINT", "Epoch timestamp Strava reports."),
  col("estimated_moving_time", "INTEGER", "Estimated moving time in seconds."),
  expr("summary_polyline", "VARCHAR", "Encoded summary polyline.", "b->'map'->>'summary_polyline'", "map"),
  expr("polyline", "VARCHAR", "Encoded full polyline (detail only).", "b->'map'->>'polyline'", "map"),
  col("map_urls", "JSON", "Static map image URLs."),
  col("waypoints", "JSON", "Waypoints ([{latlng, title, description, categories, distance_into_route}])."),
  col("segments", "JSON", "Segments on the route (detail only)."),
  expr("detail_fetched_at", "TIMESTAMPTZ", "When /routes/{id} was fetched.", "src.detail_fetched_at"),
  fetchedAt,
];

const clubColumns: Column[] = [
  col("id", "BIGINT", "Club id."),
  col("name", "VARCHAR", "Club name."),
  col("sport_type", "VARCHAR", "Club sport."),
  col("localized_sport_type", "VARCHAR", "Localized sport label."),
  col("activity_types", "VARCHAR[]", "Activity types the club covers."),
  col("activity_types_icon", "VARCHAR", "Icon name."),
  col("dimensions", "VARCHAR[]", "Leaderboard dimensions."),
  col("city", "VARCHAR", "City."),
  col("state", "VARCHAR", "State."),
  col("country", "VARCHAR", "Country."),
  col("private", "BOOLEAN", "Private club."),
  col("member_count", "INTEGER", "Members."),
  col("featured", "BOOLEAN", "Featured."),
  col("verified", "BOOLEAN", "Verified."),
  col("url", "VARCHAR", "Vanity URL."),
  col("membership", "VARCHAR", "Athlete's membership status."),
  col("admin", "BOOLEAN", "Athlete is admin."),
  col("owner", "BOOLEAN", "Athlete is owner."),
  col("description", "VARCHAR", "Description (detail only)."),
  col("club_type", "VARCHAR", "Club type (detail only)."),
  col("following_count", "INTEGER", "Members the athlete follows (detail only)."),
  col("website", "VARCHAR", "Website (detail only)."),
  col("profile_medium", "VARCHAR", "Avatar URL (medium)."),
  col("profile", "VARCHAR", "Avatar URL (large)."),
  col("cover_photo", "VARCHAR", "Cover photo URL."),
  col("cover_photo_small", "VARCHAR", "Cover photo URL (small)."),
  expr("detail_fetched_at", "TIMESTAMPTZ", "When /clubs/{id} was fetched.", "src.detail_fetched_at"),
  fetchedAt,
];

export const TABLES: Table[] = [
  activityTable,
  {
    name: "activity_segment_effort",
    comment:
      "Segment efforts: every effort embedded in activity details (include_all_efforts), plus efforts fetched through segment effort lists. Join segment for the segment's attributes.",
    primaryKey: ["id"],
    columns: [...segmentEffortColumns, fetchedAt],
  },
  {
    name: "activity_best_effort",
    comment: "Strava's best efforts within an activity (fastest 400m, 1k, mile, 5k, ... for runs).",
    primaryKey: ["id"],
    columns: [...bestEffortColumns, fetchedAt],
  },
  { name: "activity_lap", comment: "Laps of each activity, from the activity detail.", primaryKey: ["id"], columns: [...lapColumns, fetchedAt] },
  {
    name: "activity_split",
    comment: "Per-kilometer (metric) and per-mile (standard) splits of each activity, from the activity detail.",
    primaryKey: ["activity_id", "units", "split"],
    columns: [...splitColumns, fetchedAt],
  },
  {
    name: "activity_zone",
    comment: "Heart-rate and power zone summaries per activity (GET /activities/{id}/zones).",
    primaryKey: ["activity_id", "type"],
    columns: [...zoneColumns, fetchedAt],
  },
  {
    name: "activity_zone_bucket",
    comment: "Time in each heart-rate or power zone per activity.",
    primaryKey: ["activity_id", "type", "bucket_index"],
    columns: [...zoneBucketColumns, fetchedAt],
  },
  {
    name: "activity_kudoer",
    comment: "Athletes who gave kudos (Strava exposes only first name and last initial).",
    primaryKey: ["activity_id", "idx"],
    columns: [...kudoerColumns, fetchedAt],
  },
  { name: "activity_comment", comment: "Comments on activities.", primaryKey: ["id"], columns: [...commentColumns, fetchedAt] },
  {
    name: "activity_photo",
    comment: "Photos and videos attached to activities (undocumented photos endpoint, full-size URLs).",
    primaryKey: ["unique_id"],
    columns: [...photoColumns, fetchedAt],
  },
  {
    name: "activity_stream_meta",
    comment: "Per-activity stream metadata; one row per stream type present.",
    primaryKey: ["activity_id", "stream_type"],
    columns: [...streamMetaColumns, fetchedAt],
  },
  streamPointTable(
    "activity_stream_point",
    "activity_id",
    "Full-resolution activity streams in long form: one row per recorded point, one column per channel (null when the channel was not recorded).",
  ),
  { name: "athlete", comment: "The authenticated athlete's profile.", primaryKey: ["id"], columns: athleteColumns },
  {
    name: "athlete_zone",
    comment: "The athlete's configured heart-rate and power zones.",
    primaryKey: ["kind", "zone_index"],
    columns: [
      expr("kind", "VARCHAR", "heart_rate or power.", "src.kind"),
      expr("zone_index", "INTEGER", "0-based zone index.", "src.zone_index"),
      col("min", "INTEGER", "Lower bound (bpm or watts)."),
      col("max", "INTEGER", "Upper bound (bpm or watts); -1 means unbounded."),
      expr("custom_zones", "BOOLEAN", "Heart-rate zones are custom.", "src.custom_zones"),
      fetchedAt,
    ],
  },
  {
    name: "athlete_stats",
    comment:
      "History of the athlete's totals (recent = last 4 weeks, ytd, all) by sport. A row set is appended whenever Strava's numbers change.",
    primaryKey: ["fetched_at", "period", "sport"],
    columns: [
      fetchedAt,
      expr("period", "VARCHAR", "recent (last 4 weeks), ytd or all.", "src.period"),
      expr("sport", "VARCHAR", "ride, run or swim.", "src.sport"),
      col("count", "INTEGER", "Number of activities."),
      col("distance", "DOUBLE", "Distance in meters."),
      col("moving_time", "DOUBLE", "Moving time in seconds."),
      col("elapsed_time", "DOUBLE", "Elapsed time in seconds."),
      col("elevation_gain", "DOUBLE", "Elevation gain in meters."),
      col("achievement_count", "INTEGER", "Achievements (recent only)."),
      expr("biggest_ride_distance", "DOUBLE", "Longest ride ever in meters (same on every row of a fetch).", "src.biggest_ride_distance"),
      expr("biggest_climb_elevation_gain", "DOUBLE", "Biggest climb ever in meters (same on every row of a fetch).", "src.biggest_climb_elevation_gain"),
    ],
  },
  { name: "gear", comment: "Bikes and shoes, including retired ones referenced by activities.", primaryKey: ["id"], columns: gearColumns },
  {
    name: "segment",
    comment: "Segments seen in efforts, starred, or on routes. Detail-only columns are null until /segments/{id} is fetched.",
    primaryKey: ["id"],
    columns: segmentColumns,
  },
  streamPointTable(
    "segment_stream_point",
    "segment_id",
    "Segment geometry (latlng, distance, altitude) in long form.",
    STREAM_CHANNELS.filter(([n]) => ["distance", "lat", "lng", "altitude"].includes(n)),
  ),
  streamPointTable(
    "segment_effort_stream_point",
    "effort_id",
    "Streams of individual segment efforts (fetched on demand).",
  ),
  { name: "route", comment: "Routes created or starred by the athlete.", primaryKey: ["id"], columns: routeColumns },
  {
    name: "route_point",
    comment: "Route geometry in long form (from /routes/{id}/streams).",
    primaryKey: ["route_id", "idx"],
    columns: [
      expr("route_id", "BIGINT", "Route id.", "s.route_id"),
      expr("idx", "INTEGER", "0-based point index.", "s.idx"),
      expr("lat", "DOUBLE", "Latitude.", "s.lat"),
      expr("lng", "DOUBLE", "Longitude.", "s.lng"),
      expr("distance", "DOUBLE", "Cumulative distance in meters.", "s.distance"),
      expr("altitude", "DOUBLE", "Altitude in meters.", "s.altitude"),
    ],
  },
  { name: "club", comment: "Clubs the athlete belongs to.", primaryKey: ["id"], columns: clubColumns },
];

export function table(name: string): Table {
  const t = TABLES.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown table ${name}`);
  return t;
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function tableDdl(t: Table): string[] {
  const cols = t.columns.map((c) => `  "${c.name}" ${c.type}`).join(",\n");
  return [
    `CREATE TABLE IF NOT EXISTS ${t.name} (\n${cols},\n  PRIMARY KEY (${t.primaryKey.map((k) => `"${k}"`).join(", ")})\n)`,
    `COMMENT ON TABLE ${t.name} IS ${sqlString(t.comment)}`,
    ...t.columns.map((c) => `COMMENT ON COLUMN ${t.name}."${c.name}" IS ${sqlString(c.comment)}`),
  ];
}

/** `"col", "col2"` and the matching select list for a table, optionally a subset. */
export function selectList(t: Table, only?: (c: Column) => boolean): { names: string; exprs: string } {
  const cols = t.columns.filter(only ?? (() => true));
  return {
    names: cols.map((c) => `"${c.name}"`).join(", "),
    exprs: cols.map((c) => `${c.expr} AS "${c.name}"`).join(",\n    "),
  };
}

/** JSON keys a table's columns consume (for the drift check). */
export function consumedKeys(t: Table): Set<string> {
  return new Set(t.columns.map((c) => c.key).filter((k): k is string => k !== null));
}
