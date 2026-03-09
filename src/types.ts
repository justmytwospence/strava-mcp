export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

export interface SummaryAthlete {
  id: number;
  firstname: string;
  lastname: string;
  profile: string;
  profile_medium: string;
  city: string;
  state: string;
  country: string;
  sex: string;
  premium: boolean;
  summit: boolean;
  created_at: string;
  updated_at: string;
}

export interface DetailedAthlete extends SummaryAthlete {
  follower_count: number;
  friend_count: number;
  measurement_preference: string;
  ftp: number | null;
  weight: number | null;
  clubs: SummaryClub[];
  bikes: SummaryGear[];
  shoes: SummaryGear[];
}

export interface ActivityMap {
  id: string;
  polyline?: string;
  summary_polyline: string;
  resource_state: number;
}

export interface SummaryActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  start_date: string;
  start_date_local: string;
  timezone: string;
  achievement_count: number;
  kudos_count: number;
  comment_count: number;
  athlete_count: number;
  photo_count: number;
  map: ActivityMap;
  trainer: boolean;
  commute: boolean;
  manual: boolean;
  private: boolean;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  max_watts?: number;
  weighted_average_watts?: number;
  kilojoules?: number;
  average_cadence?: number;
  gear_id: string | null;
}

export interface DetailedActivity extends SummaryActivity {
  description: string;
  calories: number;
  device_name: string;
  embed_token: string;
  splits_metric: Split[];
  splits_standard: Split[];
  laps: Lap[];
  segment_efforts: SegmentEffort[];
  gear: SummaryGear | null;
}

export interface Split {
  distance: number;
  elapsed_time: number;
  elevation_difference: number;
  moving_time: number;
  split: number;
  average_speed: number;
  average_heartrate?: number;
  pace_zone: number;
}

export interface Lap {
  id: number;
  name: string;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  distance: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  average_cadence?: number;
  lap_index: number;
  split: number;
  total_elevation_gain: number;
}

export interface Comment {
  id: number;
  text: string;
  athlete: SummaryAthlete;
  created_at: string;
}

export interface SummaryClub {
  id: number;
  name: string;
  profile: string;
  profile_medium: string;
  sport_type: string;
  city: string;
  state: string;
  country: string;
  member_count: number;
  private: boolean;
  url: string;
}

export interface DetailedClub extends SummaryClub {
  description: string;
  club_type: string;
  following_count: number;
}

export interface SummarySegment {
  id: number;
  name: string;
  activity_type: string;
  distance: number;
  average_grade: number;
  maximum_grade: number;
  elevation_high: number;
  elevation_low: number;
  climb_category: number;
  city: string;
  state: string;
  country: string;
  private: boolean;
  starred: boolean;
}

export interface DetailedSegment extends SummarySegment {
  total_elevation_gain: number;
  effort_count: number;
  athlete_count: number;
  star_count: number;
  created_at: string;
  updated_at: string;
  map: ActivityMap;
}

export interface SegmentEffort {
  id: number;
  name: string;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  start_date_local: string;
  distance: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  average_cadence?: number;
  segment: SummarySegment;
  pr_rank: number | null;
  achievements: Array<{ type_id: number; type: string; rank: number }>;
}

export interface Route {
  id: number;
  name: string;
  description: string;
  distance: number;
  elevation_gain: number;
  type: number;
  sub_type: number;
  private: boolean;
  starred: boolean;
  timestamp: number;
  map: ActivityMap;
  estimated_moving_time: number;
}

export interface SummaryGear {
  id: string;
  name: string;
  primary: boolean;
  distance: number;
  brand_name?: string;
  model_name?: string;
  description?: string;
  resource_state: number;
}

export interface Stream {
  type: string;
  data: unknown[];
  series_type: string;
  original_size: number;
  resolution: string;
}

export interface Upload {
  id: number;
  id_str: string;
  external_id: string;
  error: string | null;
  status: string;
  activity_id: number | null;
}

export interface ActivityZone {
  score: number;
  distribution_buckets: Array<{ min: number; max: number; time: number }>;
  type: string;
  sensor_based: boolean;
  points: number;
  custom_zones: boolean;
}

export interface AthleteZones {
  heart_rate: {
    custom_zones: boolean;
    zones: Array<{ min: number; max: number }>;
  };
  power?: {
    zones: Array<{ min: number; max: number }>;
  };
}

export interface AthleteStats {
  biggest_ride_distance: number;
  biggest_climb_elevation_gain: number;
  recent_ride_totals: ActivityTotal;
  recent_run_totals: ActivityTotal;
  recent_swim_totals: ActivityTotal;
  ytd_ride_totals: ActivityTotal;
  ytd_run_totals: ActivityTotal;
  ytd_swim_totals: ActivityTotal;
  all_ride_totals: ActivityTotal;
  all_run_totals: ActivityTotal;
  all_swim_totals: ActivityTotal;
}

export interface ActivityTotal {
  count: number;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  elevation_gain: number;
  achievement_count?: number;
}

export interface ExplorerSegment {
  id: number;
  name: string;
  climb_category: number;
  climb_category_desc: string;
  avg_grade: number;
  elev_difference: number;
  distance: number;
  points: string;
  start_latlng: [number, number];
  end_latlng: [number, number];
}
