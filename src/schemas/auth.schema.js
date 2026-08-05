// zod schemas shared by the invitations/ and auth/ routes.

const { z } = require('zod');

const TOKEN_REGEX = /^[a-f0-9]{64}$/;

const createInvitationSchema = z.object({
  student_name_hint: z.string().trim().min(1).max(255).optional(),
  // Which role the invitee gets on redemption. Optional and defaults to
  // 'student' in the route, matching what every pre-multi-tenant invitation
  // meant and what existing clients send. WHO may invite WHICH role is
  // enforced in invitations.route.js (INVITABLE_ROLES) -- this schema only
  // constrains the value to one that exists. 'owner' is deliberately absent:
  // an organization's single owner is created at signup, never by invitation.
  role: z.enum(['manager', 'admin', 'student']).optional()
});

const tokenParamSchema = z.object({
  token: z.string().regex(TOKEN_REGEX, 'Invalid invitation token')
});

const registerSchema = z.object({
  token: z.string().regex(TOKEN_REGEX, 'Invalid invitation token'),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(255)
});

// Organization signup: creates the organization AND its owner account in one
// step. Deliberately combined -- an organization can never exist without an
// owner, so there is no orphaned-organization state to handle and no separate
// "claim your seat" invitation flow to build.
const registerOrganizationSchema = z.object({
  organization_name: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(255)
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(255)
});

module.exports = {
  createInvitationSchema,
  tokenParamSchema,
  registerSchema,
  registerOrganizationSchema,
  loginSchema
};
