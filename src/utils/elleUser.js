// Resolves the single role='elle' user's id. `executor` is either the shared
// pool or an open transaction connection — both expose `.query()`, so this
// works identically inside or outside a transaction. No caching: this app
// runs at ~12-user scale, so a plain query per call is cheap enough.

async function getElleUserId(executor) {
  const [rows] = await executor.query("SELECT id FROM users WHERE role = 'elle' LIMIT 1");

  return rows[0]?.id ?? null;
}

module.exports = { getElleUserId };
