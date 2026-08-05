const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireRole, requireAuth } = require('../middleware/auth');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  uploadUrlRequestSchema,
  createFileSchema,
  updateFileSchema,
  fileIdParamSchema,
  listFilesQuerySchema,
  createCategorySchema,
  updateCategorySchema,
  categoryIdParamSchema
} = require('../schemas/library.schema');
const {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
  S3_KEY_PREFIX,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS
} = require('../constants/library');
const s3 = require('../services/s3');
const { sanitizeFilename } = require('../utils/sanitizeFilename');
const { serializeFile, serializeCategory, assertCategoryExists } = require('./library.helpers');

const router = express.Router();

// Read access (list/get/download) is open to any authenticated user — the
// library is a shared shelf of teaching resources. Everything that mutates
// it (uploading, filing, renaming, deleting) is Elle-only, so each mutating
// route below carries requireRole('elle') rather than requireAuth().

// --- Categories -----------------------------------------------------------

router.get('/categories', requireAuth(), async (req, res, next) => {
  try {
    // LEFT JOIN so a category with no files still reports file_count 0,
    // which the UI needs to render an empty category rather than hide it.
    const [rows] = await pool.query(
      `SELECT c.*, COUNT(f.id) AS file_count
         FROM library_categories c
         LEFT JOIN library_files f ON f.category_id = c.id
        GROUP BY c.id
        ORDER BY c.name ASC`
    );

    // The count of files filed nowhere, surfaced alongside the real
    // categories so the client can render an "Uncategorized" bucket without
    // fetching the whole file list to compute it.
    const [[{ count: uncategorizedCount }]] = await pool.query(
      'SELECT COUNT(*) AS count FROM library_files WHERE category_id IS NULL'
    );

    res.status(200).json({
      categories: rows.map(serializeCategory),
      uncategorized_count: Number(uncategorizedCount)
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/categories',
  requireRole('elle'),
  validateBody(createCategorySchema),
  async (req, res, next) => {
    try {
      const [result] = await pool.query(
        'INSERT INTO library_categories (name, created_by) VALUES (?, ?)',
        [req.body.name, req.user.id]
      );

      const [rows] = await pool.query('SELECT * FROM library_categories WHERE id = ?', [
        result.insertId
      ]);

      res.status(201).json({ category: serializeCategory(rows[0]) });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res
          .status(409)
          .json({ status: 'error', message: 'A category with that name already exists.' });
      }
      next(err);
    }
  }
);

router.patch(
  '/categories/:id',
  requireRole('elle'),
  validateParams(categoryIdParamSchema),
  validateBody(updateCategorySchema),
  async (req, res, next) => {
    try {
      const [result] = await pool.query('UPDATE library_categories SET name = ? WHERE id = ?', [
        req.body.name,
        req.params.id
      ]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Category not found' });
      }

      const [rows] = await pool.query('SELECT * FROM library_categories WHERE id = ?', [
        req.params.id
      ]);

      res.status(200).json({ category: serializeCategory(rows[0]) });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res
          .status(409)
          .json({ status: 'error', message: 'A category with that name already exists.' });
      }
      next(err);
    }
  }
);

// Deleting a category does NOT delete its files: the FK is ON DELETE SET
// NULL, so they fall back to "Uncategorized" and stay browsable/re-filable.
router.delete(
  '/categories/:id',
  requireRole('elle'),
  validateParams(categoryIdParamSchema),
  async (req, res, next) => {
    try {
      const [[{ count: fileCount }]] = await pool.query(
        'SELECT COUNT(*) AS count FROM library_files WHERE category_id = ?',
        [req.params.id]
      );

      const [result] = await pool.query('DELETE FROM library_categories WHERE id = ?', [
        req.params.id
      ]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Category not found' });
      }

      res.status(200).json({ status: 'ok', uncategorized_files: Number(fileCount) });
    } catch (err) {
      next(err);
    }
  }
);

// --- Files ----------------------------------------------------------------

router.post(
  '/upload-url',
  requireRole('elle'),
  validateBody(uploadUrlRequestSchema),
  async (req, res, next) => {
    try {
      if (req.body.content_length !== undefined && req.body.content_length > MAX_FILE_SIZE_BYTES) {
        return res
          .status(400)
          .json({ status: 'error', message: 'File exceeds maximum allowed size' });
      }

      const s3Key = `${S3_KEY_PREFIX}/${crypto.randomUUID()}/${sanitizeFilename(req.body.original_filename)}`;

      let upload;
      try {
        upload = await s3.createLibraryUploadPost(s3Key, req.body.content_type);
      } catch (err) {
        console.error('S3 createLibraryUploadPost failed:', err);
        return res
          .status(502)
          .json({ status: 'error', message: 'Failed to generate upload URL' });
      }

      res.status(200).json({
        upload: { url: upload.url, fields: upload.fields, s3_key: s3Key },
        expires_in: UPLOAD_URL_EXPIRES_IN_SECONDS,
        max_file_size_bytes: MAX_FILE_SIZE_BYTES,
        allowed_content_types: ALLOWED_CONTENT_TYPES
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/files', requireRole('elle'), validateBody(createFileSchema), async (req, res, next) => {
  try {
    const categoryId = req.body.category_id ?? null;

    if (!(await assertCategoryExists(res, categoryId))) {
      return;
    }

    const { title, original_filename: originalFilename, s3_key: s3Key, description } = req.body;

    // Verifies the upload actually landed before writing a row that would
    // otherwise point at a nonexistent object, and takes the size/type from
    // S3 itself rather than trusting client-reported values.
    let head;
    try {
      head = await s3.headLibraryObject(s3Key);
    } catch (err) {
      console.error('S3 headLibraryObject failed:', err);
      return res.status(502).json({ status: 'error', message: 'Failed to verify upload' });
    }

    if (!head) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Upload not found — please retry the upload.' });
    }

    if (!ALLOWED_CONTENT_TYPES.includes(head.contentType) || head.contentLength > MAX_FILE_SIZE_BYTES) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Uploaded file does not meet the requirements' });
    }

    try {
      const [insertResult] = await pool.query(
        `INSERT INTO library_files
           (category_id, title, original_filename, s3_key, content_type, size_bytes, description, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          categoryId,
          title,
          originalFilename,
          s3Key,
          head.contentType,
          head.contentLength,
          description ?? null,
          req.user.id
        ]
      );

      const [rows] = await pool.query(
        `SELECT f.*, c.name AS category_name
           FROM library_files f
           LEFT JOIN library_categories c ON c.id = f.category_id
          WHERE f.id = ?`,
        [insertResult.insertId]
      );

      res.status(201).json({ file: serializeFile(rows[0]) });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res
          .status(409)
          .json({ status: 'error', message: 'This upload has already been recorded.' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.get('/files', requireAuth(), validateQuery(listFilesQuerySchema), async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    if (req.query.category_id === 'uncategorized') {
      conditions.push('f.category_id IS NULL');
    } else if (req.query.category_id) {
      conditions.push('f.category_id = ?');
      params.push(req.query.category_id);
    }

    if (req.query.q) {
      conditions.push('(f.title LIKE ? OR f.original_filename LIKE ?)');
      // Escapes the LIKE wildcards so a literal % or _ in the search term
      // matches itself instead of acting as a pattern.
      const term = `%${req.query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      params.push(term, term);
    }

    let query = `SELECT f.*, c.name AS category_name
                   FROM library_files f
                   LEFT JOIN library_categories c ON c.id = f.category_id`;
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY f.created_at DESC';

    const [rows] = await pool.query(query, params);

    res.status(200).json({ files: rows.map(serializeFile) });
  } catch (err) {
    next(err);
  }
});

router.get('/files/:id', requireAuth(), validateParams(fileIdParamSchema), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.*, c.name AS category_name
         FROM library_files f
         LEFT JOIN library_categories c ON c.id = f.category_id
        WHERE f.id = ?`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'File not found' });
    }

    res.status(200).json({ file: serializeFile(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Both signed-URL endpoints differ only in Content-Disposition, so they
// share one handler factory rather than two near-identical routes.
// `mode` is 'download' (attachment) or 'preview' (inline).
function signedUrlHandler(mode) {
  const sign = mode === 'preview' ? s3.getLibraryPreviewUrl : s3.getLibraryDownloadUrl;

  return async (req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT * FROM library_files WHERE id = ?', [req.params.id]);
      const file = rows[0];

      if (!file) {
        return res.status(404).json({ status: 'error', message: 'File not found' });
      }

      let url;
      try {
        url = await sign(file.s3_key, file.original_filename);
      } catch (err) {
        console.error(`S3 library ${mode} URL failed:`, err);
        return res
          .status(502)
          .json({ status: 'error', message: `Failed to generate ${mode} URL` });
      }

      res.status(200).json({
        url,
        expires_in: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
        content_type: file.content_type
      });
    } catch (err) {
      next(err);
    }
  };
}

router.get(
  '/files/:id/download-url',
  requireAuth(),
  validateParams(fileIdParamSchema),
  signedUrlHandler('download')
);

// Serves the in-app viewer: same object, but signed for inline rendering so
// an <img>/<video>/<audio>/<iframe> can display it instead of downloading.
router.get(
  '/files/:id/preview-url',
  requireAuth(),
  validateParams(fileIdParamSchema),
  signedUrlHandler('preview')
);

// The move-between-categories endpoint (also serves rename/re-describe).
// Elle-only, per the same rule as upload. Passing category_id: null files
// the record back to "Uncategorized".
router.patch(
  '/files/:id',
  requireRole('elle'),
  validateParams(fileIdParamSchema),
  validateBody(updateFileSchema),
  async (req, res, next) => {
    try {
      const [existingRows] = await pool.query('SELECT id FROM library_files WHERE id = ?', [
        req.params.id
      ]);

      if (existingRows.length === 0) {
        return res.status(404).json({ status: 'error', message: 'File not found' });
      }

      // Only columns the client actually sent are updated, so a pure move
      // can't blank out the title/description and vice versa. `category_id`
      // is checked with hasOwnProperty rather than a truthiness test because
      // an explicit null is a meaningful value here ("move to Uncategorized").
      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(req.body, 'category_id')) {
        const categoryId = req.body.category_id ?? null;
        if (!(await assertCategoryExists(res, categoryId))) {
          return;
        }
        updates.push('category_id = ?');
        params.push(categoryId);
      }

      if (req.body.title !== undefined) {
        updates.push('title = ?');
        params.push(req.body.title);
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
        updates.push('description = ?');
        params.push(req.body.description ?? null);
      }

      params.push(req.params.id);
      await pool.query(`UPDATE library_files SET ${updates.join(', ')} WHERE id = ?`, params);

      const [rows] = await pool.query(
        `SELECT f.*, c.name AS category_name
           FROM library_files f
           LEFT JOIN library_categories c ON c.id = f.category_id
          WHERE f.id = ?`,
        [req.params.id]
      );

      res.status(200).json({ file: serializeFile(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/files/:id',
  requireRole('elle'),
  validateParams(fileIdParamSchema),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT * FROM library_files WHERE id = ?', [req.params.id]);
      const file = rows[0];

      if (!file) {
        return res.status(404).json({ status: 'error', message: 'File not found' });
      }

      // S3 cleanup is best-effort: a failure here shouldn't block removing
      // the row the user asked to delete (same posture as videos.route.js).
      try {
        await s3.deleteLibraryObject(file.s3_key);
      } catch (err) {
        console.error('S3 deleteLibraryObject failed:', err);
      }

      await pool.query('DELETE FROM library_files WHERE id = ?', [file.id]);

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
