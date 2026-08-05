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

// The library's tenancy predicate.
//
// Deliberately NOT scopeFor(): the library is a shared shelf, readable by
// everyone in the organization (library.route.js explains why), and scopeFor
// would throw for two roles that legitimately belong here -- manager (it
// hard-denies managers, but org curriculum is not per-student detail) and
// student (it demands a `student` column these tables don't have). Both would
// break. The tables carry org_id and nothing else, so org_id IS the whole
// fence that is expressible here.
//
// If you are tempted to "fix" this by switching to scopeFor, read the two
// paragraphs above first.
function orgFence(user, column = 'org_id') {
  return { sql: `${column} = ?`, params: [user.orgId] };
}

// Confirms a category_id references a real category IN THE CALLER'S
// ORGANIZATION before it's written to a file row. The FK would reject a
// nonexistent id anyway, but it would happily accept another organization's
// category -- filing your file into their shelf. Returns true if valid (or if
// categoryId is null/undefined, meaning "uncategorized", which is always
// allowed), otherwise sends a 400 and returns false.
//
// DELIBERATELY RENAMED from assertCategoryExists rather than given an extra
// parameter: an added param can be forgotten at a call site and silently keep
// the old cross-org behaviour. The rename makes every caller fail loudly until
// it's updated. Same reasoning as utils/students.js.
//
// 400 and not 404: the route was fine, the request BODY referenced something
// out of scope. It also doesn't distinguish "not yours" from "doesn't exist",
// so ids can't be enumerated across tenants.
async function assertCategoryInScope(res, user, categoryId) {
  if (categoryId === null || categoryId === undefined) {
    return true;
  }

  const [rows] = await pool.query(
    'SELECT id FROM library_categories WHERE id = ? AND org_id = ?',
    [categoryId, user.orgId]
  );

  if (rows.length === 0) {
    res.status(400).json({
      status: 'error',
      message: 'category_id does not reference an existing category'
    });
    return false;
  }

  return true;
}

module.exports = { serializeFile, serializeCategory, assertCategoryInScope, orgFence };
