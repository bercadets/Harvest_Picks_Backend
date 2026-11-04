const { v7: uuidv7 } = require('uuid');

const AppError = require('../shared/utils/appError');
const { withTransaction } = require('../shared/utils/transaction');
const ledgerApi = require('../ledger/ledger.api');
const notificationsApi = require('../notifications/notifications.api');
const repo = require('./prediction.repository');

const DEFAULT_QUOTE_STAKE = 100;
const MAX_MULTIPLIER_X100 = 9_999_999_999n; // locked_multiplier is numeric(10,2)
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ helpers

const isManager = (user) => user.role === 'MODERATOR';
const short = (text, max = 100) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

// pg returns numeric as text ("0.0500"). Canonical form: "0.05".
function canonicalDecimal(value) {
  const [intPart, fracPart = ''] = String(value).split('.');
  const i = intPart.replace(/^0+(?=\d)/, '');
  const f = fracPart.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// "0.05" with scale 4 -> 500n. Integer arithmetic only, so no floating-point rounding can creep in.
function toScaled(value, scale) {
  const [intPart, fracPart = ''] = String(value).split('.');
  if (fracPart.length > scale) throw new Error(`toScaled: "${value}" has more than ${scale} decimals`);
  return BigInt(intPart + fracPart.padEnd(scale, '0'));
}

/**
 * The odds for a bet of `stake` on an option, in exact integer math:
 *
 *   multiplier = floor_2dp( (total_pool + stake) x (1 - house_margin) / (option_pool + stake) ), never below 1.00
 *   payout     = floor(stake x multiplier)
 *   backing    = payout - stake            (what the Moderator Fund adds to the pot)
 *
 * Pools = seed points + real stakes (all options for the total, this option for the option pool).
 * The multiplier is kept x100 (183 = 1.83) and the margin x10,000 (500 = 0.05).
 */
function computeQuote({ totalPool, optionPool, stake, marginScaled }) {
  const s = BigInt(stake);
  let m100 = ((BigInt(totalPool) + s) * (10_000n - marginScaled)) / ((BigInt(optionPool) + s) * 100n);
  if (m100 < 100n) m100 = 100n;
  const payout = (s * m100) / 100n;
  return {
    m100,
    multiplier: `${m100 / 100n}.${String(m100 % 100n).padStart(2, '0')}`,
    payout,
    backing: payout - s,
  };
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

function isIdempotencyViolation(err) {
  return err && err.code === '23505' && String(err.constraint || '').includes('idempotency_key');
}

// ---------------------------------------------------------------------- DTOs

function toEventDto(row, options, { manager, stake }) {
  const quotedStake = stake ?? Math.min(DEFAULT_QUOTE_STAKE, row.max_bet_points);
  const marginScaled = toScaled(row.house_margin, 4);
  const totalPool = options.reduce((sum, o) => sum + o.seed_points + o.staked_points, 0);

  const dto = {
    id: row.id,
    question: row.question,
    description: row.description,
    status: row.status,
    bettingOpen: row.betting_open,
    maxBetPoints: row.max_bet_points,
    closesAt: row.closes_at,
    winningOptionId: row.winning_option_id,
    cancelReason: row.cancel_reason,
    resolvedAt: row.resolved_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    totalPoolPoints: totalPool,
    quotedStake, // the multipliers below are what a bet of this size would get right now
    options: options.map((o) => {
      const poolPoints = o.seed_points + o.staked_points;
      const q = computeQuote({ totalPool, optionPool: poolPoints, stake: quotedStake, marginScaled });
      return {
        id: o.id,
        label: o.label,
        displayOrder: o.display_order,
        seedPoints: o.seed_points,
        stakedPoints: o.staked_points,
        poolPoints,
        multiplier: q.multiplier,
        potentialPayoutPoints: Number(q.payout),
      };
    }),
  };

  if (manager) {
    dto.houseMargin = canonicalDecimal(row.house_margin);
    dto.noWinnerPolicy = row.no_winner_policy;
    dto.createdByUserId = row.created_by_user_id;
    dto.resolvedByUserId = row.resolved_by_user_id;
  }
  return dto;
}

function toBetDto(row, { manager }) {
  const dto = {
    id: row.id,
    eventId: row.event_id,
    question: row.question,
    eventStatus: row.event_status,
    optionId: row.option_id,
    optionLabel: row.option_label,
    stakePoints: row.stake_points,
    lockedMultiplier: row.locked_multiplier, // "1.83": fixed when the bet was placed
    potentialPayoutPoints: row.potential_payout_points,
    status: row.status,
    settledAt: row.settled_at,
    createdAt: row.created_at,
  };
  if (manager) {
    dto.farmerUserId = row.farmer_user_id;
    dto.backingPoints = row.backing_points;
  }
  return dto;
}

async function loadEventDto(id, { manager, stake }, db) {
  const row = await repo.findEvent(id, db);
  if (!row) throw AppError.notFound('Event not found');
  const options = await repo.listOptionsWithPools([id], db);
  return toEventDto(row, options, { manager, stake });
}

async function lockEventOrFail(id, client) {
  const event = await repo.lockEvent(id, client);
  if (!event) throw AppError.notFound('Event not found');
  return event;
}

// =================================================================== EVENTS

async function createEvent(input, moderatorId) {
  return withTransaction(async (client) => {
    const eventId = uuidv7();
    await repo.insertEvent(
      {
        id: eventId,
        question: input.question,
        description: input.description,
        maxBetPoints: input.maxBetPoints,
        houseMargin: input.houseMargin,
        noWinnerPolicy: input.noWinnerPolicy,
        closesAt: input.closesAt,
        createdByUserId: moderatorId,
      },
      client
    );
    await repo.insertOptions(
      eventId,
      input.options.map((o, index) => ({ id: uuidv7(), label: o.label, seedPoints: o.seedPoints, displayOrder: index })),
      client
    );
    await ledgerApi.openEventEscrow({ eventId }, client); // the pot for this event
    return loadEventDto(eventId, { manager: true }, client);
  });
}

async function listEvents({ status, stake, limit, before, manager }) {
  const { cursorTime, cursorId } = decodeCursor(before);
  const rows = await repo.listEvents({ status, limit: limit + 1, cursorTime, cursorId });
  const { pageRows, nextCursor } = page(rows, limit);

  const options = pageRows.length ? await repo.listOptionsWithPools(pageRows.map((r) => r.id)) : [];
  const byEvent = new Map();
  for (const option of options) {
    if (!byEvent.has(option.event_id)) byEvent.set(option.event_id, []);
    byEvent.get(option.event_id).push(option);
  }
  return {
    events: pageRows.map((row) => toEventDto(row, byEvent.get(row.id) || [], { manager, stake })),
    nextCursor,
  };
}

async function getEvent({ id, stake, user }) {
  return loadEventDto(id, { manager: isManager(user), stake }, undefined);
}

/** Moderator closes betting by hand (OPEN -> CLOSED). */
async function closeEvent({ id }) {
  return withTransaction(async (client) => {
    const event = await lockEventOrFail(id, client);
    if (event.status !== 'OPEN') throw AppError.conflict(`This event is already ${event.status.toLowerCase()}`);
    if ((await repo.markEventClosed(id, client)) !== 1) throw new Error(`Event ${id} could not be closed`);
    return loadEventDto(id, { manager: true }, client);
  });
}

// ===================================================================== BETS

/**
 * Place a bet. One transaction, in this order:
 *  1. lock the event, check it is open and before its closing time, check the stake limit
 *  2. work out the odds from the pools, then the payout and the backing the fund must add
 *  3. top the fund up automatically if it cannot cover the backing (a bet is never refused for that)
 *  4. take the stake from the farmer, take the backing from the fund, both into the event's pot
 *  5. save the bet, then record the auto top-up (it points at the bet) and tell the moderator
 * The odds are locked into the bet. Anything that fails (e.g. the farmer cannot afford the stake)
 * rolls everything back, including the auto top-up.
 */
async function placeBet({ eventId, farmerUserId, optionId, stakePoints, idempotencyKey }) {
  try {
    return await withTransaction(async (client) => {
      await repo.lockIdempotencyKey(idempotencyKey, client);

      const existing = await repo.findBetByIdempotencyKey(idempotencyKey, client);
      if (existing) {
        if (existing.event_id !== eventId || existing.option_id !== optionId || existing.stake_points !== stakePoints) {
          throw AppError.conflict('This Idempotency-Key was already used for a different bet');
        }
        return { bet: toBetDto(existing, { manager: false }), replayed: true };
      }

      // 1. The event row lock makes every bet, close, resolve and cancel on this event take turns.
      const event = await lockEventOrFail(eventId, client);
      if (event.status !== 'OPEN') throw new AppError('This event is not open for betting', 409, 'EVENT_NOT_OPEN');
      if (event.past_close) throw new AppError('Betting has closed for this event', 409, 'EVENT_CLOSED');
      if (stakePoints > event.max_bet_points) {
        throw new AppError(
          `The maximum bet for this event is ${event.max_bet_points} points`,
          422,
          'STAKE_TOO_HIGH',
          { maxBetPoints: event.max_bet_points }
        );
      }

      // 2. Odds. Safe to read now: nobody else can add a bet to this event while we hold the lock.
      const options = await repo.listOptionsWithPools([eventId], client);
      const option = options.find((o) => o.id === optionId);
      if (!option) throw AppError.notFound('That option does not belong to this event');

      const totalPool = options.reduce((sum, o) => sum + o.seed_points + o.staked_points, 0);
      const quote = computeQuote({
        totalPool,
        optionPool: option.seed_points + option.staked_points,
        stake: stakePoints,
        marginScaled: toScaled(event.house_margin, 4),
      });
      if (quote.m100 > MAX_MULTIPLIER_X100 || quote.payout > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw AppError.unprocessable('The odds for this option are out of range');
      }
      const potentialPayoutPoints = Number(quote.payout);
      const backingPoints = Number(quote.backing);

      const betId = uuidv7();
      const farmer = await ledgerApi.getFarmerAccount({ userId: farmerUserId }, client);
      const fund = await ledgerApi.getFundAccount(client);
      const escrow = await ledgerApi.getEscrowAccount({ eventId }, client);
      const label = short(event.question);

      // 3. A fund shortage never refuses a bet: the shortfall is topped up and queued for review.
      const topUp =
        backingPoints > 0
          ? await ledgerApi.autoTopUpIfShort(
              { requiredPoints: backingPoints, referenceKey: `bet:${betId}:topup` },
              client
            )
          : null;

      // 4. Stake into the pot (422 INSUFFICIENT_FUNDS if the farmer cannot afford it), then the fund's backing.
      const stakeTransfer = await ledgerApi.transfer(
        {
          referenceKey: `bet:${betId}:stake`,
          transferType: 'BET_STAKE',
          fromAccountId: farmer.id,
          toAccountId: escrow.id,
          amount: stakePoints,
          description: `Bet on ${label}`,
          createdByUserId: farmerUserId,
        },
        client
      );
      const backingTransfer =
        backingPoints > 0
          ? await ledgerApi.transfer(
              {
                referenceKey: `bet:${betId}:backing`,
                transferType: 'BET_BACKING',
                fromAccountId: fund.id,
                toAccountId: escrow.id,
                amount: backingPoints,
                description: `Fund backing for a bet on ${label}`,
                createdByUserId: null,
              },
              client
            )
          : null;

      // 5. Save the bet, then the things that point at it.
      await repo.insertBet(
        {
          id: betId,
          eventId,
          optionId,
          farmerUserId,
          stakePoints,
          lockedMultiplier: quote.multiplier,
          potentialPayoutPoints,
          backingPoints,
          idempotencyKey,
          stakeTransferId: stakeTransfer.id,
          backingTransferId: backingTransfer ? backingTransfer.id : null,
        },
        client
      );

      if (topUp) {
        const recorded = await ledgerApi.recordAutoTopUp(
          { transferId: topUp.transferId, eventId, betId, authorizedByUserId: event.created_by_user_id },
          client
        );
        await notificationsApi.create(
          {
            userId: event.created_by_user_id,
            type: notificationsApi.TYPES.FUND_TOPUP_AUTO,
            message: `The Moderator Fund was topped up automatically with ${topUp.amount} points to back a bet on "${label}". Please review it.`,
            referenceType: notificationsApi.REFERENCE_TYPES.FUND_TOPUP,
            referenceId: recorded.id,
          },
          client
        );
      }

      return { bet: toBetDto(await repo.findBetById(betId, client), { manager: false }), replayed: false };
    });
  } catch (err) {
    if (!isIdempotencyViolation(err)) throw err;
    // Backstop only: the advisory lock normally makes this unreachable.
    return { bet: toBetDto(await repo.findBetByIdempotencyKey(idempotencyKey), { manager: false }), replayed: true };
  }
}

/** Farmer: their own bets ("My Predictions"). Moderator: every bet on one event. */
async function listBets({ farmerUserId = null, eventId = null, status, limit, before, manager }) {
  const { cursorTime, cursorId } = decodeCursor(before);
  const rows = await repo.listBets({ farmerUserId, eventId, status, limit: limit + 1, cursorTime, cursorId });
  const { pageRows, nextCursor } = page(rows, limit);
  return { bets: pageRows.map((row) => toBetDto(row, { manager })), nextCursor };
}

async function listEventBets({ eventId, status, limit, before }) {
  if (!(await repo.findEvent(eventId))) throw AppError.notFound('Event not found');
  return listBets({ eventId, status, limit, before, manager: true });
}

// ================================================================ SETTLEMENT

async function loadSettlementContext(eventId, client) {
  const bets = await repo.listActiveBetsForSettlement(eventId, client);
  const escrow = await ledgerApi.getEscrowAccount({ eventId }, client);
  const fund = await ledgerApi.getFundAccount(client);
  const farmerAccounts = new Map();
  for (const userId of new Set(bets.map((b) => b.farmer_user_id))) {
    farmerAccounts.set(userId, (await ledgerApi.getFarmerAccount({ userId }, client)).id);
  }
  return { bets, escrow, fund, farmerAccounts };
}

/**
 * Settles every open bet of an event with one transfer per bet leg:
 *   PAY    escrow -> farmer for the full potential payout           (bet WON)
 *   LOSE   escrow -> fund for stake + backing                       (bet LOST)
 *   REFUND stake escrow -> farmer, backing escrow -> fund           (bet REFUNDED)
 * Each bet's pot contribution (stake + backing) equals its potential payout, so the pot always
 * ends at exactly zero. That is asserted before anything is committed.
 */
async function settleAll({ event, ctx, decide, moderatorId, notificationText, client }) {
  const updates = [];
  const notes = [];
  const totals = { winners: 0, losers: 0, refunded: 0, paidOutPoints: 0, returnedToFundPoints: 0, refundedStakePoints: 0 };
  const label = short(event.question);

  for (const bet of ctx.bets) {
    const action = decide(bet);
    const farmerAccountId = ctx.farmerAccounts.get(bet.farmer_user_id);
    let update;

    if (action === 'PAY') {
      const t = await ledgerApi.transfer(
        {
          referenceKey: `bet:${bet.id}:payout`,
          transferType: 'BET_PAYOUT',
          fromAccountId: ctx.escrow.id,
          toAccountId: farmerAccountId,
          amount: bet.potential_payout_points,
          description: `Won: ${label}`,
          createdByUserId: moderatorId,
        },
        client
      );
      update = { betId: bet.id, status: 'WON', settlementTransferId: t.id, fundReturnTransferId: null };
      totals.winners += 1;
      totals.paidOutPoints += bet.potential_payout_points;
    } else if (action === 'LOSE') {
      const amount = bet.stake_points + bet.backing_points;
      const t = await ledgerApi.transfer(
        {
          referenceKey: `bet:${bet.id}:loss`,
          transferType: 'BET_LOSS',
          fromAccountId: ctx.escrow.id,
          toAccountId: ctx.fund.id,
          amount,
          description: `Lost bet: ${label}`,
          createdByUserId: moderatorId,
        },
        client
      );
      update = { betId: bet.id, status: 'LOST', settlementTransferId: null, fundReturnTransferId: t.id };
      totals.losers += 1;
      totals.returnedToFundPoints += amount;
    } else {
      const refund = await ledgerApi.transfer(
        {
          referenceKey: `bet:${bet.id}:refund`,
          transferType: 'BET_REFUND',
          fromAccountId: ctx.escrow.id,
          toAccountId: farmerAccountId,
          amount: bet.stake_points,
          description: `Refund: ${label}`,
          createdByUserId: moderatorId,
        },
        client
      );
      let backingReturn = null;
      if (bet.backing_points > 0) {
        backingReturn = await ledgerApi.transfer(
          {
            referenceKey: `bet:${bet.id}:backing-return`,
            transferType: 'BACKING_RETURN',
            fromAccountId: ctx.escrow.id,
            toAccountId: ctx.fund.id,
            amount: bet.backing_points,
            description: `Backing returned: ${label}`,
            createdByUserId: moderatorId,
          },
          client
        );
      }
      update = {
        betId: bet.id,
        status: 'REFUNDED',
        settlementTransferId: refund.id,
        fundReturnTransferId: backingReturn ? backingReturn.id : null,
      };
      totals.refunded += 1;
      totals.refundedStakePoints += bet.stake_points;
      totals.returnedToFundPoints += bet.backing_points;
    }

    updates.push(update);
    notes.push({
      userId: bet.farmer_user_id,
      type: { WON: notificationsApi.TYPES.BET_WON, LOST: notificationsApi.TYPES.BET_LOST, REFUNDED: notificationsApi.TYPES.BET_REFUNDED }[update.status],
      message: notificationText(update.status, bet),
      referenceType: notificationsApi.REFERENCE_TYPES.BET,
      referenceId: bet.id,
    });
  }

  if (updates.length > 0 && (await repo.settleBets(updates, client)) !== updates.length) {
    throw new Error(`Event ${event.id}: not every bet could be settled`);
  }
  return { notes, totals };
}

// The pot must be empty before anything is committed. If it is not, the whole settlement rolls back.
async function assertPotIsEmpty(eventId, client) {
  const escrow = await ledgerApi.getEscrowAccount({ eventId }, client);
  if (escrow.balance !== 0) {
    throw new Error(`Event ${eventId}: the pot holds ${escrow.balance} points after settlement (expected 0)`);
  }
}

/**
 * Moderator picks the winning option (CLOSED events only, once). Winners are paid their locked payout.
 * Losing bets go to the fund. If nobody picked the winner, the event's no_winner_policy decides:
 * REFUND_ALL refunds every bet, FUND_TAKES_POOL makes every bet lose.
 */
async function resolveEvent({ id, winningOptionId, moderatorId }) {
  return withTransaction(async (client) => {
    const event = await lockEventOrFail(id, client);
    if (event.status !== 'CLOSED') {
      throw AppError.conflict(
        event.status === 'OPEN' ? 'Close the event before resolving it' : `This event is already ${event.status.toLowerCase()}`
      );
    }

    const options = await repo.listOptionsWithPools([id], client);
    if (!options.some((o) => o.id === winningOptionId)) {
      throw new AppError('That option does not belong to this event', 422, 'INVALID_OPTION');
    }
    const labels = new Map(options.map((o) => [o.id, o.label]));

    const ctx = await loadSettlementContext(id, client);
    const hasWinners = ctx.bets.some((b) => b.option_id === winningOptionId);
    const refundAll = !hasWinners && event.no_winner_policy === 'REFUND_ALL';
    const q = short(event.question);

    const { notes, totals } = await settleAll({
      event,
      ctx,
      moderatorId,
      client,
      decide: (bet) => {
        if (refundAll) return 'REFUND';
        if (hasWinners && bet.option_id === winningOptionId) return 'PAY';
        return 'LOSE';
      },
      notificationText: (status, bet) => {
        const pick = labels.get(bet.option_id);
        if (status === 'WON') return `You won ${bet.potential_payout_points} points on "${q}" (${pick}).`;
        if (status === 'LOST') return `Your ${bet.stake_points}-point bet on "${q}" (${pick}) did not win.`;
        return `Nobody picked the winning option for "${q}", so your ${bet.stake_points}-point bet was refunded.`;
      },
    });

    if ((await repo.markEventResolved({ id, winningOptionId, resolvedByUserId: moderatorId }, client)) !== 1) {
      throw new Error(`Event ${id} could not be marked resolved`);
    }
    await assertPotIsEmpty(id, client);
    await notificationsApi.createMany(notes, client);

    return {
      event: await loadEventDto(id, { manager: true }, client),
      settlement: { ...totals, noWinnerPolicyApplied: hasWinners ? null : event.no_winner_policy },
    };
  });
}

/** Moderator cancels an OPEN or CLOSED event: every stake goes back to its farmer, every backing to the fund. */
async function cancelEvent({ id, reason, moderatorId }) {
  return withTransaction(async (client) => {
    const event = await lockEventOrFail(id, client);
    if (!['OPEN', 'CLOSED'].includes(event.status)) {
      throw AppError.conflict(`This event is already ${event.status.toLowerCase()}`);
    }

    const ctx = await loadSettlementContext(id, client);
    const q = short(event.question);
    const { notes, totals } = await settleAll({
      event,
      ctx,
      moderatorId,
      client,
      decide: () => 'REFUND',
      notificationText: (status, bet) => `The event "${q}" was cancelled. Your ${bet.stake_points}-point bet was refunded.`,
    });

    if ((await repo.markEventCancelled({ id, reason }, client)) !== 1) {
      throw new Error(`Event ${id} could not be marked cancelled`);
    }
    await assertPotIsEmpty(id, client);
    await notificationsApi.createMany(notes, client);

    return { event: await loadEventDto(id, { manager: true }, client), settlement: totals };
  });
}

module.exports = {
  createEvent, listEvents, getEvent, closeEvent, placeBet, listBets, listEventBets, resolveEvent, cancelEvent,
};