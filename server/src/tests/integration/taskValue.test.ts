/**
 * "Value moved" against a real aggregation.
 *
 * The number is a running total of what a party has actually committed. A
 * cancelled task is refunded on the spot, so leaving its amount in the total
 * makes the tile disagree with the wallet sitting next to it — and the figure
 * can then only ever climb. These cases run the same `$sum` expression the
 * controllers use, so a change to it has to survive them.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { Task } from '../../models';
import { sumMovedValuePaise } from '../../utils/taskValue';
import { rupeesToPaise } from '../../utils/money';
import type { TaskState } from '../../types';

describeIntegration('value moved excludes refunded tasks', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  const partyId = new Types.ObjectId();
  let sequence = 0;

  async function makeTask(status: TaskState, rupees: number): Promise<void> {
    sequence += 1;
    const ref = `VALUE-${sequence}`;
    await Task.create({
      partyId,
      createdBy: new Types.ObjectId(),
      taskCode: `TASK-VALUE-${sequence}`,
      externalRef: ref,
      customerName: 'Value Test',
      identifier: 'value@bank',
      payoutMethod: { type: 'UPI', upiId: 'value@bank' },
      amountPaise: rupeesToPaise(rupees),
      status,
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
  }

  /** The controllers' shape: count every task, value only the ones not refunded. */
  async function totals(): Promise<{ count: number; movedPaise: number; rawPaise: number }> {
    const rows = await Task.aggregate<{ count: number; movedPaise: number; rawPaise: number }>([
      { $match: { partyId } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          movedPaise: sumMovedValuePaise,
          rawPaise: { $sum: '$amountPaise' },
        },
      },
    ]);
    return rows[0] ?? { count: 0, movedPaise: 0, rawPaise: 0 };
  }

  it('counts a task the moment it is created', async () => {
    await makeTask('CREATED', 10_000);
    await expect(totals()).resolves.toMatchObject({ movedPaise: rupeesToPaise(10_000) });
  });

  it('drops it again once it is cancelled', async () => {
    await makeTask('CANCELLED', 10_000);
    const t = await totals();
    expect(t.movedPaise).toBe(0);
    // Still a task that happened — only its value went back.
    expect(t.count).toBe(1);
    expect(t.rawPaise).toBe(rupeesToPaise(10_000));
  });

  it('keeps value for work still in flight', async () => {
    for (const status of ['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING'] as TaskState[]) {
      await makeTask(status, 1_000);
    }
    await expect(totals()).resolves.toMatchObject({ movedPaise: rupeesToPaise(5_000) });
  });

  it('keeps value for a task that went through a rejection but is still live', async () => {
    // Rejected and reassigned tasks are not refunded — someone will still do
    // this work, so the party is still committed to the amount.
    await makeTask('REJECTED', 3_000);
    await makeTask('REASSIGNED', 4_000);
    await expect(totals()).resolves.toMatchObject({ movedPaise: rupeesToPaise(7_000) });
  });

  it('leaves exactly the cancelled amount out of a mixed ledger', async () => {
    await makeTask('COMPLETED', 10_000);
    await makeTask('IN_PROGRESS', 5_000);
    await makeTask('CANCELLED', 8_000);
    await makeTask('CANCELLED', 2_000);

    const t = await totals();
    expect(t.count).toBe(4);
    expect(t.rawPaise).toBe(rupeesToPaise(25_000));
    expect(t.movedPaise).toBe(rupeesToPaise(15_000));
    expect(t.rawPaise - t.movedPaise).toBe(rupeesToPaise(10_000));
  });

  it('can go down, which is the whole point', async () => {
    await makeTask('CREATED', 10_000);
    const before = await totals();

    await Task.updateOne({ partyId, status: 'CREATED' }, { $set: { status: 'CANCELLED' } });
    const after = await totals();

    expect(before.movedPaise).toBe(rupeesToPaise(10_000));
    expect(after.movedPaise).toBe(0);
    expect(after.movedPaise).toBeLessThan(before.movedPaise);
  });

  it('is zero for a party with nothing but cancellations', async () => {
    await makeTask('CANCELLED', 1_000);
    await makeTask('CANCELLED', 2_000);
    await expect(totals()).resolves.toMatchObject({ movedPaise: 0, count: 2 });
  });
});
