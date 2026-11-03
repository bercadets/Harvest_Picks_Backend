const express = require('express');
const { authenticate, requireRole, requireModerator } = require('../shared/middleware/auth.middleware');
const controller = require('./products.controller');

const router = express.Router();
const anyUser = requireRole('FARMER', 'MODERATOR');

// ---- Accepted crops
// Farmers see active crops only; moderators see all of them.
router.get('/crops', authenticate, anyUser, controller.listCrops);
router.get('/crops/:id', authenticate, anyUser, controller.getCrop);
router.post('/crops', authenticate, requireModerator, controller.createCrop); // first rate included
router.patch('/crops/:id', authenticate, requireModerator, controller.updateCrop); // name, category, isActive
router.post('/crops/:id/rates', authenticate, requireModerator, controller.changeCropRate); // appends rate history
router.get('/crops/:id/rates', authenticate, requireModerator, controller.listCropRates);

// ---- Shop items
// Farmers see visible items only; moderators see all of them.
router.get('/items', authenticate, anyUser, controller.listItems);
router.get('/items/:id', authenticate, anyUser, controller.getItem);
router.post('/items', authenticate, requireModerator, controller.createItem); // first price + stock included
router.patch('/items/:id', authenticate, requireModerator, controller.updateItem); // name, description, isVisible
router.post('/items/:id/prices', authenticate, requireModerator, controller.changeItemPrice); // appends price history
router.get('/items/:id/prices', authenticate, requireModerator, controller.listItemPrices);
router.post('/items/:id/restock', authenticate, requireModerator, controller.restockItem);
router.get('/items/:id/restocks', authenticate, requireModerator, controller.listRestocks);

module.exports = router;