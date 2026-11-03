const express = require('express');
const { authenticate, requireRole, requireFarmer, requireModerator } = require('../shared/middleware/auth.middleware');
const idempotency = require('../shared/middleware/idempotency.middleware');
const controller = require('./barter.controller');

const router = express.Router();
const anyUser = requireRole('FARMER', 'MODERATOR');

// ---- Part A: crop deposits
router.get('/deposits/estimate', authenticate, requireFarmer, controller.estimateDeposit); // ?cropId=&quantity=
router.post('/deposits', authenticate, requireFarmer, idempotency(), controller.submitDeposit);
router.get('/deposits/mine', authenticate, requireFarmer, controller.listMyDeposits); // ?status=&limit=&before=
router.get('/deposits', authenticate, requireModerator, controller.listDepositQueue); // queue: ?status=PENDING (default)
router.get('/deposits/:id', authenticate, anyUser, controller.getDeposit); // farmers: own only
router.post('/deposits/:id/confirm', authenticate, requireModerator, controller.confirmDeposit);
router.post('/deposits/:id/reject', authenticate, requireModerator, controller.rejectDeposit); // { reason }

// ---- Part B: shop checkout and delivery
router.post('/orders', authenticate, requireFarmer, idempotency(), controller.checkout);
router.get('/orders/mine', authenticate, requireFarmer, controller.listMyOrders);
router.post('/orders/lookup', authenticate, requireModerator, controller.lookupOrder); // { token }
router.get('/orders', authenticate, requireModerator, controller.listOrders); // ?status=PENDING_DELIVERY (default)
router.get('/orders/:id', authenticate, anyUser, controller.getOrder); // farmers: own only
router.post('/orders/:id/deliver', authenticate, requireModerator, controller.markDelivered); // { token? }

module.exports = router;