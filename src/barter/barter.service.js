const crypto = require('crypto');
const { v7: uuidv7 } = require('uuid');

const AppError = require('../shared/utils/appError');
const { withTransaction } = require('../shared/utils/transaction');
const ledgerApi = require('../ledger/ledger.api');
const productsApi = require('../products/products.api');
const notificationsApi = require('../notifications/notifications.api');
const repo = require('./barter.repository');

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ helpers

// pg returns numeric as text ("5.000"). Canonical form: "5", "2.5".
function canonicalDecimal(value) {
  const [intPart, fracPart = ''] = String(value).split('.');
  const i = intPart.replace(/^0+(?=\d)/, '');
  const f = fracPart.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// "12.5" with scale 4 -> 125000n. Integer arithmetic only, so no floating-point rounding can creep in.
function toScaled(value, scale) {
  const [intPart, fracPart = ''] = String(value).split('.');
  if (fracPart.length > scale) throw new Error(`toScaled: "${value}" has more than ${scale} decimals`);
  return BigInt(intPart + fracPart.padEnd(scale, '0'));
}

// floor(quantity x rate). Quantity has up to 3 decimals, the rate up to 4: 3 + 4 = 7 decimals to divide out.
function estimatePoints(quantity, ratePointsPerUnit) {
  const points = (toScaled(quantity, 3) * toScaled(ratePointsPerUnit, 4)) / 10_000_000n;
  if (points > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw AppError.unprocessable('That quantity is too large');
  }
  return Number(points);
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

function page(rows, limit) {
  const pageRows = rows.slice(0, limit);
  return { pageRows, nextCursor: rows.length > limit ? encodeCursor(pageRows[pageRows.length - 1]) : null };
}

const isManager = (user) => user.role === 'MODERATOR';

function isIdempotencyViolation(err) {
  return err && err.code === '23505' && String(err.constraint || '').includes('idempotency_key');
}

// -------------------------------------------------------------- delivery tokens
//
// The plain code is shown to the farmer in the checkout response and is NEVER stored: the database
// keeps only its SHA-256 hash. The code is derived from the order id with a server secret, so a retried
// checkout (same Idempotency-Key, e.g. after a lost response) can show the same code again.
// Format: HP-XXXX-XXXX-XXXX-XXXX (80 bits, Crockford base32: no I, L, O or U).

const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function deriveToken(orderId) {
  const digest = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`delivery-token:${orderId}`).digest();
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(digest[i]);
  let out = '';
  for (let i = 15; i >= 0; i--) out += TOKEN_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

const formatToken = (token) => `HP-${token.match(/.{4}/g).join('-')}`;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Accepts what a person might type: lower case, spaces, dashes, the HP prefix, O for 0, I or L for 1.
function normalizeToken(input) {
  let t = String(input).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (t.length === 18 && t.startsWith('HP')) t = t.slice(2);
  t = t.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(t)) throw AppError.badRequest('That is not a valid delivery code');
  return t;
}

function tokenMatches(token, storedHash) {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------- DTOs

function toDepositDto(row, crop) {
  return {
    id: row.id,
    farmerUserId: row.farmer_user_id,
    cropId: row.crop_id,
    cropName: crop ? crop.name : null,
    unit: crop ? crop.unit : null,
    quantity: canonicalDecimal(row.quantity),
    pointsPerUnit: canonicalDecimal(row.rate_points_per_unit),
    estimatedPoints: row.estimated_points,
    status: row.status,
    rejectionReason: row.rejection_reason,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    ledgerTransferId: row.ledger_transfer_id,
    createdAt: row.created_at,
  };
}

async function hydrateDeposits(rows, db) {
  const cropIds = [...new Set(rows.map((row) => row.crop_id))];
  const crops = cropIds.length ? await productsApi.getCropsByIds({ cropIds }, db) : [];
  const byId = new Map(crops.map((crop) => [crop.cropId, crop]));
  return rows.map((row) => toDepositDto(row, byId.get(row.crop_id)));
}

async function hydrateOrders(rows, db) {
  if (rows.length === 0) return [];
  const itemRows = await repo.findOrderItems(rows.map((row) => row.id), db);
  const itemIds = [...new Set(itemRows.map((item) => item.shop_item_id))];
  const items = itemIds.length ? await productsApi.getItemsByIds({ itemIds }, db) : [];
  const names = new Map(items.map((item) => [item.itemId, item.name]));

  const linesByOrder = new Map();
  for (const item of itemRows) {
    if (!linesByOrder.has(item.order_id)) linesByOrder.set(item.order_id, []);
    linesByOrder.get(item.order_id).push({
      itemId: item.shop_item_id,
      name: names.get(item.shop_item_id) ?? null,
      quantity: item.quantity,
      unitPricePoints: item.unit_price_points,
      lineTotalPoints: item.line_total_points,
    });
  }

  return rows.map((row) => ({
    id: row.id,
    farmerUserId: row.farmer_user_id,
    status: row.status,
    totalPoints: row.total_points,
    items: linesByOrder.get(row.id) || [],
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    deliveredByUserId: row.delivered_by_user_id,
  }));
}

const depositLabel = (row, crop) =>
  `${canonicalDecimal(row.quantity)} ${crop ? `${crop.unit} ${crop.name}` : 'of a crop'}`;

// ===================================================================== DEPOSITS

/** What a deposit would be worth right now. Changes nothing. */
async function estimateDeposit({ cropId, quantity }) {
  const rate = await productsApi.getCurrentCropRate({ cropId });
  const estimatedPoints = estimatePoints(quantity, rate.pointsPerUnit);
  return {
    cropId: rate.cropId,
    cropName: rate.name,
    unit: rate.unit,
    quantity,
    pointsPerUnit: rate.pointsPerUnit,
    estimatedPoints,
    meetsMinimum: estimatedPoints >= 1,
  };
}

/** Farmer submits a deposit: the current rate is saved with it, so later rate changes cannot alter it. */
async function submitDeposit({ farmerUserId, cropId, quantity, idempotencyKey }) {
  try {
    return await withTransaction(async (client) => {
      await repo.lockIdempotencyKey(idempotencyKey, client);

      const existing = await repo.findDepositByIdempotencyKey(idempotencyKey, client);
      if (existing) {
        if (existing.crop_id !== cropId || canonicalDecimal(existing.quantity) !== quantity) {
          throw AppError.conflict('This Idempotency-Key was already used for a different deposit');
        }
        const [deposit] = await hydrateDeposits([existing], client);
        return { deposit, replayed: true };
      }

      const rate = await productsApi.getCurrentCropRate({ cropId }, client); // 404 / 422 CROP_NOT_ACCEPTED
      const estimatedPoints = estimatePoints(quantity, rate.pointsPerUnit);
      if (estimatedPoints < 1) {
        throw new AppError(
          'That quantity is worth less than 1 point at the current rate',
          422,
          'DEPOSIT_TOO_SMALL',
          { estimatedPoints }
        );
      }

      const id = uuidv7();
      await repo.insertDeposit(
        {
          id,
          farmerUserId,
          cropId,
          cropRateId: rate.cropRateId,
          quantity,
          ratePointsPerUnit: rate.pointsPerUnit,
          estimatedPoints,
          idempotencyKey,
        },
        client
      );
      const [deposit] = await hydrateDeposits([await repo.findDepositById(id, {}, client)], client);
      return { deposit, replayed: false };
    });
  } catch (err) {
    if (!isIdempotencyViolation(err)) throw err;
    // Backstop only: the advisory lock normally makes this unreachable.
    const winner = await repo.findDepositByIdempotencyKey(idempotencyKey);
    const [deposit] = await hydrateDeposits([winner]);
    return { deposit, replayed: true };
  }
}

/** Farmer: own deposits. Moderator: the queue (pending ones oldest first). */
async function listDeposits({ farmerUserId, status, limit, before }) {
  const { cursorTime, cursorId } = decodeCursor(before);
  const rows = await repo.listDeposits({
    farmerUserId,
    status,
    ascending: status === 'PENDING',
    limit: limit + 1,
    cursorTime,
    cursorId,
  });
  const { pageRows, nextCursor } = page(rows, limit);
  return { deposits: await hydrateDeposits(pageRows), nextCursor };
}

async function getDeposit({ id, user }) {
  const row = await repo.findDepositById(id);
  // Someone else's deposit looks exactly like a missing one.
  if (!row || (!isManager(user) && row.farmer_user_id !== user.id)) throw AppError.notFound('Deposit not found');
  const [deposit] = await hydrateDeposits([row]);
  return deposit;
}

async function lockPendingDeposit(id, client) {
  const row = await repo.findDepositById(id, { lock: true }, client);
  if (!row) throw AppError.notFound('Deposit not found');
  if (row.status !== 'PENDING') throw AppError.conflict(`This deposit was already ${row.status.toLowerCase()}`);
  return row;
}

/**
 * Moderator confirms the crops arrived. In ONE transaction: the points move from the fund to the farmer,
 * the deposit becomes APPROVED, and the farmer is notified. If the fund cannot pay, the 422
 * INSUFFICIENT_FUNDS (details.accountType = MODERATOR_FUND) is returned and nothing changes.
 * The farmer is paid the estimate saved at submission, whatever the rate is now.
 */
async function confirmDeposit({ id, moderatorId }) {
  return withTransaction(async (client) => {
    const row = await lockPendingDeposit(id, client);
    const [crop] = await productsApi.getCropsByIds({ cropIds: [row.crop_id] }, client); // works for switched-off crops
    const farmer = await ledgerApi.getFarmerAccount({ userId: row.farmer_user_id }, client);
    const fund = await ledgerApi.getFundAccount(client);
    const label = depositLabel(row, crop);

    const transfer = await ledgerApi.transfer(
      {
        referenceKey: `deposit:${row.id}:approve`,
        transferType: 'CROP_DEPOSIT',
        fromAccountId: fund.id,
        toAccountId: farmer.id,
        amount: row.estimated_points,
        description: `Deposit: ${label}`,
        createdByUserId: moderatorId,
      },
      client
    );

    if ((await repo.markDepositApproved({ id: row.id, reviewerUserId: moderatorId, ledgerTransferId: transfer.id }, client)) !== 1) {
      throw new Error(`Deposit ${row.id} could not be approved (it was locked, so this should be impossible)`);
    }

    await notificationsApi.create(
      {
        userId: row.farmer_user_id,
        type: notificationsApi.TYPES.DEPOSIT_APPROVED,
        message: `Your deposit of ${label} was approved: ${row.estimated_points} points were added to your passbook.`,
        referenceType: notificationsApi.REFERENCE_TYPES.CROP_DEPOSIT,
        referenceId: row.id,
      },
      client
    );

    const [deposit] = await hydrateDeposits([await repo.findDepositById(row.id, {}, client)], client);
    return deposit;
  });
}

async function rejectDeposit({ id, moderatorId, reason }) {
  return withTransaction(async (client) => {
    const row = await lockPendingDeposit(id, client);
    const [crop] = await productsApi.getCropsByIds({ cropIds: [row.crop_id] }, client);

    if ((await repo.markDepositRejected({ id: row.id, reviewerUserId: moderatorId, reason }, client)) !== 1) {
      throw new Error(`Deposit ${row.id} could not be rejected (it was locked, so this should be impossible)`);
    }

    await notificationsApi.create(
      {
        userId: row.farmer_user_id,
        type: notificationsApi.TYPES.DEPOSIT_REJECTED,
        message: `Your deposit of ${depositLabel(row, crop)} was rejected: ${reason}`,
        referenceType: notificationsApi.REFERENCE_TYPES.CROP_DEPOSIT,
        referenceId: row.id,
      },
      client
    );

    const [deposit] = await hydrateDeposits([await repo.findDepositById(row.id, {}, client)], client);
    return deposit;
  });
}

// ======================================================================= ORDERS

function orderDescription(lines) {
  const text = `Bought: ${lines.map((l) => `${l.quantity} x ${l.name}`).join(', ')}`;
  return text.length <= 200 ? text : `Shop order: ${lines.length} items`;
}

/**
 * Checkout. Prices come from Products, never from the client. In ONE transaction: reserve stock,
 * take the points, create the order and its lines. If anything fails (not enough stock, not enough
 * points, ...) nothing at all is kept.
 * `items` is already merged: one line per item.
 */
async function checkout({ farmerUserId, items, idempotencyKey }) {
  try {
    return await withTransaction(async (client) => {
      await repo.lockIdempotencyKey(idempotencyKey, client);

      const existing = await repo.findOrderByIdempotencyKey(idempotencyKey, client);
      if (existing) {
        const [order] = await hydrateOrders([existing], client);
        const same =
          order.items.length === items.length &&
          items.every((line) => order.items.some((o) => o.itemId === line.itemId && o.quantity === line.quantity));
        if (!same) throw AppError.conflict('This Idempotency-Key was already used for a different order');

        // The same request again (for example after a lost response): show the same code again.
        const token = deriveToken(existing.id);
        const deliveryToken = tokenMatches(token, existing.delivery_token_hash) ? formatToken(token) : null;
        return { order, deliveryToken, replayed: true };
      }

      const priced = await productsApi.getCurrentItemPrices({ itemIds: items.map((l) => l.itemId) }, client);
      const lines = priced.map((p, i) => ({
        id: uuidv7(),
        itemId: p.itemId,
        name: p.name,
        quantity: items[i].quantity,
        unitPricePoints: p.pricePoints,
        lineTotalPoints: items[i].quantity * p.pricePoints,
      }));
      const totalPoints = lines.reduce((sum, l) => sum + l.lineTotalPoints, 0);
      if (!Number.isSafeInteger(totalPoints)) throw AppError.unprocessable('This order is too large');

      await productsApi.reserveStock({ items: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) }, client);

      const orderId = uuidv7();
      const farmer = await ledgerApi.getFarmerAccount({ userId: farmerUserId }, client);
      const fund = await ledgerApi.getFundAccount(client);
      const transfer = await ledgerApi.transfer(
        {
          referenceKey: `order:${orderId}:pay`,
          transferType: 'SHOP_PURCHASE',
          fromAccountId: farmer.id,
          toAccountId: fund.id,
          amount: totalPoints,
          description: orderDescription(lines),
          createdByUserId: farmerUserId,
        },
        client
      );

      const token = deriveToken(orderId);
      await repo.insertOrder(
        { id: orderId, farmerUserId, totalPoints, deliveryTokenHash: hashToken(token), ledgerTransferId: transfer.id, idempotencyKey },
        client
      );
      await repo.insertOrderItems(orderId, lines, client);

      const [order] = await hydrateOrders([await repo.findOrderById(orderId, {}, client)], client);
      return { order, deliveryToken: formatToken(token), replayed: false };
    });
  } catch (err) {
    if (!isIdempotencyViolation(err)) throw err;
    // Backstop only: the advisory lock normally makes this unreachable.
    const winner = await repo.findOrderByIdempotencyKey(idempotencyKey);
    const [order] = await hydrateOrders([winner]);
    const token = deriveToken(winner.id);
    return { order, deliveryToken: tokenMatches(token, winner.delivery_token_hash) ? formatToken(token) : null, replayed: true };
  }
}

/** Farmer: own orders. Moderator: all orders (pending ones oldest first). */
async function listOrders({ farmerUserId, status, limit, before }) {
  const { cursorTime, cursorId } = decodeCursor(before);
  const rows = await repo.listOrders({
    farmerUserId,
    status,
    ascending: status === 'PENDING_DELIVERY',
    limit: limit + 1,
    cursorTime,
    cursorId,
  });
  const { pageRows, nextCursor } = page(rows, limit);
  return { orders: await hydrateOrders(pageRows), nextCursor };
}

async function getOrder({ id, user }) {
  const row = await repo.findOrderById(id);
  if (!row || (!isManager(user) && row.farmer_user_id !== user.id)) throw AppError.notFound('Order not found');
  const [order] = await hydrateOrders([row]);
  return order;
}

/** Moderator: find an order from the code the farmer shows at pickup. */
async function lookupOrder({ token }) {
  const row = await repo.findOrderByTokenHash(hashToken(normalizeToken(token)));
  if (!row) throw AppError.notFound('No order matches that delivery code');
  const [order] = await hydrateOrders([row]);
  return order;
}

/**
 * Moderator hands over the goods. If a delivery code is given it must belong to this order (protects
 * against marking the wrong order). Leaving it out is allowed, for a farmer who lost the code and was
 * checked another way.
 */
async function markDelivered({ id, moderatorId, token }) {
  return withTransaction(async (client) => {
    const row = await repo.findOrderById(id, { lock: true }, client);
    if (!row) throw AppError.notFound('Order not found');
    if (row.status === 'DELIVERED') throw AppError.conflict('This order was already delivered');

    if (token !== undefined && !tokenMatches(normalizeToken(token), row.delivery_token_hash)) {
      throw new AppError('That delivery code does not belong to this order', 422, 'DELIVERY_CODE_MISMATCH');
    }

    if ((await repo.markOrderDelivered({ id: row.id, moderatorUserId: moderatorId }, client)) !== 1) {
      throw new Error(`Order ${row.id} could not be marked delivered (it was locked, so this should be impossible)`);
    }
    const [order] = await hydrateOrders([await repo.findOrderById(row.id, {}, client)], client);
    return order;
  });
}

module.exports = {
  estimateDeposit, submitDeposit, listDeposits, getDeposit, confirmDeposit, rejectDeposit,
  checkout, listOrders, getOrder, lookupOrder, markDelivered,
};