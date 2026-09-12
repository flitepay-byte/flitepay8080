/**
 * A live walk through one payout on the seeded database, checking the exact
 * numbers the commission model promises.
 *
 * The suite proves this against fixtures it builds itself. This proves it
 * against the database the application actually starts from — which is where
 * the last two real bugs were found, because a fixture cannot be wrong about
 * its own seed the way a seed can be wrong about itself.
 *
 *   npx tsx src/audit/_check-commission.ts
 */
import { connectMongo, disconnectMongo } from '../config/db';
import { Captain, Party, User, Task, PlatformAccount, DMCAllocation } from '../models';
import { getConfig } from '../services/systemConfig.service';
import { createTask, claimTask } from '../services/task.service';
import { startTask, submitProof, approveTask } from '../services/workflow.service';
import { requestDeposit, approveDeposit } from '../services/dmcPurchase.service';
import { paiseToRupees, rupeesToPaise } from '../utils/money';

const dmc = (paise: number): string => `DMC ${paiseToRupees(paise).toLocaleString('en-IN')}`;

const failures: string[] = [];
function check(label: string, actualPaise: number, expectedPaise: number): void {
  const ok = actualPaise === expectedPaise;
  if (!ok) failures.push(`${label}: expected ${dmc(expectedPaise)}, got ${dmc(actualPaise)}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(44)} ${dmc(actualPaise)}`);
}

async function main(): Promise<void> {
  await connectMongo();

  const config = await getConfig();
  const partyRate = config.payOutPartyCommissionPercentage;
  const captainRate = config.payOutCaptainCommissionPercentage;
  console.log(`\nRates in force: party charged ${partyRate}%, captain paid ${captainRate}%\n`);

  const party = await Party.findOne({ contactEmail: 'chai@co.in' });
  const captainUser = await User.findOne({ email: 'demo1@otdms.demo' });
  const admin = await User.findOne({ role: 'ADMIN' });
  const captain = captainUser ? await Captain.findOne({ userId: captainUser._id }) : null;
  if (!party || !captain || !admin || !captainUser) {
    throw new Error('Seed the database first: npm run seed');
  }

  const partyActor = { userId: String(party.userId), role: 'PARTY' as const };
  const captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' as const };
  const adminActor = { userId: String(admin._id), role: 'ADMIN' as const };

  // ---- The captain posts security, so they have capital to work with -------
  console.log('captain posts DMC 20,000 of security money');
  const purchase = await requestDeposit(
    captain._id,
    rupeesToPaise(20_000),
    captainActor,
  );
  await approveDeposit(String(purchase._id), adminActor);

  // ---- The party is given DMC to spend ------------------------------------
  const OPENING = rupeesToPaise(100_000);
  await Party.updateOne({ _id: party._id }, { $set: { dmcBalancePaise: OPENING } });

  const AMOUNT = rupeesToPaise(5_000);
  const expectedCharge = Math.round((AMOUNT * partyRate)) / 100;
  const expectedCaptainShare = Math.min(Math.round(AMOUNT * captainRate) / 100, expectedCharge);
  const expectedPlatform = expectedCharge - expectedCaptainShare;

  const captainBefore = (await Captain.findById(captain._id))?.dmcBalancePaise ?? 0;
  const poolBefore = (await PlatformAccount.findOne({ key: 'GLOBAL' }))?.poolBalancePaise ?? 0;

  // ---- One payout, start to finish ----------------------------------------
  console.log('\nparty creates a DMC 5,000 payout');
  const task = await createTask(
    {
      partyId: party._id,
      createdBy: party.userId,
      amountPaise: AMOUNT,
      customerName: 'Live Check Customer',
      payoutMethod: { type: 'UPI', upiId: 'customer@upi' },
    },
    partyActor,
  );

  const afterCreate = await Party.findById(party._id);
  check('party debited at creation', OPENING - (afterCreate?.dmcBalancePaise ?? 0), AMOUNT + expectedCharge);
  check('task records the captain share', task.commissionPaise ?? 0, expectedCaptainShare);
  check('task records the platform share', task.adminCommissionPaise ?? 0, expectedPlatform);

  const poolAtCreation = (await PlatformAccount.findOne({ key: 'GLOBAL' }))?.poolBalancePaise ?? 0;
  check('pool untouched while merely created', poolAtCreation - poolBefore, 0);

  console.log('\ncaptain does the work');
  const id = String(task._id);
  // Open it to the pool rather than waiting on the router's offer clock —
  // routing is not what this script is checking, the money is.
  await Captain.updateOne({ _id: captain._id }, { $set: { isOnline: true, status: 'ACTIVE' } });
  await Task.updateOne(
    { _id: task._id },
    { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } },
  );
  await claimTask(id, captain._id, captainActor);
  await startTask(id, captain._id, captainActor);
  await submitProof({ taskId: id, captainId: captain._id, providerReference: `UTR${Date.now()}` }, captainActor);

  console.log('party approves it\n');
  await approveTask(id, partyActor);

  const captainAfter = (await Captain.findById(captain._id))?.dmcBalancePaise ?? 0;
  const poolAfter = (await PlatformAccount.findOne({ key: 'GLOBAL' }))?.poolBalancePaise ?? 0;
  const partyAfter = (await Party.findById(party._id))?.dmcBalancePaise ?? 0;

  check('captain credited amount plus share', captainAfter - captainBefore, AMOUNT + expectedCaptainShare);
  check('pool keeps the platform remainder', poolAfter - poolBefore, expectedPlatform);
  check('party is out exactly amount plus charge', OPENING - partyAfter, AMOUNT + expectedCharge);

  // Nothing created, nothing lost: what left the party is what arrived.
  const moved = OPENING - partyAfter;
  const received = captainAfter - captainBefore + (poolAfter - poolBefore);
  check('every paise the party paid arrived somewhere', received, moved);

  // Admin can actually reach its share.
  const adminAlloc = await DMCAllocation.findOne({ taskId: task._id, ownerType: 'ADMIN' });
  check('platform allocation exists to withdraw against', adminAlloc?.amountPaise ?? 0, expectedPlatform);

  const finalTask = await Task.findById(id);
  console.log(`\ntask ${finalTask?.taskCode} is ${finalTask?.status}`);

  console.log(
    failures.length === 0
      ? '\n==== every figure matches the model ====\n'
      : `\n==== ${failures.length} MISMATCHES ====\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  );
  await disconnectMongo();
  process.exit(failures.length === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  console.error(err);
  await disconnectMongo();
  process.exit(1);
});
