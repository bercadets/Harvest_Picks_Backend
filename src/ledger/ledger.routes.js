const express = require('express');
const { authenticate, requireFarmer, requireModerator } = require('../shared/middleware/auth.middleware');
const idempotency = require('../shared/middleware/idempotency.middleware');
const controller = require('./ledger.controller');

const router = express.Router();

// Farmer: own passbook only
router.get('/passbook', authenticate, requireFarmer, controller.getPassbook);

// Moderator: the fund and its top-ups
router.get('/fund', authenticate, requireModerator, controller.getFund); // balance + low-balance warning
router.get('/fund/history', authenticate, requireModerator, controller.getFundHistory);
router.post('/fund/topups', authenticate, requireModerator, idempotency(), controller.manualTopUp);
router.get('/fund/topups', authenticate, requireModerator, controller.listTopups); // ?status=PENDING_REVIEW|CONFIRMED|DISPUTED|ALL
router.post('/fund/topups/:id/confirm', authenticate, requireModerator, controller.confirmTopUp);
router.post('/fund/topups/:id/dispute', authenticate, requireModerator, controller.disputeTopUp);

module.exports = router;