/**
 * A pretend merchant that has integrated OTDMS.
 *
 * This is not part of OTDMS. It stands in for a *customer's* site — a shop
 * with its own products and its own users — so the integration can be
 * exercised the way a real one would be, from the outside, over HTTP, with
 * nothing shared but the API key.
 *
 * It is deliberately plain Node with no dependencies and no build step, for
 * two reasons. It has to be readable as documentation: a party's developer
 * should be able to open this one file and see exactly what to send. And it
 * has to be obviously separate from the platform — anything it can do, any
 * integrator can do.
 *
 * Everything it does that matters is in `callOtdms` and `verifyCallback`
 * below: sign the request, check the signature on what comes back.
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4100);
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;

/**
 * THE CREDENTIALS, HELD AT RUNTIME
 * --------------------------------
 * Seeded from the environment so nothing that worked before stops working, and
 * replaceable from /integration so a key can be pasted in while the demo is
 * running. That is the whole point of this page: an administrator issues a key
 * in OTDMS and tries it here, without editing a file or restarting anything.
 *
 * In memory only. A real shop would put these in its own configuration — this
 * one forgets them on restart, deliberately, because a demo that quietly keeps
 * somebody's live secret in a file on disk is a worse demo.
 *
 * The secret never leaves this process. Everything the browser can reach is
 * either masked or derived; the signing happens here, server-side, exactly as it
 * would in a real integration.
 */
const config = {
  baseUrl: process.env.OTDMS_BASE || 'http://localhost:4000/api/v1/api',
  keyId: process.env.OTDMS_KEY_ID || '',
  secret: process.env.OTDMS_SECRET || '',
  callbackUrl: process.env.OTDMS_CALLBACK_URL || '',
  /** Set by the last successful test, so the page can say more than "saved". */
  lastCheckedAt: null,
  lastCheckOk: false,
};

/** Configured enough to sign a request. */
function isConfigured() {
  return Boolean(config.baseUrl && config.keyId && config.secret);
}

/** What the browser is allowed to see. Never the secret. */
function maskedConfig() {
  return {
    baseUrl: config.baseUrl,
    keyId: config.keyId,
    // Enough to recognise which secret is loaded, not enough to use it.
    secretMasked: config.secret
      ? `${config.secret.slice(0, 4)}${'•'.repeat(24)}${config.secret.slice(-4)}`
      : '',
    hasSecret: Boolean(config.secret),
    callbackUrl: config.callbackUrl || `${SELF_URL}/otdms/callback`,
    configured: isConfigured(),
    lastCheckedAt: config.lastCheckedAt,
    lastCheckOk: config.lastCheckOk,
  };
}
/**
 * Whose shop this is. Configurable because more than one of these can run at
 * once — a second party integrating the same API is a second shop, and two
 * tabs both headed "Chai & Co" would be indistinguishable.
 */
const SHOP_NAME = process.env.SHOP_NAME || 'Chai & Co';
/** Escaped once here; the page is assembled as a string. */
const SHOP_HTML = SHOP_NAME.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The shop's own catalogue. OTDMS knows nothing about any of this. */
const PRODUCTS = [
  { id: 'tea-500', name: 'Assam tea, 500g', price: 450 },
  { id: 'coffee-250', name: 'Coorg coffee, 250g', price: 620 },
  { id: 'spice-box', name: 'Spice box, 8 jars', price: 1_890 },
];

/** The shop's own orders, in memory. A real shop would use its own database. */
const orders = new Map();
/** Callbacks received, newest first, so the demo can show them arriving. */
const callbackLog = [];

// ---------------------------------------------------------------------------
// THE INTEGRATION — this is the part worth copying
// ---------------------------------------------------------------------------

/**
 * Sign and send a request to OTDMS.
 *
 * The signature covers the timestamp, the method, the full path and the exact
 * body bytes. Sending `body` as the same string that was signed matters more
 * than it looks: re-serialising the object would be free to reorder keys, and
 * the signature would then be over something other than what was sent.
 */
async function callOtdms(method, path, body) {
  if (!isConfigured()) {
    // Said plainly rather than letting an unsigned call fail with a 401 that
    // looks like a credential problem. Nothing is configured at all.
    return {
      status: 503,
      payload: { message: 'This shop is not connected yet. Open /integration and enter your credentials.' },
    };
  }

  const raw = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const fullPath = new URL(config.baseUrl + path).pathname;

  const signature = crypto
    .createHmac('sha256', config.secret)
    .update([timestamp, method.toUpperCase(), fullPath, raw].join('\n'))
    .digest('hex');

  const response = await fetch(config.baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-otdms-key': config.keyId,
      'x-otdms-timestamp': timestamp,
      'x-otdms-signature': signature,
    },
    ...(body === undefined ? {} : { body: raw }),
  });

  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

/**
 * Check that a callback really came from OTDMS.
 *
 * Without this the callback endpoint is a public "mark my order paid" button:
 * anyone who guesses the URL can post a success and take the goods. The check
 * is the same HMAC in the other direction, over this endpoint's own path.
 */
function verifyCallback(headers, rawBody, path) {
  const timestamp = headers['x-otdms-timestamp'];
  const signature = headers['x-otdms-signature'];
  if (!timestamp || !signature) return false;

  // Reject anything too old to be a live notification, so a captured callback
  // cannot be replayed at us tomorrow.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = crypto
    .createHmac('sha256', config.secret)
    .update([timestamp, 'POST', path, rawBody].join('\n'))
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// The shop
// ---------------------------------------------------------------------------

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A customer buys something. The shop asks OTDMS to collect the money.
 *
 * Either one of the catalogue items, or an amount typed in. The typed-in path
 * exists because the three fixed prices make the platform awkward to exercise:
 * testing a limit, a rounding case or a particular commission means being able
 * to choose the number, and inventing three more products would only move the
 * problem.
 *
 * Nothing about the integration changes between the two — a shop sends an
 * amount and its own reference, and where that amount came from is the shop's
 * business. Which is the point this file is here to demonstrate.
 */
async function handleCheckout(req, res) {
  const { productId, amount: rawAmount } = JSON.parse((await readBody(req)) || '{}');

  let product;
  if (productId) {
    product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return json(res, 400, { error: 'No such product' });
  } else {
    // Only the checks this shop can make on its own. What counts as too small
    // or too large is OTDMS's rule, and it changes in their settings — asking
    // here as well would give two answers, and one of them would go stale.
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { error: 'Enter an amount greater than zero' });
    }
    // Paise are the smallest unit; a third decimal is not an amount anyone can
    // pay, and rounding it silently would bill a number the customer never saw.
    // Compared against an epsilon rather than exactly, because 450.55 * 100 is
    // 45054.99999999999 in floating point and would otherwise be refused.
    const paise = amount * 100;
    if (Math.abs(paise - Math.round(paise)) > 1e-6) {
      return json(res, 400, { error: 'Amounts go to two decimal places' });
    }
    product = { id: 'custom', name: 'Custom amount', price: Math.round(paise) / 100 };
  }

  // The shop's own order id, which is also what OTDMS is asked to key on. That
  // is what makes a retry safe: the same order can never become two payments.
  const orderId = `SHOP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const { status, payload } = await callOtdms('POST', '/payin', {
    reference: orderId,
    amount: product.price,
    callbackUrl: `${SELF_URL}/otdms/callback`,
  });

  if (status >= 400) {
    return json(res, status, { error: payload.message || 'Could not start the payment' });
  }

  // The gateway's own id for this payment, pulled out of the QR. A real shop
  // would never need it; the simulate button does, because it is standing in
  // for the customer's UPI app.
  const gatewayOrderId = payload.data.qr
    ? new URLSearchParams(String(payload.data.qr.payload).split('?')[1] || '').get('tr')
    : null;

  orders.set(orderId, {
    orderId,
    product: product.name,
    amount: product.price,
    status: 'AWAITING_PAYMENT',
    otdmsId: payload.data.id,
    gatewayOrderId,
  });

  return json(res, 200, { orderId, qr: payload.data.qr, amount: product.price, product: product.name });
}

/**
 * A refund: the shop sends money back to its customer.
 *
 * Only for an order the customer actually paid. OTDMS cannot enforce this and
 * should not try — a payout is a generic "send this person money", and plenty
 * of legitimate ones are not refunds of anything. Which payment a refund
 * refers to is knowledge only the shop has, so the shop is where the rule
 * lives.
 *
 * Getting it wrong is not a cosmetic bug. A refund on an unpaid order sends
 * real money to someone who never paid, and bills the shop for it — so this is
 * checked here rather than only hidden in the page, because a button that is
 * not rendered is a filter, not a rule.
 */
const REFUNDABLE = 'PAID';

async function handleRefund(req, res) {
  const { orderId, upiId, amount } = JSON.parse((await readBody(req)) || '{}');
  const order = orders.get(orderId);
  if (!order) return json(res, 404, { error: 'No such order' });

  if (order.status !== REFUNDABLE) {
    return json(res, 409, {
      error:
        order.status === 'AWAITING_PAYMENT'
          ? 'This order has not been paid, so there is nothing to refund'
          : `This order is ${order.status}, so it cannot be refunded`,
    });
  }

  /**
   * How much to send back.
   *
   * A shop refunds a part of an order as often as the whole of one — a single
   * item out of three, a goodwill adjustment, postage. So the amount is the
   * shop's to choose, defaulting to the whole order when it says nothing.
   *
   * Bounded above by what the customer actually paid, and checked here rather
   * than only in the page: a form that offers the right choices is a
   * convenience, and the rule has to live somewhere a crafted request also
   * meets. Refunding more than came in would send the shop's own money out
   * under the name of a refund.
   */
  const refundAmount = amount === undefined || amount === null || amount === '' ? order.amount : Number(amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    return json(res, 400, { error: 'Refund amount must be greater than zero' });
  }
  if (refundAmount > order.amount) {
    return json(res, 400, {
      error: `This order was ${order.amount}, so you cannot refund ${refundAmount}`,
    });
  }

  const { status, payload } = await callOtdms('POST', '/payout', {
    reference: `${orderId}-REFUND`,
    amount: refundAmount,
    callbackUrl: `${SELF_URL}/otdms/callback`,
    beneficiary: { name: 'Shop customer', upiId: upiId || 'customer@bank' },
  });

  if (status >= 400) {
    return json(res, status, { error: payload.message || 'Could not start the refund' });
  }
  order.status = 'REFUND_REQUESTED';
  // Kept so the table can say how much went back, which matters once that can
  // be less than the order.
  order.refundAmount = refundAmount;
  return json(res, 200, { refund: payload.data });
}

/**
 * Stand in for the customer paying.
 *
 * A real shop would never have this: the customer pays with their own UPI app
 * and the gateway tells OTDMS. There is no such app here, so without a button
 * the demo hands you a QR nobody can pay and a captain waiting forever for
 * money that has no way to arrive.
 *
 * It calls OTDMS's simulation endpoint, which signs a webhook as the gateway
 * would and delivers it through the real handler — so what is demonstrated is
 * the actual path, not a shortcut past it. Unsigned by us on purpose: this is
 * the simulation door, and we are not the gateway.
 */
async function handleSimulatePayment(req, res) {
  const { orderId } = JSON.parse((await readBody(req)) || '{}');
  const order = orders.get(orderId);
  if (!order) return json(res, 404, { error: 'No such order' });
  if (!order.gatewayOrderId) return json(res, 400, { error: 'This order has no QR to pay' });

  const response = await fetch(`${config.baseUrl}/gateway/upi/simulate-payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: order.gatewayOrderId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json(res, response.status, { error: payload.message || 'Could not simulate the payment' });
  }
  return json(res, 200, { paid: true });
}

/** OTDMS telling us an outcome. */
async function handleCallback(req, res) {
  const raw = await readBody(req);
  if (!verifyCallback(req.headers, raw, '/otdms/callback')) {
    // Refused rather than logged-and-accepted: an unverified callback is
    // indistinguishable from an attacker, so it cannot be allowed to change an
    // order's status.
    return json(res, 401, { error: 'Bad signature' });
  }

  const event = JSON.parse(raw);

  // A refund's callback names the refund, not the order it came from. Mapping
  // it back to the order is right — that is where the status belongs — but the
  // outcome must be read as a refund. Treating it like any other settlement
  // marked a refunded order PAID again, which both lied about what happened
  // and put it straight back into the refundable state.
  const reference = String(event.reference ?? '');
  const isRefund = reference.endsWith('-REFUND');
  const order = orders.get(reference) || orders.get(reference.replace(/-REFUND$/, ''));
  if (order) {
    if (event.status === 'SETTLED') {
      order.status = isRefund ? 'REFUNDED' : 'PAID';
    } else {
      order.status = isRefund ? `REFUND_${event.status}` : event.status;
    }
  }
  callbackLog.unshift({ receivedAt: new Date().toISOString(), event });
  if (callbackLog.length > 20) callbackLog.pop();

  return json(res, 200, { received: true });
}

// ---------------------------------------------------------------------------
// THE INTEGRATION PAGE — where credentials are pasted in while this is running
// ---------------------------------------------------------------------------

/**
 * Save the credentials this shop will sign with.
 *
 * The secret arrives here once, over the wire from the page, and stays in this
 * process. It is never sent back: everything the browser reads afterwards comes
 * from `maskedConfig()`. That is what keeps the signing server-side, which is
 * the property a real integration has to have — a secret that reaches a browser
 * is a secret anybody using that browser can take.
 *
 * An empty secret leaves the existing one alone, so somebody correcting a typo
 * in the base URL does not have to paste the credential again.
 */
async function handleSaveConfig(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');

  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  const keyId = String(body.keyId || '').trim();
  const secret = String(body.secret || '').trim();
  const callbackUrl = String(body.callbackUrl || '').trim();

  if (!baseUrl) return json(res, 400, { error: 'Enter the OT-DMS base URL' });
  if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'The base URL must start with http:// or https://' });
  if (!keyId) return json(res, 400, { error: 'Enter the API Key ID' });
  if (!secret && !config.secret) return json(res, 400, { error: 'Enter the API Secret' });

  config.baseUrl = baseUrl;
  config.keyId = keyId;
  if (secret) config.secret = secret;
  config.callbackUrl = callbackUrl;
  // A new credential has not been checked yet, whatever the old one did.
  config.lastCheckedAt = null;
  config.lastCheckOk = false;

  return json(res, 200, maskedConfig());
}

/**
 * Try the credentials against OT-DMS.
 *
 * `GET /balance` is the check because it is the cheapest authenticated call
 * there is: it proves the key id is known, the signature verifies, and the
 * clocks agree — which is every way this can be wrong — while creating nothing
 * and moving nothing.
 */
async function handleTestConfig(_req, res) {
  if (!isConfigured()) {
    return json(res, 400, { ok: false, error: 'Save your credentials first' });
  }

  let result;
  try {
    result = await callOtdms('GET', '/balance');
  } catch (err) {
    config.lastCheckedAt = new Date().toISOString();
    config.lastCheckOk = false;
    return json(res, 200, {
      ok: false,
      // A DNS or connection failure, which is a different problem from a
      // refused credential and needs saying differently.
      error: `Could not reach ${config.baseUrl} — ${err.message}`,
      config: maskedConfig(),
    });
  }

  const ok = result.status === 200;
  config.lastCheckedAt = new Date().toISOString();
  config.lastCheckOk = ok;

  return json(res, 200, {
    ok,
    status: result.status,
    ...(ok
      ? { balance: result.payload.data || result.payload }
      : { error: result.payload.message || `OT-DMS refused the call (${result.status})` }),
    config: maskedConfig(),
  });
}

/** Forget the credentials. The demo goes back to unconnected. */
function handleClearConfig(_req, res) {
  config.keyId = '';
  config.secret = '';
  config.callbackUrl = '';
  config.lastCheckedAt = null;
  config.lastCheckOk = false;
  return json(res, 200, maskedConfig());
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, SELF_URL);

  const routes = {
    'GET /': () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page());
    },
    'GET /integration': () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(integrationPage());
    },
    'GET /api/config': () => json(res, 200, maskedConfig()),
    'POST /api/config': () => handleSaveConfig(req, res),
    'POST /api/config/test': () => handleTestConfig(req, res),
    'POST /api/config/clear': () => handleClearConfig(req, res),
    'GET /api/products': () => json(res, 200, PRODUCTS),
    'GET /api/orders': () => json(res, 200, [...orders.values()].reverse()),
    'GET /api/callbacks': () => json(res, 200, callbackLog),
    'POST /api/checkout': () => handleCheckout(req, res),
    'POST /api/refund': () => handleRefund(req, res),
    'POST /api/simulate-payment': () => handleSimulatePayment(req, res),
    'POST /otdms/callback': () => handleCallback(req, res),
    'GET /api/balance': async () => {
      const { status, payload } = await callOtdms('GET', '/balance');
      json(res, status, payload.data || payload);
    },
    'GET /api/status': async () => {
      const orderId = url.searchParams.get('orderId');
      const { status, payload } = await callOtdms('GET', `/transactions/${orderId}`);
      json(res, status, payload.data || payload);
    },
  };

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return json(res, 404, { error: 'Not found' });

  Promise.resolve(handler()).catch((err) => json(res, 500, { error: err.message }));
});

function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${SHOP_HTML} — demo shop</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg:#faf9f7; --fg:#1b1a18; --muted:#6b6862; --line:#e2ded7; --card:#fff; --accent:#8a5a2b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#171614; --fg:#f2efe9; --muted:#a09b92; --line:#2f2c28; --card:#201e1b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
  .grid { display:grid; gap:14px; grid-template-columns: repeat(auto-fill,minmax(220px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .price { font-variant-numeric: tabular-nums; font-weight:600; }
  button { background:var(--accent); color:#fff; border:0; border-radius:7px; padding:9px 14px; font:inherit; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button:disabled { opacity:.5; cursor:default; }
  h2 { font-size: 1rem; margin: 32px 0 10px; }
  pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; font-size:12px; }
  .qr { word-break: break-all; font-family: ui-monospace, monospace; font-size: 11px; }
  table { width:100%; border-collapse: collapse; font-size:13px; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  .banner { background:#fff4d6; border:1px solid #e8d191; color:#5a4413; border-radius:8px; padding:10px 12px; font-size:13px; margin-bottom:24px; }
  @media (prefers-color-scheme: dark) { .banner { background:#2c2410; border-color:#5a4a1c; color:#e8d191; } }
</style></head><body><div class="wrap">
  <div class="banner">
    <strong>Simulation.</strong> This is a pretend shop integrating a fictional payment API.
    No real money moves anywhere, and DMC is not a currency.
  </div>

  <h1>${SHOP_HTML}</h1>
  <p class="note">
    A shop that has integrated OTDMS. Its products, its orders, its customers — OTDMS only settles the money.
    <a href="/integration" style="color:var(--accent)">API integration</a>
  </p>

  <!-- Shown only when nothing is configured, so the first failure is explained
       before it happens rather than as a 503 on the first purchase. -->
  <div id="notConnected" class="banner" style="display:none;background:#fae3dc;border-color:#e0b3a0;color:#8a3316">
    <strong>Not connected.</strong> This shop has no OT-DMS credentials yet, so nothing will go through.
    <a href="/integration" style="color:inherit;font-weight:600">Set them up</a>.
  </div>

  <div class="grid" id="products"></div>

  <div class="card" style="margin-top:14px">
    <div><strong>Any amount</strong></div>
    <p class="note" style="margin:4px 0 10px">
      The three prices above are this shop's catalogue. Type a number instead when you need a
      particular one — a limit, a rounding case, a commission you want to check.
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="note">DMC</span>
      <input id="customAmount" type="number" min="0" step="0.01" placeholder="1000"
             style="width:140px;padding:8px;border:1px solid #d8d2c8;border-radius:6px;font:inherit"
             onkeydown="if(event.key==='Enter')buyCustom()" />
      <button onclick="buyCustom()">Buy</button>
    </div>
    <p id="customError" class="note" style="margin:8px 0 0;color:#b4441f;display:none"></p>
  </div>

  <h2>Checkout</h2>
  <div id="checkout" class="card"><p class="note" style="margin:0">Pick something above.</p></div>

  <h2>Orders</h2>
  <table id="orders"><thead><tr><th>Order</th><th>Item</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody></tbody></table>

  <h2>Callbacks from OTDMS</h2>
  <pre id="callbacks">none yet</pre>
</div>
<script>
const rupees = (n) => 'DMC ' + Number(n).toLocaleString('en-IN');

async function load() {
  const products = await (await fetch('/api/products')).json();
  document.getElementById('products').innerHTML = products.map((p) =>
    '<div class="card"><div>' + p.name + '</div>' +
    '<div class="price">' + rupees(p.price) + '</div>' +
    '<div style="margin-top:10px"><button onclick="buy(\\'' + p.id + '\\')">Buy</button></div></div>'
  ).join('');
  await refresh();
}

/**
 * The typed-in amount. Sends the same request as a catalogue item, with an
 * amount instead of a product id — the shop decides the number either way.
 *
 * The error goes beside the input rather than in the checkout box below,
 * because a rejected amount is a problem with what was typed and the answer
 * belongs where the typing happened.
 */
async function buyCustom() {
  const input = document.getElementById('customAmount');
  const error = document.getElementById('customError');
  error.style.display = 'none';

  const amount = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(amount) || amount <= 0) {
    error.textContent = 'Enter an amount greater than zero.';
    error.style.display = 'block';
    return;
  }
  await buy(null, amount);
}

async function buy(productId, amount) {
  const box = document.getElementById('checkout');
  const error = document.getElementById('customError');
  box.innerHTML = '<p class="note" style="margin:0">Asking OTDMS for a QR…</p>';
  const res = await fetch('/api/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(productId ? { productId } : { amount }),
  });
  const data = await res.json();
  if (!res.ok) {
    // A refused typed-in amount — including OTDMS's own minimum and maximum,
    // which this shop deliberately does not duplicate — is about what was
    // typed, so it is answered next to the input rather than further down.
    if (!productId) {
      box.innerHTML = '<p class="note" style="margin:0">Pick something above.</p>';
      error.textContent = data.error;
      error.style.display = 'block';
    } else {
      box.innerHTML = '<p style="margin:0;color:#b4441f">' + data.error + '</p>';
    }
    return;
  }

  box.innerHTML =
    '<div><strong>' + data.product + '</strong> — ' + rupees(data.amount) + '</div>' +
    '<p class="note">Your customer scans this. Nothing here is a real UPI handle.</p>' +
    '<div class="qr">' + (data.qr ? data.qr.payload : '(no QR)') + '</div>' +
    '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button onclick="pay(\\'' + data.orderId + '\\')">Simulate the customer paying</button>' +
      '<button class="ghost" onclick="check(\\'' + data.orderId + '\\')">Check status</button></div>' +
    '<p class="note" style="margin-top:8px">There is no real UPI app here, so this button stands in for your customer.</p>';
  await refresh();
}

async function pay(orderId) {
  const res = await fetch('/api/simulate-payment', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId }),
  });
  const data = await res.json();
  alert(res.ok ? 'Paid. The captain has been credited and OTDMS is calling us back.' : data.error);
  await refresh();
}

async function check(orderId) {
  const data = await (await fetch('/api/status?orderId=' + encodeURIComponent(orderId))).json();
  alert(orderId + ' is ' + (data.status || JSON.stringify(data)));
  await refresh();
}

async function refund(orderId, paid) {
  // Pre-filled with the whole order, because that is the common case — but
  // typed, because a part refund is just as ordinary and the shop is the only
  // one who knows which it is. The server bounds it at what was paid; this is
  // here only to say so before the round trip.
  const typed = prompt('How much to refund? (paid ' + rupees(paid) + ')', String(paid));
  if (typed === null) return;
  const amount = Number(typed);
  if (!isFinite(amount) || amount <= 0) return alert('Enter an amount greater than zero.');
  if (amount > paid) return alert('That order was ' + rupees(paid) + ', so you cannot refund more.');

  const upiId = prompt('Send the refund to which UPI ID?', 'customer@bank');
  if (!upiId) return;
  const res = await fetch('/api/refund', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, upiId, amount }),
  });
  const data = await res.json();
  alert(res.ok ? 'Refund accepted' : data.error);
  await refresh();
}

async function refresh() {
  const orders = await (await fetch('/api/orders')).json();
  document.querySelector('#orders tbody').innerHTML = orders.length
    ? orders.map((o) =>
        '<tr><td>' + o.orderId + '</td><td>' + o.product + '</td><td>' + rupees(o.amount) + '</td>' +
        '<td>' + o.status +
          // Once a refund can be less than the order, the status alone
          // stops being the whole story.
          (o.refundAmount != null ? ' <span class="note">(' + rupees(o.refundAmount) + ')</span>' : '') +
        '</td><td>' +
        (o.status === 'AWAITING_PAYMENT'
          ? '<button onclick="pay(\\'' + o.orderId + '\\')">Pay</button> '
          : '') +
        // Refund only what was actually paid. Offering it on an unpaid order
        // invites you to send money back that never came in.
        (o.status === 'PAID'
          ? '<button class="ghost" onclick="refund(\\'' + o.orderId + '\\',' + o.amount + ')">Refund</button>'
          : '') +
        '</td></tr>'
      ).join('')
    : '<tr><td colspan="5" class="note">No orders yet.</td></tr>';

  const callbacks = await (await fetch('/api/callbacks')).json();
  document.getElementById('callbacks').textContent = callbacks.length
    ? JSON.stringify(callbacks, null, 2)
    : 'none yet';
}

load();
/** Keeps the "not connected" banner honest without a page reload. */
async function checkConnection() {
  try {
    const c = await (await fetch('/api/config')).json();
    document.getElementById('notConnected').style.display = c.configured ? 'none' : '';
  } catch { /* leave the banner as it is */ }
}
checkConnection();

setInterval(refresh, 4000);
</script></body></html>`;
}

/**
 * The integration page.
 *
 * Same stylesheet and the same shape as the shop, because it is part of the
 * same pretend site — a real merchant would put this behind their own admin
 * login, and it is on a plain path here only because there is nothing to log
 * into.
 *
 * The secret input is the one thing worth looking at. It is write-only: you can
 * put a value in, and nothing ever reads one back out. What the page shows is
 * whatever `maskedConfig()` returns, which is four characters at each end and
 * bullets in between — enough to tell two keys apart, useless as a credential.
 */
function integrationPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${SHOP_HTML} — API integration</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg:#faf9f7; --fg:#1b1a18; --muted:#6b6862; --line:#e2ded7; --card:#fff; --accent:#8a5a2b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#171614; --fg:#f2efe9; --muted:#a09b92; --line:#2f2c28; --card:#201e1b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 28px 0 10px; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  label { display:block; font-size:13px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:6px; font:inherit; background:var(--bg); color:var(--fg); }
  input.mono { font-family: ui-monospace, monospace; font-size:13px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:7px; padding:9px 14px; font:inherit; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
  .pill { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:4px 11px; font-size:13px; font-weight:500; }
  .ok { background:#e4f2e4; color:#1f5c26; } .bad { background:#fae3dc; color:#8a3316; } .idle { background:#efece7; color:#6b6862; }
  @media (prefers-color-scheme: dark) { .ok { background:#16301a; color:#8fd39a; } .bad { background:#361a12; color:#e7a68c; } .idle { background:#26241f; color:#a09b92; } }
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:6px 14px; font-size:13px; }
  dt { color:var(--muted); } dd { margin:0; font-family: ui-monospace, monospace; word-break:break-all; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; font-size:12px; }
  .banner { background:#fff4d6; border:1px solid #e8d191; color:#5a4413; border-radius:8px; padding:10px 12px; font-size:13px; margin-bottom:24px; }
  @media (prefers-color-scheme: dark) { .banner { background:#2c2410; border-color:#5a4a1c; color:#e8d191; } }
  a { color: var(--accent); }
  ol { padding-left: 20px; font-size:13px; color:var(--muted); }
  ol li { margin-bottom:5px; }
</style></head><body><div class="wrap">
  <div class="banner">
    <strong>Testing page.</strong> Credentials entered here are kept in this demo shop's memory only —
    never written to a file, and forgotten when it restarts.
  </div>

  <h1>API integration</h1>
  <p class="note">
    Connect this shop to OT-DMS. Create a key in the OT-DMS admin console under the party's profile,
    then paste it here. <a href="/">Back to the shop</a>
  </p>

  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <strong>Connection</strong>
      <span id="statusPill" class="pill idle">Not configured</span>
    </div>
    <p id="statusDetail" class="note" style="margin:8px 0 0"></p>
  </div>

  <h2>Credentials</h2>
  <div class="card">
    <label for="baseUrl">OT-DMS Base URL</label>
    <input id="baseUrl" class="mono" placeholder="http://localhost:4000/api/v1/api" />

    <label for="keyId">API Key ID</label>
    <input id="keyId" class="mono" placeholder="otdms_..." />

    <label for="secret">API Secret</label>
    <input id="secret" class="mono" type="password" autocomplete="off" placeholder="paste the secret shown once when the key was created" />
    <p class="note" style="margin:5px 0 0" id="secretHint"></p>

    <label for="callbackUrl">Callback URL</label>
    <input id="callbackUrl" class="mono" />
    <p class="note" style="margin:5px 0 0">
      Where OT-DMS sends payment updates. Give this same URL to the admin when creating the key.
    </p>

    <div class="row">
      <button onclick="save()">Save / Connect</button>
      <button class="ghost" onclick="test()">Test API connection</button>
      <button class="ghost" onclick="clearConfig()">Disconnect</button>
    </div>
    <p id="formMsg" class="note" style="margin:12px 0 0"></p>
  </div>

  <h2>Configured</h2>
  <div class="card">
    <dl>
      <dt>Base URL</dt><dd id="outBase">—</dd>
      <dt>Key ID</dt><dd id="outKey">—</dd>
      <dt>Secret</dt><dd id="outSecret">—</dd>
      <dt>Callback URL</dt><dd id="outCallback">—</dd>
    </dl>
  </div>

  <h2>How to use this</h2>
  <div class="card">
    <ol>
      <li>In OT-DMS admin, open the party's profile and create an API key.</li>
      <li>Copy the Key ID and the Secret — the secret is shown once.</li>
      <li>Paste both above with the base URL, then <strong>Save / Connect</strong>.</li>
      <li><strong>Test API connection</strong> — this asks OT-DMS for the balance, which proves the signature works.</li>
      <li>Go back to the shop and buy something, or issue a refund. Both now go through this key.</li>
    </ol>
  </div>

  <h2>Last test result</h2>
  <pre id="testOut">Nothing tested yet.</pre>

<script>
const $ = (id) => document.getElementById(id);

function render(c) {
  $('outBase').textContent = c.baseUrl || '—';
  $('outKey').textContent = c.keyId || '—';
  $('outSecret').textContent = c.secretMasked || '—';
  $('outCallback').textContent = c.callbackUrl || '—';
  $('secretHint').textContent = c.hasSecret
    ? 'A secret is saved. Leave this blank to keep it.'
    : 'No secret saved yet.';

  const pill = $('statusPill');
  if (!c.configured) {
    pill.className = 'pill idle';
    pill.textContent = 'Not configured';
    $('statusDetail').textContent = 'Enter a base URL, key id and secret below.';
  } else if (c.lastCheckOk) {
    pill.className = 'pill ok';
    pill.textContent = 'Connected';
    $('statusDetail').textContent = 'Last checked ' + new Date(c.lastCheckedAt).toLocaleString();
  } else if (c.lastCheckedAt) {
    pill.className = 'pill bad';
    pill.textContent = 'Refused';
    $('statusDetail').textContent = 'Last checked ' + new Date(c.lastCheckedAt).toLocaleString() + ' — see the result below.';
  } else {
    pill.className = 'pill idle';
    pill.textContent = 'Saved, not tested';
    $('statusDetail').textContent = 'Press "Test API connection" to check these credentials.';
  }

  // Prefill so an edit is a correction rather than a retype. The secret box is
  // deliberately left empty: there is nothing to prefill it with.
  if (!$('baseUrl').value) $('baseUrl').value = c.baseUrl || '';
  if (!$('keyId').value) $('keyId').value = c.keyId || '';
  if (!$('callbackUrl').value) $('callbackUrl').value = c.callbackUrl || '';
}

async function load() {
  render(await (await fetch('/api/config')).json());
}

async function save() {
  $('formMsg').textContent = 'Saving…';
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: $('baseUrl').value,
      keyId: $('keyId').value,
      secret: $('secret').value,
      callbackUrl: $('callbackUrl').value,
    }),
  });
  const data = await res.json();
  if (!res.ok) { $('formMsg').textContent = data.error || 'Could not save.'; return; }

  // Clear the secret box the moment it has been sent. Nothing is gained by
  // leaving a live credential sitting in a form field.
  $('secret').value = '';
  $('formMsg').textContent = 'Saved. Now test the connection.';
  render(data);
}

async function test() {
  $('formMsg').textContent = 'Testing…';
  const res = await fetch('/api/config/test', { method: 'POST' });
  const data = await res.json();
  $('testOut').textContent = JSON.stringify(data.ok ? { ok: true, balance: data.balance } : { ok: false, error: data.error, status: data.status }, null, 2);
  $('formMsg').textContent = data.ok ? 'Connection works.' : (data.error || 'Connection refused.');
  if (data.config) render(data.config);
}

async function clearConfig() {
  const res = await fetch('/api/config/clear', { method: 'POST' });
  $('baseUrl').value = ''; $('keyId').value = ''; $('secret').value = ''; $('callbackUrl').value = '';
  $('testOut').textContent = 'Nothing tested yet.';
  $('formMsg').textContent = 'Disconnected.';
  render(await res.json());
}

load();
</script></body></html>`;
}

server.listen(PORT, () => {
  console.log(`Demo shop on ${SELF_URL} — talking to ${config.baseUrl}`);
  if (!isConfigured()) {
    // Not a warning about a missing file any more: there is a page for this.
    console.log(`Not connected yet. Open ${SELF_URL}/integration and paste in a key.`);
  }
});
