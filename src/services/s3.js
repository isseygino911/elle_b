// The one place @aws-sdk/client-s3 is imported. Everything else in this app
// that needs to store/retrieve a survey or video file goes through the
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

const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 600;

// Credentials come from the default provider chain (env vars in this app's
// deployment) — never read directly from process.env here.
const client = new S3Client({ region: config.aws.region });

async function putSurveyObject(key, buffer, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType
    })
  );
}

async function getSurveyDownloadUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.aws.bucket,
    Key: key
  });

  return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS });
}

async function deleteSurveyObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.aws.bucket,
      Key: key
    })
  );
}

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

module.exports = {
  putSurveyObject,
  getSurveyDownloadUrl,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS,
  deleteSurveyObject,
  createVideoUploadPost,
  headVideoObject,
  getVideoPlaybackUrl,
  deleteVideoObject,
  createLibraryUploadPost,
  headLibraryObject,
  getLibraryDownloadUrl,
  getLibraryPreviewUrl,
  deleteLibraryObject
};
