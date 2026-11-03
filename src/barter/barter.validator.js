const { z } = require('zod');

// "05.500" -> "5.5"
function canonicalDecimal(value) {
  const [intPart, fracPart = ''] = String(value).split('.');
  const i = intPart.replace(/^0+(?=\d)/, '');
  const f = fracPart.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// Quantities are decimals: accept a number or a numeric string, keep it as a STRING (no float math).
// numeric(14,3): up to 11 whole digits and 3 decimals.
const quantity = z
  .union([z.number(), z.string()])
  .transform((value) => String(value).trim())
  .pipe(
    z
      .string()
      .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimal places')
      .refine((value) => Number(value) > 0, 'Quantity must be greater than 0')
  )
  .transform(canonicalDecimal);

const cleanText = (value) => value.normalize('NFC').trim().replace(/\s+/g, ' ');

const reason = z
  .string()
  .transform(cleanText)
  .pipe(
    z
      .string()
      .min(3, 'Please give a short reason (at least 3 characters)')
      .max(200, 'Reason must be at most 200 characters')
      .regex(/^[^\p{C}]*$/u, 'Reason contains invalid characters')
  );

const idParamSchema = z.object({ id: z.string().uuid('Invalid id') });
const uuid = z.string().uuid('Invalid id');
const cursor = z.string().min(1).max(300).optional();
const limit = z.coerce.number().int().min(1).max(100).default(20);

// ---- deposits
const estimateQuerySchema = z.object({ cropId: uuid, quantity });
const createDepositSchema = z.object({ cropId: uuid, quantity }).strict();
const rejectDepositSchema = z.object({ reason }).strict();

const depositListSchema = (defaultStatus) =>
  z.object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default(defaultStatus),
    limit,
    before: cursor,
  });

// ---- orders
const MAX_LINE_QUANTITY = 1_000_000;

const orderLine = z
  .object({
    itemId: uuid,
    quantity: z
      .number({ error: 'Quantity must be a number' })
      .int('Quantity must be a whole number')
      .min(1, 'Quantity must be at least 1')
      .max(MAX_LINE_QUANTITY, 'Quantity is too large'),
  })
  .strict();

// Prices are never accepted from the client (.strict() rejects a "price" field). Duplicate lines are merged.
const createOrderSchema = z
  .object({ items: z.array(orderLine).min(1, 'The cart is empty').max(50, 'At most 50 different items per order') })
  .strict()
  .transform(({ items }) => {
    const merged = new Map();
    for (const { itemId, quantity: q } of items) merged.set(itemId, (merged.get(itemId) || 0) + q);
    return { items: [...merged].map(([itemId, q]) => ({ itemId, quantity: q })) };
  })
  .refine(
    ({ items }) => items.every((line) => line.quantity <= MAX_LINE_QUANTITY),
    'Quantity for one item is too large'
  );

const orderListSchema = (defaultStatus) =>
  z.object({
    status: z.enum(['PENDING_DELIVERY', 'DELIVERED', 'ALL']).default(defaultStatus),
    limit,
    before: cursor,
  });

const tokenText = z.string().trim().min(8, 'Enter the delivery code').max(40, 'That is not a delivery code');
const lookupOrderSchema = z.object({ token: tokenText }).strict();
const deliverOrderSchema = z.object({ token: tokenText.optional() }).strict();

module.exports = {
  parseIdParam: (params) => idParamSchema.parse(params).id,
  parseEstimateQuery: (query) => estimateQuerySchema.parse(query),
  parseCreateDeposit: (body) => createDepositSchema.parse(body),
  parseRejectDeposit: (body) => rejectDepositSchema.parse(body),
  parseDepositList: (query, defaultStatus) => {
    const parsed = depositListSchema(defaultStatus).parse(query);
    return { ...parsed, status: parsed.status === 'ALL' ? null : parsed.status };
  },
  parseCreateOrder: (body) => createOrderSchema.parse(body),
  parseOrderList: (query, defaultStatus) => {
    const parsed = orderListSchema(defaultStatus).parse(query);
    return { ...parsed, status: parsed.status === 'ALL' ? null : parsed.status };
  },
  parseLookupOrder: (body) => lookupOrderSchema.parse(body),
  parseDeliverOrder: (body) => deliverOrderSchema.parse(body),
};