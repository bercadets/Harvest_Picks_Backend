const { z } = require('zod');

const cleanText = (value) => value.normalize('NFC').trim().replace(/\s+/g, ' ');

const text = (label, min, max) =>
  z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
        .max(max, `${label} must be at most ${max} characters`)
        .regex(/^[^\p{C}]*$/u, `${label} contains invalid characters`)
    );

const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

const points = (label, min, max) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number of points`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} is too large`);

// House margin is a decimal in [0, 1) with at most 4 decimals. Kept as a STRING (no float math).
const houseMargin = z
  .union([z.number(), z.string()])
  .transform((value) => String(value).trim())
  .pipe(z.string().regex(/^0(\.\d{1,4})?$/, 'House margin must be at least 0 and below 1, with at most 4 decimals'));

// closesAt must carry a time zone (for example 2026-12-01T18:00:00+08:00) so there is no guessing.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const closesAt = z
  .string()
  .regex(ISO_WITH_ZONE, 'closesAt must be a date and time with a time zone, e.g. 2026-12-01T18:00:00+08:00')
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()), 'closesAt is not a valid date')
  .refine((date) => date.getTime() > Date.now(), 'closesAt must be in the future')
  .transform((date) => date.toISOString());

const optionSchema = z
  .object({ label: text('Option label', 1, 60), seedPoints: points('Seed points', 0, 1_000_000_000).default(0) })
  .strict();

const createEventSchema = z
  .object({
    question: text('Question', 5, 200),
    description: z.preprocess(emptyToNull, text('Description', 1, 1000).nullable()).optional(),
    options: z.array(optionSchema).min(2, 'An event needs at least 2 options').max(10, 'At most 10 options'),
    maxBetPoints: points('Maximum bet', 1, 1_000_000_000),
    closesAt,
    houseMargin: houseMargin.default('0'),
    noWinnerPolicy: z.enum(['REFUND_ALL', 'FUND_TAKES_POOL']).default('REFUND_ALL'),
  })
  .strict()
  .refine(
    (event) => new Set(event.options.map((o) => o.label.toLowerCase())).size === event.options.length,
    { message: 'Option labels must be different from each other', path: ['options'] }
  )
  .transform((event) => ({ ...event, description: event.description ?? null }));

const idParamSchema = z.object({ id: z.string().uuid('Invalid id') });
const uuid = z.string().uuid('Invalid id');
const cursor = z.string().min(1).max(300).optional();
const limit = z.coerce.number().int().min(1).max(100).default(20);
const quoteStake = z.coerce.number().int().min(1).max(1_000_000_000).optional();

const eventQuerySchema = z.object({ stake: quoteStake });
const eventListSchema = (defaultStatus) =>
  z.object({
    status: z.enum(['OPEN', 'CLOSED', 'RESOLVED', 'CANCELLED', 'ALL']).default(defaultStatus),
    stake: quoteStake,
    limit,
    before: cursor,
  });

// The client sends only WHICH option and HOW MUCH. Odds and payout are never accepted from outside.
const placeBetSchema = z.object({ optionId: uuid, stakePoints: points('Stake', 1, 1_000_000_000) }).strict();
const resolveSchema = z.object({ winningOptionId: uuid }).strict();
const cancelSchema = z.object({ reason: text('Reason', 3, 200) }).strict();

const betListSchema = (defaultStatus) =>
  z.object({
    status: z.enum(['ACTIVE', 'WON', 'LOST', 'REFUNDED', 'ALL']).default(defaultStatus),
    limit,
    before: cursor,
  });

const nullAll = (parsed) => ({ ...parsed, status: parsed.status === 'ALL' ? null : parsed.status });

module.exports = {
  parseIdParam: (params) => idParamSchema.parse(params).id,
  parseCreateEvent: (body) => createEventSchema.parse(body),
  parseEventQuery: (query) => eventQuerySchema.parse(query),
  parseEventList: (query, defaultStatus) => nullAll(eventListSchema(defaultStatus).parse(query)),
  parsePlaceBet: (body) => placeBetSchema.parse(body),
  parseResolve: (body) => resolveSchema.parse(body),
  parseCancel: (body) => cancelSchema.parse(body),
  parseBetList: (query, defaultStatus) => nullAll(betListSchema(defaultStatus).parse(query)),
};