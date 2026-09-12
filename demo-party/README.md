# Demo party site

A pretend shop ("Chai & Co") that has integrated the OTDMS payment API. It is
**not part of OTDMS** — it stands in for a customer's own website, so the
integration can be exercised from the outside exactly as a real one would be.

Everything is simulated. No real money moves, and DMC is a fictional unit.

## Running it

1. Get credentials. Seeding the app creates the party this shop belongs to and
   prints the exact command to start it with:

   ```bash
   cd otdms/server
   npm run seed
   ```

   The party it creates (`chai@co`) *is* this shop, so the dashboard and this
   site are two views of the same business. You can also mint a key by hand
   from the party dashboard under **API keys** — the secret is shown once.

2. Start the shop:

   ```bash
   cd otdms/demo-party
   OTDMS_KEY_ID=otdms_xxx OTDMS_SECRET=yyy node server.js
   ```

   | Variable | Default | What it is |
   |---|---|---|
   | `OTDMS_KEY_ID` | — | The key id from the dashboard |
   | `OTDMS_SECRET` | — | The secret shown once when the key was created |
   | `OTDMS_BASE` | `http://localhost:4000/api/v1/api` | Where OTDMS is |
   | `PORT` | `4100` | Port for this shop |
   | `SELF_URL` | `http://localhost:4100` | How OTDMS reaches this shop for callbacks |

3. Open <http://localhost:4100>.

For callbacks to arrive, OTDMS has to be able to reach `SELF_URL`. On one
machine the default is fine; through a tunnel, set `SELF_URL` to the public
address.

## What it demonstrates

**Pay-in.** Press *Buy*. The shop calls `POST /payin` with its own order id and
gets back a QR for the customer to scan. When the payment lands, OTDMS calls
this shop's `/otdms/callback` and the order flips to `PAID`.

**Pay-out.** Press *Refund* on an order. The shop calls `POST /payout` with the
customer's UPI ID — OTDMS holds no account of the shop's customers, so the
destination comes from the shop in the call.

**Idempotency.** The shop's own order id is the reference. Sending it twice
returns the same payment rather than making a second one, which is what makes
a retry after a timeout safe.

## The integration itself

Two functions in `server.js` are the whole thing, and both are worth copying:

- `callOtdms` — signs an outbound request.
- `verifyCallback` — checks the signature on an inbound one.

### Signing a request

Every call carries three headers:

| Header | Value |
|---|---|
| `x-otdms-key` | the key id |
| `x-otdms-timestamp` | seconds since the epoch |
| `x-otdms-signature` | HMAC-SHA256 of the payload below, hex |

The signed payload is four lines joined with `\n`:

```
<timestamp>
<METHOD>
<full path, e.g. /api/v1/api/payin>
<the exact request body bytes, or "" for a GET>
```

Sign the exact bytes you send. Re-serialising the object before sending is the
single commonest way this goes wrong — key order and spacing are free to
differ, and the signature is then over something you did not send.

Requests more than five minutes old are refused, so keep the clock roughly
right.

### Verifying a callback

Callbacks are signed the same way, with the same secret, over your callback
endpoint's own path. Check it. An unverified callback endpoint is a public
"mark my order paid" button.

## Endpoints used

| Call | Purpose |
|---|---|
| `POST /payin` | Take a payment. Returns a QR. |
| `POST /payout` | Send money to your customer. |
| `GET /transactions/:reference` | Current state, by your own reference. |
| `GET /balance` | Available, and what is held against payouts. |
| `POST /transactions/:reference/replay-callback` | Ask for the callback again. |
