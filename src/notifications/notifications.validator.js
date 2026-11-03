const { z } = require('zod');

const listQuerySchema = z.object({
  // Only the exact words "true" / "false" (z.coerce.boolean would treat "false" as true).
  unread: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().min(1).max(300).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid('Invalid id') });

module.exports = {
  parseListQuery: (query) => listQuerySchema.parse(query),
  parseIdParam: (params) => idParamSchema.parse(params).id,
};