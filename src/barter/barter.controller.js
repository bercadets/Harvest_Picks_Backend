// HTTP only: read the request, validate it, call the service, send the response.
const service = require('./barter.service');
const v = require('./barter.validator');

// ---------------------------------------------------------------- deposits
async function estimateDeposit(req, res) {
  res.json(await service.estimateDeposit(v.parseEstimateQuery(req.query)));
}

async function submitDeposit(req, res) {
  const body = v.parseCreateDeposit(req.body);
  const { deposit, replayed } = await service.submitDeposit({
    farmerUserId: req.user.id,
    cropId: body.cropId,
    quantity: body.quantity,
    idempotencyKey: req.idempotencyKey,
  });
  res.status(replayed ? 200 : 201).json({ deposit, replayed });
}

async function listMyDeposits(req, res) {
  res.json(await service.listDeposits({ farmerUserId: req.user.id, ...v.parseDepositList(req.query, 'ALL') }));
}

async function listDepositQueue(req, res) {
  res.json(await service.listDeposits({ farmerUserId: null, ...v.parseDepositList(req.query, 'PENDING') }));
}

async function getDeposit(req, res) {
  res.json(await service.getDeposit({ id: v.parseIdParam(req.params), user: req.user }));
}

async function confirmDeposit(req, res) {
  res.json(await service.confirmDeposit({ id: v.parseIdParam(req.params), moderatorId: req.user.id }));
}

async function rejectDeposit(req, res) {
  const { reason } = v.parseRejectDeposit(req.body);
  res.json(await service.rejectDeposit({ id: v.parseIdParam(req.params), moderatorId: req.user.id, reason }));
}

// ------------------------------------------------------------------ orders
async function checkout(req, res) {
  const { items } = v.parseCreateOrder(req.body);
  const { order, deliveryToken, replayed } = await service.checkout({
    farmerUserId: req.user.id,
    items,
    idempotencyKey: req.idempotencyKey,
  });
  res.status(replayed ? 200 : 201).json({ order, deliveryToken, replayed });
}

async function listMyOrders(req, res) {
  res.json(await service.listOrders({ farmerUserId: req.user.id, ...v.parseOrderList(req.query, 'ALL') }));
}

async function listOrders(req, res) {
  res.json(await service.listOrders({ farmerUserId: null, ...v.parseOrderList(req.query, 'PENDING_DELIVERY') }));
}

async function getOrder(req, res) {
  res.json(await service.getOrder({ id: v.parseIdParam(req.params), user: req.user }));
}

async function lookupOrder(req, res) {
  res.json(await service.lookupOrder(v.parseLookupOrder(req.body)));
}

async function markDelivered(req, res) {
  const { token } = v.parseDeliverOrder(req.body ?? {});
  res.json(await service.markDelivered({ id: v.parseIdParam(req.params), moderatorId: req.user.id, token }));
}

module.exports = {
  estimateDeposit, submitDeposit, listMyDeposits, listDepositQueue, getDeposit, confirmDeposit, rejectDeposit,
  checkout, listMyOrders, listOrders, getOrder, lookupOrder, markDelivered,
};