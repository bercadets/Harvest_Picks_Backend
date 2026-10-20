const express = require('express');
const { authenticate } = require('../shared/middleware/auth.middleware');
const controller = require('./users.controller');

const router = express.Router();

// Public
router.post('/register', controller.register); // creates a FARMER + empty profile + passbook
router.post('/login', controller.login);

// Any logged-in user (FARMER or MODERATOR), own data only
router.get('/me', authenticate, controller.getMe);
router.patch('/me', authenticate, controller.updateMe);

module.exports = router;