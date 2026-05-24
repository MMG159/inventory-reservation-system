# Inventory Reservation System (Next.js + Prisma + Redis)

This project implements an inventory reservation flow with:

- **Next.js App Router + TypeScript**
- **Prisma + Postgres (Supabase-ready)**
- **Upstash Redis** for:
  - distributed locking (race-condition safety)
  - idempotency-key replay protection
- **Local in-memory fallback** for lock/idempotency in development when Upstash envs are not configured
- **Cron-based expiry release** for stale reservations

## What Is Implemented

### Data model

- `Product`
- `Warehouse`
- `Stock` (`totalUnits`, `reservedUnits`)
- `Reservation` (`PENDING`, `CONFIRMED`, `RELEASED`, `expiresAt`)

Schema file:

- [schema.prisma](C:/Users/m123m.MMG/Downloads/Assignment/schema.prisma)

### Core backend utilities

- Prisma singleton: [lib/prisma.ts](C:/Users/m123m.MMG/Downloads/Assignment/lib/prisma.ts)
- Redis singleton: [lib/redis.ts](C:/Users/m123m.MMG/Downloads/Assignment/lib/redis.ts)
- Distributed lock helper: [lib/distributed-lock.ts](C:/Users/m123m.MMG/Downloads/Assignment/lib/distributed-lock.ts)
- Idempotency helper: [lib/idempotency.ts](C:/Users/m123m.MMG/Downloads/Assignment/lib/idempotency.ts)

### API routes

- `GET /api/products`: [app/api/products/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/products/route.ts)
- `GET /api/warehouses`: [app/api/warehouses/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/warehouses/route.ts)
- `POST /api/reservations`: [app/api/reservations/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/reservations/route.ts)
- `GET /api/reservations/:id`: [app/api/reservations/[id]/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/reservations/[id]/route.ts)
- `POST /api/reservations/:id/confirm`: [app/api/reservations/[id]/confirm/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/reservations/[id]/confirm/route.ts)
- `POST /api/reservations/:id/release`: [app/api/reservations/[id]/release/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/reservations/[id]/release/route.ts)
- `GET /api/cron/release-expired`: [app/api/cron/release-expired/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/cron/release-expired/route.ts)

### UI

- Product list and reserve actions: [app/page.tsx](C:/Users/m123m.MMG/Downloads/Assignment/app/page.tsx)
- Checkout page with live expiry countdown: [app/checkout/[reservationId]/page.tsx](C:/Users/m123m.MMG/Downloads/Assignment/app/checkout/[reservationId]/page.tsx)

---

## Setup Instructions

## 1. Prerequisites

- Node.js 18+ (20+ recommended)
- A Postgres database (Supabase works)
- Upstash Redis database
- Node package manager (`npm` used in examples)

## 2. Environment variables

Copy:

```bash
cp .env.example .env.local
```

Fill the values in `.env.local`:

- `DATABASE_URL`: pooled Supabase URL (runtime queries)
- `DIRECT_URL`: direct Supabase URL (migrations/introspection)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `CRON_SECRET` (recommended for securing Vercel Cron calls)

Note for local development:

- If Upstash Redis env vars are missing or placeholders, the app falls back to an in-memory lock/idempotency store.
- This fallback is intended only for local testing and single-instance development.

Template:

- [.env.example](C:/Users/m123m.MMG/Downloads/Assignment/.env.example)

## 3. Install dependencies

In your Next.js project root:

```bash
npm install
```

Also ensure these packages exist:

```bash
npm install @prisma/client @upstash/redis zod
npm install -D prisma tsx
```

## 4. Prisma migrations

Because schema is at repository root (`./schema.prisma`), run:

```bash
npx prisma migrate dev --name init --schema ./schema.prisma
npx prisma generate --schema ./schema.prisma
```

## 5. Seed mock data

Seed script:

- [prisma/seed.ts](C:/Users/m123m.MMG/Downloads/Assignment/prisma/seed.ts)

Run directly:

```bash
npx tsx prisma/seed.ts
```

If you prefer `prisma db seed`, add a `prisma.seed` script in `package.json` first.

## 6. Run locally

```bash
npm run dev
```

Open `http://localhost:3000`.

---

## Reservation Concurrency Correctness (Distributed Lock)

The critical race is multiple requests trying to reserve the same product+warehouse at the same time (especially the last unit).

Lock utility:

- [lib/distributed-lock.ts](C:/Users/m123m.MMG/Downloads/Assignment/lib/distributed-lock.ts)

How it works:

1. A lock key is derived per inventory bucket: `productId:warehouseId`.
2. Lock acquisition uses Redis `SET key value NX PX ttl`:
   - `NX` means only one caller can acquire it.
   - `PX` ensures auto-expiry if the process crashes.
3. If lock acquisition fails, the code retries briefly until timeout.
4. Once locked, the flow executes:
   - read stock
   - verify `totalUnits - reservedUnits >= quantity`
   - increment `reservedUnits`
   - create reservation
5. Lock release uses a Lua compare-and-delete script:
   - delete only if current lock value matches this caller’s token
   - prevents one caller from deleting another caller’s lock

Local fallback behavior:

- If Redis is not configured, `withDistributedLock` uses an in-memory lock map with TTL and retry semantics.
- This preserves correctness for local single-instance testing but is not distributed across instances.

Why this is correct:

- Competing requests for the same stock bucket are serialized.
- Only one request can pass the availability check and write first.
- No stale lock ownership during release because of token check.

---

## Idempotency-Key Behavior

Idempotency utility:

- [lib/idempotency.ts](C:/Users/m123m.MMG/Downloads/Assignment/lib/idempotency.ts)

Supported flows use optional/required `Idempotency-Key` headers to make retries safe.

Mechanism:

1. Build a Redis key: `idempotency:<scope>:<idempotency-key>`.
2. If a `completed` record already exists, return cached result (`replayed = true`).
3. Otherwise try to set a short-lived `processing` marker (`NX`).
4. If `processing` already exists, return conflict (`409`, in-progress duplicate).
5. Execute handler once.
6. Persist final `completed` result with TTL (default 24 hours).

Effect:

- Client retries (network blips, browser retries, function retries) do not duplicate stock mutations or reservation transitions.
- For successful prior operations, API returns the same semantic result.

Local fallback behavior:

- If Redis is not configured, idempotency records are stored in an in-memory map with processing/completed states and TTL.
- This supports local testing but does not provide cross-instance guarantees.

---

## Expiry and Cron Release Mechanism

Cron route:

- [app/api/cron/release-expired/route.ts](C:/Users/m123m.MMG/Downloads/Assignment/app/api/cron/release-expired/route.ts)

What it does:

1. Optionally validates Vercel cron auth (`Authorization: Bearer <CRON_SECRET>`).
2. Finds all `Reservation` rows where:
   - `status = PENDING`
   - `expiresAt <= now`
3. Inside a **single Prisma transaction**:
   - transition reservation to `RELEASED` (guarded check)
   - decrement corresponding `Stock.reservedUnits`
4. Returns summary `{ scanned, released, skipped, runAt }`.

Why transaction matters:

- Prevents partial updates where reservation status changes without stock rollback (or vice versa).
- If any stock invariant fails, transaction aborts and no partial batch is committed.

### Vercel Cron example

In `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/release-expired",
      "schedule": "*/1 * * * *"
    }
  ]
}
```

Set `CRON_SECRET` in Vercel Project Environment Variables for endpoint protection.

---

## API Behavior Notes

- Reservation creation returns `409` if stock is insufficient.
- Reservation confirmation returns:
  - `410` if expired
  - `409` for state conflicts
- Checkout page surfaces `409`/`410` with visible alert/toast messaging.

---

## Trade-offs and Future Improvements

## 1. Cron-based expiry vs event-driven timers/queues

Current approach is simple and robust, but expiry release depends on cron cadence.

Improvements with more time:

- move expiry to a queue/delay system (e.g., Redis streams, SQS, BullMQ, or workflow engine)
- schedule per-reservation release jobs for near-exact expiry timing
- reduce lag between expiry timestamp and actual stock release

## 2. Lock TTL tuning and extension

Current lock TTL is fixed and short (good default, but static).

Improvements:

- heartbeat/lock-extension for long-running workflows
- dynamic TTL based on measured p95/p99 transaction durations
- lock metrics and contention dashboards

## 3. Idempotency payload binding

Current idempotency design is key-based by scope.

Improvements:

- hash and store request payload to reject mismatched replays on same key
- persist idempotency records in durable DB for longer retention/audit

## 4. Database scaling

Current design uses primary writes and regular reads on one database endpoint.

Improvements:

- read replicas for high-read endpoints (`/api/products`, `/api/warehouses`)
- caching layer for catalog reads
- partitioning/archival strategy for old reservation data

## 5. Observability and ops hardening

Improvements:

- structured logs with request ids and idempotency keys
- metrics: lock acquisition latency, conflict rate, cron release counts
- alerts for stock invariant failures and cron failures

---

## Quick Test Flow

1. Seed DB.
2. Open `/` and create a reservation.
3. Open `/checkout/<reservationId>`.
4. Confirm before expiry and verify stock decreases in both `totalUnits` and `reservedUnits`.
5. Create another reservation and let it expire.
6. Trigger cron endpoint and verify status transitions to `RELEASED` and `reservedUnits` decrements.
