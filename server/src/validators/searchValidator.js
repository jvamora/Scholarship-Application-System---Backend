const { z } = require('zod');

// HTTP query parameters arrive as strings — coerce them to the right types
// so the rest of the pipeline sees real booleans / numbers.
const toBool = (v) => {
  if (v === 'true' || v === '1' || v === true || v === 1) return true;
  if (v === 'false' || v === '0' || v === false || v === 0) return false;
  return undefined;
};

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

const searchScholarshipSchema = z.object({
  search: z.string().optional(),
  isActive: z.preprocess(toBool, z.boolean()).optional(),
  minAmount: z.preprocess(toNum, z.number().min(0)).optional(),
  maxAmount: z.preprocess(toNum, z.number().min(0)).optional(),
  // Accept both full ISO timestamps and plain date inputs (YYYY-MM-DD)
  deadlineFrom: z.string().optional(),
  deadlineTo: z.string().optional(),
  limit: z.preprocess(toNum, z.number().min(1).max(100)).default(20),
  offset: z.preprocess(toNum, z.number().min(0)).default(0),
});

const searchApplicationSchema = z.object({
  status: z.string().optional(),
  scholarshipId: z.preprocess(toNum, z.number().int().positive()).optional(),
  search: z.string().optional(),
  limit: z.preprocess(toNum, z.number().min(1).max(100)).default(20),
  offset: z.preprocess(toNum, z.number().min(0)).default(0),
});

const searchPreferencesSchema = z.object({
  name: z.string().min(3),
  filters: searchScholarshipSchema,
});

module.exports = {
  searchScholarshipSchema,
  searchApplicationSchema,
  searchPreferencesSchema,
};
