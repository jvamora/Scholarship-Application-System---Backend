const { z } = require('zod');

const exportScholarshipSchema = z.object({
  status: z.string().optional(),
});

const exportApplicationSchema = z.object({
  status: z.string().optional(),
  scholarshipId: z.string().optional(),
});

module.exports = {
  exportScholarshipSchema,
  exportApplicationSchema,
};
