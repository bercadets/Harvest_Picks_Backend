// The ONLY file other cohorts may import from Products.
// Every function takes the transaction `client` as its LAST argument.
//
// Barter deposit:   getCurrentCropRate({ cropId }, client)
//                   -> { cropId, cropRateId, pointsPerUnit: "20", unit, name, category }
//                   pointsPerUnit is a decimal STRING. Never do float math on it.
//                   Throws 422 CROP_NOT_ACCEPTED when the crop is switched off.
//
// Barter checkout:  1. getCurrentItemPrices({ itemIds }, client)
//                      -> [{ itemId, name, pricePoints, stockQuantity }] in the order asked.
//                      Throws 404 ITEM_NOT_FOUND / 422 ITEM_UNAVAILABLE (hidden item).
//                   2. reserveStock({ items: [{ itemId, quantity }] }, client)
//                      All lines or none. Throws 409 OUT_OF_STOCK. Run it in the SAME transaction
//                      as the Ledger payment so a failed payment puts the stock back.
const service = require('./products.service');

module.exports = {
  getCurrentCropRate: service.getCurrentCropRate,
  getCurrentItemPrices: service.getCurrentItemPrices,
  reserveStock: service.reserveStock,
};