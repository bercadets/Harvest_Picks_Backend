const { z } = require('zod');

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().min(1).max(300).optional(),
});

const topupListQuerySchema = z.object({
  status: z.enum(['PENDING_REVIEW', 'CONFIRMED', 'DISPUTED', 'ALL']).default('PENDING_REVIEW'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const manualTopUpSchema = z
  .object({
    amount: z
      .number({ error: 'Amount must be a number' })
      .int('Amount must be a whole number of points')
      .positive('Amount must be greater than 0')
      .max(1_000_000_000_000, 'Amount is too large'),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid('Invalid id') });

module.exports = {
  parseHistoryQuery: (query) => historyQuerySchema.parse(query),
  parseTopupListQuery: (query) => {
    const { status, limit } = topupListQuerySchema.parse(query);
    return { status: status === 'ALL' ? null : status, limit };
  },
  parseManualTopUp: (body) => manualTopUpSchema.parse(body),
  parseIdParam: (params) => idParamSchema.parse(params).id,
};