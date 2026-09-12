/**
 * Builds the audit dataset: ~200 tasks pushed through the real services, with
 * a deliberately uneven spread of outcomes.
 *
 * Nothing here writes states directly. Every record reaches its final shape by
 * the same code paths the application uses, because a dataset assembled by
 * hand would only prove that the audit's own assumptions are self-consistent.
 */
import { Types } from 'mongoose';
import mongoose from 'mongoose';
import { connectMongo } from '../config/db';
import {
  User, Party, Captain, Task, hashPassword,
} from '../models';
import { ensureSystemConfig, getConfig } from '../services/systemConfig.service';
import { createTask, claimTask } from '../services/task.service';
import {
  startTask, submitProof, approveTask, rejectTask,
  resolveTaskRejection, requestCancellation, reviewCancellationAsCaptain,
  reviewCancellationAsParty, resolveCancelDispute,
} from '../services/workflow.service';
import { requestTopUp, approveTopUp, rejectTopUp } from '../services/partyTopUp.service';
import { rupeesToPaise } from '../utils/money';
import { auditMongoUri, assertAuditDatabase, Rng, AUDIT_DB } from './harness';

const rng = new Rng();

const COMPANY = ['Acme Traders', 'Vertex Logistics', 'Nandi Freight', 'Sharma & Sons', 'Coastal Cargo', 'Meridian Supply'];
const CUSTOMER = [
  'Rahul Sharma', 'Priya Nair', 'Imran Qureshi', 'Anita Desai', 'Vikram Rao',
  'Sunita Patel', 'Arjun Menon', 'Fatima Sheikh', 'Rohit Verma', 'Deepa Iyer',
  // Deliberately awkward names — these have to survive search and display.
  "O'Brien Logistics", 'Müller GmbH', 'Sri Ram & Co.', 'Task-2026 Traders', 'A',
];

export interface Dataset {
  adminUserId: Types.ObjectId;
  /**
   * Opening balance plus anything the harness itself granted mid-run. The
   * accounting audit has to subtract these to reconstruct a balance, or it
   * would report the harness's own top-ups as unexplained DMC.
   */
  partyCreditsPaise: Record<string, number>;
  parties: Array<{ id: Types.ObjectId; userId: Types.ObjectId; code: string; email: string }>;
  captains: Array<{ id: Types.ObjectId; userId: Types.ObjectId; code: string; email: string }>;
  taskIds: Types.ObjectId[];
  password: string;
}

const PASSWORD = 'Demo@12345';

/**
 * The reference a captain reports after paying. Nothing in this system issues
 * it — the money moves outside — so the audit fabricates one the way a real
 * bank would hand one over.
 */
function reportedReference(): string {
  return `UTR${Math.floor(Math.random() * 900_000_000 + 100_000_000)}`;
}

export async function buildDataset(): Promise<Dataset> {
  await connectMongo(auditMongoUri());
  assertAuditDatabase();

  const db = mongoose.connection.db;
  if (db) await db.dropDatabase();
  await ensureSystemConfig();
  const config = await getConfig();

  const password = await hashPassword(PASSWORD);

  const adminUser = await User.create({
    email: 'admin@audit.demo', passwordHash: password, name: 'Audit Admin', role: 'ADMIN', status: 'ACTIVE',
  });

  // --- 6 parties, one deliberately suspended, one with no balance at all ---
  const parties: Dataset['parties'] = [];
  const partyCreditsPaise: Record<string, number> = {};
  for (let i = 0; i < 6; i++) {
    const email = `party${i + 1}@audit.demo`;
    const user = await User.create({ email, passwordHash: password, name: COMPANY[i], role: 'PARTY', status: 'ACTIVE' });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${String(i + 1).padStart(3, '0')}`,
      companyName: COMPANY[i],
      contactEmail: email,
      // One party starts broke, to exercise the insufficient-balance paths.
      dmcBalancePaise: i === 5 ? 0 : config.partyRegistrationDmcPaise * 20,
      status: i === 4 ? 'SUSPENDED' : 'ACTIVE',
    });
    parties.push({ id: party._id, userId: user._id, code: party.partyCode, email });
    partyCreditsPaise[String(party._id)] = party.dmcBalancePaise;
  }

  // --- 10 captains with a spread of collateral, presence and status ---
  const captains: Dataset['captains'] = [];
  for (let i = 0; i < 10; i++) {
    const email = `captain${i + 1}@audit.demo`;
    const user = await User.create({ email, passwordHash: password, name: `Captain ${i + 1}`, role: 'CAPTAIN', status: 'ACTIVE' });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${String(i + 1).padStart(3, '0')}`,
      displayName: `Captain ${i + 1}`,
      collateralBalancePaise: i === 9 ? 0 : rupeesToPaise(rng.int(50_000, 500_000)),
      lockedAmountPaise: 0,
      isOnline: i < 8,
      status: i === 8 ? 'SUSPENDED' : 'ACTIVE',
      upiId: `captain${i + 1}@upi`,
    });
    captains.push({ id: captain._id, userId: user._id, code: captain.captainCode, email });
  }

  const activeParties = parties.filter((_, i) => i !== 4 && i !== 5);
  const adminActor = { userId: String(adminUser._id), role: 'ADMIN' as const };

  // --- 200 tasks, spread across outcomes ---
  const taskIds: Types.ObjectId[] = [];
  let created = 0;
  let refusals = 0;
  const TARGET = 200;

  // A party that runs out of DMC refuses every further task, so the loop needs
  // its own way out — otherwise it spins forever on a balance that will not
  // recover. Topping the parties back up keeps the workload going without
  // pretending the refusal did not happen.
  while (created < TARGET) {
    if (refusals >= 25) {
      const grant = config.partyRegistrationDmcPaise * 40;
      await Party.updateMany(
        { _id: { $in: activeParties.map((p) => p.id) } },
        { $inc: { dmcBalancePaise: grant } },
      );
      for (const p of activeParties) partyCreditsPaise[String(p.id)] = (partyCreditsPaise[String(p.id)] ?? 0) + grant;
      refusals = 0;
    }
    const party = rng.pick(activeParties);
    const partyActor = { userId: String(party.userId), role: 'PARTY' as const };

    // A wide amount spread, including the boundaries.
    const amountPaise = rng.chance(0.05)
      ? rupeesToPaise(rng.pick([1, 100_000]))
      : rupeesToPaise(rng.int(100, 20_000));

    let task;
    try {
      task = await createTask(
        {
          partyId: party.id,
          createdBy: party.userId,
          customerName: rng.pick(CUSTOMER),
          amountPaise,
          payoutMethod: rng.chance(0.3)
            ? { type: 'BANK', bankName: 'Demo Bank', accountNumber: `9${rng.int(100000000, 999999999)}`, ifscCode: 'DEMO0001234', accountHolderName: rng.pick(CUSTOMER) }
            : { type: 'UPI', upiId: `cust${rng.int(1, 9999)}@upi` },
        },
        partyActor,
      );
    } catch {
      // Limits or balance refused it — a real outcome, not a dataset failure.
      refusals += 1;
      continue;
    }
    refusals = 0;
    created += 1;
    taskIds.push(task._id);
    const tid = String(task._id);

    // Who is it offered to? Some tasks are deliberately left untouched.
    const roll = rng.next();
    if (roll < 0.12) continue; // left sitting unclaimed

    const fresh = await Task.findById(tid).lean();
    const offeredTo = fresh?.offeredCaptainId;
    if (!offeredTo) continue;
    const captain = captains.find((c) => String(c.id) === String(offeredTo));
    if (!captain) continue;
    const capActor = { userId: String(captain.userId), role: 'CAPTAIN' as const };

    try {
      await claimTask(tid, captain.id, capActor);
    } catch {
      continue;
    }

    if (roll < 0.20) continue; // claimed and abandoned mid-flight

    // Cancellation is only open while the task is still ASSIGNED, so this
    // slice has to run before the captain starts work.
    if (roll < 0.28) {
      try {
        if (rng.chance(0.5)) {
          await requestCancellation(tid, 'Party changed their mind about this order', partyActor);
          if (rng.chance(0.5)) {
            await reviewCancellationAsCaptain(tid, captain.id, rng.chance(0.5) ? 'APPROVE' : 'REJECT', 'Reviewed by captain', capActor);
          }
        } else {
          await requestCancellation(tid, 'Captain cannot complete this one', capActor);
          if (rng.chance(0.5)) {
            await reviewCancellationAsParty(tid, party.id, rng.chance(0.5) ? 'APPROVE' : 'REJECT', 'Reviewed by party', partyActor);
          }
        }
        const state = await Task.findById(tid).lean();
        if (state?.status === 'CANCEL_DISPUTED' && rng.chance(0.7)) {
          await resolveCancelDispute(tid, rng.chance(0.5) ? 'APPROVE' : 'REASSIGN', adminActor);
        }
      } catch {
        /* a refused cancellation is itself a valid end state */
      }
      continue;
    }

    await startTask(tid, captain.id, capActor);

    const reference = reportedReference();

    if (roll < 0.34) continue; // paid but never submitted proof

    await submitProof(
      { taskId: tid, captainId: captain.id, providerReference: reference, notes: rng.chance(0.4) ? 'Paid via UPI' : undefined },
      capActor,
    );

    if (roll < 0.42) continue; // sitting in the party's audit queue

    // --- Rejected, then admin decides ---
    if (roll < 0.62) {
      await rejectTask(
        tid,
        rng.pick([
          'Customer says nothing arrived in their account',
          'The reference does not match what we can see',
          'Amount credited was short by a few rupees',
        ]),
        rng.pick(['NOT_RECEIVED', 'WRONG_DESTINATION', 'WRONG_AMOUNT', 'PROOF_MISMATCH', 'OTHER'] as const),
        partyActor,
      );

      if (rng.chance(0.25)) continue; // left waiting on admin

      const decision = rng.chance(0.6) ? 'REASSIGN' : 'APPROVE';
      await resolveTaskRejection(tid, decision, adminActor);
      if (decision === 'APPROVE') continue;

      // Reassigned — a second captain may take it the rest of the way.
      if (rng.chance(0.35)) continue; // left in the pool
      const second = await Task.findById(tid).lean();
      const nextId = second?.offeredCaptainId;
      const nextCaptain = captains.find((c) => String(c.id) === String(nextId));
      if (!nextCaptain) continue;
      const nextActor = { userId: String(nextCaptain.userId), role: 'CAPTAIN' as const };
      try {
        await claimTask(tid, nextCaptain.id, nextActor);
        await startTask(tid, nextCaptain.id, nextActor);
        const ref2 = reportedReference();
        await submitProof({ taskId: tid, captainId: nextCaptain.id, providerReference: ref2 }, nextActor);
        // A few go round a second time.
        if (rng.chance(0.2)) {
          await rejectTask(tid, 'Still not received by the customer', 'NOT_RECEIVED', partyActor);
          if (rng.chance(0.5)) await resolveTaskRejection(tid, 'REASSIGN', adminActor);
        } else {
          await approveTask(tid, partyActor);
        }
      } catch {
        /* contention or state guard — a legitimate outcome */
      }
      continue;
    }

    // --- The common case: approved ---
    await approveTask(tid, partyActor);
  }

  // --- Party top-ups across all three outcomes ---
  for (const party of parties) {
    const partyActor = { userId: String(party.userId), role: 'PARTY' as const };
    for (let i = 0; i < rng.int(1, 3); i++) {
      try {
        const request = await requestTopUp(
          party.id,
          rupeesToPaise(rng.int(1_000, 50_000)),
          partyActor,
        );
        const outcome = rng.next();
        if (outcome < 0.4) await approveTopUp(String(request._id), adminActor);
        else if (outcome < 0.65) await rejectTopUp(String(request._id), 'No matching credit found', adminActor);
      } catch {
        /* left pending */
      }
    }
  }

  const totalTasks = await Task.countDocuments({});
  console.log(`\nDataset built in "${AUDIT_DB}": ${totalTasks} tasks, ${parties.length} parties, ${captains.length} captains`);

  return { adminUserId: adminUser._id, partyCreditsPaise, parties, captains, taskIds, password: PASSWORD };
}
