// HTTP only: read the request, validate it, call the service, send the response.
const service = require('./products.service');
const v = require('./products.validator');

// ------------------------------------------------------------------- crops
async function listCrops(req, res) {
  res.json(await service.listCrops({ role: req.user.role }));
}

async function getCrop(req, res) {
  res.json(await service.getCrop({ id: v.parseIdParam(req.params), role: req.user.role }));
}

async function createCrop(req, res) {
  res.status(201).json(await service.createCrop(v.parseCreateCrop(req.body), req.user.id));
}

async function updateCrop(req, res) {
  res.json(await service.updateCrop(v.parseIdParam(req.params), v.parseUpdateCrop(req.body)));
}

async function changeCropRate(req, res) {
  const { pointsPerUnit } = v.parseCreateRate(req.body);
  res.status(201).json(
    await service.changeCropRate({ id: v.parseIdParam(req.params), pointsPerUnit, userId: req.user.id })
  );
}

async function listCropRates(req, res) {
  res.json(await service.listCropRates({ id: v.parseIdParam(req.params), limit: v.parseLimit(req.query) }));
}

// ------------------------------------------------------------------- items
async function listItems(req, res) {
  res.json(await service.listItems({ role: req.user.role }));
}

async function getItem(req, res) {
  res.json(await service.getItem({ id: v.parseIdParam(req.params), role: req.user.role }));
}

async function createItem(req, res) {
  res.status(201).json(await service.createItem(v.parseCreateItem(req.body), req.user.id));
}

async function updateItem(req, res) {
  res.json(await service.updateItem(v.parseIdParam(req.params), v.parseUpdateItem(req.body)));
}

async function changeItemPrice(req, res) {
  const { pricePoints } = v.parseCreatePrice(req.body);
  res.status(201).json(
    await service.changeItemPrice({ id: v.parseIdParam(req.params), pricePoints, userId: req.user.id })
  );
}

async function listItemPrices(req, res) {
  res.json(await service.listItemPrices({ id: v.parseIdParam(req.params), limit: v.parseLimit(req.query) }));
}

async function restockItem(req, res) {
  const { quantity } = v.parseRestock(req.body);
  res.status(201).json(
    await service.restockItem({ id: v.parseIdParam(req.params), quantity, userId: req.user.id })
  );
}

async function listRestocks(req, res) {
  res.json(await service.listRestocks({ id: v.parseIdParam(req.params), limit: v.parseLimit(req.query) }));
}

module.exports = {
  listCrops, getCrop, createCrop, updateCrop, changeCropRate, listCropRates,
  listItems, getItem, createItem, updateItem, changeItemPrice, listItemPrices, restockItem, listRestocks,
};