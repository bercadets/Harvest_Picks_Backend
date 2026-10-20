// HTTP only: read the request, validate it, call the service, send the response.
const service = require('./users.service');
const { parseRegister, parseLogin, parseUpdateProfile } = require('./users.validator');

async function register(req, res) {
  const result = await service.register(parseRegister(req.body));
  res.status(201).json(result);
}

async function login(req, res) {
  const result = await service.login(parseLogin(req.body));
  res.json(result);
}

async function getMe(req, res) {
  res.json(await service.getMe(req.user.id));
}

async function updateMe(req, res) {
  res.json(await service.updateMe(req.user.id, parseUpdateProfile(req.body)));
}

module.exports = { register, login, getMe, updateMe };