# Harvest Picks — Backend API

Harvest Picks is the core REST API and transactional ledger engine for an agricultural barter exchange and dynamic parimutuel prediction market. Farmers deposit crops for AgriPoints (AP), spend them in a shop, and stake them on prediction events. A strict zero-sum ledger ensures every point entering the system exits through a legitimate transaction — no value is created or destroyed outside a Moderator top-up.

The API is partitioned into five decoupled domain cohorts, each with its own data ownership and Role-Based Access Control (FARMER vs. MODERATOR). Only the Ledger cohort may mutate point balances; every other cohort requests atomic transfers through it.

> **Note:** This repository is the backend service only. The frontend lives in a separate repository and authenticates via JWT.

## Architecture & Domain Cohorts

| Cohort | Responsibility | Key Entities |
| --- | --- | --- |
| 1. Users | Identity, password hashing, JWT issuance, and profile management | User, UserProfile |
| 2. Ledger | Append-only double-entry passbook, Moderator Fund, and Event Escrows | Account, LedgerTransfer, FundTopUp |
| 3. Products | Single source of truth for accepted crops, conversion rates, and shop stock | Crop, CropRateHistory, ShopItem |
| 4. Barter | Crop deposit verification workflows and shop checkout with delivery tokens | CropDeposit, BarterOrder, OrderItem |
| 5. Prediction | Event lifecycle, row-locked parimutuel pricing, and escrow settlement | Event, EventOption, Bet |

## Core Economic Guarantees

**Strict Point Conservation.** New AgriPoints enter the ecosystem exclusively via `MODERATOR_TOPUP`. Across all deposits, shop purchases, bets, and payouts, total circulating points remain zero-sum.

**Idempotency.** All state-mutating financial endpoints require an `Idempotency-Key` header. Duplicate submissions safely replay the original response (`"replayed": true`) with no double-charge or double-credit.

**Historical Rate & Price Snapshots.** Crop conversion rates and shop prices are recorded at transaction creation time (`pointsPerUnit`, `unitPricePoints`). Future catalog changes never rewrite pending or historical records.

**Row-Locked Concurrency.** Bet placement locks the target event row and Moderator Fund inside a single ACID transaction, preventing race conditions on dynamic odds and ensuring escrow balances resolve to exactly zero.

## API Reference

All protected routes require a JWT Bearer token. Financial and order POST endpoints also require an `Idempotency-Key`.

```
Authorization: Bearer <jwt_token>
Content-Type: application/json
Idempotency-Key: <uuid-v4>   # required on financial & order POST endpoints
```

All errors return a structured envelope:

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Not enough points",
    "details": { "required": 600, "available": 180 }
  }
}
```

Common codes: `VALIDATION_ERROR` (400) · `UNAUTHORIZED` (401) · `FORBIDDEN` (403) · `NOT_FOUND` (404) · `CONFLICT` / `OUT_OF_STOCK` / `EVENT_NOT_OPEN` (409) · `INSUFFICIENT_FUNDS` / `DEPOSIT_TOO_SMALL` / `STAKE_TOO_HIGH` (422).

### Cohort 1 — Users `/api/users`

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| POST | /api/users/register | Public | Register a new FARMER account and initialize a 0 AP passbook |
| POST | /api/users/login | Public | Authenticate and receive a role-scoped JWT |
| GET | /api/users/me | Authenticated | Retrieve current user metadata and contact profile |
| PATCH | /api/users/me | Authenticated | Update email, phoneNumber, and address |

### Cohort 2 — Ledger `/api/ledger`

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | /api/ledger/passbook | FARMER | Current AP balance and paginated transaction history |
| GET | /api/ledger/fund | MODERATOR | Moderator Fund balance, low-balance threshold, and alert flag |
| GET | /api/ledger/fund/history | MODERATOR | Immutable audit log of all fund inflows and outflows |
| GET | /api/ledger/fund/topups | MODERATOR | List manual and automatic top-ups awaiting review |
| POST | /api/ledger/fund/topups | MODERATOR | Inject AP into the Moderator Fund (requires Idempotency-Key) |

### Cohort 3 — Products `/api/products`

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | /api/products/crops | Authenticated | List accepted crops and active conversion rates |
| POST | /api/products/crops | MODERATOR | Add a new accepted crop with an initial conversion rate |
| GET | /api/products/crops/:id/rates | MODERATOR | View historical rate timeline for a specific crop |
| POST | /api/products/crops/:id/rates | MODERATOR | Publish a new effective rate for future deposits |
| GET | /api/products/items | Authenticated | List shop items (farmers see visible only; moderators see all) |
| POST | /api/products/items | MODERATOR | Create a shop item with whole-number pricing and stock quantity |

### Cohort 4 — Barter `/api/barter`

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | /api/barter/deposits/estimate | FARMER | Preview estimated AP and minimum-threshold flag for a crop quantity |
| POST | /api/barter/deposits | FARMER | Submit a crop deposit locked at the current conversion rate |
| GET | /api/barter/deposits | MODERATOR | List pending deposits in FIFO order |
| POST | /api/barter/deposits/:id/confirm | MODERATOR | Confirm physical receipt and transfer AP from Fund to Farmer |
| POST | /api/barter/deposits/:id/reject | MODERATOR | Reject a pending deposit with a mandatory reason string |
| POST | /api/barter/orders | FARMER | Checkout cart items, deduct AP, decrement stock, issue a deliveryToken |
| GET | /api/barter/orders/mine | FARMER | Retrieve the authenticated farmer's order history |
| GET | /api/barter/orders | MODERATOR | List orders awaiting physical fulfillment |
| POST | /api/barter/orders/lookup | MODERATOR | Look up an order by the farmer's pickup deliveryToken |
| POST | /api/barter/orders/:id/deliver | MODERATOR | Verify pickup token and mark the order DELIVERED |

### Cohort 5 — Prediction `/api/prediction`

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | /api/prediction/events | Authenticated | List events with live pool totals and quoted multipliers |
| GET | /api/prediction/events/:id | Authenticated | Retrieve event details and a dynamic odds quote for a ?stake= query |
| POST | /api/prediction/events | MODERATOR | Create an open event with ≥ 2 options, virtual seed pools, and a timezone-aware closesAt |
| POST | /api/prediction/events/:id/bets | FARMER | Place a final bet, locking the multiplier and escrowing stake + fund backing |
| GET | /api/prediction/events/:id/bets | MODERATOR | Audit all bets and internal fund backing for an event |
| GET | /api/prediction/bets/mine | FARMER | List farmer bets filterable by status (ACTIVE, WON, LOST) |
| POST | /api/prediction/events/:id/close | MODERATOR | Manually halt betting before outcome settlement |
| POST | /api/prediction/events/:id/resolve | MODERATOR | Settle the event, pay winners from escrow, return remainder to Fund |
| POST | /api/prediction/events/:id/cancel | MODERATOR | Cancel an invalid event and refund 100% of stakes and backing |

### Notifications `/api/notifications`

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | /api/notifications | Authenticated | Fetch user-scoped in-app notifications |
| GET | /api/notifications/unread-count | Authenticated | Return badge count of unread notifications |
| POST | /api/notifications/:id/read | Authenticated | Mark a single notification as read |
| POST | /api/notifications/read-all | Authenticated | Mark all user notifications as read |

## Dynamic Parimutuel Odds Engine

Prediction markets use a seeded parimutuel model with locked execution multipliers.

**Virtual Seed Liquidity.** Moderators initialize each option with virtual `seedPoints` (e.g., Yes: 500, No: 500) to establish opening odds without touching real Moderator Fund balances.

**Locked Execution.** When a farmer confirms a bet, the multiplier is computed inside a row-level database lock and permanently recorded on the bet. Subsequent bets shift the odds for future bettors without altering existing positions.

**Escrow & Auto-Backing.** At bet creation, the Moderator Fund transfers the difference between potential payout and stake into the Event Escrow (`Backing = PotentialPayout − Stake`). If the Fund is below the required backing, the system automatically creates a `MODERATOR_TOPUP (PENDING_REVIEW)` so user bets are never blocked.

## Getting Started

**Prerequisites**

- Node.js ≥ 20.x
- PostgreSQL ≥ 15.x (ACID transactions and row-level locking required)

**Environment variables** — create a `.env` file in the project root:

```env
PORT=3000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/harvest_picks"
JWT_SECRET="replace-with-strong-secret-key"

# CORS origins for the frontend client
CORS_ORIGINS="http://localhost:5500,http://127.0.0.1:5500"

# Ledger configuration
LOW_BALANCE_THRESHOLD=1000
```

**Installation**

```bash
# 1. Clone the repository
git clone https://github.com/bercadets/Harvest_Picks_Backend.git
cd Harvest_Picks_Backend

# 2. Install dependencies
npm install

# 3. Run database migrations
npm run db:migrate

# 4. Seed a Moderator, a Farmer, crops, shop items, and 100,000 AP Fund
npm run db:seed

# 5. Start the development server
npm run dev
```

## Integration Tests

41 end-to-end scenarios verified across all five cohorts:

| Suite | Tests | What's covered |
| --- | --- | --- |
| Identity & RBAC | 1.1 – 1.6 | FARMER-only self-registration, privilege escalation prevention, per-user passbook isolation |
| Ledger & Idempotency | 2.1 – 2.6 | Idempotency-Key replay safety, rejection of negative/fractional mutations, low-balance alerts |
| Catalog & Rate Versioning | 3.1 – 3.6, 4.5 | Hidden items return 404 to farmers; rate changes preserve locked rates on existing deposits |
| Barter & Stock Atomicity | 4.1 – 4.11, 6.1 – 6.9 | Decimal crop calculations, hashed delivery tokens, rollback on insufficient balance or stock |
| Parimutuel Settlement | 7.1 – 7.17 | Server-side closesAt enforcement, auto top-ups on fund shortfalls, full refunds on cancellation, zero-sum reconciliation |

## Roadmap

- [ ] **OpenAPI / Swagger UI** — auto-generate interactive documentation from route validation schemas
- [ ] **Postman Collection** — export a full environment and test-runner collection to `/docs/postman/`

