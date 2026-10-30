/**
 * Phase 3 limits and defaults (ADR-024). Values marked "plan" come from the build plan; values
 * marked "technical" are transport limits, not business rules, and the owner may tune them.
 */
export const EXECUTION_LIMITS = {
  /** technical: operations accepted in one push request. */
  maxOpsPerPush: 50,
  /** technical: work + material lines in one update. */
  maxLinesPerUpdate: 50,
  /** technical: photos attached to one update. */
  maxPhotosPerUpdate: 20,
  /** technical: one compressed photo (≈1600 px JPEG is well under 2 MiB). */
  maxPhotoBytes: 8 * 1024 * 1024,
  /** technical: bytes accepted by one resumable-upload request. */
  maxChunkBytes: 1024 * 1024,
  labelMaxLength: 200,
  noteMaxLength: 2000,
  /** technical: updates returned by one pull page. */
  maxPullPage: 500,
} as const;

/** plan (UI principles): warn when the GPS fix is more than 50 m from the feature ("قابل للضبط"). */
export const DEFAULT_GPS_WARNING_DISTANCE_M = 50;

/** plan (Phase 3 camera): long side about 1600 px, JPEG quality 80 %. */
export const PHOTO_MAX_DIMENSION_PX = 1600;
export const PHOTO_JPEG_QUALITY = 0.8;

/**
 * technical: a device clock more than this far ahead of the server is flagged `CLOCK_AHEAD`
 * (never rejected). Owner may tune.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
