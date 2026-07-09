// Multer wrapper for the survey XML upload endpoint. Memory storage only —
// the buffer is handed to the XML parser and then to S3, never written to
// local disk. Restricts uploads to a single .xml file under 5MB, and
// normalizes multer's own errors into the app's standard error shape instead
// of letting them fall through to the 500 handler.

const multer = require('multer');

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['text/xml', 'application/xml']);
const ALLOWED_EXTENSION = /\.xml$/i;

function fileFilter(req, file, cb) {
  if (!ALLOWED_EXTENSION.test(file.originalname) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter
});

// Wraps a single-file multer middleware so its errors (size cap, bad
// type/extension, etc.) come back as { status: 'error', message } 400s
// instead of bubbling to the app's generic error handler as a 500.
function uploadSurveyFile(fieldName) {
  const middleware = upload.single(fieldName);

  return function (req, res, next) {
    middleware(req, res, (err) => {
      if (!err) {
        return next();
      }

      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'File exceeds the 5MB size limit'
            : err.code === 'LIMIT_UNEXPECTED_FILE'
              ? 'File must be a .xml file with content-type text/xml or application/xml'
              : 'Invalid file upload';
        return res.status(400).json({ status: 'error', message });
      }

      return res.status(400).json({ status: 'error', message: 'Invalid file upload' });
    });
  };
}

module.exports = { uploadSurveyFile };
