// The ONLY file other cohorts may import from the Ledger.
// Every function takes the transaction `client` as its LAST argument, so the work commits or
// rolls back together with the caller's transaction.
//
//   const { withTransaction } = require('../shared/utils/transaction');
//   await withTransaction(async (client) => {
//     const farmer = await ledgerApi.getFarmerAccount({ userId }, client);
//     const fund = await ledgerApi.getFundAccount(client);
//     await ledgerApi.transfer({
//       referenceKey: `deposit:${depositId}:approve`,
//       transferType: 'CROP_DEPOSIT',
//       fromAccountId: fund.id,
//       toAccountId: farmer.id,
//       amount: 100,
//       description: 'Deposit: 5 kg Rice',
//       createdByUserId: moderatorId,
//     }, client);
//   });
//
// Errors to expect from transfer(): a 422 AppError with code INSUFFICIENT_FUNDS
// (details.accountType says whose balance was too low) and a 409 for a reused reference key.
//
// Place-bet order (Prediction):
//   1. generate the bet id in code
//   2. autoTopUpIfShort({ requiredPoints: backing, referenceKey: `bet:${betId}:topup` }, client)
//   3. transfer BET_STAKE (farmer -> escrow), then BET_BACKING (fund -> escrow, skip if 0)
//   4. insert the bet row with those transfer ids
//   5. if step 2 returned a top-up: recordAutoTopUp({ transferId, eventId, betId, authorizedByUserId }, client)
const service = require('./ledger.service');

module.exports = {
  transfer: service.transfer,
  openFarmerAccount: service.openFarmerAccount,
  openEventEscrow: service.openEventEscrow,
  getFarmerAccount: service.getFarmerAccount,
  getEscrowAccount: service.getEscrowAccount,
  getFundAccount: service.getFundAccount,
  autoTopUpIfShort: service.autoTopUpIfShort,
  recordAutoTopUp: service.recordAutoTopUp,
};