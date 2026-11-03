const { v7: uuidv7 } = require('uuid');

const AppError = require('../shared/utils/appError');
const repo = require('./notifications.repository');

// Every notification type and reference type in use. A typo in another cohort fails loudly
// instead of creating a notification the frontend does not know how to show.
// Adding a new kind means adding it here first.
const TYPES = Object.freeze({
  DEPOSIT_APPROVED: 'DEPOSIT_APPROVED',
  DEPOSIT_REJECTED: 'DEPOSIT_REJECTED',
  BET_WON: 'BET_WON',
  BET_LOST: 'BET_LOST',
  BET_REFUNDED: 'BET_REFUNDED',
  FUND_TOPUP_AUTO: 'FUND_TOPUP_AUTO',
});

const REFERENCE_TYPES = Object.freeze({
  CROP_DEPOSIT: 'CROP_DEPOSIT',
  ORDER: 'ORDER',
  BET: 'BET',
  PREDICTION_EVENT: 'PREDICTION_EVENT',
  FUND_TOPUP: 'FUND_TOPUP',
});

const MAX_MESSAGE_LENGTH = 500;
const MAX_BATCH = 10_000;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ helpers

const toNotificationDto = (row) => ({
  id: row.id,
  type: row.type,
  message: row.message,
  referenceType: row.reference_type,
  referenceId: row.reference_id,
  isRead: row.is_read,
  createdAt: row.created_at,
});

// Mistakes in the calling code (not user input): fail loudly as a logged 500.
function normalize(n) {
  if (!n || typeof n !== 'object') throw new Error('notification: an object is required');
  if (typeof n.userId !== 'string' || !UUID.test(n.userId)) throw new Error('notification: userId must be a uuid');
  if (!Object.values(TYPES).includes(n.type)) throw new Error(`notification: unknown type "${n.type}"`);
  if (typeof n.message !== 'string' || n.message.trim() === '') throw new Error('notification: message is required');

  const message = n.message.trim();
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`notification: message is longer than ${MAX_MESSAGE_LENGTH} characters`);

  const referenceType = n.referenceType ?? null;
  const referenceId = n.referenceId ?? null;
  if ((referenceType === null) !== (referenceId === null)) {
    throw new Error('notification: referenceType and referenceId must be given together');
  }
  if (referenceType !== null) {
    if (!Object.values(REFERENCE_TYPES).includes(referenceType)) throw new Error(`notification: unknown referenceType "${referenceType}"`);
    if (typeof referenceId !== 'string' || !UUID.test(referenceId)) throw new Error('notification: referenceId must be a uuid');
  }

  return { id: uuidv7(), userId: n.userId, type: n.type, message, referenceType, referenceId };
}

function decodeCursor(cursor) {
  if (!cursor) return { cursorTime: null, cursorId: null };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (CURSOR_TIME.test(parsed.t) && UUID.test(parsed.id)) return { cursorTime: parsed.t, cursorId: parsed.id };
  } catch (err) {
    // fall through
  }
  throw AppError.badRequest('Invalid cursor');
}

const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ t: row.cursor_time, id: row.id })).toString('base64url');

// ------------------------------------------- used by other cohorts (notifications.api)

/** Creates one notification. Pass the caller's transaction `client` so it commits (or rolls back) with it. */
async function create(input, client) {
  const n = normalize(input);
  await repo.insertNotification(n, client);
  return { id: n.id };
}

/** Creates many in a single statement. Returns the new ids in the same order as the input. */
async function createMany(inputs, client) {
  if (!Array.isArray(inputs)) throw new Error('createMany: an array is required');
  if (inputs.length === 0) return [];
  if (inputs.length > MAX_BATCH) throw new Error(`createMany: at most ${MAX_BATCH} notifications at once`);

  const list = inputs.map(normalize);
  await repo.insertMany(list, client);
  return list.map((n) => ({ id: n.id }));
}

// ------------------------------------------------------------ the user's own inbox

async function list({ userId, unread, limit, before }) {
  const { cursorTime, cursorId } = decodeCursor(before);
  const rows = await repo.listForUser(userId, { unreadOnly: unread, limit: limit + 1, cursorTime, cursorId });

  const page = rows.slice(0, limit);
  return {
    notifications: page.map(toNotificationDto),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

async function getUnreadCount({ userId }) {
  return { unreadCount: await repo.countUnread(userId) };
}

async function markRead({ userId, id }) {
  if (!(await repo.markRead(userId, id))) throw AppError.notFound('Notification not found');
  return { id, isRead: true };
}

async function markAllRead({ userId }) {
  return { updated: await repo.markAllRead(userId) };
}

module.exports = { TYPES, REFERENCE_TYPES, create, createMany, list, getUnreadCount, markRead, markAllRead };