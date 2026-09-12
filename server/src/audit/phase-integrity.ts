/**
 * PHASE: state machine, history and search.
 *
 * Reads the finished dataset back and asks whether it could have been produced
 * legally: every transition permitted, every event attributable, every search
 * scoped to the person asking.
 */
import { Types } from 'mongoose';
import { Task, Party, Captain, Proof } from '../models';
import { TASK_TRANSITIONS, TERMINAL_STATES, type TaskState } from '../types';
import { taskSearchClause } from '../utils/taskSearch';
import { resolveCounterparties } from '../utils/counterpartySearch';
import { record, report } from './harness';

const AREA_STATE = 'State machine';
const AREA_HISTORY = 'History/Audit';
const AREA_SEARCH = 'Search';

export async function auditIntegrity(): Promise<void> {
  console.log('\n=== PHASE: state machine, history and search ===');

  const tasks = await Task.find().lean();
  console.log(`  (auditing ${tasks.length} tasks)`);

  // ---------- 1. Every recorded transition is a legal one ----------
  const illegal: string[] = [];
  for (const task of tasks) {
    for (const event of task.stateHistory) {
      if (event.from === null) continue;
      const allowed = TASK_TRANSITIONS[event.from as TaskState] ?? [];
      if (!allowed.includes(event.to as TaskState)) {
        illegal.push(`${task.taskCode}: ${event.from} -> ${event.to}`);
      }
    }
  }
  if (!record(AREA_STATE, 'every recorded transition is permitted by the table', illegal.length === 0, illegal.slice(0, 5).join(' | '))) {
    report({
      severity: 'P1', area: AREA_STATE, roles: ['Admin'],
      title: 'Task history contains a transition the state machine forbids',
      reproduction: 'Walk every Task.stateHistory entry and check event.to against TASK_TRANSITIONS[event.from].',
      expected: 'Every transition is in the frozen table; assertTransition gates all writes.',
      actual: `${illegal.length} illegal transitions, e.g. ${illegal.slice(0, 5).join(' | ')}`,
      impact: 'Some path writes state without going through the guard, so the machine is not the single source of truth.',
    });
  }

  // ---------- 2. History ends where the task actually is ----------
  const mismatched = tasks.filter((t) => {
    const last = t.stateHistory[t.stateHistory.length - 1];
    return last && last.to !== t.status;
  });
  if (!record(AREA_HISTORY, 'the last history entry matches the current status', mismatched.length === 0,
    `${mismatched.length} mismatched, e.g. ${mismatched.slice(0, 3).map((t) => `${t.taskCode} is ${t.status} but history ends ${t.stateHistory[t.stateHistory.length - 1]?.to}`).join(' | ')}`)) {
    report({
      severity: 'P1', area: AREA_HISTORY, roles: ['Admin', 'Party', 'Captain'],
      title: 'Task status and the end of its own history disagree',
      reproduction: 'Compare Task.status to the `to` of the final stateHistory entry.',
      expected: 'Every status change appends an event, so the two always agree.',
      actual: `${mismatched.length} tasks disagree, e.g. ${mismatched.slice(0, 3).map((t) => `${t.taskCode}: status ${t.status}, history ends ${t.stateHistory[t.stateHistory.length - 1]?.to}`).join(' | ')}`,
      impact: 'The audit trail is not a faithful record; a state change happened with no entry.',
    });
  }

  // ---------- 3. Every event is attributable ----------
  const unattributed = tasks.filter((t) => t.stateHistory.some((e) => !e.actorRole));
  if (!record(AREA_HISTORY, 'every history event names the role that caused it', unattributed.length === 0,
    `${unattributed.length} tasks have an event with no actorRole`)) {
    report({
      severity: 'P2', area: AREA_HISTORY, roles: ['Admin'],
      title: 'History event recorded with no actor role',
      reproduction: 'Find tasks with a stateHistory entry missing actorRole.',
      expected: 'Every event names the role that caused it, SYSTEM included.',
      actual: `${unattributed.length} tasks carry an unattributed event.`,
      impact: 'A dispute cannot be settled from the trail if nobody knows who acted.',
    });
  }

  // ---------- 4. Timestamps never run backwards ----------
  const outOfOrder = tasks.filter((t) => {
    for (let i = 1; i < t.stateHistory.length; i++) {
      const prev = t.stateHistory[i - 1];
      const cur = t.stateHistory[i];
      if (prev && cur && cur.at.getTime() < prev.at.getTime()) return true;
    }
    return false;
  });
  if (!record(AREA_HISTORY, 'history timestamps never go backwards', outOfOrder.length === 0, `${outOfOrder.length} out of order`)) {
    report({
      severity: 'P2', area: AREA_HISTORY, roles: ['Admin'],
      title: 'State history entries are not in chronological order',
      reproduction: 'Walk each stateHistory and compare consecutive `at` values.',
      expected: 'The log is append-only and monotonic.',
      actual: `${outOfOrder.length} tasks have an event dated before the one preceding it.`,
      impact: 'Reconstructing what happened when becomes unreliable.',
    });
  }

  // ---------- 5. Reassignment is attributable to a captain ----------
  const reassigned = tasks.filter((t) => t.reassignmentCount > 0);
  const unattributableReassign = reassigned.filter((t) => {
    const assigned = t.stateHistory.filter((e) => e.to === 'ASSIGNED');
    return assigned.some((e) => !e.captainId);
  });
  record(AREA_HISTORY, `${reassigned.length} reassigned tasks exist`, reassigned.length > 0);
  if (!record(AREA_HISTORY, 'every claim event names the captain who made it', unattributableReassign.length === 0,
    `${unattributableReassign.length} with an unstamped claim`)) {
    report({
      severity: 'P2', area: AREA_HISTORY, roles: ['Admin'],
      title: 'A reassigned task has a claim event with no captain attached',
      reproduction: 'For tasks with reassignmentCount > 0, check every ASSIGNED event has a captainId.',
      expected: 'The save hook and the explicit stamps cover every claim.',
      actual: `${unattributableReassign.length} reassigned tasks have an unstamped ASSIGNED event.`,
      impact: "Admin cannot tell which captain held the task at each point of its history.",
    });
  }

  // ---------- 6. previousCaptainIds never contains the current holder ----------
  const selfOverlap = tasks.filter((t) => t.captainId && (t.previousCaptainIds ?? []).some((id) => String(id) === String(t.captainId)));
  if (!record(AREA_STATE, 'the current captain is never also listed as a previous one', selfOverlap.length === 0,
    `${selfOverlap.length} overlapping`)) {
    report({
      severity: 'P2', area: AREA_STATE, roles: ['Captain', 'Admin'],
      title: 'A task lists its current captain among the captains it was taken from',
      reproduction: 'Find tasks where captainId appears in previousCaptainIds.',
      expected: 'A captain rejected off a task is never offered it again, so the two sets are disjoint.',
      actual: `${selfOverlap.length} tasks overlap.`,
      impact: 'A released captain is treated as both current and released; their view of the task becomes contradictory.',
    });
  }

  // ---------- 7. A terminal task holds no live clocks ----------
  const terminalWithClocks = tasks.filter(
    (t) => TERMINAL_STATES.includes(t.status as TaskState) && (t.offerExpiresAt || t.expiryAckDeadline),
  );
  if (!record(AREA_STATE, 'a finished task carries no pending deadlines', terminalWithClocks.length === 0,
    `${terminalWithClocks.length} terminal tasks still hold a deadline`)) {
    report({
      severity: 'P2', area: AREA_STATE, roles: ['Captain', 'Admin'],
      title: 'A completed or cancelled task still carries an offer or acknowledgement deadline',
      reproduction: 'Find tasks in COMPLETED/CANCELLED with offerExpiresAt or expiryAckDeadline still set.',
      expected: 'Terminal states clear their clocks so the sweeper never looks at them again.',
      actual: `${terminalWithClocks.length} terminal tasks still carry a deadline.`,
      impact: 'The background sweeper keeps reconsidering finished work, and countdowns can appear on the UI for tasks that are over.',
    });
  }

  // ---------- 8. An unclaimed task holds no captain ----------
  const ghostHolders = tasks.filter((t) => ['CREATED', 'REASSIGNED'].includes(t.status) && t.captainId);
  if (!record(AREA_STATE, 'an unclaimed task has no captain attached', ghostHolders.length === 0, `${ghostHolders.length} ghosts`)) {
    report({
      severity: 'P1', area: AREA_STATE, roles: ['Captain'],
      title: 'A task in the pool still has a captain attached',
      reproduction: 'Find tasks in CREATED or REASSIGNED where captainId is not null.',
      expected: 'Returning a task to the pool clears the captain and releases their collateral.',
      actual: `${ghostHolders.length} pooled tasks still name a captain.`,
      impact: "Collateral stays locked against a task the captain no longer holds.",
    });
  }

  // ---------- 9. At most one live proof per task ----------
  const liveProofs = await Proof.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { supersededAt: null } },
    { $group: { _id: '$taskId', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  if (!record(AREA_STATE, 'no task has two live proofs', liveProofs.length === 0, `${liveProofs.length} tasks with multiple`)) {
    report({
      severity: 'P1', area: AREA_STATE, roles: ['Party', 'Captain'],
      title: 'A task has more than one live (non-superseded) proof',
      reproduction: 'Group Proof by taskId where supersededAt is null; keep counts > 1.',
      expected: 'Submitting a new proof supersedes the previous one.',
      actual: `${liveProofs.length} tasks carry multiple live proofs.`,
      impact: 'The party audits an ambiguous record; approval may attach to the wrong evidence.',
    });
  }

  // ---------- 10. Search: scoping and hostile input ----------
  const captain = await Captain.findOne().lean();
  const party = await Party.findOne().lean();
  if (captain && party) {
    // A captain's search must never reach a task they have no relation to.
    const someoneElses = await Task.findOne({
      captainId: { $ne: null, $nin: [captain._id] },
      previousCaptainIds: { $ne: captain._id },
    }).lean();

    if (someoneElses) {
      const clause = taskSearchClause(someoneElses.taskCode, { includeExternalRef: false });
      const scoped = {
        $and: [{ $or: [{ captainId: captain._id }, { previousCaptainIds: captain._id }] }],
        ...(clause ? { $or: clause } : {}),
      };
      const hits = await Task.countDocuments(scoped);
      if (!record(AREA_SEARCH, "a captain searching another captain's exact task code finds nothing", hits === 0, `${hits} hits`)) {
        report({
          severity: 'P0', area: AREA_SEARCH, roles: ['Captain'],
          title: "Captain search returns tasks belonging to other captains",
          reproduction: `As ${captain.captainCode}, search the captain task list for the exact code ${someoneElses.taskCode}.`,
          expected: 'Search narrows what they already hold; it never widens it.',
          actual: `${hits} results returned.`,
          impact: 'Search becomes a discovery channel across the captain population.',
        });
      }

      // And must never be searchable by the tracking reference.
      const refClause = taskSearchClause(someoneElses.externalRef, { includeExternalRef: false });
      const refFields = (refClause ?? []).flatMap((c) => Object.keys(c));
      record(AREA_SEARCH, 'captain search never covers the party tracking reference', !refFields.includes('externalRef'));
    }

    // Hostile input must be matched literally, not executed.
    const hostile = ['.*', '^TASK', '(a+)+$', '[a-z]', 'x'.repeat(200), '', '   ', '$where', '{"$ne":null}'];
    let misbehaved = 0;
    const total = await Task.countDocuments({});
    for (const term of hostile) {
      const clause = taskSearchClause(term, { includeExternalRef: true });
      if (!clause) continue;
      const hits = await Task.countDocuments({ $or: clause });
      // A literal match on any of these should be rare; matching everything
      // means the term was executed as a pattern.
      if (hits === total && total > 1) misbehaved += 1;
    }
    if (!record(AREA_SEARCH, 'regex-like and oversized search input is matched literally', misbehaved === 0,
      `${misbehaved} terms matched everything`)) {
      report({
        severity: 'P1', area: AREA_SEARCH, roles: ['Party', 'Captain', 'Admin'],
        title: 'A regex metacharacter in the search box is executed as a pattern',
        reproduction: 'Search for ".*" or "(a+)+$" in any task list.',
        expected: 'The term is escaped and matched as text.',
        actual: `${misbehaved} hostile terms returned every task in the collection.`,
        impact: 'Search can be used to dump the collection, and a catastrophic pattern can pin the database.',
      });
    }

    // Counterparty search must not fall back to "everything" on no match.
    const nobody = await resolveCounterparties('zzz-definitely-nobody-zzz');
    const emptyMatch = nobody !== null && nobody.captainIds.length === 0 && nobody.partyIds.length === 0;
    record(AREA_SEARCH, 'a counterparty search matching nobody resolves to an empty set', emptyMatch);

    const blank = await resolveCounterparties('   ');
    record(AREA_SEARCH, 'a blank counterparty search does not filter at all', blank === null);
  }

  // ---------- 11. Task codes are unique ----------
  const duplicateCodes = await Task.aggregate<{ _id: string; n: number }>([
    { $group: { _id: '$taskCode', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  if (!record(AREA_STATE, 'task codes are unique', duplicateCodes.length === 0, `${duplicateCodes.length} duplicated`)) {
    report({
      severity: 'P1', area: AREA_STATE, roles: ['Party', 'Admin'],
      title: 'Duplicate task codes exist',
      reproduction: 'Group Task by taskCode and keep counts > 1.',
      expected: 'The code is the human-facing unique identifier.',
      actual: `${duplicateCodes.length} codes are used more than once.`,
      impact: 'Searching by code returns the wrong task; support conversations become ambiguous.',
    });
  }

  // ---------- 12. Every task still has an owner ----------
  const parties = await Party.find().select('_id').lean();
  const partyIds = new Set(parties.map((p) => String(p._id)));
  const orphanTasks = tasks.filter((t) => !partyIds.has(String(t.partyId)));
  record(AREA_STATE, 'every task belongs to an existing party', orphanTasks.length === 0, `${orphanTasks.length} orphans`);
}
