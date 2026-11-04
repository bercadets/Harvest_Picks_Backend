// SQL only. No business rules here.
// Convention: the last argument is the database handle (default: the pool).
// Pass the transaction `client` for anything that must commit or roll back together.
const { pool } = require('../config/database');

// API field name -> column name. Only these can ever reach the SQL text.
const CROP_COLUMNS = { name: 'name', category: 'category', isActive: 'is_active' };
const ITEM_COLUMNS = { name: 'name', description: 'description', isVisible: 'is_visible' };

function buildSet(fields, columnMap) {
  const keys = Object.keys(fields).filter((key) => key in columnMap);
  return {
    sql: keys.map((key, i) => `${columnMap[key]} = $${i + 2}`).join(', '),
    values: keys.map((key) => fields[key]),
  };
}

// A crop together with its CURRENT rate (the row whose effective_to is null).
const CROP_WITH_RATE = `
  SELECT c.id, c.name, c.unit, c.category, c.is_active, c.created_at, c.updated_at,
         r.id AS rate_id, r.points_per_unit, r.effective_from AS rate_effective_from
    FROM crops c
    LEFT JOIN crop_rates r ON r.crop_id = c.id AND r.effective_to IS NULL`;

// A shop item together with its CURRENT price.
const ITEM_WITH_PRICE = `
  SELECT i.id, i.name, i.description, i.stock_quantity, i.is_visible, i.created_at, i.updated_at,
         p.id AS price_id, p.price_points, p.effective_from AS price_effective_from
    FROM shop_items i
    LEFT JOIN shop_item_prices p ON p.shop_item_id = i.id AND p.effective_to IS NULL`;

// ------------------------------------------------------------------- crops

async function insertCrop({ id, name, unit, category }, db = pool) {
  await db.query('INSERT INTO crops (id, name, unit, category) VALUES ($1, $2, $3, $4)', [
    id, name, unit, category,
  ]);
}

async function findCrop(id, db = pool) {
  const { rows } = await db.query(`${CROP_WITH_RATE} WHERE c.id = $1`, [id]);
  return rows[0] || null;
}

// Names and units for crops that already have deposits, whether or not they are still accepted.
async function findCropsByIds(ids, db = pool) {
  const { rows } = await db.query(
    'SELECT id, name, unit, category, is_active FROM crops WHERE id = ANY($1::uuid[])',
    [ids]
  );
  return rows;
}

async function listCrops({ onlyActive }, db = pool) {
  const { rows } = await db.query(
    `${CROP_WITH_RATE} WHERE ($1::boolean = false OR c.is_active) ORDER BY lower(c.name), c.id`,
    [onlyActive]
  );
  return rows;
}

// Serializes everything that changes one crop (rename, rate change).
async function lockCrop(id, db = pool) {
  const { rows } = await db.query('SELECT id FROM crops WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] || null;
}

async function findCropIdByName(name, excludeId, db = pool) {
  const { rows } = await db.query(
    'SELECT id FROM crops WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)',
    [name, excludeId]
  );
  return rows[0] || null;
}

async function updateCrop(id, fields, db = pool) {
  const { sql, values } = buildSet(fields, CROP_COLUMNS);
  if (!sql) return;
  await db.query(`UPDATE crops SET ${sql} WHERE id = $1`, [id, ...values]);
}

// ------------------------------------------------------------- crop rates

async function findCurrentRate(cropId, db = pool) {
  const { rows } = await db.query(
    'SELECT id, points_per_unit FROM crop_rates WHERE crop_id = $1 AND effective_to IS NULL',
    [cropId]
  );
  return rows[0] || null;
}

// clock_timestamp() (real time), not now() (when the transaction started): a transaction that
// waited on a lock must never close a row with a time earlier than that row's own start.
async function closeCurrentRate(cropId, db = pool) {
  const { rows } = await db.query(
    `UPDATE crop_rates SET effective_to = clock_timestamp()
      WHERE crop_id = $1 AND effective_to IS NULL
      RETURNING effective_to`,
    [cropId]
  );
  return rows[0] || null;
}

async function insertRate({ id, cropId, pointsPerUnit, effectiveFrom, createdByUserId }, db = pool) {
  await db.query(
    `INSERT INTO crop_rates (id, crop_id, points_per_unit, effective_from, created_by_user_id)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, clock_timestamp()), $5)`,
    [id, cropId, pointsPerUnit, effectiveFrom, createdByUserId]
  );
}

async function listRates(cropId, limit, db = pool) {
  const { rows } = await db.query(
    `SELECT id, points_per_unit, effective_from, effective_to, created_by_user_id
       FROM crop_rates WHERE crop_id = $1
      ORDER BY effective_from DESC, id DESC LIMIT $2`,
    [cropId, limit]
  );
  return rows;
}

// ------------------------------------------------------------------ items

async function insertItem({ id, name, description, stockQuantity, isVisible }, db = pool) {
  await db.query(
    `INSERT INTO shop_items (id, name, description, stock_quantity, is_visible)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name, description, stockQuantity, isVisible]
  );
}

async function findItem(id, db = pool) {
  const { rows } = await db.query(`${ITEM_WITH_PRICE} WHERE i.id = $1`, [id]);
  return rows[0] || null;
}

async function findItemsByIds(ids, db = pool) {
  const { rows } = await db.query(`${ITEM_WITH_PRICE} WHERE i.id = ANY($1::uuid[])`, [ids]);
  return rows;
}

async function listItems({ onlyVisible }, db = pool) {
  const { rows } = await db.query(
    `${ITEM_WITH_PRICE} WHERE ($1::boolean = false OR i.is_visible) ORDER BY lower(i.name), i.id`,
    [onlyVisible]
  );
  return rows;
}

async function lockItem(id, db = pool) {
  const { rows } = await db.query(
    'SELECT id, stock_quantity FROM shop_items WHERE id = $1 FOR UPDATE',
    [id]
  );
  return rows[0] || null;
}

async function updateItem(id, fields, db = pool) {
  const { sql, values } = buildSet(fields, ITEM_COLUMNS);
  if (!sql) return;
  await db.query(`UPDATE shop_items SET ${sql} WHERE id = $1`, [id, ...values]);
}

// Atomic: only succeeds while enough stock is left. Returns null when it could not.
async function decrementStock(itemId, quantity, db = pool) {
  const { rows } = await db.query(
    `UPDATE shop_items SET stock_quantity = stock_quantity - $2
      WHERE id = $1 AND stock_quantity >= $2
      RETURNING stock_quantity`,
    [itemId, quantity]
  );
  return rows[0] ? rows[0].stock_quantity : null;
}

async function incrementStock(itemId, quantity, db = pool) {
  const { rows } = await db.query(
    'UPDATE shop_items SET stock_quantity = stock_quantity + $2 WHERE id = $1 RETURNING stock_quantity',
    [itemId, quantity]
  );
  return rows[0].stock_quantity;
}

async function findItemBasics(id, db = pool) {
  const { rows } = await db.query('SELECT id, name, stock_quantity FROM shop_items WHERE id = $1', [id]);
  return rows[0] || null;
}

// ------------------------------------------------------------ item prices

async function findCurrentPrice(itemId, db = pool) {
  const { rows } = await db.query(
    'SELECT id, price_points FROM shop_item_prices WHERE shop_item_id = $1 AND effective_to IS NULL',
    [itemId]
  );
  return rows[0] || null;
}

async function closeCurrentPrice(itemId, db = pool) {
  const { rows } = await db.query(
    `UPDATE shop_item_prices SET effective_to = clock_timestamp()
      WHERE shop_item_id = $1 AND effective_to IS NULL
      RETURNING effective_to`,
    [itemId]
  );
  return rows[0] || null;
}

async function insertPrice({ id, itemId, pricePoints, effectiveFrom, createdByUserId }, db = pool) {
  await db.query(
    `INSERT INTO shop_item_prices (id, shop_item_id, price_points, effective_from, created_by_user_id)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, clock_timestamp()), $5)`,
    [id, itemId, pricePoints, effectiveFrom, createdByUserId]
  );
}

async function listPrices(itemId, limit, db = pool) {
  const { rows } = await db.query(
    `SELECT id, price_points, effective_from, effective_to, created_by_user_id
       FROM shop_item_prices WHERE shop_item_id = $1
      ORDER BY effective_from DESC, id DESC LIMIT $2`,
    [itemId, limit]
  );
  return rows;
}

// --------------------------------------------------------------- restocks

async function insertRestock({ id, itemId, quantity, createdByUserId }, db = pool) {
  await db.query(
    'INSERT INTO shop_restocks (id, shop_item_id, quantity, created_by_user_id) VALUES ($1, $2, $3, $4)',
    [id, itemId, quantity, createdByUserId]
  );
}

async function listRestocks(itemId, limit, db = pool) {
  const { rows } = await db.query(
    `SELECT id, quantity, created_by_user_id, created_at
       FROM shop_restocks WHERE shop_item_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [itemId, limit]
  );
  return rows;
}

module.exports = {
  insertCrop, findCrop, findCropsByIds, listCrops, lockCrop, findCropIdByName, updateCrop,
  findCurrentRate, closeCurrentRate, insertRate, listRates,
  insertItem, findItem, findItemsByIds, listItems, lockItem, updateItem,
  decrementStock, incrementStock, findItemBasics,
  findCurrentPrice, closeCurrentPrice, insertPrice, listPrices,
  insertRestock, listRestocks,
};