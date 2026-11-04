const express = require('express');
const { authenticate, requireRole, requireFarmer, requireModerator } = require('../shared/middleware/auth.middleware');
const idempotency = require('../shared/middleware/idempotency.middleware');
const controller = require('./prediction.controller');

const router = express.Router();
const anyUser = requireRole('FARMER', 'MODERATOR');

// ---- Events
router.get('/events', authenticate, anyUser, controller.listEvents); // ?status=&stake=&limit=&before=  (farmers: OPEN by default)
router.get('/events/:id', authenticate, anyUser, controller.getEvent); // ?stake= shows the odds a bet of that size would get
router.post('/events', authenticate, requireModerator, controller.createEvent);
router.post('/events/:id/close', authenticate, requireModerator, controller.closeEvent);
router.post('/events/:id/resolve', authenticate, requireModerator, controller.resolveEvent); // { winningOptionId }
router.post('/events/:id/cancel', authenticate, requireModerator, controller.cancelEvent); // { reason }

// ---- Bets
router.post('/events/:id/bets', authenticate, requireFarmer, idempotency(), controller.placeBet); // { optionId, stakePoints }
router.get('/events/:id/bets', authenticate, requireModerator, controller.listEventBets);
router.get('/bets/mine', authenticate, requireFarmer, controller.listMyBets); // "My Predictions"

// ---- AI RESEARCH BRIEF (built by a teammate, NOT part of this cohort)
// Mount its route here, for example:
//   router.get('/events/:id/brief', authenticate, requireFarmer, briefController.getBrief);

module.exports = router;