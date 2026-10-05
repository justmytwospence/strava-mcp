export const STRAVA_API_BASE = "https://www.strava.com/api/v3";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
export const CHARACTER_LIMIT = 25_000;
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 200;

export const SPORT_TYPES = [
  "AlpineSki",
  "BackcountrySki",
  "Badminton",
  "Canoeing",
  "Crossfit",
  "EBikeRide",
  "Elliptical",
  "EMountainBikeRide",
  "Golf",
  "GravelRide",
  "Handcycle",
  "HighIntensityIntervalTraining",
  "Hike",
  "IceSkate",
  "InlineSkate",
  "Kayaking",
  "Kitesurf",
  "MountainBikeRide",
  "NordicSki",
  "Pickleball",
  "Pilates",
  "Racquetball",
  "Ride",
  "RockClimbing",
  "RollerSki",
  "Rowing",
  "Run",
  "Sail",
  "Skateboard",
  "Snowboard",
  "Snowshoe",
  "Soccer",
  "Squash",
  "StairStepper",
  "StandUpPaddling",
  "Surfing",
  "Swim",
  "TableTennis",
  "Tennis",
  "TrailRun",
  "Velomobile",
  "VirtualRide",
  "VirtualRow",
  "VirtualRun",
  "Walk",
  "WeightTraining",
  "Wheelchair",
  "Windsurf",
  "Workout",
  "Yoga",
] as const;

export type SportType = (typeof SPORT_TYPES)[number];

export const ACTIVITY_STREAM_KEYS = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
  "moving",
  "grade_smooth",
] as const;

export const SEGMENT_STREAM_KEYS = ["latlng", "distance", "altitude"] as const;

export type StreamKey = (typeof ACTIVITY_STREAM_KEYS)[number];

export const STREAM_TYPE_DESCRIPTIONS: Record<StreamKey, string> = {
  time: "Elapsed seconds from start of the activity",
  distance: "Cumulative distance in meters",
  latlng: "GPS position as [latitude, longitude] pairs",
  altitude: "Elevation in meters",
  velocity_smooth: "Smoothed speed in meters per second",
  heartrate: "Heart rate in beats per minute",
  cadence: "Cadence in rpm (cycling) or spm (running)",
  watts: "Power output in watts",
  temp: "Temperature in degrees Celsius",
  moving: "Boolean flag indicating whether the athlete was moving",
  grade_smooth: "Smoothed road grade as a percentage",
};
