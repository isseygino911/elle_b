// Shared constants for submitting homework: the S3 prefix, the size cap, the
// content types a student may hand in, and the recording length default.
//
// Kept in one place so the schema, service and route layers cannot drift out of
// sync on limits -- the same reasoning as constants/library.js and
// constants/video.js.

// 500 MiB, matching the library's cap rather than video's 2 GiB.
//
// A submission attachment is a score PDF, a photo of hand position, or a short
// take -- not the multi-gigabyte lesson recordings videos.route.js was sized
// for. The lower ceiling is what makes the 5-minute recording cap meaningful:
// a capped recording cannot approach 2 GiB, so a request that claims to is
// either a bug or an attempt to use homework as free storage.
const MAX_FILE_SIZE_BYTES = 524288000;

// video/webm is LOAD-BEARING, not one entry among many.
//
// It is the exact literal MediaRecorder produces, and the exact literal the
// presigned POST pins with ['eq', '$Content-Type', ...]. useMediaRecorder
// records codec-qualified ('video/webm;codecs=vp9,opus') but relabels the blob
// bare precisely so the pinned condition matches. Removing or qualifying this
// entry breaks in-browser recording entirely, and it breaks at upload time --
// after the student has already performed.
const ALLOWED_CONTENT_TYPES = [
  // Documents -- a worked exercise, a marked-up score.
  'application/pdf',
  'text/plain',
  // Images -- a photo of written work or hand position.
  'image/png',
  'image/jpeg',
  'image/webp',
  // Audio -- an instrument take without video.
  'audio/mpeg',
  'audio/mp4',
  // Video. See the note above on video/webm.
  'video/mp4',
  'video/webm',
  'video/quicktime'
];

// A camera take must be exactly this. The recorder produces nothing else, so a
// kind='recording' row claiming any other type did not come from the recorder
// and its duration_sec cannot be trusted against max_recording_sec.
const RECORDING_CONTENT_TYPE = 'video/webm';

// The per-assignment default, mirrored from 0032's column default rather than
// re-chosen here. Five minutes: long enough for a piece, short enough that a
// student discovers the limit while recording rather than at upload.
const MAX_RECORDING_SEC_DEFAULT = 300;

const S3_KEY_PREFIX = 'submissions';
const UPLOAD_URL_EXPIRES_IN_SECONDS = 600;
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 600;

module.exports = {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
  RECORDING_CONTENT_TYPE,
  MAX_RECORDING_SEC_DEFAULT,
  S3_KEY_PREFIX,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS
};
