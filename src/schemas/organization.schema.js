const { z } = require('zod');

// Matches registerOrganizationSchema's organization_name rule exactly. A
// rename that accepted something signup would have rejected (or vice versa)
// would mean the same value is valid or invalid depending on which door it
// came through.
const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(255)
});

module.exports = { updateOrganizationSchema };
