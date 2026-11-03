const express = require('express');
const { authenticate } = require('../shared/middleware/auth.middleware');
const controller = require('./notifications.controller');

const router = express.Router();

// Any logged-in user (FARMER or MODERATOR). Every route works on the caller's OWN notifications only.
router.get('/', authenticate, controller.list); // ?unread=true&limit=20&before=<cursor>
router.get('/unread-count', authenticate, controller.getUnreadCount); // for the bell badge
router.post('/read-all', authenticate, controller.markAllRead);
router.post('/:id/read', authenticate, controller.markRead);

module.exports = router;