'use strict';

// The organization accent theme (migration 0029).
//
// Two things are worth testing here and they are different in kind.
//
// 1. THE COLUMN IS A CLOSED SET. The chosen slug ends up driving CSS custom
//    properties on every member's screen (elle_f/src/lib/orgThemes.js applies
//    it to <html>). If an owner could store arbitrary text there, they would
//    have a styling-injection surface pointed at their own users. The z.enum
//    in schemas/organization.schema.js is the boundary that prevents it, so
//    these tests push the shapes that would matter if it ever came off.
//
// 2. THE PALETTES STAY READABLE. Each palette pairs an accent with the
//    glyph color drawn on top of it (the active nav icon, a filled button
//    label). Swapping the accent app-wide is only safe because every pairing
//    clears WCAG AA. That is asserted here rather than left to the comments
//    in orgThemes.js, which were wrong by up to 1.2:1 when first written --
//    a documented ratio nobody recomputes is a ratio that drifts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTestDatabase } = require('../helpers/setup');
const { get, patch } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');
const { ORGANIZATION_THEMES, DEFAULT_ORGANIZATION_THEME } = require('../../src/constants/theme');

const { ctx } = useTestDatabase();

test('an organization starts on the default palette', async () => {
  const { orgA } = ctx.fixtures;

  const res = await get('/organization', { token: tokenFor(orgA.owner) });

  assert.equal(res.status, 200);
  assert.equal(res.body.organization.theme, DEFAULT_ORGANIZATION_THEME);
});

test('an owner can switch their organization to another palette', async () => {
  const { orgA } = ctx.fixtures;

  const res = await patch('/organization', {
    token: tokenFor(orgA.owner),
    body: { theme: 'ocean' }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.organization.theme, 'ocean');

  // Re-read: the response echoes a re-select, but this proves the write
  // actually landed rather than the handler reflecting its own input.
  const after = await get('/organization', { token: tokenFor(orgA.owner) });
  assert.equal(after.body.organization.theme, 'ocean');
});

test('every advertised palette is actually storable', async () => {
  const { orgA } = ctx.fixtures;
  const token = tokenFor(orgA.owner);

  // Guards the seam between this list and the column: VARCHAR(32) is wide
  // enough for today's names, and a longer slug added later would be
  // truncated by MariaDB rather than rejected.
  for (const slug of ORGANIZATION_THEMES) {
    const res = await patch('/organization', { token, body: { theme: slug } });

    assert.equal(res.status, 200, `${slug} was rejected`);
    assert.equal(res.body.organization.theme, slug, `${slug} did not round-trip`);
  }
});

test('a palette outside the allowlist is refused', async () => {
  const { orgA } = ctx.fixtures;
  const token = tokenFor(orgA.owner);

  // The third and fourth are the ones that matter: both would be inert as a
  // CSS custom property value on their own, but they are the shape an
  // injection attempt takes, and neither should ever reach the column.
  const rejected = [
    'chartreuse',
    '#ff0000',
    'lime;--color-bg-dark:#ff0000',
    'red;} html{display:none} .x{',
    ''
  ];

  for (const theme of rejected) {
    const res = await patch('/organization', { token, body: { theme } });
    assert.equal(res.status, 400, `${JSON.stringify(theme)} was accepted`);
  }

  // ...and the stored value is untouched by any of it.
  const after = await get('/organization', { token });
  assert.equal(after.body.organization.theme, DEFAULT_ORGANIZATION_THEME);
});

test('a non-owner cannot change the palette', async () => {
  const { orgA } = ctx.fixtures;

  // A teacher is the interesting case rather than a student: they hold real
  // administrative capability in the app, and the palette is still not theirs
  // to set -- it is the mark on every member's sidebar.
  for (const user of [orgA.teacher1, orgA.manager, orgA.student1a]) {
    const res = await patch('/organization', {
      token: tokenFor(user),
      body: { theme: 'coral' }
    });

    assert.equal(res.status, 403, `${user.role} was allowed to set the theme`);
  }

  const after = await get('/organization', { token: tokenFor(orgA.owner) });
  assert.equal(after.body.organization.theme, DEFAULT_ORGANIZATION_THEME);
});

test('changing the palette leaves the name and logo toggle alone', async () => {
  const { orgA } = ctx.fixtures;
  const token = tokenFor(orgA.owner);

  const before = await get('/organization', { token });

  await patch('/organization', { token, body: { theme: 'amber' } });

  const after = await get('/organization', { token });

  // The PATCH builds its UPDATE from whichever keys arrived; this is the
  // regression guard for that, from the newest key's side.
  assert.equal(after.body.organization.name, before.body.organization.name);
  assert.equal(
    after.body.organization.show_name_with_logo,
    before.body.organization.show_name_with_logo
  );
});

test("one organization's palette does not touch another's", async () => {
  const { orgA, orgB } = ctx.fixtures;

  await patch('/organization', { token: tokenFor(orgA.owner), body: { theme: 'forest' } });

  const b = await get('/organization', { token: tokenFor(orgB.owner) });

  assert.equal(b.body.organization.theme, DEFAULT_ORGANIZATION_THEME);
});

test('a slug the frontend has no palette for still serializes', async () => {
  const { orgA } = ctx.fixtures;

  // Reachable by a hand-edited row or a rollback that leaves 0029's data in
  // place. The serializer normalises rather than passing it through, so the
  // client never has to render an unknown theme.
  await ctx.pool.query('UPDATE organizations SET theme = ? WHERE id = ?', ['bogus', orgA.id]);

  const res = await get('/organization', { token: tokenFor(orgA.owner) });

  assert.equal(res.status, 200);
  assert.equal(res.body.organization.theme, DEFAULT_ORGANIZATION_THEME);
});

// ---------------------------------------------------------------------------
// Palette accessibility
// ---------------------------------------------------------------------------

// WCAG 2.1 relative luminance / contrast ratio. Inlined rather than pulled
// from a package: it is nine lines and the alternative is a dependency in the
// server's tree for a frontend color check.
function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

// The palettes live in the frontend (they are colors, and the server only
// stores a name), so they are read out of the source rather than imported --
// elle_f is ESM and this suite is CommonJS. A regex over a hand-maintained
// literal is brittle in general; here it is the cheaper half of the trade
// against a build step, and the count assertion below catches a parse that
// silently matched nothing.
function readFrontendPalettes() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../elle_f/src/lib/orgThemes.js'),
    'utf8'
  );

  const pattern =
    /slug:\s*'([a-z]+)'[\s\S]*?base:\s*'(#[0-9a-f]{6})'[\s\S]*?on:\s*'(#[0-9a-f]{6})'/g;

  return [...source.matchAll(pattern)].map(([, slug, base, on]) => ({ slug, base, on }));
}

test('every palette pairs its accent with a readable glyph color', () => {
  const palettes = readFrontendPalettes();

  // If the regex above ever stops matching, this is what fails -- rather than
  // the suite quietly asserting nothing at all.
  assert.equal(
    palettes.length,
    ORGANIZATION_THEMES.length,
    'parsed a different number of palettes than the server allows'
  );

  for (const { slug, base, on } of palettes) {
    const ratio = contrastRatio(base, on);

    // 4.5:1 is AA for body text. The glyph drawn on an accent fill is small
    // text, so the large-text 3:1 allowance does not apply.
    assert.ok(
      ratio >= 4.5,
      `${slug}: on-accent contrast is ${ratio.toFixed(2)}:1, below the 4.5:1 floor`
    );
  }
});

test('the frontend palette list matches the server allowlist', () => {
  const slugs = readFrontendPalettes().map((palette) => palette.slug);

  // The two lists are maintained separately on purpose (the server must not
  // know about colors), which is exactly why they need a test tying them
  // together. Order matters too: the frontend renders the swatches in list
  // order and the first entry is the documented default.
  assert.deepEqual(slugs, [...ORGANIZATION_THEMES]);
  assert.equal(slugs[0], DEFAULT_ORGANIZATION_THEME);
});
