const { z } = require('zod');

const applicationSchema = z.object({
  scholarshipId: z.string().min(1),
  answers: z.record(z.string()),
  // Documents will be handled separately
});

const statusUpdateSchema = z.object({
  status: z.enum(['submitted', 'under_review', 'committee_review', 'interview', 'approved', 'rejected']),
});

module.exports = {
  applicationSchema,
  statusUpdateSchema,
};
