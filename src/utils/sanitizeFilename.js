// Shared filename sanitizer used when building S3 keys for uploaded files
// (videos and library files). Strips anything outside a safe character set and
// caps length so the resulting S3 key can't contain path separators,
// unicode weirdness, or run unreasonably long.

const SANITIZE_FILENAME_REGEX = /[^A-Za-z0-9._-]/g;
const MAX_FILENAME_LENGTH = 200;

function sanitizeFilename(originalFilename) {
  return originalFilename.replace(SANITIZE_FILENAME_REGEX, '_').slice(0, MAX_FILENAME_LENGTH);
}

module.exports = { sanitizeFilename };
