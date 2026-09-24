# Kopi POS

A production-oriented point-of-sale platform for coffee shops: touch-first checkout, recipe-driven inventory, profit analytics and offline resilience. Built to be extended to multiple branches from day one.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start with Docker](#quick-start-with-docker)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [How the core flows work](#how-the-core-flows-work)
- [API reference](#api-reference)
- [Security notes](#security-notes)
- [Project layout](#project-layout)
- [Going to production](#going-to-production)

---

## Features

**Selling**
- Touch-optimised POS grid with category tabs, favourites and 44px minimum hit targets
- Barcode/SKU scanning straight from the search field
- Product variants (sizes, milk options) with per-variant price and recipe multiplier
- Split payments across cash, QRIS, debit, credit, e-wallet, transfer and voucher
- Line and order level discounts, service charge, tax (inclusive or exclusive) and cash rounding
- 80mm thermal receipt printing and reprint
- Cash drawer shifts with expected-vs-counted reconciliation

**Inventory**
- Ingredients with units, cost, low-stock threshold and reorder quantity
- Recipes that deduct ingredients **automatically and atomically** on every completed sale
- Append-only stock ledger — the on-hand balance is always reproducible
- Manual adjustments, wastage, returns and full physical stock counts
- Purchase orders with partial goods receipt and weighted-average cost roll-forward
- Automatic reorder suggestions and debounced low-stock notifications

**Money & insight**
- Real-time dashboard with revenue, profit, order and margin KPIs
- Recharts visualisations: 30-day trend, category mix, payment mix, peak hours
- Full profit & loss statement — net revenue, COGS, expenses, payment fees, net profit
- COGS is snapshotted per line at the moment of sale, so historical margins stay accurate
- Expense tracking split into fixed and variable categories
- Customer loyalty points, visit counts and lifetime spend

**Platform**
- JWT auth with short-lived access tokens and rotating refresh tokens (reuse detection)
- Role-based access: Admin, Manager, Cashier — plus a fast employee-code + PIN login for the till
- Append-only audit log with automatic credential redaction
- Offline mode: sales queue in IndexedDB and replay safely via idempotency keys
- Real-time push over Socket.IO, scoped to the caller's branch
- Database backups (SQL dump or portable JSON) with 30-day retention
- Excel and PDF export throughout
- Dark / light / system theme

---

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────┐
│  apps/web  (Next.js 14)  │        │  apps/api  (Express)     │
│                          │  REST  │                          │
│  App Router · Tailwind   │◄──────►│  routes → services → db  │
│  TanStack Query          │  WS    │  zod validation          │
│  Zustand (cart, auth)    │◄──────►│  Socket.IO realtime      │
│  IndexedDB offline queue │        │  Prisma ORM              │
└──────────────────────────┘        └────────────┬─────────────┘
                                                 │
                                    ┌────────────▼─────────────┐
                                    │   PostgreSQL 16          │
                                    └──────────────────────────┘
```

The API follows a layered structure. HTTP concerns (routing, validation, auth, auditing) never leak into services, and services never touch `req`/`res` — which is what makes them safe to compose inside a single database transaction.

```
routes      →  HTTP shape, zod schemas, RBAC, audit declarations
services    →  business rules, transactions, invariants
infra       →  Prisma client, Socket.IO
core        →  errors, logger, money helpers, HTTP helpers
middleware  →  auth, validation, rate limiting, error mapping
```

### Multi-branch design

Catalog data (categories, products, ingredients, suppliers) is organisation-wide. Operational data (stock, orders, expenses, purchase orders, shifts) carries a `branchId`. The `resolveBranch` middleware pins every request to exactly one branch: non-admins are locked to their own, admins may target another explicitly. Adding branch two is a row insert, not a migration.

---

## Requirements

- **Node.js 20+** and npm 10+
- **PostgreSQL 16+** (or just Docker)
- **Docker + Docker Compose** for the containerised path

> Node.js is required. If `node --version` fails, install it from [nodejs.org](https://nodejs.org/) before continuing.

---

## Quick start with Docker

```bash
# 1. Configure
cp .env.example .env

# 2. Generate real secrets and paste them into .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_REFRESH_SECRET

# 3. Launch
docker compose up -d --build

# 4. Watch it come up
docker compose logs -f
```

| Service  | URL                     |
| -------- | ----------------------- |
| Web app  | http://localhost:3000   |
| API      | http://localhost:4000   |
| Health   | http://localhost:4000/health |
| Postgres | localhost:5432          |

Migrations and the seed run automatically on first boot. Sign in with the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` values from your `.env`.

---

## Local development

```bash
# Install every workspace
npm install

# Start PostgreSQL only
docker compose up -d postgres

# Point DATABASE_URL at localhost, then:
npm run db:generate     # generate the Prisma client
npm run db:migrate      # create and apply the first migration
npm run db:seed         # demo branch, staff, menu, recipes, opening stock

# Run both apps with hot reload
npm run dev
```

Useful scripts:

| Command | Description |
| --- | --- |
| `npm run dev` | API (`:4000`) and web (`:3000`) together |
| `npm run build` | Production build of both apps |
| `npm run typecheck` | TypeScript across the monorepo |
| `npm run db:studio` | Prisma Studio database browser |
| `npm run db:push` | Sync schema without a migration (prototyping only) |

### Seeded accounts

| Role | Login | Notes |
| --- | --- | --- |
| Admin | `SEED_ADMIN_EMAIL` | Full access |
| Cashier | `SEED_CASHIER_EMAIL` | Also has POS PIN `1234` with code `EMP0002` |

**Change both passwords before exposing this to a network.**

The seed also creates 4 categories, 12 products with real recipes, 14 ingredients with opening stock, 8 expense categories and a supplier — enough to make a sale and watch stock drop immediately.

---

## Environment variables

Everything lives in a single root `.env`. See [.env.example](.env.example) for the annotated list.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | yes | Signs access tokens — min 32 chars |
| `JWT_REFRESH_SECRET` | yes | Signs refresh tokens — must differ from the above |
| `JWT_ACCESS_TTL` | | Access token lifetime (default `15m`) |
| `JWT_REFRESH_TTL` | | Refresh token lifetime (default `7d`) |
| `CORS_ORIGINS` | | Comma-separated allowlist of browser origins |
| `COOKIE_SECURE` | | Set `true` behind HTTPS |
| `RATE_LIMIT_MAX` | | Requests per window per IP (default 300/min) |
| `AUTH_RATE_LIMIT_MAX` | | Failed logins per window (default 10/min) |
| `BACKUP_DIR` | | Where database snapshots are written |
| `NEXT_PUBLIC_API_URL` | yes | API base URL the browser calls |
| `NEXT_PUBLIC_CURRENCY` / `NEXT_PUBLIC_LOCALE` | | Number and date formatting |

The API validates its configuration at boot and **refuses to start in production** with placeholder or duplicated secrets.

---

## How the core flows work

### Automatic ingredient deduction

Completing an order runs as one database transaction:

1. Price every line — resolving variant price deltas and recipe multipliers
2. Snapshot each line's unit cost (this becomes COGS, immune to later price edits)
3. Aggregate ingredient demand across all lines, merging duplicates
4. Verify availability for **every** ingredient up front, so a shortage fails cleanly with one combined error rather than a half-deducted inventory
5. Write the order, its items and its payments
6. Deduct stock and append a `StockMovement` ledger row per ingredient
7. Update customer loyalty totals

Only after the transaction commits does the system emit real-time events and evaluate low-stock alerts — a notification failure can never roll back a completed sale.

A Large Latte with a `1.4` recipe multiplier consumes `18g × 1.4 = 25.2g` of coffee and `180ml × 1.4 = 252ml` of milk. Void the order with *restock* ticked and every gram goes back, recorded as a separate `VOID_RESTOCK` movement.

### Offline mode

When the network drops, the POS keeps selling:

1. The catalog is cached in IndexedDB, so the product grid still renders
2. A sale that fails with a network error is queued locally with a client-generated UUID
3. On reconnect (or every 60s) the queue replays to `POST /orders/sync`
4. The server stores that UUID as `idempotencyKey` — a replay returns the **original** order instead of creating a duplicate
5. Each queued order is processed independently, so one bad entry never blocks the rest

### Profit calculation

```
net revenue   = gross sales − discounts + service charge
gross profit  = net revenue − COGS
net profit    = gross profit − operating expenses − payment processing fees
```

Tax is deliberately excluded from revenue — it is collected on behalf of the tax authority, not earned.

### Weighted-average costing

Receiving goods rolls the ingredient's cost forward:

```
new cost = (on-hand qty × old cost + received qty × invoice cost) ÷ total qty
```

Future sales use the updated cost, so margins reflect what you actually paid.

---

## API reference

Base URL: `/api/v1`. All routes except `/auth/*` require `Authorization: Bearer <accessToken>`.

Responses are consistently shaped:

```jsonc
// success
{ "success": true, "data": { ... }, "meta": { "page": 1, "total": 42 } }

// failure
{ "success": false, "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": [ ... ] } }
```

| Group | Endpoints |
| --- | --- |
| **Auth** | `POST /auth/login` · `POST /auth/login/pin` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/change-password` · `POST /auth/set-pin` |
| **Catalog** | `GET /catalog/pos` · `GET /catalog/products` · `GET /catalog/products/barcode/:code` · `POST|PATCH|DELETE /catalog/products/:id` · `GET|POST|PATCH|DELETE /catalog/categories` |
| **Inventory** | `GET /inventory/stock` · `POST /inventory/stock/adjust` · `POST /inventory/stock/stocktake` · `GET /inventory/movements` · `GET|POST|PATCH|DELETE /inventory/ingredients` · `GET|POST|PATCH /inventory/suppliers` |
| **Orders** | `POST /orders` · `POST /orders/quote` · `POST /orders/sync` · `GET /orders` · `GET /orders/:id` · `GET /orders/:id/receipt` · `POST /orders/:id/void` · `POST /orders/:id/refund` |
| **Customers** | `GET|POST /customers` · `GET|PATCH /customers/:id` · `POST /customers/:id/redeem` |
| **Employees** | `GET|POST /employees` · `PATCH|DELETE /employees/:id` · `POST /employees/:id/reset-password` · `GET|POST /employees/shifts/*` |
| **Purchasing** | `GET|POST /purchase-orders` · `POST /purchase-orders/:id/submit` · `POST /purchase-orders/:id/receive` · `POST /purchase-orders/:id/cancel` · `GET /purchase-orders/reorder-suggestions` |
| **Expenses** | `GET|POST /expenses` · `PATCH|DELETE /expenses/:id` · `GET|POST|PATCH /expenses/categories` |
| **Reports** | `GET /reports/dashboard` · `/summary` · `/sales-series` · `/top-products` · `/categories` · `/hourly` · `/cashiers` · `/expenses` · `/inventory-valuation` · `/export` |
| **Platform** | `GET|POST|PATCH /platform/branches` · `GET|PATCH /platform/settings` · `GET /platform/notifications` · `GET /platform/audit-logs` · `GET|POST|DELETE /platform/backups` |

Reporting endpoints accept either an explicit `from`/`to` pair or a `preset` of `today`, `yesterday`, `last7`, `last30`, `thisMonth`, `lastMonth` or `thisYear`.

### Realtime

Connect to the Socket.IO path `/realtime`, passing the access token in `auth.token`. Clients join only their own branch room.

| Event | Fires when |
| --- | --- |
| `order:created` | A sale completes |
| `order:voided` | An order is voided or refunded |
| `stock:changed` | Any stock movement is written |
| `stock:low` | An ingredient crosses its threshold |
| `notification:new` | A notification is created |

---

## Security notes

| Concern | Mitigation |
| --- | --- |
| Password storage | Argon2id (19 MiB memory cost) |
| Token theft via XSS | Access token in memory only; refresh token in an `httpOnly`, `sameSite=lax` cookie |
| Stolen refresh token | Rotation with reuse detection — replaying a spent token revokes the entire token family |
| Brute force | Per-IP auth rate limit plus a 15-minute account lock after 5 failed attempts |
| Account enumeration | Constant-ish login timing — a hash is computed even for unknown emails |
| Injection | Prisma parameterises everything; the two raw analytics queries use `Prisma.sql` tagged templates |
| Mass assignment | Every request body passes through an explicit zod schema |
| Cross-branch data access | `resolveBranch` middleware plus branch-scoped queries and Socket.IO rooms |
| Path traversal | Backup filenames are pattern-matched and re-verified against the resolved base directory |
| Credential leakage | Audit logs and application logs redact passwords, PINs and tokens; `pg_dump` receives credentials via environment, never argv |
| XSS in receipts | Receipt HTML escapes every interpolated value |
| Transport | Helmet with HSTS in production, strict CORS allowlist, no `x-powered-by` |

**Before going live:** replace every `CHANGE_ME`, set `COOKIE_SECURE=true`, terminate TLS in front of the app, and restrict `CORS_ORIGINS` to your real domain.

---

## Project layout

```
.
├── docker-compose.yml
├── .env.example
├── apps
│   ├── api
│   │   ├── prisma/
│   │   │   ├── schema.prisma        # 20 models, multi-branch ready
│   │   │   └── seed.ts              # idempotent demo data
│   │   └── src/
│   │       ├── app.ts               # Express assembly
│   │       ├── server.ts            # bootstrap, housekeeping, graceful shutdown
│   │       ├── config/env.ts        # fail-fast configuration
│   │       ├── core/                # errors, logger, money, http helpers
│   │       ├── infra/               # Prisma, Socket.IO
│   │       ├── middleware/          # auth, rbac, validate, audit, errors
│   │       ├── modules/
│   │       │   ├── auth/  catalog/  inventory/  orders/
│   │       │   ├── customers/  employees/  expenses/
│   │       │   └── purchasing/  reports/  settings/  platform/
│   │       └── routes/index.ts
│   └── web
│       └── src/
│           ├── app/
│           │   ├── login/           # password + PIN sign-in
│           │   └── (app)/           # authenticated shell
│           │       ├── dashboard/  pos/  transactions/
│           │       ├── products/  inventory/  purchase-orders/
│           │       └── customers/  employees/  expenses/  reports/
│           │           settings/  audit-logs/
│           ├── components/          # ui, modal, data-table, app-shell, pos
│           └── lib/                 # api, auth, cart, offline, receipt, export
```

---

## Going to production

- [ ] Replace every secret in `.env`; never commit it
- [ ] `COOKIE_SECURE=true` and serve over HTTPS
- [ ] Narrow `CORS_ORIGINS` to your domain
- [ ] Run `npx prisma migrate deploy` (not `db push`) on deploy
- [ ] Set `RUN_SEED=false` in the API container after first boot
- [ ] Ship backups off-box — the built-in retention is local only
- [ ] Point the pino JSON output at your log aggregator
- [ ] Put the API behind a reverse proxy; `trust proxy` is already set to one hop
- [ ] Add a read replica or Redis cache before scaling past a handful of branches

### Extending to multiple branches

The data model is already there. To switch a second location on:

1. Create the branch under **Settings → Branches** (ingredient stock rows are initialised automatically)
2. Assign employees to it
3. Set opening stock via a stock count or a received purchase order

Orders, expenses, purchase orders and shifts are already scoped. Admins can switch context with `?branchId=` or the `X-Branch-Id` header; everyone else stays pinned to their own branch.

---

## License

Provided as-is for you to adapt to your own shop.
