// Multer wrappers for the endpoints that accept a file directly (as opposed to
// videos and library files, which the client PUTs straight to S3 with a
// presigned POST). Memory storage only -- buffers are handed to a parser or to
// S3 and never written to local disk.
//
// Two uploads share this file: the survey XML import and the organization
// brand logo. They differ only in size cap, accepted types, and the wording of
// the resulting error, so the error-normalizing wrapper below is written once
// and parameterized -- a second copy of it would be a second place for
// multer's errors to start falling through to the 500 handler.

const multer = require('multer');

const SURVEY_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const SURVEY_ALLOWED_MIME_TYPES = new Set(['text/xml', 'application/xml']);
const SURVEY_ALLOWED_EXTENSION = /\.xml$/i;

// Deliberately no image/svg+xml. An SVG is executable markup, and these
// objects are public-read on the bucket origin (see services/s3.js), so a
// crafted logo would be a stored-XSS payload one direct navigation away.
// PNG/JPEG/WebP cover every real logo file.
const LOGO_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const LOGO_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LOGO_ALLOWED_EXTENSION = /\.(png|jpe?g|webp)$/i;

// Rejects on either axis: a .png named onto an XML payload and an .xml named
// onto a PNG are both refused, because the extension and the declared
// content-type have to agree with each other and with the allowlist.
function makeFileFilter(allowedExtension, allowedMimeTypes) {
  return function fileFilter(req, file, cb) {
    if (!allowedExtension.test(file.originalname) || !allowedMimeTypes.has(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
  };
}

// Wraps a single-file multer middleware so its errors (size cap, bad
// type/extension, etc.) come back as { status: 'error', message } 400s
// instead of bubbling to the app's generic error handler as a 500.
function singleFileUpload(upload, fieldName, messages) {
  const middleware = upload.single(fieldName);

  return function (req, res, next) {
    middleware(req, res, (err) => {
      if (!err) {
        return next();
      }

      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? messages.tooLarge
            : err.code === 'LIMIT_UNEXPECTED_FILE'
              ? messages.wrongType
              : 'Invalid file upload';
        return res.status(400).json({ status: 'error', message });
      }

      return res.status(400).json({ status: 'error', message: 'Invalid file upload' });
    });
  };
}

const surveyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SURVEY_MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: makeFileFilter(SURVEY_ALLOWED_EXTENSION, SURVEY_ALLOWED_MIME_TYPES)
});

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: makeFileFilter(LOGO_ALLOWED_EXTENSION, LOGO_ALLOWED_MIME_TYPES)
});

function uploadSurveyFile(fieldName) {
  return singleFileUpload(surveyUpload, fieldName, {
    tooLarge: 'File exceeds the 5MB size limit',
    wrongType: 'File must be a .xml file with content-type text/xml or application/xml'
  });
}

function uploadOrgLogoFile(fieldName) {
  return singleFileUpload(logoUpload, fieldName, {
    tooLarge: 'Logo exceeds the 2MB size limit',
    wrongType: 'Logo must be a PNG, JPEG or WebP image'
  });
}

module.exports = { uploadSurveyFile, uploadOrgLogoFile, LOGO_MAX_FILE_SIZE_BYTES };
