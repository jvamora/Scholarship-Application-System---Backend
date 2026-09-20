const { z } = require('zod');

// Accept both full ISO timestamps and plain date inputs (YYYY-MM-DD)
const deadlineSchema = z.union([
  z.string().datetime(),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date (expected YYYY-MM-DD)'),
]);

const scholarshipSchema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().min(10),
  eligibility: z.string().min(10),
  benefits: z.string().optional(),
  slots: z.coerce.number().int().nonnegative().optional(),
  available_slots: z.coerce.number().int().nonnegative().optional(),
  amount: z.coerce.number().positive(),
  deadline: deadlineSchema,
  requirements: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  status: z.enum(['draft', 'open', 'closed', 'completed']).optional(),
  image_url: z.string().nullish(),
});

const updateScholarshipSchema = scholarshipSchema.partial();

module.exports = {
  scholarshipSchema,
  updateScholarshipSchema,
};
