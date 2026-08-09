const { z } = require('zod');
const { ORGANIZATION_THEMES } = require('../constants/theme');

// Matches registerOrganizationSchema's organization_name rule exactly. A
// rename that accepted something signup would have rejected (or vice versa)
// would mean the same value is valid or invalid depending on which door it
// came through.
//
// Every field is optional because this one endpoint now serves three unrelated
// settings -- the studio's name, whether that name renders beside the brand
// logo, and the accent palette the organization wears -- and the page saves
// them independently. The refine keeps that from degrading into "an empty body
// is a successful no-op": with no key present there is nothing to write, and
// the caller should hear about it.
//
// Note that a partial body is the point, not a compromise: the route builds
// its UPDATE from whichever keys arrived, so saving a rename cannot silently
// overwrite the toggle with a stale value the form happened to be holding.
//
// `theme` is z.enum over the shared constant rather than a free string: the
// value drives CSS custom properties on every member's screen, so the set of
// things it can be has to be closed here, at the boundary. See
// constants/theme.js for why this is a slug and not a color.
const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    show_name_with_logo: z.boolean().optional(),
    theme: z.enum(ORGANIZATION_THEMES).optional()
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.show_name_with_logo !== undefined ||
      body.theme !== undefined,
    { message: 'Provide at least one of: name, show_name_with_logo, theme' }
  );

module.exports = { updateOrganizationSchema };
