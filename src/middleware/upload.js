// Multer wrapper for the endpoints that accept a file directly (as opposed to
// videos and library files, which the client PUTs straight to S3 with a
// presigned POST). Memory storage only -- buffers are handed to S3 and never
// written to local disk.
//
// The error-normalizing wrapper below is parameterized rather than inlined
// into its single caller. It previously served a survey XML import alongside
// the organization brand logo; keeping it factored means multer's errors have
// exactly one place to be translated into 400s instead of falling through to
// the 500 handler. Do not inline it.

const multer = require('multer');

// Deliberately no image/svg+xml. An SVG is executable markup, and a crafted
// one would be a stored-XSS payload one direct navigation away. PNG/JPEG/WebP
// cover every real logo and cover image.
//
// Shared by both image uploads below (org logo, course thumbnail) -- the
// allowlist is a property of "this app accepts raster images", not of any one
// endpoint. Only the size caps differ.
const IMAGE_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMAGE_ALLOWED_EXTENSION = /\.(png|jpe?g|webp)$/i;

const LOGO_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

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

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: makeFileFilter(IMAGE_ALLOWED_EXTENSION, IMAGE_ALLOWED_MIME_TYPES)
});

function uploadOrgLogoFile(fieldName) {
  return singleFileUpload(logoUpload, fieldName, {
    tooLarge: 'Logo exceeds the 2MB size limit',
    wrongType: 'Logo must be a PNG, JPEG or WebP image'
  });
}

// A course cover image. Same allowlist as the logo -- PNG/JPEG/WebP, no SVG,
// for the same stored-XSS reason -- but a larger cap: a logo is a small mark
// sized for a sidebar, while a cover photo is a photograph.
//
// This is the second caller the singleFileUpload wrapper was kept factored
// for. Reuse it rather than adding another multer error translation.
const COURSE_THUMBNAIL_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const courseThumbnailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: COURSE_THUMBNAIL_MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: makeFileFilter(IMAGE_ALLOWED_EXTENSION, IMAGE_ALLOWED_MIME_TYPES)
});

function uploadCourseThumbnailFile(fieldName) {
  return singleFileUpload(courseThumbnailUpload, fieldName, {
    tooLarge: 'Image exceeds the 5MB size limit',
    wrongType: 'Image must be a PNG, JPEG or WebP file'
  });
}

module.exports = {
  uploadOrgLogoFile,
  LOGO_MAX_FILE_SIZE_BYTES,
  uploadCourseThumbnailFile,
  COURSE_THUMBNAIL_MAX_FILE_SIZE_BYTES
};
