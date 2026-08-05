// Shared helpers for library.route.js, keeping row-shaping and the
// category-existence check out of the route handlers themselves.

const pool = require('../db/pool');

// Shapes a `library_files` row for API responses — omits the internal
// s3_key (downloads go through the dedicated /download-url endpoint, which
// is also what enforces auth on the object). category_name is present only
// when the caller joined it in; null means the file is uncategorized.
function serializeFile(row) {
  return {
    id: row.id,
    category_id: row.category_id,
    category_name: row.category_name ?? null,
    title: row.title,
    original_filename: row.original_filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    description: row.description,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at
  };
}

// Shapes a `library_categories` row. file_count is only present on the list
// endpoint (which aggregates it); it's coerced because MySQL returns COUNT()
// as a string in some driver configurations.
function serializeCategory(row) {
  return {
    id: row.id,
    name: row.name,
    file_count: row.file_count === undefined ? undefined : Number(row.file_count),
    created_by: row.created_by,
    created_at: row.created_at
  };
}

// Confirms a category_id references a real category before it's written to
// a file row. The FK would reject a bad id anyway, but catching it here
// turns an opaque ER_NO_REFERENCED_ROW into a clear 400. Returns true if
// valid (or if categoryId is null/undefined, meaning "uncategorized",
// which is always allowed), otherwise sends a 400 and returns false.
async function assertCategoryExists(res, categoryId) {
  if (categoryId === null || categoryId === undefined) {
    return true;
  }

  const [rows] = await pool.query('SELECT id FROM library_categories WHERE id = ?', [categoryId]);

  if (rows.length === 0) {
    res.status(400).json({
      status: 'error',
      message: 'category_id does not reference an existing category'
    });
    return false;
  }

  return true;
}

module.exports = { serializeFile, serializeCategory, assertCategoryExists };
