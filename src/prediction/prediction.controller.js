// HTTP only: read the request, validate it, call the service, send the response.
const service = require('./prediction.service');
const v = require('./prediction.validator');

const isManager = (req) => req.user.role === 'MODERATOR';

// ------------------------------------------------------------------ events
async function createEvent(req, res) {
  res.status(201).json(await service.createEvent(v.parseCreateEvent(req.body), req.user.id));
}

async function listEvents(req, res) {
  // Farmers browse open events by default; moderators see every event by default.
  const query = v.parseEventList(req.query, isManager(req) ? 'ALL' : 'OPEN');
  res.json(await service.listEvents({ ...query, manager: isManager(req) }));
}

async function getEvent(req, res) {
  const { stake } = v.parseEventQuery(req.query);
  res.json(await service.getEvent({ id: v.parseIdParam(req.params), stake, user: req.user }));
}

async function closeEvent(req, res) {
  res.json(await service.closeEvent({ id: v.parseIdParam(req.params) }));
}

async function resolveEvent(req, res) {
  const { winningOptionId } = v.parseResolve(req.body);
  res.json(await service.resolveEvent({ id: v.parseIdParam(req.params), winningOptionId, moderatorId: req.user.id }));
}

async function cancelEvent(req, res) {
  const { reason } = v.parseCancel(req.body);
  res.json(await service.cancelEvent({ id: v.parseIdParam(req.params), reason, moderatorId: req.user.id }));
}

// -------------------------------------------------------------------- bets
async function placeBet(req, res) {
  const { optionId, stakePoints } = v.parsePlaceBet(req.body);
  const { bet, replayed } = await service.placeBet({
    eventId: v.parseIdParam(req.params),
    farmerUserId: req.user.id,
    optionId,
    stakePoints,
    idempotencyKey: req.idempotencyKey,
  });
  res.status(replayed ? 200 : 201).json({ bet, replayed });
}

async function listMyBets(req, res) {
  res.json(await service.listBets({ farmerUserId: req.user.id, manager: false, ...v.parseBetList(req.query, 'ALL') }));
}

async function listEventBets(req, res) {
  res.json(await service.listEventBets({ eventId: v.parseIdParam(req.params), ...v.parseBetList(req.query, 'ALL') }));
}

module.exports = {
  createEvent, listEvents, getEvent, closeEvent, resolveEvent, cancelEvent, placeBet, listMyBets, listEventBets,
};