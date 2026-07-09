// zod schemas shared by the invitations/ and auth/ routes.

const { z } = require('zod');

const TOKEN_REGEX = /^[a-f0-9]{64}$/;

const createInvitationSchema = z.object({
  student_name_hint: z.string().trim().min(1).max(255).optional()
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

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(255)
});

module.exports = {
  createInvitationSchema,
  tokenParamSchema,
  registerSchema,
  loginSchema
};
