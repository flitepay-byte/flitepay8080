import { toCustomerTrackingDto, CUSTOMER_TIMELINE_STEPS } from '../../utils/serializers';
import type { ITask } from '../../models';

function fakeTask(overrides: Partial<ITask> = {}): ITask {
  const now = new Date('2026-01-15T10:00:00Z');
  return {
    _id: 'task-oid',
    taskCode: 'TASK-2026-000125',
    partyId: 'party-oid',
    customerName: 'Rahul Sharma',
    identifier: 'DEMO-UPI-001',
    amountPaise: 1_000_000,
    externalRef: 'DEMO-REF-001',
    status: 'COMPLETED',
    captainId: 'captain-oid',
    commissionPaise: 5000,
    providerReference: 'SIM123456789012',
    payoutResult: 'SUCCESS',
    rejectionReason: 'internal note',
    reassignmentCount: 2,
    previousCaptainIds: [],
    stateHistory: [
      { from: null, to: 'CREATED', at: now },
      { from: 'CREATED', to: 'ASSIGNED', at: now },
      { from: 'ASSIGNED', to: 'IN_PROGRESS', at: now },
      { from: 'IN_PROGRESS', to: 'PROOF_SUBMITTED', at: now },
      { from: 'PROOF_SUBMITTED', to: 'AUDIT_PENDING', at: now },
      { from: 'AUDIT_PENDING', to: 'COMPLETED', at: now },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as ITask;
}

describe('customer tracking view', () => {
  it('exposes only reference, amount, status and timeline', () => {
    const dto = toCustomerTrackingDto(fakeTask());
    // An allow-list, not a sample: anything added to this view has to be
    // added here too, which is what stops a field being exposed by accident.
    expect(Object.keys(dto).sort()).toEqual(
      [
        'amount', 'expectedBy', 'isLate', 'lastUpdated', 'paid',
        'reference', 'status', 'statusLabel', 'timeline',
      ].sort(),
    );
  });

  it('never leaks captain identity, commission, or internal references', () => {
    const serialised = JSON.stringify(toCustomerTrackingDto(fakeTask()));
    expect(serialised).not.toContain('captain-oid');
    expect(serialised).not.toContain('party-oid');
    expect(serialised).not.toContain('SIM123456789012');
    expect(serialised).not.toContain('internal note');
    expect(serialised).not.toContain('commission');
    expect(serialised).not.toContain('TASK-2026-000125');
    expect(serialised).not.toContain('DEMO-UPI-001');
  });

  it('converts the amount to rupees', () => {
    expect(toCustomerTrackingDto(fakeTask()).amount).toBe(10000);
  });

  it('marks the full timeline complete for a finished task', () => {
    const dto = toCustomerTrackingDto(fakeTask());
    expect(dto.timeline).toHaveLength(CUSTOMER_TIMELINE_STEPS.length);
    expect(dto.timeline.every((step) => step.complete)).toBe(true);
  });

  it('marks only reached steps complete for an in-flight task', () => {
    const dto = toCustomerTrackingDto(
      fakeTask({
        status: 'IN_PROGRESS',
        stateHistory: [
          { from: null, to: 'CREATED', at: new Date() },
          { from: 'CREATED', to: 'ASSIGNED', at: new Date() },
          { from: 'ASSIGNED', to: 'IN_PROGRESS', at: new Date() },
        ],
      } as Partial<ITask>),
    );
    const byKey = Object.fromEntries(dto.timeline.map((s) => [s.key, s.complete]));
    expect(byKey['CREATED']).toBe(true);
    expect(byKey['ASSIGNED']).toBe(true);
    expect(byKey['COMPLETED']).toBe(false);
    expect(byKey['AUDIT_PENDING']).toBe(false);
  });

  it('presents a reassigned task as neutral progress, hiding the churn', () => {
    const dto = toCustomerTrackingDto(fakeTask({ status: 'REASSIGNED' } as Partial<ITask>));
    expect(dto.statusLabel).toBe('In Progress');
    expect(JSON.stringify(dto)).not.toContain('reassign');
  });

  it('presents a rejected task as under review rather than exposing the audit result', () => {
    const dto = toCustomerTrackingDto(fakeTask({ status: 'REJECTED' } as Partial<ITask>));
    expect(dto.statusLabel).toBe('Under Review');
  });
});
