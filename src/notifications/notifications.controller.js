// HTTP only: read the request, validate it, call the service, send the response.
const service = require('./notifications.service');
const validator = require('./notifications.validator');

async function list(req, res) {
  const query = validator.parseListQuery(req.query);
  res.json(await service.list({ userId: req.user.id, ...query }));
}

async function getUnreadCount(req, res) {
  res.json(await service.getUnreadCount({ userId: req.user.id }));
}

async function markRead(req, res) {
  const id = validator.parseIdParam(req.params);
  res.json(await service.markRead({ userId: req.user.id, id }));
}

async function markAllRead(req, res) {
  res.json(await service.markAllRead({ userId: req.user.id }));
}

module.exports = { list, getUnreadCount, markRead, markAllRead };