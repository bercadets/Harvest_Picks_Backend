const bcrypt = require('bcryptjs');

const BCRYPT_COST = Math.min(14, Math.max(10, Number(process.env.BCRYPT_COST) || 12));

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, comparePassword };
