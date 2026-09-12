/**
 * The commission ledger, over real HTTP, against the live database.
 *
 * The suite proves the endpoint's logic against fixtures. This proves the whole
 * path the browser takes — sign in, carry the session, read a page — because
 * the bug being fixed here was invisible on the server and only appeared on the
 * screen.
 *
 * Fifteen entries: enough to cross a page boundary and cover both directions,
 * small enough to read the numbers by eye.
 *
 * It writes into the live database, so two things matter. It measures against
 * a baseline taken first, because the database is not assumed to be empty —
 * whatever history is already there is somebody's real testing. And it removes
 * its own rows through the driver at the end, because the WalletEntry model
 * refuses deletion on purpose: a ledger that can be edited is not a ledger.
 * That guard is right, and this script is the exception that has to reach past
 * it rather than a reason to weaken it.
 *
 *   npx tsx src/audit/_check-ledger.ts
 */
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../config/db';
import { Captain, Party, User, Transaction, Task, WalletEntry } from '../models';
import { rupeesToPaise } from '../utils/money';

const API = 'http://localhost:4000/api/v1';
const MARK = 'LEDGERCHECK';
const COUNT = 15;

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(54)}${detail}`);
}

interface Row { id: string; direction: string | null; amount: number | null; commission: number }
interface Page { items: Row[]; totalPages: number; totalEarned: number; entryCount: number }

async function removeOwnRows(): Promise<number> {
  const db = mongoose.connection.db;
  if (!db) return -1;
  await db.collection('walletentries').deleteMany({ sourceReference: { $regex: MARK } });
  await db.collection('transactions').deleteMany({ transactionCode: { $regex: MARK } });
  await db.collection('tasks').deleteMany({ taskCode: { $regex: MARK } });
  return (
    (await db.collection('walletentries').countDocuments({ sourceReference: { $regex: MARK } })) +
    (await db.collection('transactions').countDocuments({ transactionCode: { $regex: MARK } })) +
    (await db.collection('tasks').countDocuments({ taskCode: { $regex: MARK } }))
  );
}

async function signIn(email: string): Promise<string> {
  const jar: string[] = [];
  const keep = (res: Response): void => {
    for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0] as string);
  };

  const csrfRes = await fetch(`${API}/auth/csrf`);
  keep(csrfRes);
  const csrf = (await csrfRes.json()) as { data?: { csrfToken?: string } };
  const headers = {
    'content-type': 'application/json',
    'x-csrf-token': csrf.data?.csrfToken ?? '',
  };

  const loginRes = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { ...headers, cookie: jar.join('; ') },
    body: JSON.stringify({ email, password: 'Demo@12345' }),
  });
  keep(loginRes);
  const login = (await loginRes.json()) as { data?: { challengeId?: string; devOtp?: string } };

  const otpRes = await fetch(`${API}/auth/verify-otp`, {
    method: 'POST',
    headers: { ...headers, cookie: jar.join('; ') },
    body: JSON.stringify({ challengeId: login.data?.challengeId, otp: login.data?.devOtp ?? '123456' }),
  });
  keep(otpRes);
  return jar.join('; ');
}

async function main(): Promise<void> {
  await connectMongo();

  const captainUser = await User.findOne({ email: 'demo1@otdms.demo' });
  const captain = captainUser ? await Captain.findOne({ userId: captainUser._id }) : null;
  const party = await Party.findOne({ contactEmail: 'chai@co.in' });
  if (!captain || !captainUser || !party) throw new Error('Seed first: npm run seed');

  const cookie = await signIn('demo1@otdms.demo');
  const read = async (page: number): Promise<Page> => {
    const res = await fetch(`${API}/captain/earnings?page=${page}&limit=10`, { headers: { cookie } });
    const body = (await res.json()) as { data?: unknown };
    if (res.status !== 200) throw new Error(`page ${page}: ${res.status} ${JSON.stringify(body)}`);
    return body.data as Page;
  };

  // ---- what is already there ------------------------------------------
  const before = await read(1);
  console.log(`\n  baseline: ${before.entryCount} entries already in the ledger, DMC ${before.totalEarned} earned`);
  console.log(`  adding ${COUNT} more (8 pay-in, 7 pay-out)\n`);

  let added = 0;
  for (let i = 0; i < COUNT; i += 1) {
    const isPayIn = i % 2 === 0;
    const code = `${isPayIn ? 'PIN' : 'TASK'}-${MARK}-${i}`;
    const amount = 100 * (i + 1);

    if (isPayIn) {
      await Transaction.create({
        transactionCode: code,
        partyId: party._id,
        captainId: captain._id,
        direction: 'PAY_IN',
        status: 'SETTLED',
        amountPaise: rupeesToPaise(amount),
        partyReference: `${MARK}-REF-${i}`,
        expiresAt: new Date(Date.now() + 900_000),
        stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
      });
    } else {
      await Task.create({
        taskCode: code,
        partyId: party._id,
        captainId: captain._id,
        customerName: 'Ledger Check',
        identifier: `UPI-${MARK}-${i}`,
        amountPaise: rupeesToPaise(amount),
        externalRef: `${MARK}-EXT-${i}`,
        status: 'COMPLETED',
        createdBy: party.userId,
        stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
      });
    }

    // Dated into the future so this run's rows sort above the baseline and
    // land on page one, whatever was there already.
    await WalletEntry.create({
      captainId: captain._id,
      kind: 'COMMISSION_EARNED',
      amountPaise: rupeesToPaise(i + 1),
      walletBalanceAfterPaise: rupeesToPaise(i + 1),
      sourceReference: code,
      createdAt: new Date(Date.now() + (i + 1) * 60_000),
    });
    added += i + 1;
  }

  const first = await read(1);
  const second = await read(2);
  const mine = [...first.items, ...second.items].filter((r) => String(r.id).length > 0);
  const ours = mine.slice(0, COUNT);

  check('page one holds ten rows', first.items.length === 10, `${first.items.length}`);
  check('a second page is offered', first.totalPages >= 2, `${first.totalPages} pages`);
  check('no row repeats across the two pages', new Set(mine.map((r) => r.id)).size === mine.length);

  const payIns = ours.filter((r) => r.direction === 'PAY_IN').length;
  const payOuts = ours.filter((r) => r.direction === 'PAY_OUT').length;
  check('both directions appear', payIns === 8 && payOuts === 7, `${payIns} pay-in, ${payOuts} pay-out`);

  const commissions = ours.map((r) => r.commission);
  check(
    'newest first, across the page boundary',
    JSON.stringify(commissions) === JSON.stringify([...commissions].sort((a, b) => b - a)),
    commissions.join(' '),
  );
  check('every row names the payment it came from', ours.every((r) => r.amount != null && r.direction != null));

  check(
    'the total rose by exactly what was added',
    Math.round((first.totalEarned - before.totalEarned) * 100) === added * 100,
    `+${(first.totalEarned - before.totalEarned).toFixed(2)} of ${added}`,
  );
  check('the total is the same on page two', first.totalEarned === second.totalEarned);
  check('the count rose by fifteen', first.entryCount - before.entryCount === COUNT, `+${first.entryCount - before.entryCount}`);

  console.log('\n  the newest three rows, as the screen renders them:');
  for (const row of first.items.slice(0, 3)) {
    console.log(
      `    ${String(row.direction).padEnd(8)} amount ${String(row.amount).padStart(6)}   commission ${String(row.commission).padStart(4)}`,
    );
  }

  // ---- leave the database exactly as it was ----------------------------
  const leftover = await removeOwnRows();
  check('everything this check created has been removed', leftover === 0, `${leftover} left`);

  const after = await read(1);
  check('the ledger is back to its baseline', after.entryCount === before.entryCount, `${after.entryCount} entries`);

  console.log(
    failures.length === 0
      ? '\n==== the ledger reads correctly over HTTP ====\n'
      : `\n==== ${failures.length} PROBLEMS ====\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  );
  await disconnectMongo();
  process.exit(failures.length === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  console.error(err);
  // Never leave rows behind, whatever went wrong on the way.
  await removeOwnRows().catch(() => undefined);
  await disconnectMongo();
  process.exit(1);
});
