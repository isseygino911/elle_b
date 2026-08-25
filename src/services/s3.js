// The one place @aws-sdk/client-s3 is imported. Everything else in this app
// that needs to store/retrieve a video, library or logo file goes through the
// functions exported below.

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const config = require('../config/env');
const {
  MAX_FILE_SIZE_BYTES,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  PLAYBACK_URL_EXPIRES_IN_SECONDS
} = require('../constants/video');
const {
  MAX_FILE_SIZE_BYTES: LIBRARY_MAX_FILE_SIZE_BYTES,
  UPLOAD_URL_EXPIRES_IN_SECONDS: LIBRARY_UPLOAD_URL_EXPIRES_IN_SECONDS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS: LIBRARY_DOWNLOAD_URL_EXPIRES_IN_SECONDS
} = require('../constants/library');
const {
  MAX_FILE_SIZE_BYTES: SUBMISSION_MAX_FILE_SIZE_BYTES,
  UPLOAD_URL_EXPIRES_IN_SECONDS: SUBMISSION_UPLOAD_URL_EXPIRES_IN_SECONDS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS: SUBMISSION_DOWNLOAD_URL_EXPIRES_IN_SECONDS
} = require('../constants/submissions');

// Credentials come from the default provider chain (env vars in this app's
// deployment) — never read directly from process.env here.
const client = new S3Client({ region: config.aws.region });

// Builds the presigned-POST params (url + fields) the client uses to upload
// a class/practice video file directly to S3. Enforces the file-size cap
// and pins the upload to the exact Content-Type it was requested for.
async function createVideoUploadPost(key, contentType) {
  return createPresignedPost(client, {
    Bucket: config.aws.bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 0, MAX_FILE_SIZE_BYTES],
      ['eq', '$Content-Type', contentType]
    ],
    Fields: {
      'Content-Type': contentType
    },
    Expires: UPLOAD_URL_EXPIRES_IN_SECONDS
  });
}

// Confirms a video upload actually landed in S3 (called after the client
// reports the presigned POST succeeded, before we write the DB row).
// Returns { contentLength, contentType } if the object exists, or null if
// it doesn't (404) — callers should treat any other error as unexpected.
async function headVideoObject(key) {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: config.aws.bucket, Key: key })
    );
    return { contentLength: result.ContentLength, contentType: result.ContentType };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

async function getVideoPlaybackUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.aws.bucket,
    Key: key
  });

  return getSignedUrl(client, command, { expiresIn: PLAYBACK_URL_EXPIRES_IN_SECONDS });
}

async function deleteVideoObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.aws.bucket,
      Key: key
    })
  );
}

// Builds the presigned-POST params (url + fields) the client uses to upload
// a library file directly to S3. Mirrors createVideoUploadPost, but against
// the library's own size cap and expiry.
async function createLibraryUploadPost(key, contentType) {
  return createPresignedPost(client, {
    Bucket: config.aws.bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 0, LIBRARY_MAX_FILE_SIZE_BYTES],
      ['eq', '$Content-Type', contentType]
    ],
    Fields: {
      'Content-Type': contentType
    },
    Expires: LIBRARY_UPLOAD_URL_EXPIRES_IN_SECONDS
  });
}

// Confirms a library upload actually landed in S3, before we write the DB
// row. Returns { contentLength, contentType } if the object exists, or null
// if it doesn't (404) — callers treat any other error as unexpected.
async function headLibraryObject(key) {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: config.aws.bucket, Key: key })
    );
    return { contentLength: result.ContentLength, contentType: result.ContentType };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

// Presigned GET for a library file. `disposition` decides whether the
// browser saves the file or renders it in place: 'attachment' (the default)
// forces a download, 'inline' lets an <img>/<video>/<iframe> display it.
// The two need separate URLs because Content-Disposition is baked into the
// signature — an attachment-signed URL downloads even inside an iframe.
//
// The filename is quoted for legacy clients and repeated as RFC 5987
// filename* so non-ASCII names (e.g. Chinese titles) survive intact;
// encodeURIComponent alone would leave the plain filename percent-escaped
// and unreadable in the save dialog.
async function getLibraryObjectUrl(key, filename, disposition = 'attachment') {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const command = new GetObjectCommand({
    Bucket: config.aws.bucket,
    Key: key,
    ResponseContentDisposition: `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  });

  return getSignedUrl(client, command, { expiresIn: LIBRARY_DOWNLOAD_URL_EXPIRES_IN_SECONDS });
}

async function getLibraryDownloadUrl(key, filename) {
  return getLibraryObjectUrl(key, filename, 'attachment');
}

async function getLibraryPreviewUrl(key, filename) {
  return getLibraryObjectUrl(key, filename, 'inline');
}

async function deleteLibraryObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.aws.bucket,
      Key: key
    })
  );
}

// --- Submissions ----------------------------------------------------------
//
// Four near-copies of the library functions above, deliberately. The domains
// differ in size cap, expiry and allowed types, and each set is read alongside
// its own constants file -- collapsing them into one parameterized helper would
// mean a change to homework limits silently reaching the library, and would put
// the caps behind an argument rather than in a file named for the domain.

// Builds the presigned-POST params for a submission attachment or camera take.
//
// The ['eq', '$Content-Type', ...] pin is what makes the recording path work:
// the browser uploads the blob relabelled to a bare 'video/webm', and this
// condition requires the upload to carry exactly the type it was signed for.
async function createSubmissionUploadPost(key, contentType) {
  return createPresignedPost(client, {
    Bucket: config.aws.bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 0, SUBMISSION_MAX_FILE_SIZE_BYTES],
      ['eq', '$Content-Type', contentType]
    ],
    Fields: {
      'Content-Type': contentType
    },
    Expires: SUBMISSION_UPLOAD_URL_EXPIRES_IN_SECONDS
  });
}

// Confirms a submission upload landed before the row is written, and reports
// the size/type S3 actually saw. The route uses these instead of the
// client-declared values -- a student's browser is not a trustworthy source for
// the numbers the caps are checked against.
//
// Returns null on 404 so the caller can answer "retry the upload"; any other
// error is unexpected and propagates.
async function headSubmissionObject(key) {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: config.aws.bucket, Key: key })
    );
    return { contentLength: result.ContentLength, contentType: result.ContentType };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

// Presigned GET for a submitted file.
//
// `disposition` decides whether the browser saves or renders it, and both are
// needed here for the same reason the library needs both: an attachment is
// downloaded, but a camera take must play inline in a <video> element. The two
// need separate URLs because Content-Disposition is baked into the signature.
//
// Filename handling matches getLibraryObjectUrl exactly -- quoted ASCII
// fallback plus RFC 5987 filename* -- so a student's non-ASCII filename
// survives into the teacher's save dialog intact.
async function getSubmissionObjectUrl(key, filename, disposition = 'attachment') {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const command = new GetObjectCommand({
    Bucket: config.aws.bucket,
    Key: key,
    ResponseContentDisposition: `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  });

  return getSignedUrl(client, command, { expiresIn: SUBMISSION_DOWNLOAD_URL_EXPIRES_IN_SECONDS });
}

async function getSubmissionDownloadUrl(key, filename) {
  return getSubmissionObjectUrl(key, filename, 'attachment');
}

// Serves the inline player a recording needs.
async function getSubmissionPreviewUrl(key, filename) {
  return getSubmissionObjectUrl(key, filename, 'inline');
}

async function deleteSubmissionObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.aws.bucket,
      Key: key
    })
  );
}

// An organization's brand logo. The one object in this app that is NOT
// private-and-presigned, deliberately: the logo renders in the sidebar of
// every page for every member, so a 10-minute signed URL would mean a signing
// round-trip per page load and a broken image on any tab left open longer
// than that. A logo is public branding, not tenant data.
//
// An organization's brand logo. Private in the bucket like everything else,
// and handed to the browser as a presigned URL -- the same shape as library
// previews and video playback above, for the same reason: the <img> then loads
// straight from S3, and this API never sits in the path of image bytes.
//
// Two earlier approaches failed and are worth not repeating. A public-read ACL
// was rejected outright (the bucket is BucketOwnerEnforced, so ACLs are
// disabled), and making the bucket public would have meant relaxing Block
// Public Access on a bucket that also holds student videos and library files.
// Streaming the object through Express instead tripped Helmet's
// Cross-Origin-Resource-Policy: same-origin -- the SPA and this API are
// different origins, so the browser fetched the image and then refused to
// render it (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin, on a 200). Presigning
// sidesteps both, because S3 sends no CORP header at all.
async function putOrgLogoObject(key, buffer, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType
    })
  );
}

// Longer than the library's 10 minutes: a logo is decoration on every page
// rather than a file someone clicks once, so the URL wants to outlive a normal
// working session. Not indefinite -- these are still presigned URLs, and a
// short-lived one is the point. BrandMark falls back to the text wordmark if
// one does lapse, so the worst case is cosmetic.
const ORG_LOGO_URL_EXPIRES_IN_SECONDS = 6 * 60 * 60;

async function getOrgLogoUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.aws.bucket,
    Key: key
  });

  return getSignedUrl(client, command, { expiresIn: ORG_LOGO_URL_EXPIRES_IN_SECONDS });
}

async function deleteOrgLogoObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.aws.bucket,
      Key: key
    })
  );
}

// A course's cover image. Same shape as the org logo directly above -- private
// in the bucket, handed over as a presigned URL -- and for the same reasons
// documented there (BucketOwnerEnforced rules out a public-read ACL, and
// streaming through Express trips Helmet's Cross-Origin-Resource-Policy).
//
// Read that block before changing anything here; both failure modes it
// records apply verbatim to this object type.
async function putCourseThumbnailObject(key, buffer, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType
    })
  );
}

// Matches the org logo's 6 hours rather than the library's 10 minutes: a
// thumbnail is decoration on a list the user keeps open while working through
// it, not a file they click once. RecordCard falls back to the status icon if
// a URL does lapse, so the worst case is cosmetic.
const COURSE_THUMBNAIL_URL_EXPIRES_IN_SECONDS = 6 * 60 * 60;

async function getCourseThumbnailUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.aws.bucket,
    Key: key
  });

  return getSignedUrl(client, command, { expiresIn: COURSE_THUMBNAIL_URL_EXPIRES_IN_SECONDS });
}

async function deleteCourseThumbnailObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.aws.bucket,
      Key: key
    })
  );
}

module.exports = {
  createVideoUploadPost,
  headVideoObject,
  getVideoPlaybackUrl,
  deleteVideoObject,
  createLibraryUploadPost,
  headLibraryObject,
  getLibraryDownloadUrl,
  getLibraryPreviewUrl,
  deleteLibraryObject,
  createSubmissionUploadPost,
  headSubmissionObject,
  getSubmissionDownloadUrl,
  getSubmissionPreviewUrl,
  deleteSubmissionObject,
  putOrgLogoObject,
  getOrgLogoUrl,
  deleteOrgLogoObject,
  putCourseThumbnailObject,
  getCourseThumbnailUrl,
  deleteCourseThumbnailObject
};
