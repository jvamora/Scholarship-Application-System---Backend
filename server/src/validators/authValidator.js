// PUBLIC REGISTRATION IS STAFF-ONLY.
// SECURITY: admin/committee/applicant were removed from public signup - they allowed anyone to mint a superuser account.
// Admin and committee accounts are provisioned internally by an administrator
// (POST /api/admin/create-user, or npm run bootstrap-admin on a fresh database).
// Applicant accounts are created by staff (POST /api/staff/applicants).
const { z } = require('zod');

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string().min(2),
  last_name: z.string().min(2),
  role: z.enum(['staff']).default('staff'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

module.exports = { registerSchema, loginSchema };
