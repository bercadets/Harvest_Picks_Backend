const { z } = require('zod');

// "  Rice   (white) " -> "Rice (white)"
const cleanText = (value) => value.normalize('NFC').trim().replace(/\s+/g, ' ');

const text = (label, max) =>
  z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(max, `${label} must be at most ${max} characters`)
        .regex(/^[^\p{C}]*$/u, `${label} contains invalid characters`)
    );

// Optional text that can be cleared: a string sets it, null or "" clears it, leaving it out keeps it.
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const clearableText = (label, max) => z.preprocess(emptyToNull, text(label, max).nullable()).optional();

// Rates are decimals: accept a number or a numeric string, keep it as a STRING (no float math).
const rate = z
  .union([z.number(), z.string()])
  .transform((value) => String(value).trim())
  .pipe(
    z
      .string()
      .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Rate must be a positive number with at most 4 decimal places')
      .refine((value) => Number(value) > 0, 'Rate must be greater than 0')
  );

const price = z
  .number({ error: 'Price must be a number' })
  .int('Price must be a whole number of points')
  .min(1, 'Price must be at least 1 point')
  .max(1_000_000_000, 'Price is too large');

const idParamSchema = z.object({ id: z.string().uuid('Invalid id') });
const limitQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const atLeastOne = [
  (value) => Object.values(value).some((v) => v !== undefined),
  'Provide at least one field to update',
];

// .strict() rejects unknown keys, e.g. trying to edit a crop's unit or an item's stock directly.
const createCropSchema = z
  .object({
    name: text('Name', 60),
    unit: text('Unit', 20),
    category: clearableText('Category', 50),
    pointsPerUnit: rate,
  })
  .strict()
  .transform((v) => ({ ...v, category: v.category ?? null }));

const updateCropSchema = z
  .object({
    name: text('Name', 60).optional(),
    category: clearableText('Category', 50),
    isActive: z.boolean({ error: 'isActive must be true or false' }).optional(),
  })
  .strict()
  .refine(...atLeastOne);

const createRateSchema = z.object({ pointsPerUnit: rate }).strict();

const createItemSchema = z
  .object({
    name: text('Name', 80),
    description: clearableText('Description', 500),
    pricePoints: price,
    stockQuantity: z
      .number({ error: 'Stock must be a number' })
      .int('Stock must be a whole number')
      .min(0, 'Stock cannot be negative')
      .max(1_000_000_000, 'Stock is too large')
      .default(0),
    isVisible: z.boolean({ error: 'isVisible must be true or false' }).default(true),
  })
  .strict()
  .transform((v) => ({ ...v, description: v.description ?? null }));

const updateItemSchema = z
  .object({
    name: text('Name', 80).optional(),
    description: clearableText('Description', 500),
    isVisible: z.boolean({ error: 'isVisible must be true or false' }).optional(),
  })
  .strict()
  .refine(...atLeastOne);

const createPriceSchema = z.object({ pricePoints: price }).strict();

const restockSchema = z
  .object({
    quantity: z
      .number({ error: 'Quantity must be a number' })
      .int('Quantity must be a whole number')
      .min(1, 'Quantity must be at least 1')
      .max(1_000_000, 'Quantity is too large for one restock'),
  })
  .strict();

module.exports = {
  parseIdParam: (params) => idParamSchema.parse(params).id,
  parseLimit: (query) => limitQuerySchema.parse(query).limit,
  parseCreateCrop: (body) => createCropSchema.parse(body),
  parseUpdateCrop: (body) => updateCropSchema.parse(body),
  parseCreateRate: (body) => createRateSchema.parse(body),
  parseCreateItem: (body) => createItemSchema.parse(body),
  parseUpdateItem: (body) => updateItemSchema.parse(body),
  parseCreatePrice: (body) => createPriceSchema.parse(body),
  parseRestock: (body) => restockSchema.parse(body),
};