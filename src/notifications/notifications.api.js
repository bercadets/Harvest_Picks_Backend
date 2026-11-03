// The ONLY file other cohorts may import from Notifications.
// create / createMany take the transaction `client` as their LAST argument, so the notification is
// saved (or discarded) together with the business operation that caused it.
//
//   const notificationsApi = require('../notifications/notifications.api');
//
//   await notificationsApi.create({
//     userId: deposit.farmer_user_id,
//     type: notificationsApi.TYPES.DEPOSIT_APPROVED,
//     message: 'Your deposit of 5 kg Rice was approved: 100 points added.',
//     referenceType: notificationsApi.REFERENCE_TYPES.CROP_DEPOSIT,
//     referenceId: deposit.id,
//   }, client);
//
//   await notificationsApi.createMany(bets.map((bet) => ({ ... })), client);   // e.g. resolving an event
//
// Always pass the client: without it the notification is saved immediately and would survive even if the
// caller's transaction later rolled back (a "deposit approved" message for a deposit that was not approved).
//
// Use the TYPES and REFERENCE_TYPES constants, not raw strings. An unknown type, a missing message, or
// a referenceType without a referenceId throws a plain Error (a logged 500): it is a coding mistake.
// referenceType and referenceId are given together or not at all (a database rule too).
const service = require('./notifications.service');

module.exports = {
  TYPES: service.TYPES,
  REFERENCE_TYPES: service.REFERENCE_TYPES,
  create: service.create,
  createMany: service.createMany,
};