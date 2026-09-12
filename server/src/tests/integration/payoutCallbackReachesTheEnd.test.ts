/**
 * A PARTY IS ALWAYS TOLD HOW THEIR PAYOUT ENDED
 *
 * An integrating party cannot poll: their order page shows whatever the last
 * callback said. So the callback that carries the *ending* — completed,
 * cancelled, expired — is the one that matters, and it has to arrive even when
 * the payout took a long or awkward route to get there.
 *
 * The bug these tests pin came from one field answering two questions.
 * `callbackDeliveredAt` means "this party has been told how it ended", and the
 * sweep skips any task that has it set. But it was stamped by *any* successful
 * send, and there is one send that happens mid-flight:
 * `payout.confirmation_required`, fired when proof arrives so the party can go
 * and ask their customer whether the money landed.
 *
 * So a payout that went through customer confirmation was marked "told" while
 * it was still in AUDIT_PENDING. Everything after that — the party rejecting
 * the proof, admin overruling them, the task completing — was never sent. The
 * shop's last word on a refund it had already paid out was "pending", forever.
 *
 * It showed up in the demo shop as an order stuck at REFUND_AUDIT_PENDING long
 * after the refund had completed, which is the worst shape for this failure:
 * the money moved and the party's own records say it did not.
 */
import http from 'node:http';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { Task, type ITask } from '../../models';
import { deliverPayoutCallback, pendingPayoutCallbacks } from '../../services/callback.service';
import { issueApiKey } from '../../services/apiKey.service';

describeIntegration('a payout callback reaches the party at the end', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  /**
   * A task shaped like one raised through the API, since only those carry a
   * callback URL and only those the sweep looks at.
   */
  async function apiTask(status: ITask['status']): Promise<ITask> {
    const unique = new Types.ObjectId().toHexString();
    return Task.create({
      taskCode: `TASK-CB-${unique.slice(-8)}`,
      partyId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
      customerName: 'Callback Customer',
      identifier: 'cb@bank',
      payoutMethod: { type: 'UPI', upiId: 'cb@bank' },
      amountPaise: 62_000,
      externalRef: `CB-${unique.slice(-8)}`,
      status,
      origin: 'API',
      callbackUrl: 'http://127.0.0.1:59999/otdms/callback',
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
  }

  const reload = async (id: Types.ObjectId): Promise<Record<string, unknown>> =>
    (await Task.findById(id).lean()) as unknown as Record<string, unknown>;

  const owed = async (taskId: Types.ObjectId): Promise<boolean> =>
    (await pendingPayoutCallbacks()).some((t) => String(t._id) === String(taskId));

  // The endpoint is deliberately unreachable, so every send here fails. That is
  // the point: what is being tested is the bookkeeping around the send, not the
  // network. A failed terminal send must leave the task owed a retry; a
  // mid-flight send must leave the record untouched either way.

  describe('the mid-flight nudge', () => {
    it('does not mark the task as told', async () => {
      const task = await apiTask('AUDIT_PENDING');
      await deliverPayoutCallback(task, 'payout.confirmation_required', 'otdms_missing');

      const after = await reload(task._id);
      expect(after['callbackDeliveredAt'] ?? null).toBeNull();
    });

    it('does not spend the terminal callback’s retry budget', async () => {
      const task = await apiTask('AUDIT_PENDING');
      await deliverPayoutCallback(task, 'payout.confirmation_required', 'otdms_missing');
      await deliverPayoutCallback(task, 'payout.confirmation_required', 'otdms_missing');

      // The attempt counter is the budget for telling them the ending. A nudge
      // is not an attempt at that.
      expect((await reload(task._id))['callbackAttempts']).toBe(0);
    });

    it('leaves the task still owed its ending once it completes', async () => {
      const task = await apiTask('AUDIT_PENDING');
      await deliverPayoutCallback(task, 'payout.confirmation_required', 'otdms_missing');

      // The party rejects, admin overrules, the task completes.
      await Task.updateOne({ _id: task._id }, { $set: { status: 'COMPLETED' } });

      // This is the assertion the bug failed: the sweep must still see it.
      expect(await owed(task._id)).toBe(true);
    });
  });

  describe('the terminal callback', () => {
    it('records the attempt so a failure is visible and retried', async () => {
      const task = await apiTask('COMPLETED');
      await deliverPayoutCallback(task, 'transaction.settled', 'otdms_missing');

      const after = await reload(task._id);
      expect(after['callbackAttempts']).toBe(1);
      expect(after['callbackDeliveredAt'] ?? null).toBeNull();
      expect(await owed(task._id)).toBe(true);
    });

    it('is owed for a cancelled payout too', async () => {
      const task = await apiTask('CANCELLED');
      expect(await owed(task._id)).toBe(true);
    });

    it('is owed for an expired payout too', async () => {
      const task = await apiTask('EXPIRED');
      expect(await owed(task._id)).toBe(true);
    });

    it('is not owed while the payout is still running', async () => {
      const task = await apiTask('AUDIT_PENDING');
      // Nothing has ended yet, so there is no ending to tell.
      expect(await owed(task._id)).toBe(false);
    });

    it('stops being owed once it has actually been delivered', async () => {
      const task = await apiTask('COMPLETED');
      await Task.updateOne({ _id: task._id }, { $set: { callbackDeliveredAt: new Date() } });
      expect(await owed(task._id)).toBe(false);
    });

    it('gives up after the retry budget is spent', async () => {
      const task = await apiTask('COMPLETED');
      await Task.updateOne({ _id: task._id }, { $set: { callbackAttempts: 5 } });
      expect(await owed(task._id)).toBe(false);
    });
  });

  /**
   * The cases above use an unreachable endpoint, which exercises the failure
   * bookkeeping. The bug itself only bites when the mid-flight send *succeeds*,
   * so these stand up a real listener that answers 200 and a real key to sign
   * with — otherwise the send fails for want of a secret and proves nothing.
   */
  describe('when the mid-flight nudge actually lands', () => {
    let server: http.Server;
    let url = '';
    let keyId = '';
    let received = 0;

    beforeEach(async () => {
      received = 0;
      server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          received += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      url = `http://127.0.0.1:${port}/otdms/callback`;

      const issued = await issueApiKey(new Types.ObjectId(), 'Callback test key', {
        userId: String(new Types.ObjectId()),
        role: 'PARTY',
      });
      keyId = issued.keyId;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const taskAt = async (status: ITask['status']): Promise<ITask> => {
      const t = await apiTask(status);
      await Task.updateOne({ _id: t._id }, { $set: { callbackUrl: url } });
      return (await Task.findById(t._id)) as ITask;
    };

    it('delivers the nudge', async () => {
      const task = await taskAt('AUDIT_PENDING');
      const ok = await deliverPayoutCallback(task, 'payout.confirmation_required', keyId);
      expect(ok).toBe(true);
      expect(received).toBe(1);
    });

    it('still does not mark the task as told', async () => {
      const task = await taskAt('AUDIT_PENDING');
      await deliverPayoutCallback(task, 'payout.confirmation_required', keyId);
      // This is the assertion the bug failed: a successful nudge used to stamp
      // `callbackDeliveredAt` and close the book on the whole payout.
      expect((await reload(task._id))['callbackDeliveredAt'] ?? null).toBeNull();
    });

    it('still owes the ending after the nudge landed and the task completed', async () => {
      const task = await taskAt('AUDIT_PENDING');
      await deliverPayoutCallback(task, 'payout.confirmation_required', keyId);
      await Task.updateOne({ _id: task._id }, { $set: { status: 'COMPLETED' } });
      expect(await owed(task._id)).toBe(true);
    });

    it('marks it told once the ending itself lands', async () => {
      const task = await taskAt('COMPLETED');
      const ok = await deliverPayoutCallback(task, 'transaction.settled', keyId);
      expect(ok).toBe(true);
      expect((await reload(task._id))['callbackDeliveredAt'] ?? null).not.toBeNull();
      expect(await owed(task._id)).toBe(false);
    });
  });

  describe('the whole awkward route', () => {
    it('still owes the ending after proof, rejection, and an admin overrule', async () => {
      // The exact sequence that surfaced this: a refund paid out, the party
      // rejecting the captain's proof, admin siding with the captain.
      const task = await apiTask('AUDIT_PENDING');
      await deliverPayoutCallback(task, 'payout.confirmation_required', 'otdms_missing');

      await Task.updateOne({ _id: task._id }, { $set: { status: 'REJECTED' } });
      expect(await owed(task._id)).toBe(false); // not an ending

      await Task.updateOne({ _id: task._id }, { $set: { status: 'COMPLETED' } });
      expect(await owed(task._id)).toBe(true); // now it is

      const after = await reload(task._id);
      expect(after['callbackDeliveredAt'] ?? null).toBeNull();
      expect(after['callbackAttempts']).toBe(0);
    });

    it('does not re-send the ending once it has landed', async () => {
      const task = await apiTask('AUDIT_PENDING');
      await deliverPayoutCallback(task, 'payout.confirmation_required', 'otdms_missing');
      await Task.updateOne(
        { _id: task._id },
        { $set: { status: 'COMPLETED', callbackDeliveredAt: new Date() } },
      );
      expect(await owed(task._id)).toBe(false);
    });
  });
});
