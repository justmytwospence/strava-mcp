import marimo

__generated_with = "0.24.0"
app = marimo.App(width="medium", app_title="Strava")


@app.cell
def _():
    import os

    import altair as alt
    import duckdb
    import marimo as mo
    import polars as pl

    return alt, duckdb, mo, os, pl


@app.cell
def _(mo):
    mo.md(r"""
    # Strava

    Training volume, trends and a map of any activity, read from the snapshot that strava-mcp publishes next to its mirror. Reload the page to pick up a newer snapshot.
    """)
    return


@app.cell
def _(duckdb, mo, os):
    snapshot_path = os.environ.get("STRAVA_SNAPSHOT", "/data/snapshot/strava.duckdb")
    mo.stop(
        not os.path.exists(snapshot_path),
        mo.callout(
            mo.md(f"No snapshot at `{snapshot_path}` yet. The server publishes one within an hour of the first sync (every six hours during a backfill)."),
            kind="warn",
        ),
    )
    con = duckdb.connect(snapshot_path, read_only=True)
    return con, snapshot_path


@app.cell
def _(con, mo, snapshot_path):
    _n = con.sql(
        """
        SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS activities,
               min(start_date_local)::DATE AS first,
               max(start_date_local)::DATE AS last,
               (SELECT count(*) FROM raw_latest WHERE object_type = 'activity_streams' AND status = 'ok') AS with_streams
        FROM activity
        """
    ).fetchone()
    mo.md(
        f"{_n[0]:,} activities from {_n[1]} to {_n[2]}, {_n[3]:,} with full streams, in `{snapshot_path}`."
    )
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Volume
    """)
    return


@app.cell
def _(mo):
    weeks = mo.ui.slider(start=8, stop=156, step=4, value=26, label="Weeks shown")
    weeks
    return (weeks,)


@app.cell
def _(con, pl, weeks):
    weekly = con.sql(
        f"""
        SELECT date_trunc('week', start_date_local)::DATE AS week, sport_type,
               sum(moving_time) / 3600.0 AS hours,
               sum(distance) / 1000 AS km,
               sum(total_elevation_gain) AS elevation_m
        FROM activity
        WHERE deleted_at IS NULL AND start_date_local >= now() - INTERVAL {int(weeks.value)} WEEK
        GROUP BY ALL
        ORDER BY week
        """
    ).pl()
    weekly_total = weekly.group_by("week").agg(pl.col("km").sum(), pl.col("elevation_m").sum()).sort("week")
    return weekly, weekly_total


@app.cell
def _(alt, weekly):
    alt.Chart(weekly).mark_bar().encode(
        x=alt.X("week:T", title=None),
        y=alt.Y("hours:Q", title="Hours", stack="zero"),
        color=alt.Color("sport_type:N", title="Sport"),
        tooltip=["week:T", "sport_type:N", alt.Tooltip("hours:Q", format=".1f")],
    ).properties(title="Hours per week by sport", width="container", height=260)
    return


@app.cell
def _(alt, weekly_total):
    _base = alt.Chart(weekly_total).encode(x=alt.X("week:T", title=None))
    _km = _base.mark_line(point=True).encode(
        y=alt.Y("km:Q", title="km"), tooltip=["week:T", alt.Tooltip("km:Q", format=".0f")]
    )
    _elev = _base.mark_area(opacity=0.3, color="#888").encode(
        y=alt.Y("elevation_m:Q", title="Elevation gain (m)"), tooltip=["week:T", alt.Tooltip("elevation_m:Q", format=".0f")]
    )
    alt.layer(_elev, _km).resolve_scale(y="independent").properties(
        title="Distance and elevation gain per week", width="container", height=220
    )
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Trends

    Average heart rate of every activity that recorded it, and the weekly pace of runs and speed of rides.
    """)
    return


@app.cell
def _(alt, con, weeks):
    _hr = con.sql(
        f"""
        SELECT start_date_local AS start, sport_type, average_heartrate AS avg_hr, name
        FROM activity
        WHERE deleted_at IS NULL AND average_heartrate IS NOT NULL
          AND start_date_local >= now() - INTERVAL {int(weeks.value)} WEEK
        """
    ).pl()
    alt.Chart(_hr).mark_circle(size=40).encode(
        x=alt.X("start:T", title=None),
        y=alt.Y("avg_hr:Q", title="bpm", scale=alt.Scale(zero=False)),
        color=alt.Color("sport_type:N", title="Sport"),
        tooltip=["start:T", "name:N", "sport_type:N", "avg_hr:Q"],
    ).properties(title="Average heart rate per activity", width="container", height=220)
    return


@app.cell
def _(alt, con, weeks):
    _pace = con.sql(
        f"""
        SELECT week, metric,
               CASE WHEN metric LIKE 'Run%' THEN sum(moving_time) / nullif(sum(distance), 0) * 1000 / 60
                    ELSE sum(distance) / nullif(sum(moving_time), 0) * 3.6 END AS value
        FROM (
          SELECT date_trunc('week', start_date_local)::DATE AS week, moving_time, distance,
                 CASE WHEN sport_type IN ('Run', 'TrailRun', 'VirtualRun') THEN 'Run pace (min/km)' ELSE 'Ride speed (km/h)' END AS metric
          FROM activity
          WHERE deleted_at IS NULL AND distance > 0
            AND sport_type IN ('Run', 'TrailRun', 'VirtualRun', 'Ride', 'GravelRide', 'MountainBikeRide', 'VirtualRide')
            AND start_date_local >= now() - INTERVAL {int(weeks.value)} WEEK
        )
        GROUP BY week, metric
        ORDER BY week
        """
    ).pl()
    alt.Chart(_pace).mark_line(point=True).encode(
        x=alt.X("week:T", title=None),
        y=alt.Y("value:Q", title=None, scale=alt.Scale(zero=False)),
        color=alt.Color("metric:N", title=None),
        tooltip=["week:T", "metric:N", alt.Tooltip("value:Q", format=".2f")],
    ).properties(title="Weekly run pace and ride speed", width="container", height=220).facet(
        row=alt.Row("metric:N", title=None)
    ).resolve_scale(y="independent")
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Activities
    """)
    return


@app.cell
def _(con, mo):
    recent = con.sql(
        """
        SELECT start_date_local AS start, name, sport_type AS sport,
               round(distance / 1000, 1) AS km, round(moving_time / 60) AS minutes,
               round(total_elevation_gain) AS elev_m, round(average_heartrate) AS avg_hr, kudos_count AS kudos
        FROM activity
        WHERE deleted_at IS NULL
        ORDER BY start_date DESC
        LIMIT 200
        """
    ).pl()
    mo.ui.table(recent, page_size=15, selection=None)
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Map

    Pick an activity with GPS data: its track from the stream points, and the elevation profile along it.
    """)
    return


@app.cell
def _(con, mo):
    _choices = con.sql(
        """
        SELECT a.id, strftime(a.start_date_local, '%Y-%m-%d') || '  ' || a.name || '  (' || a.sport_type || ', ' || round(a.distance / 1000, 1) || ' km)' AS label
        FROM activity a
        WHERE a.deleted_at IS NULL AND a.summary_polyline IS NOT NULL AND a.summary_polyline <> ''
          AND EXISTS (SELECT 1 FROM activity_stream_meta m WHERE m.activity_id = a.id AND m.stream_type = 'latlng')
        ORDER BY a.start_date DESC
        LIMIT 100
        """
    ).fetchall()
    activity_options = {label: str(aid) for aid, label in _choices}
    activity = mo.ui.dropdown(options=activity_options, value=next(iter(activity_options), None), label="Activity")
    activity
    return (activity,)


@app.cell
def _(activity, con, mo):
    mo.stop(activity.value is None, mo.md("No activity with stream points in the snapshot yet."))
    track = con.sql(
        f"""
        SELECT idx, lat, lng, altitude, distance
        FROM activity_stream_point
        WHERE activity_id = {int(activity.value)} AND lat IS NOT NULL
        ORDER BY idx
        """
    ).pl()
    return (track,)


@app.cell
def _(mo, track):
    _points = ",".join(f"[{_lat:.5f},{_lng:.5f}]" for _lat, _lng in zip(track["lat"], track["lng"]))
    mo.Html(
        f"""
        <div id="map" style="height: 420px; border-radius: 6px;"></div>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <script>
          (function () {{
            var el = document.getElementById("map");
            var map = L.map(el);
            L.tileLayer("https://tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png", {{
              maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
            }}).addTo(map);
            var line = L.polyline([{_points}], {{ color: "#fc4c02", weight: 3 }}).addTo(map);
            map.fitBounds(line.getBounds(), {{ padding: [20, 20] }});
          }})();
        </script>
        """
    )
    return


@app.cell
def _(alt, track):
    alt.Chart(track).mark_area(opacity=0.5).encode(
        x=alt.X("distance:Q", title="Distance (m)"),
        y=alt.Y("altitude:Q", title="Altitude (m)", scale=alt.Scale(zero=False)),
    ).properties(title="Elevation profile", width="container", height=160)
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Sync health
    """)
    return


@app.cell
def _(con, mo):
    _c = con.sql(
        """
        SELECT
          (SELECT count(*) FROM activity WHERE deleted_at IS NULL) AS activities,
          (SELECT count(*) FROM activity WHERE deleted_at IS NULL AND detail_fetched_at IS NOT NULL) AS with_detail,
          (SELECT count(*) FROM raw_latest WHERE object_type = 'activity_streams' AND status = 'ok') AS with_streams,
          (SELECT count(*) FROM sync_job) AS queued,
          (SELECT strftime(max(logged_at), '%Y-%m-%d %H:%M UTC') FROM sync_log) AS last_job
        """
    ).fetchone()
    _outcomes = con.sql(
        """
        SELECT outcome, count(*) AS n FROM sync_log
        WHERE logged_at > now() - INTERVAL 1 DAY GROUP BY 1 ORDER BY 1
        """
    ).pl()
    mo.vstack(
        [
            mo.md(
                f"{_c[0]:,} activities, {_c[1]:,} with detail, {_c[2]:,} with streams. {_c[3]:,} jobs queued; last job at {_c[4]}."
            ),
            mo.ui.table(_outcomes, selection=None, label="Job outcomes, last 24 hours"),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
