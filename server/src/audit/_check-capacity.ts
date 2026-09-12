/**
 * The captain's three numbers, walked on the live database.
 *
 * The suite proves this against fixtures it builds itself. This proves it
 * against the database the application actually starts from, through the same
 * services the screens call — which is where the last few real bugs were
 * found, because a fixture cannot be wrong about the seed the way the seed can
 * be wrong about itself.
 *
 *   npx tsx src/audit/_check-capacity.ts
 */
import { connectMongo, disconnectMongo } from '../config/db';
import { Captain, Party, User, Task } from '../models';
import { updateConfig } from '../services/systemConfig.service';
import { createTask, claimTask } from '../services/task.service';
import { startTask, submitProof, approveTask } from '../services/workflow.service';
import {
  createPayIn, assignCaptain, openToCustomer, confirmMovement, settle,
} from '../services/transaction.service';
import { toCaptainDto } from '../utils/serializers';
import { rupeesToPaise } from '../utils/money';
import { Types } from 'mongoose';

const failures: string[] = [];

async function main(): Promise<void> {
  await connectMongo();

  const party = await Party.findOne({ contactEmail: 'chai@co.in' });
  const captainUser = await User.findOne({ email: 'demo1@otdms.demo' });
  const captain = captainUser ? await Captain.findOne({ userId: captainUser._id }) : null;
  if (!party || !captain || !captainUser) throw new Error('Seed first: npm run seed');

  const partyActor = { userId: String(party.userId), role: 'PARTY' as const };
  const captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' as const };

  // 5% to the captain on a pay-out, nothing on a pay-in, so the only
  // commission in the walk is the 50 on each completed pay-out.
  await updateConfig(
    {
      payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5,
      payInPartyCommissionPercentage: 0, payInCaptainCommissionPercentage: 0,
    },
    new Types.ObjectId(),
  );

  // The opening position: a ₹20,000 deposit already split in half.
  await Captain.updateOne(
    { _id: captain._id },
    {
      $set: {
        collateralBalancePaise: rupeesToPaise(10_000),
        dmcBalancePaise: rupeesToPaise(10_000),
        commissionEarnedTotalPaise: 0,
        lockedAmountPaise: 0,
        isOnline: true,
        status: 'ACTIVE',
      },
    },
  );
  await Party.updateOne({ _id: party._id }, { $set: { dmcBalancePaise: rupeesToPaise(1_000_000) } });

  async function show(step: string, expectDmc: number, expectCanTake: number): Promise<void> {
    const c = await Captain.findById(captain!._id);
    const dto = toCaptainDto(c!) as unknown as {
      taskLimit: number; dmcBalance: number; canTakeNow: number;
    };
    const ok = dto.dmcBalance === expectDmc && dto.canTakeNow === expectCanTake && dto.taskLimit === 10_000;
    if (!ok) {
      failures.push(
        `${step}: expected limit 10,000 / dmc ${expectDmc} / canTake ${expectCanTake}, ` +
        `got ${dto.taskLimit} / ${dto.dmcBalance} / ${dto.canTakeNow}`,
      );
    }
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'}  ${step.padEnd(30)}` +
      `limit ${String(dto.taskLimit).padStart(7)}   ` +
      `DMC ${String(dto.dmcBalance).padStart(7)}   ` +
      `can take ${String(dto.canTakeNow).padStart(7)}`,
    );
  }

  async function payIn(amount: number): Promise<void> {
    const { transaction } = await createPayIn(
      party!._id,
      { partyReference: `CAP-${Date.now()}-${Math.random()}`, amountPaise: rupeesToPaise(amount) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id, { gatewayQrPayload: 'upi://pay?x=1' });
    await confirmMovement(transaction._id, `UTR${Date.now()}${Math.random()}`);
    await settle(transaction._id);
  }

  async function payOutClaim(amount: number): Promise<string> {
    const task = await createTask(
      {
        partyId: party!._id,
        createdBy: party!.userId,
        amountPaise: rupeesToPaise(amount),
        customerName: 'Capacity Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@upi' },
      },
      partyActor,
    );
    await Task.updateOne(
      { _id: task._id },
      { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } },
    );
    const id = String(task._id);
    await claimTask(id, captain!._id, captainActor);
    return id;
  }

  async function finish(id: string): Promise<void> {
    await startTask(id, captain!._id, captainActor);
    await submitProof(
      { taskId: id, captainId: captain!._id, providerReference: `UTR${Date.now()}` },
      captainActor,
    );
    await approveTask(id, partyActor);
  }

  console.log('\n  step                          task limit   available DMC   can take now');
  console.log('  ' + '-'.repeat(74));

  await show('opening', 10_000, 10_000);

  await payIn(1_000);
  await show('1. pay-in 1,000', 9_000, 9_000);

  await payIn(1_000);
  await show('2. pay-in 1,000', 8_000, 8_000);

  const a = await payOutClaim(1_000);
  await show('3. pay-out 1,000 claimed', 7_000, 7_000);
  await finish(a);
  await show('   pay-out completed', 9_050, 9_000);

  await payIn(1_000);
  await show('4. pay-in 1,000', 8_050, 8_000);

  const b = await payOutClaim(1_000);
  await show('5. pay-out 1,000 claimed', 7_050, 7_000);
  await finish(b);
  await show('   pay-out completed', 9_100, 9_000);

  await payIn(1_000);
  await show('6. pay-in 1,000', 8_100, 8_000);

  console.log(
    failures.length === 0
      ? '\n==== every number matches the specification ====\n'
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
