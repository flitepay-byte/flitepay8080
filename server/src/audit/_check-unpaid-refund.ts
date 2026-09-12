/**
 * The scenario the user hit: buy, do not pay, then try to refund.
 *
 * Walks it against the live database and the running demo shop, checking three
 * things that were each wrong or unclear:
 *
 *   1. an unpaid order cannot be refunded — the shop refuses it, so no payout
 *      task is created and the shop is not billed for money nobody received;
 *   2. the captain's DMC really is held while the customer decides, and really
 *      is given back when the window closes — the hold is a commitment, not a
 *      loss;
 *   3. a paid order can still be refunded, so the guard blocks the wrong case
 *      rather than the whole feature.
 *
 *   npx tsx src/audit/_check-unpaid-refund.ts
 */
import { connectMongo, disconnectMongo } from '../config/db';
import { Captain, Party, User, Transaction, Task } from '../models';
import { requestDeposit, approveDeposit } from '../services/dmcPurchase.service';
import { expireOverdueTransactions } from '../services/transactionSweep.service';
import { paiseToRupees, rupeesToPaise } from '../utils/money';

const SHOP = 'http://localhost:4100';
const dmc = (paise: number): string => `DMC ${paiseToRupees(paise).toLocaleString('en-IN')}`;

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
}

const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${SHOP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function main(): Promise<void> {
  await connectMongo();

  const party = await Party.findOne({ contactEmail: 'chai@co.in' });
  const captainUser = await User.findOne({ email: 'demo1@otdms.demo' });
  const admin = await User.findOne({ role: 'ADMIN' });
  const captain = captainUser ? await Captain.findOne({ userId: captainUser._id }) : null;
  if (!party || !captain || !admin || !captainUser) throw new Error('Seed first: npm run seed');

  // ---- Give the captain capital and put them online -----------------------
  if (captain.dmcBalancePaise === 0) {
    const deposit = await requestDeposit(
      captain._id,
      rupeesToPaise(20_000),
      { userId: String(captainUser._id), role: 'CAPTAIN' },
    );
    await approveDeposit(String(deposit._id), { userId: String(admin._id), role: 'ADMIN' });
  }
  await Captain.updateOne({ _id: captain._id }, { $set: { isOnline: true, status: 'ACTIVE' } });
  await Party.updateOne({ _id: party._id }, { $set: { dmcBalancePaise: rupeesToPaise(100_000) } });

  const capitalBefore = (await Captain.findById(captain._id))?.dmcBalancePaise ?? 0;
  const partyBefore = (await Party.findById(party._id))?.dmcBalancePaise ?? 0;
  const tasksBefore = await Task.countDocuments({ partyId: party._id });
  console.log(`\ncaptain holds ${dmc(capitalBefore)}, party holds ${dmc(partyBefore)}\n`);

  // =========================================================================
  // 1. Buy, do not pay
  // =========================================================================
  console.log('customer buys but does not pay');
  const bought = await post('/api/checkout', { productId: 'tea-500' });
  if (bought.status !== 200) throw new Error(`checkout failed: ${JSON.stringify(bought.body)}`);
  const orderId = bought.body.orderId as string;

  const txn = await Transaction.findOne({ partyReference: orderId });
  check('a payment was opened for the order', txn != null, txn?.status ?? 'none');

  const heldCapital = (await Captain.findById(captain._id))?.dmcBalancePaise ?? 0;
  check(
    'the captain’s DMC is held while the customer decides',
    capitalBefore - heldCapital === (txn?.amountPaise ?? -1),
    `${dmc(capitalBefore)} -> ${dmc(heldCapital)}`,
  );

  // =========================================================================
  // 2. Refund it without paying
  // =========================================================================
  console.log('\ncustomer asks for a refund without ever paying');
  const refused = await post('/api/refund', { orderId, upiId: 'customer@bank' });
  check('the shop refuses it', refused.status === 409, String(refused.body.error ?? refused.status));

  const tasksAfter = await Task.countDocuments({ partyId: party._id });
  check('no payout task was created', tasksAfter === tasksBefore, `${tasksBefore} -> ${tasksAfter}`);

  const partyAfterRefund = (await Party.findById(party._id))?.dmcBalancePaise ?? 0;
  check('the shop was not billed for it', partyAfterRefund === partyBefore, dmc(partyAfterRefund));

  // =========================================================================
  // 3. The hold comes back when nobody pays
  // =========================================================================
  console.log('\nthe payment window closes with nobody having paid');
  await Transaction.updateOne({ _id: txn?._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await expireOverdueTransactions();

  const expired = await Transaction.findById(txn?._id);
  check('the payment expired', expired?.status === 'EXPIRED', expired?.status ?? 'none');

  const released = (await Captain.findById(captain._id))?.dmcBalancePaise ?? 0;
  check('the captain got their DMC back, whole', released === capitalBefore, dmc(released));

  // =========================================================================
  // 4. A paid order can still be refunded
  // =========================================================================
  console.log('\na second order, paid this time');
  const second = await post('/api/checkout', { productId: 'tea-500' });
  const paidOrderId = second.body.orderId as string;
  await post('/api/simulate-payment', { orderId: paidOrderId });

  // The callback is delivered out of band; give it a moment to land.
  await new Promise((r) => setTimeout(r, 1500));

  const orders = (await (await fetch(`${SHOP}/api/orders`)).json()) as any[];
  const paidOrder = orders.find((o: any) => o.orderId === paidOrderId);
  check('it reads as paid', paidOrder?.status === 'PAID', paidOrder?.status ?? 'none');

  const allowed = await post('/api/refund', { orderId: paidOrderId, upiId: 'customer@bank' });
  check('the refund is allowed', allowed.status === 200, String(allowed.body.error ?? 'accepted'));

  const tasksNow = await Task.countDocuments({ partyId: party._id });
  check('a payout task was created for it', tasksNow === tasksBefore + 1, `${tasksBefore} -> ${tasksNow}`);

  console.log(
    failures.length === 0
      ? '\n==== all four behave correctly ====\n'
      : `\n==== ${failures.length} PROBLEMS ====\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  );
  await disconnectMongo();
  process.exit(failures.length === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  console.error(err);
  await disconnectMongo();
  process.exit(1);
});
