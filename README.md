# OTDMS — Operational Task & Disbursement Management System

**An educational simulation.** No part of this system moves money, contacts a
payment rail, or holds credentials for one. The payout step is served by
`MockPayoutProvider`, which fabricates references and outcomes in-process and
performs no network I/O of any kind. All seeded data is fictional.

---

## Running it

```bash
cp server/.env.example server/.env      # optional; compose supplies defaults
make up                                 # builds and starts everything
make seed                               # loads fictional demo data
```

| Surface  | URL                                      |
|----------|------------------------------------------|
| Client   | http://localhost:5173                    |
| API      | http://localhost:4000/api/v1/health      |
| Swagger  | http://localhost:4000/docs               |
| Tracking | http://localhost:5173/track/DEMO-REF-013 |

### Demo accounts

Password for all: `Demo@12345` (from `SEED_DEFAULT_PASSWORD`).

| Role    | Email                 |
|---------|-----------------------|
| Admin   | admin@otdms.demo      |
| Party   | party@otdms.demo      |
| Captain | captain@otdms.demo    |
| Captain | captain2@otdms.demo   |

Sign-in is two-step. Outside production the API returns the OTP as `devOtp` and
the login screen displays it, so no mailbox is needed.

### Without Docker

```bash
cd server && npm install && npm run dev     # needs Mongo and Redis reachable
cd client && npm install && npm run dev
```

---

## Architecture

```
client/   Vite + React 18 + TypeScript + Tailwind + TanStack Query + Zustand
server/   Express + TypeScript + Mongoose + Redis + Socket.io
```

Request path: `routes → validators (Zod) → middleware (auth, RBAC, CSRF) →
controllers → services → models`. Controllers stay thin; business rules live in
services and are unit-testable without a database.

### Task lifecycle

```
CREATED ──▶ ASSIGNED ──▶ IN_PROGRESS ──▶ PROOF_SUBMITTED ──▶ AUDIT_PENDING
                                                                  │
                                                    ┌─────────────┴─────────────┐
                                                    ▼                           ▼
                                               COMPLETED                    REJECTED
                                                                                │
                                                                                ▼
                                                                          REASSIGNED
                                                                           (back to pool)

Exits: CANCELLED (from CREATED/ASSIGNED/IN_PROGRESS), EXPIRED (from IN_PROGRESS)
```

The table lives in `server/src/types/index.ts` and is frozen. Every state change
routes through `assertTransition`, so no code path — including admin tooling —
can produce an illegal transition.

---

## Notable implementation decisions

### Money is stored as integer paise

The one deliberate deviation from the original specification. IEEE-754 doubles
cannot represent `0.1` exactly, so accumulating percentage commissions in
floating-point rupees drifts and corrupts the ledger. Internally every amount is
an integer `*Paise` field; API bodies and CSVs use rupees, and conversion happens
only in `utils/money.ts` at the boundary. `server/src/tests/unit/money.test.ts`
asserts the round-trip and the spec's own worked examples (₹10,000 at 0.5% = ₹50).

### Concurrent claims

Three layers, outermost to innermost:

1. **Redis lock** — cheap serialisation across API instances; avoids wasted work.
2. **MongoDB transaction** — used when a replica set is detected, so the
   collateral hold and the task assignment commit or roll back together.
3. **Atomic compare-and-swap** — the actual correctness guarantee. The claim
   filter requires `status ∈ CLAIMABLE` *and* `captainId: null`, so of N
   simultaneous claims exactly one matches. Losers receive `TASK_ALREADY_CLAIMED`.

Without a replica set the non-transactional path locks collateral first, CASes
the task, and compensates by releasing the hold if the CAS loses the race.
The collateral guard itself is a `$expr` inside the update filter, evaluated by
Mongo at write time, which closes the time-of-check/time-of-use gap a
read-then-write in Node would leave open.

### Derived, not stored

`availableLimit = collateralBalance − lockedAmount` is a Mongoose virtual. It
cannot drift out of sync with its inputs because it is never persisted.
`recomputeLockedAmount` re-derives the hold from the tasks that justify it and
reports drift.

### Immutability

`Commission` and `AuditLog` block update and delete at the schema level via
`pre` hooks, not by convention. The unique index on `Commission.taskId` is what
actually prevents double-crediting: a concurrent duplicate raises E11000, which
the service treats as idempotent success. Every row snapshots the rate and
`configVersion` in force at the time, so changing settings cannot rewrite history.

### The customer view is an allow-list

`toCustomerTrackingDto` builds its output starting from an empty object and adds
only permitted fields, rather than deleting from the document. A field added to
the model later cannot leak. Tested in `serializers.test.ts`.

---

## Security

- Two-step OTP; step one never issues a session. Codes are stored SHA-256 hashed.
- JWTs in HTTP-only cookies, so XSS cannot read them; CSRF via double-submit.
- Server-side session records, so logout and admin revocation are immediate.
- RBAC enforced per route on the server. The UI hiding a control is presentation.
- Zod validation replaces the request payload with parsed output; combined with
  `express-mongo-sanitize` this closes NoSQL operator injection.
- Uploads: server-generated filenames, size and MIME limits, and magic-byte
  verification — a file whose bytes contradict its declared type is deleted.
- Rate limits on login, OTP, claiming, and public tracking, backed by Redis.
- Helmet CSP, CORS allow-list, `npm audit --omit=dev` clean, non-root container.

---

## Testing

```bash
make test                 # or: cd server && npm test
npm run test:unit         # no database required
```

**101 unit tests** cover the state machine (every legal transition plus eleven
illegal ones), the commission engine including tier boundaries, collateral
arithmetic at the off-by-one-paise edge, CSV validation, reconciliation matching,
the mock provider's outcome distribution, and the customer-view allow-list.

Integration tests gate on `MONGO_URI` and skip without it, so the unit suite runs
anywhere. Under Compose they exercise the real contended-claim race: five
captains claiming one task, exactly one winner, and total locked collateral equal
to exactly one task amount.

---

## Configuration

Everything a stakeholder might change lives in `SystemConfig` and is editable
from the admin settings screen: commission basis and rates, tier bands, captain
and party limits, task deadline, OTP timing and attempt budgets, lockout policy,
upload limits, and the mock provider's success/pending distribution. No rate is
hard-coded in any engine. Reads are cached in Redis for five minutes and fall
back to Mongo if Redis is unavailable.
