const { v7: uuidv7 } = require('uuid');

const AppError = require('../shared/utils/appError');
const { withTransaction } = require('../shared/utils/transaction');
const repo = require('./ledger.repository');

// Which kinds of account each transfer type may move points between.
// null on `from` = new points enter the system; null on `to` = points leave the system.
const TRANSFER_RULES = {
  MODERATOR_TOPUP: { from: null, to: 'MODERATOR_FUND' },
  CROP_DEPOSIT: { from: 'MODERATOR_FUND', to: 'FARMER' },
  SHOP_PURCHASE: { from: 'FARMER', to: 'MODERATOR_FUND' },
  BET_STAKE: { from: 'FARMER', to: 'EVENT_ESCROW' },
  BET_BACKING: { from: 'MODERATOR_FUND', to: 'EVENT_ESCROW' },
  BET_PAYOUT: { from: 'EVENT_ESCROW', to: 'FARMER' },
  BET_LOSS: { from: 'EVENT_ESCROW', to: 'MODERATOR_FUND' },
  BET_REFUND: { from: 'EVENT_ESCROW', to: 'FARMER' },
  BACKING_RETURN: { from: 'EVENT_ESCROW', to: 'MODERATOR_FUND' },
  FUND_ADJUSTMENT: { from: 'MODERATOR_FUND', to: null },
};

const DEFAULT_LOW_BALANCE_LEVEL = 1000;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ helpers

const toAccountDto = (row) => ({ id: row.id, accountType: row.account_type, balance: row.balance });

const toTransferDto = (row) => ({
  id: row.id,
  referenceKey: row.reference_key,
  transferType: row.transfer_type,
  fromAccountId: row.from_account_id,
  toAccountId: row.to_account_id,
  amount: row.amount,
  fromBalanceAfter: row.from_balance_after,
  toBalanceAfter: row.to_balance_after,
  createdAt: row.created_at,
});

const toTopupDto = (row) => ({
  id: row.id,
  ledgerTransferId: row.ledger_transfer_id,
  triggerType: row.trigger_type,
  eventId: row.event_id,
  betId: row.bet_id,
  status: row.status,
  amount: row.amount,
  authorizedByUserId: row.authorized_by_user_id,
  reviewedByUserId: row.reviewed_by_user_id,
  reviewedAt: row.reviewed_at,
  createdAt: row.created_at,
});

function requireClient(client, fnName) {
  if (!client) {
    throw new Error(`${fnName} must be called inside a transaction: pass the transaction client`);
  }
}

function insufficientFunds(account, required) {
  const isFund = account.account_type === 'MODERATOR_FUND';
  const details = { accountType: account.account_type, required };
  if (!isFund) details.available = account.balance; // never reveal the fund's balance to farmers
  return new AppError(
    isFund ? 'The Moderator Fund does not have enough points' : 'Not enough points',
    422,
    'INSUFFICIENT_FUNDS',
    details
  );
}

// ------------------------------------------------------- the one money door

/**
 * Moves points between accounts. EVERY point movement in the system goes through here.
 *
 * args: { referenceKey, transferType, fromAccountId, toAccountId, amount, description, createdByUserId }
 *  - referenceKey is the idempotency key. Same key + same details again returns the original
 *    transfer ({ ...transfer, replayed: true }) without moving anything. Same key with
 *    different details is a 409.
 *  - Joins the caller's transaction when `client` is passed; otherwise runs its own.
 *  - Throws a 422 INSUFFICIENT_FUNDS (and changes nothing) if the source would go below 0.
 */
async function transfer(args, client) {
  if (!client) return withTransaction((tx) => transfer(args, tx));

  const {
    referenceKey,
    transferType,
    fromAccountId = null,
    toAccountId = null,
    amount,
    description = null,
    createdByUserId = null,
  } = args;

  // Mistakes in the calling code (not user input): fail loudly as a 500 and log it.
  const rule = TRANSFER_RULES[transferType];
  if (!rule) throw new Error(`Unknown transfer type: ${transferType}`);
  if (typeof referenceKey !== 'string' || referenceKey.length === 0) {
    throw new Error('transfer: referenceKey is required');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`transfer: amount must be a positive whole number, got ${amount}`);
  }
  if ((rule.from === null) !== (fromAccountId === null)) {
    throw new Error(`transfer: ${transferType} ${rule.from === null ? 'must not have' : 'needs'} a from account`);
  }
  if ((rule.to === null) !== (toAccountId === null)) {
    throw new Error(`transfer: ${transferType} ${rule.to === null ? 'must not have' : 'needs'} a to account`);
  }
  if (fromAccountId !== null && fromAccountId === toAccountId) {
    throw new Error('transfer: from and to accounts must differ');
  }

  // 1. Lock every account involved, in id order.
  const ids = [fromAccountId, toAccountId].filter(Boolean);
  const locked = await repo.lockAccounts(ids, client);
  const byId = new Map(locked.map((row) => [row.id, row]));
  const from = fromAccountId ? byId.get(fromAccountId) : null;
  const to = toAccountId ? byId.get(toAccountId) : null;
  if ((fromAccountId && !from) || (toAccountId && !to)) throw AppError.notFound('Account not found');

  // 2. Idempotency check AFTER the locks: a concurrent request with the same key has
  //    either finished by now (we see its transfer) or is still holding the lock.
  const existing = await repo.findTransferByReferenceKey(referenceKey, client);
  if (existing) {
    const same =
      existing.transfer_type === transferType &&
      existing.from_account_id === fromAccountId &&
      existing.to_account_id === toAccountId &&
      existing.amount === amount;
    if (!same) throw AppError.conflict('This reference key was already used for a different transfer');
    return { ...toTransferDto(existing), replayed: true };
  }

  if (from && from.account_type !== rule.from) throw new Error(`transfer: ${transferType} cannot take points from a ${from.account_type} account`);
  if (to && to.account_type !== rule.to) throw new Error(`transfer: ${transferType} cannot send points to a ${to.account_type} account`);

  // 3. Never go below zero.
  if (from && from.balance < amount) throw insufficientFunds(from, amount);
  if (to && !Number.isSafeInteger(to.balance + amount)) throw new Error('transfer: balance would overflow');

  // 4. Move the points and write the record.
  const fromBalanceAfter = from ? await repo.adjustBalance(from.id, -amount, client) : null;
  const toBalanceAfter = to ? await repo.adjustBalance(to.id, amount, client) : null;

  const row = await repo.insertTransfer(
    {
      id: uuidv7(),
      referenceKey,
      transferType,
      fromAccountId,
      toAccountId,
      amount,
      fromBalanceAfter,
      toBalanceAfter,
      description,
      createdByUserId,
    },
    client
  );
  return { ...toTransferDto(row), replayed: false };
}

// --------------------------------------------- accounts (used by other cohorts)

async function openFarmerAccount({ userId }, client) {
  return toAccountDto(await repo.insertAccount({ id: uuidv7(), accountType: 'FARMER', userId }, client));
}

async function openEventEscrow({ eventId }, client) {
  return toAccountDto(await repo.insertAccount({ id: uuidv7(), accountType: 'EVENT_ESCROW', eventId }, client));
}

async function getFarmerAccount({ userId }, client) {
  const row = await repo.findAccountByUserId(userId, client);
  if (!row) throw AppError.notFound('Farmer account not found');
  return toAccountDto(row);
}

async function getEscrowAccount({ eventId }, client) {
  const row = await repo.findAccountByEventId(eventId, client);
  if (!row) throw AppError.notFound('Event escrow account not found');
  return toAccountDto(row);
}

async function getFundAccount(client) {
  const row = await repo.findFundAccount(client);
  if (!row) throw new Error('The MODERATOR_FUND account is missing. Run db/schema.sql or npm run seed.');
  return toAccountDto(row);
}

// ------------------------------------------------------ automatic fund top-up

/**
 * Step 1 of the auto top-up, for Prediction's place-bet transaction.
 * Locks the fund and, if it holds less than `requiredPoints`, tops it up by exactly the
 * shortfall (a MODERATOR_TOPUP with no human author). Returns null when nothing was needed.
 * Never refuses a bet for lack of fund points.
 */
async function autoTopUpIfShort({ requiredPoints, referenceKey }, client) {
  requireClient(client, 'autoTopUpIfShort');
  const fund = await repo.lockFundAccount(client);
  if (!fund) throw new Error('The MODERATOR_FUND account is missing');

  const shortfall = requiredPoints - fund.balance;
  if (shortfall <= 0) return null;

  const t = await transfer(
    {
      referenceKey,
      transferType: 'MODERATOR_TOPUP',
      toAccountId: fund.id,
      amount: shortfall,
      description: 'Automatic top-up (simulated): fund shortfall',
      createdByUserId: null,
    },
    client
  );
  return { transferId: t.id, amount: shortfall };
}

/**
 * Step 2: call this AFTER the bet row exists (fund_topups.bet_id points at it).
 * Records the top-up for the moderator's review queue as PENDING_REVIEW.
 */
async function recordAutoTopUp({ transferId, eventId, betId, authorizedByUserId }, client) {
  requireClient(client, 'recordAutoTopUp');
  const id = uuidv7();
  await repo.insertFundTopup(
    {
      id,
      ledgerTransferId: transferId,
      triggerType: 'AUTO_SHORTFALL',
      eventId,
      betId,
      status: 'PENDING_REVIEW',
      authorizedByUserId,
      reviewedByUserId: null,
    },
    client
  );
  return { id };
}

// ----------------------------------------------------- passbook and history

function decodeCursor(cursor) {
  if (!cursor) return { cursorTime: null, cursorId: null };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (CURSOR_TIME.test(parsed.t) && UUID.test(parsed.id)) {
      return { cursorTime: parsed.t, cursorId: parsed.id };
    }
  } catch (err) {
    // fall through
  }
  throw AppError.badRequest('Invalid cursor');
}

const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ t: row.cursor_time, id: row.id })).toString('base64url');

async function listHistory(accountId, { limit, before }, { showActor }) {
  const { cursorTime, cursorId } = decodeCursor(before);
  const rows = await repo.listTransfersForAccount(accountId, { limit: limit + 1, cursorTime, cursorId });

  const page = rows.slice(0, limit);
  const entries = page.map((row) => {
    const incoming = row.to_account_id === accountId;
    const entry = {
      id: row.id,
      date: row.created_at,
      type: row.transfer_type,
      description: row.description,
      direction: incoming ? 'IN' : 'OUT',
      amount: row.amount,
      balanceAfter: incoming ? row.to_balance_after : row.from_balance_after,
    };
    if (showActor) entry.createdByUserId = row.created_by_user_id;
    return entry;
  });

  return { entries, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

/** A farmer's own passbook. Farmers can only ever see their own account. */
async function getPassbook({ userId, limit, before }) {
  const account = await repo.findAccountByUserId(userId);
  if (!account) throw AppError.notFound('Passbook not found');
  const history = await listHistory(account.id, { limit, before }, { showActor: false });
  return { balance: account.balance, ...history };
}

function lowBalanceLevel() {
  const raw = process.env.FUND_LOW_BALANCE_LEVEL;
  return raw !== undefined && raw !== '' && Number.isFinite(Number(raw))
    ? Number(raw)
    : DEFAULT_LOW_BALANCE_LEVEL;
}

async function getFundSummary() {
  const fund = await getFundAccount();
  const level = lowBalanceLevel();
  return { balance: fund.balance, lowBalanceLevel: level, isLow: fund.balance < level };
}

async function getFundHistory({ limit, before }) {
  const fund = await getFundAccount();
  const history = await listHistory(fund.id, { limit, before }, { showActor: true });
  return { balance: fund.balance, ...history };
}

// ------------------------------------------------- moderator fund top-ups

/** Moderator's simulated deposit: the only way new points enter the system by hand. */
async function manualTopUp({ amount, idempotencyKey, userId }) {
  return withTransaction(async (client) => {
    const fund = await getFundAccount(client);
    const t = await transfer(
      {
        referenceKey: `topup:manual:${idempotencyKey}`,
        transferType: 'MODERATOR_TOPUP',
        toAccountId: fund.id,
        amount,
        description: 'Moderator Deposit (simulated)',
        createdByUserId: userId,
      },
      client
    );

    if (!t.replayed) {
      await repo.insertFundTopup(
        {
          id: uuidv7(),
          ledgerTransferId: t.id,
          triggerType: 'MANUAL',
          eventId: null,
          betId: null,
          status: 'CONFIRMED', // the moderator who made it has already approved it
          authorizedByUserId: userId,
          reviewedByUserId: userId,
        },
        client
      );
    }
    const row = await repo.findTopupByTransferId(t.id, client);
    return { topup: toTopupDto(row), replayed: t.replayed };
  });
}

async function listTopups({ status, limit }) {
  const rows = await repo.listTopups({ status, limit });
  return { topups: rows.map(toTopupDto) };
}

/**
 * Confirm = "I checked it, it is valid". Changes no balance.
 * Dispute = "this should not have happened". The points already moved, so a compensating
 * FUND_ADJUSTMENT takes them back out (reference key topup:<id>:dispute). If the fund no longer
 * holds that many points, the dispute is refused and nothing changes.
 * Only a top-up that is still PENDING_REVIEW can be reviewed, once.
 */
async function reviewTopUp({ topupId, userId, decision }) {
  return withTransaction(async (client) => {
    const topup = await repo.findTopupById(topupId, { lock: true }, client);
    if (!topup) throw AppError.notFound('Top-up not found');
    if (topup.status !== 'PENDING_REVIEW') {
      throw AppError.conflict(`This top-up was already ${topup.status.toLowerCase()}`);
    }

    let adjustment = null;
    if (decision === 'DISPUTED') {
      const fund = await getFundAccount(client);
      adjustment = await transfer(
        {
          referenceKey: `topup:${topup.id}:dispute`,
          transferType: 'FUND_ADJUSTMENT',
          fromAccountId: fund.id,
          amount: topup.amount,
          description: `Reversal of disputed top-up ${topup.id}`,
          createdByUserId: userId,
        },
        client
      );
    }

    await repo.markTopupReviewed(topup.id, decision, userId, client);
    const updated = await repo.findTopupById(topup.id, {}, client);
    return { topup: toTopupDto(updated), adjustmentTransferId: adjustment ? adjustment.id : null };
  });
}

module.exports = {
  transfer,
  openFarmerAccount,
  openEventEscrow,
  getFarmerAccount,
  getEscrowAccount,
  getFundAccount,
  autoTopUpIfShort,
  recordAutoTopUp,
  getPassbook,
  getFundSummary,
  getFundHistory,
  manualTopUp,
  listTopups,
  reviewTopUp,
};