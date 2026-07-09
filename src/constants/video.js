// Shared constants for class/practice video upload + playback (Phase 3).
// Kept in one place so the schema, service, and route layers can't drift
// out of sync with each other on limits/prefixes/expirations.

const MAX_FILE_SIZE_BYTES = 2147483648; // 2 GiB
const ALLOWED_CONTENT_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const S3_KEY_PREFIX = 'videos';
const UPLOAD_URL_EXPIRES_IN_SECONDS = 600;
const PLAYBACK_URL_EXPIRES_IN_SECONDS = 900;

module.exports = {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
  S3_KEY_PREFIX,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  PLAYBACK_URL_EXPIRES_IN_SECONDS
};
