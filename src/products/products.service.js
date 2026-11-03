const { v7: uuidv7 } = require('uuid');

const AppError = require('../shared/utils/appError');
const { withTransaction } = require('../shared/utils/transaction');
const repo = require('./products.repository');

const MAX_STOCK = 1_000_000_000;

// ------------------------------------------------------------------ helpers

// pg returns numeric as text ("20.0000"). Canonical form: "20", "0.5", "7.25".
function canonicalDecimal(value) {
  const [intPart, fracPart = ''] = String(value).split('.');
  const i = intPart.replace(/^0+(?=\d)/, '');
  const f = fracPart.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

const isManager = (role) => role === 'MODERATOR';

const toCropDto = (row) => ({
  id: row.id,
  name: row.name,
  unit: row.unit,
  category: row.category,
  isActive: row.is_active,
  pointsPerUnit: row.points_per_unit == null ? null : canonicalDecimal(row.points_per_unit),
  rateEffectiveFrom: row.rate_effective_from,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toItemDto = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  pricePoints: row.price_points,
  stockQuantity: row.stock_quantity,
  inStock: row.stock_quantity > 0,
  isVisible: row.is_visible,
  priceEffectiveFrom: row.price_effective_from,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const nameTaken = () => AppError.conflict('A crop with that name already exists');

function isCropNameViolation(err) {
  return err && err.code === '23505' && String(err.constraint || '').includes('crops_name');
}

// -------------------------------------------------------------------- crops

/** Farmers see only accepted (active) crops; moderators see all of them. */
async function listCrops({ role }) {
  const rows = await repo.listCrops({ onlyActive: !isManager(role) });
  return { crops: rows.map(toCropDto) };
}

async function getCrop({ id, role }) {
  const row = await repo.findCrop(id);
  if (!row || (!row.is_active && !isManager(role))) throw AppError.notFound('Crop not found');
  return toCropDto(row);
}

async function createCrop({ name, unit, category, pointsPerUnit }, userId) {
  try {
    return await withTransaction(async (client) => {
      if (await repo.findCropIdByName(name, null, client)) throw nameTaken();

      const cropId = uuidv7();
      await repo.insertCrop({ id: cropId, name, unit, category }, client);
      await repo.insertRate(
        { id: uuidv7(), cropId, pointsPerUnit, effectiveFrom: null, createdByUserId: userId },
        client
      );
      return toCropDto(await repo.findCrop(cropId, client));
    });
  } catch (err) {
    if (isCropNameViolation(err)) throw nameTaken();
    throw err;
  }
}

/** Rename, change the category, or switch a crop off/on. (The unit and the rate have their own rules.) */
async function updateCrop(id, fields) {
  try {
    return await withTransaction(async (client) => {
      if (!(await repo.lockCrop(id, client))) throw AppError.notFound('Crop not found');
      if (fields.name !== undefined && (await repo.findCropIdByName(fields.name, id, client))) {
        throw nameTaken();
      }
      await repo.updateCrop(id, fields, client);
      return toCropDto(await repo.findCrop(id, client));
    });
  } catch (err) {
    if (isCropNameViolation(err)) throw nameTaken();
    throw err;
  }
}

/**
 * A rate change never edits the old row: it closes the current one and starts a new one,
 * so deposits already submitted keep the rate they were promised.
 */
async function changeCropRate({ id, pointsPerUnit, userId }) {
  return withTransaction(async (client) => {
    if (!(await repo.lockCrop(id, client))) throw AppError.notFound('Crop not found');

    const current = await repo.findCurrentRate(id, client);
    if (current && canonicalDecimal(current.points_per_unit) === canonicalDecimal(pointsPerUnit)) {
      throw AppError.conflict(`The rate is already ${canonicalDecimal(pointsPerUnit)} points per unit`);
    }

    const closed = await repo.closeCurrentRate(id, client);
    await repo.insertRate(
      {
        id: uuidv7(),
        cropId: id,
        pointsPerUnit,
        effectiveFrom: closed ? closed.effective_to : null, // no gap, no overlap
        createdByUserId: userId,
      },
      client
    );
    return toCropDto(await repo.findCrop(id, client));
  });
}

async function listCropRates({ id, limit }) {
  if (!(await repo.findCrop(id))) throw AppError.notFound('Crop not found');
  const rows = await repo.listRates(id, limit);
  return {
    rates: rows.map((row) => ({
      id: row.id,
      pointsPerUnit: canonicalDecimal(row.points_per_unit),
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      createdByUserId: row.created_by_user_id,
    })),
  };
}

// -------------------------------------------------------------- shop items

/** Farmers see visible items only; moderators see everything, including hidden items. */
async function listItems({ role }) {
  const rows = await repo.listItems({ onlyVisible: !isManager(role) });
  return { items: rows.map(toItemDto) };
}

async function getItem({ id, role }) {
  const row = await repo.findItem(id);
  if (!row || (!row.is_visible && !isManager(role))) throw AppError.notFound('Item not found');
  return toItemDto(row);
}

async function createItem({ name, description, pricePoints, stockQuantity, isVisible }, userId) {
  return withTransaction(async (client) => {
    const itemId = uuidv7();
    await repo.insertItem({ id: itemId, name, description, stockQuantity, isVisible }, client);
    await repo.insertPrice(
      { id: uuidv7(), itemId, pricePoints, effectiveFrom: null, createdByUserId: userId },
      client
    );
    if (stockQuantity > 0) {
      await repo.insertRestock(
        { id: uuidv7(), itemId, quantity: stockQuantity, createdByUserId: userId },
        client
      );
    }
    return toItemDto(await repo.findItem(itemId, client));
  });
}

/** Rename, change the description, or hide/show an item. (Price and stock have their own endpoints.) */
async function updateItem(id, fields) {
  return withTransaction(async (client) => {
    if (!(await repo.lockItem(id, client))) throw AppError.notFound('Item not found');
    await repo.updateItem(id, fields, client);
    return toItemDto(await repo.findItem(id, client));
  });
}

async function changeItemPrice({ id, pricePoints, userId }) {
  return withTransaction(async (client) => {
    if (!(await repo.lockItem(id, client))) throw AppError.notFound('Item not found');

    const current = await repo.findCurrentPrice(id, client);
    if (current && current.price_points === pricePoints) {
      throw AppError.conflict(`The price is already ${pricePoints} points`);
    }

    const closed = await repo.closeCurrentPrice(id, client);
    await repo.insertPrice(
      {
        id: uuidv7(),
        itemId: id,
        pricePoints,
        effectiveFrom: closed ? closed.effective_to : null,
        createdByUserId: userId,
      },
      client
    );
    return toItemDto(await repo.findItem(id, client));
  });
}

async function listItemPrices({ id, limit }) {
  if (!(await repo.findItem(id))) throw AppError.notFound('Item not found');
  const rows = await repo.listPrices(id, limit);
  return {
    prices: rows.map((row) => ({
      id: row.id,
      pricePoints: row.price_points,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      createdByUserId: row.created_by_user_id,
    })),
  };
}

/** Adds stock and logs it. Adding (not "setting") is safe while farmers are buying at the same time. */
async function restockItem({ id, quantity, userId }) {
  return withTransaction(async (client) => {
    const item = await repo.lockItem(id, client);
    if (!item) throw AppError.notFound('Item not found');
    if (item.stock_quantity + quantity > MAX_STOCK) {
      throw AppError.unprocessable(`Stock cannot go above ${MAX_STOCK}`);
    }

    await repo.incrementStock(id, quantity, client);
    await repo.insertRestock({ id: uuidv7(), itemId: id, quantity, createdByUserId: userId }, client);
    return toItemDto(await repo.findItem(id, client));
  });
}

async function listRestocks({ id, limit }) {
  if (!(await repo.findItem(id))) throw AppError.notFound('Item not found');
  const rows = await repo.listRestocks(id, limit);
  return {
    restocks: rows.map((row) => ({
      id: row.id,
      quantity: row.quantity,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
    })),
  };
}

// ------------------------------------------- used by other cohorts (products.api)

/** Barter: the rate a deposit is priced at right now. Refuses crops that are switched off. */
async function getCurrentCropRate({ cropId }, client) {
  const row = await repo.findCrop(cropId, client);
  if (!row) throw AppError.notFound('Crop not found');
  if (!row.is_active) throw new AppError('This crop is no longer accepted', 422, 'CROP_NOT_ACCEPTED');
  if (!row.rate_id) throw new Error(`Crop ${cropId} has no current rate`);

  return {
    cropId: row.id,
    name: row.name,
    unit: row.unit,
    category: row.category,
    cropRateId: row.rate_id,
    pointsPerUnit: canonicalDecimal(row.points_per_unit), // a decimal STRING, never a float
  };
}

/** Barter checkout: current price and stock for the cart, in the order requested. */
async function getCurrentItemPrices({ itemIds }, client) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) throw new Error('getCurrentItemPrices: itemIds is required');
  if (new Set(itemIds).size !== itemIds.length) throw new Error('getCurrentItemPrices: duplicate itemIds');

  const rows = await repo.findItemsByIds(itemIds, client);
  const byId = new Map(rows.map((row) => [row.id, row]));

  return itemIds.map((itemId) => {
    const row = byId.get(itemId);
    if (!row) throw new AppError('Item not found', 404, 'ITEM_NOT_FOUND', { itemId });
    if (!row.is_visible) throw new AppError(`${row.name} is not available`, 422, 'ITEM_UNAVAILABLE', { itemId });
    if (row.price_points == null) throw new Error(`Item ${itemId} has no current price`);
    return { itemId: row.id, name: row.name, pricePoints: row.price_points, stockQuantity: row.stock_quantity };
  });
}

/**
 * Barter checkout: takes stock for every line, all or nothing. Must run inside the caller's
 * transaction, so if payment fails later the stock goes back automatically.
 * Each line is one atomic "decrease only if enough is left", so two buyers can never oversell.
 */
async function reserveStock({ items }, client) {
  if (!client) throw new Error('reserveStock must be called inside a transaction: pass the transaction client');
  if (!Array.isArray(items) || items.length === 0) throw new Error('reserveStock: items is required');

  const ids = items.map((line) => line.itemId);
  if (new Set(ids).size !== ids.length) throw new Error('reserveStock: duplicate itemIds');
  for (const line of items) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`reserveStock: quantity must be a positive whole number, got ${line.quantity}`);
    }
  }

  // Same order for everyone, so two checkouts sharing items cannot deadlock.
  const ordered = [...items].sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  const reserved = [];

  for (const { itemId, quantity } of ordered) {
    const remaining = await repo.decrementStock(itemId, quantity, client);
    if (remaining === null) {
      const item = await repo.findItemBasics(itemId, client);
      if (!item) throw new AppError('Item not found', 404, 'ITEM_NOT_FOUND', { itemId });
      throw new AppError(`Not enough stock for ${item.name}`, 409, 'OUT_OF_STOCK', {
        itemId,
        name: item.name,
        requested: quantity,
        available: item.stock_quantity,
      });
    }
    reserved.push({ itemId, quantity, remainingStock: remaining });
  }
  return reserved;
}

module.exports = {
  listCrops, getCrop, createCrop, updateCrop, changeCropRate, listCropRates,
  listItems, getItem, createItem, updateItem, changeItemPrice, listItemPrices, restockItem, listRestocks,
  getCurrentCropRate, getCurrentItemPrices, reserveStock,
};