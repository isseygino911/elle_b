const { z } = require('zod');

// Matches registerOrganizationSchema's organization_name rule exactly. A
// rename that accepted something signup would have rejected (or vice versa)
// would mean the same value is valid or invalid depending on which door it
// came through.
//
// Both fields are optional because this one endpoint now serves two unrelated
// settings -- the studio's name and whether that name renders beside the brand
// logo -- and the page saves them independently. The refine keeps that from
// degrading into "an empty body is a successful no-op": with neither key
// present there is nothing to write, and the caller should hear about it.
//
// Note that a partial body is the point, not a compromise: the route builds
// its UPDATE from whichever keys arrived, so saving a rename cannot silently
// overwrite the toggle with a stale value the form happened to be holding.
const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    show_name_with_logo: z.boolean().optional()
  })
  .refine((body) => body.name !== undefined || body.show_name_with_logo !== undefined, {
    message: 'Provide at least one of: name, show_name_with_logo'
  });

module.exports = { updateOrganizationSchema };
