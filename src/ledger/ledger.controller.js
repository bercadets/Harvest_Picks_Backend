// HTTP only: read the request, validate it, call the service, send the response.
const service = require('./ledger.service');
const validator = require('./ledger.validator');

async function getPassbook(req, res) {
  const query = validator.parseHistoryQuery(req.query);
  res.json(await service.getPassbook({ userId: req.user.id, ...query }));
}

async function getFund(req, res) {
  res.json(await service.getFundSummary());
}

async function getFundHistory(req, res) {
  res.json(await service.getFundHistory(validator.parseHistoryQuery(req.query)));
}

async function manualTopUp(req, res) {
  const { amount } = validator.parseManualTopUp(req.body);
  const { topup, replayed } = await service.manualTopUp({
    amount,
    idempotencyKey: req.idempotencyKey,
    userId: req.user.id,
  });
  res.status(replayed ? 200 : 201).json({ topup, replayed });
}

async function listTopups(req, res) {
  res.json(await service.listTopups(validator.parseTopupListQuery(req.query)));
}

async function confirmTopUp(req, res) {
  const topupId = validator.parseIdParam(req.params);
  res.json(await service.reviewTopUp({ topupId, userId: req.user.id, decision: 'CONFIRMED' }));
}

async function disputeTopUp(req, res) {
  const topupId = validator.parseIdParam(req.params);
  res.json(await service.reviewTopUp({ topupId, userId: req.user.id, decision: 'DISPUTED' }));
}

module.exports = { getPassbook, getFund, getFundHistory, manualTopUp, listTopups, confirmTopUp, disputeTopUp };