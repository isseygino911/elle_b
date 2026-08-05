// Shared constants for library file upload + download (Library phase).
// Kept in one place so the schema, service, and route layers can't drift
// out of sync with each other on limits/prefixes/expirations — same
// reasoning as constants/video.js.

const MAX_FILE_SIZE_BYTES = 524288000; // 500 MiB

// The library is a general-purpose resource shelf, so the allowed set spans
// documents, images, archives, and audio/video. Enforced in three places
// that must agree: the presigned-POST condition, the post-upload HeadObject
// check, and the client-side file picker's accept list.
const ALLOWED_CONTENT_TYPES = [
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Archives
  'application/zip',
  // Audio / video
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/quicktime'
];

const S3_KEY_PREFIX = 'library';
const UPLOAD_URL_EXPIRES_IN_SECONDS = 600;
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 600;

module.exports = {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
  S3_KEY_PREFIX,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS
};
