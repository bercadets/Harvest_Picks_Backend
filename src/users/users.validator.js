const { z } = require('zod');

// "  Juan   dela  Cruz " -> "Juan dela Cruz"  (also unifies composed/decomposed letters like n + ~)
const cleanName = (value) => value.normalize('NFC').trim().replace(/\s+/g, ' ');

// Registration / rename: strict rules.
const newName = z
  .string()
  .transform(cleanName)
  .pipe(
    z
      .string()
      .min(2, 'Name must be at least 2 characters')
      .max(50, 'Name must be at most 50 characters')
      .regex(/^[\p{L}\p{N} ._'-]+$/u, "Name can only contain letters, numbers, spaces and . _ ' -")
  );

// Login: lenient on purpose, so a wrong name just fails to log in instead of explaining the rules.
const loginName = z
  .string()
  .transform(cleanName)
  .pipe(z.string().min(1, 'Name is required').max(50, 'Name is too long'));

// bcrypt only uses the first 72 bytes, so refuse longer passwords instead of silently cutting them.
const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= 72,
    'Password is too long (72 bytes at most)'
  );

// Contact details: a string sets the value, null or "" clears it, leaving it out keeps it.
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const contactField = (schema) => z.preprocess(emptyToNull, schema.nullable()).optional();

const email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address');
const phoneNumber = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9\s()-]{5,19}$/, 'Enter a valid phone number');
const address = z.string().trim().min(3, 'Address is too short').max(255, 'Address is too long');

// .strict() rejects unknown keys, so a client sending { role: "MODERATOR" } gets a 400.
const registerSchema = z
  .object({ name: newName, password: newPassword })
  .strict()
  .transform(({ name, password }) => ({ name, nameNormalized: name.toLowerCase(), password }));

const loginSchema = z
  .object({ name: loginName, password: z.string().min(1, 'Password is required').max(200) })
  .strict()
  .transform(({ name, password }) => ({ nameNormalized: name.toLowerCase(), password }));

const updateProfileSchema = z
  .object({
    name: newName.optional(),
    email: contactField(email),
    phoneNumber: contactField(phoneNumber),
    address: contactField(address),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    'Provide at least one field to update'
  )
  .transform((value) => {
    const out = { profile: {} };
    if (value.name !== undefined) {
      out.name = value.name;
      out.nameNormalized = value.name.toLowerCase();
    }
    for (const key of ['email', 'phoneNumber', 'address']) {
      if (value[key] !== undefined) out.profile[key] = value[key];
    }
    return out;
  });

module.exports = {
  parseRegister: (body) => registerSchema.parse(body),
  parseLogin: (body) => loginSchema.parse(body),
  parseUpdateProfile: (body) => updateProfileSchema.parse(body),
};