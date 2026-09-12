/**
 * PHASE: privacy and authorization, through the real HTTP stack.
 *
 * DTO-level checks prove what a serialiser returns; they prove nothing about
 * whether a route lets the wrong person call it. Everything here goes through
 * supertest against the actual Express app, with real tokens issued by the
 * real login route, so route guards, ownership checks and middleware are all
 * in the path.
 *
 * The interesting tests are the hostile ones: a captain asking for a task that
 * is not theirs, a party asking for another party's, ids guessed rather than
 * discovered.
 */
import request from 'supertest';
import type { Express } from 'express';
import { Task, Party, Captain, PartyTopUpRequest } from '../models';
import { env } from '../config/env';
import { record, report } from './harness';
import { signIn, GET, POST, type Session } from './auth';
import type { Dataset } from './seed';

const AREA = 'Privacy/AuthZ';
const P = env.API_PREFIX;

/** Anything in the payload that would identify the party or the tracking reference. */
function scanForLeaks(body: unknown, needles: Array<{ what: string; value: string }>): string[] {
  const text = JSON.stringify(body ?? null);
  return needles.filter((n) => n.value && text.includes(n.value)).map((n) => n.what);
}

export async function auditPrivacy(app: Express, data: Dataset): Promise<void> {
  console.log('\n=== PHASE: privacy and authorization (real HTTP) ===');

  const partyA = data.parties[0];
  const partyB = data.parties[1];
  const capA = data.captains[0];
  const capB = data.captains[1];
  if (!partyA || !partyB || !capA || !capB) throw new Error('dataset too small');

  const admin = await signIn(app, 'admin@audit.demo', data.password);
  const sessionPartyA = await signIn(app, partyA.email, data.password);
  const sessionPartyB = await signIn(app, partyB.email, data.password);
  const sessionCapA = await signIn(app, capA.email, data.password);
  const sessionCapB = await signIn(app, capB.email, data.password);
  record(AREA, 'all five accounts complete the two-step OTP sign-in', true);
  record(AREA, 'each session carries the role it signed in as',
    admin.role === 'ADMIN' && sessionPartyA.role === 'PARTY' && sessionCapA.role === 'CAPTAIN',
    `${admin.role}/${sessionPartyA.role}/${sessionCapA.role}`);

  // ---------- Admin must actually get what it needs to arbitrate ----------
  {
    const anyTask = await Task.findOne({ captainId: { $ne: null } }).lean();
    if (anyTask) {
      const res = await GET(admin, `/admin/tasks/${anyTask._id}`);
      const body = JSON.stringify(res.body);
      const holder = await Captain.findById(anyTask.captainId).lean();
      const owner = await Party.findById(anyTask.partyId).lean();
      const complete =
        res.status === 200 &&
        body.includes(String(anyTask.partyId)) &&
        (holder ? body.includes(holder.captainCode) : true) &&
        (owner ? body.includes(owner.partyCode) : true);
      if (!record(AREA, 'admin task detail names both the party and the captain', complete, `status ${res.status}`)) {
        report({
          severity: 'P2', area: AREA, roles: ['Admin'],
          title: 'Admin task detail is missing party or captain identity',
          reproduction: `GET ${P}/admin/tasks/${anyTask._id} as admin.`,
          expected: 'Admin is the one role that sees both sides, so both must be present.',
          actual: `HTTP ${res.status}; party or captain identity absent from the payload.`,
          impact: 'Admin cannot arbitrate a dispute without knowing who is involved.',
          evidence: `taskId=${anyTask._id}`,
        });
      }
    }
  }

  // ---------- Party B is used as the intruder target throughout ----------
  const partyBSelfCheck = await GET(sessionPartyB, '/party/tasks?page=1&limit=5');
  record(AREA, 'the second party can read its own task list', partyBSelfCheck.status === 200, `status ${partyBSelfCheck.status}`);

  // ---------- Captain sees no party/customer-source identity ----------
  const capATasks = await Task.find({ $or: [{ captainId: capA.id }, { previousCaptainIds: capA.id }] }).lean();
  const sample = capATasks[0];

  if (sample) {
    const owner = await Party.findById(sample.partyId).lean();
    const res = await GET(sessionCapA, `/captain/tasks/${sample._id}`);
    const leaks = scanForLeaks(res.body, [
      { what: 'externalRef', value: sample.externalRef },
      { what: 'party company name', value: owner?.companyName ?? '' },
      { what: 'party contact email', value: owner?.contactEmail ?? '' },
    ]);
    if (!record(AREA, 'captain task detail leaks no party identity or tracking reference', leaks.length === 0, leaks.join(', '))) {
      report({
        severity: 'P0', area: AREA, roles: ['Captain'],
        title: `Captain task detail exposes ${leaks.join(', ')}`,
        reproduction: `GET ${P}/captain/tasks/${sample._id} as ${capA.code}.`,
        expected: 'A captain never receives the party identity or the party tracking reference.',
        actual: `Response contains: ${leaks.join(', ')}.`,
        impact: 'A captain can identify the party behind a task and contact the customer out of band.',
        evidence: `taskId=${sample._id}`,
      });
    }
  } else {
    record(AREA, 'captain has at least one task to inspect', false, 'no tasks for CAP-001');
  }

  await auditTaskCodeComposition(sessionCapA, capA.id);

  // ---------- Captain cannot fetch a task belonging to another captain ----------
  const otherTask = await Task.findOne({
    captainId: { $ne: null, $nin: [capA.id] },
    previousCaptainIds: { $ne: capA.id },
  }).lean();

  if (otherTask) {
    const res = await GET(sessionCapA, `/captain/tasks/${otherTask._id}`);
    if (!record(AREA, "captain cannot open another captain's task by id", res.status === 404, `status ${res.status}`)) {
      report({
        severity: 'P0', area: AREA, roles: ['Captain'],
        title: "A captain can fetch another captain's task by guessing its id",
        reproduction: `GET ${P}/captain/tasks/${otherTask._id} as ${capA.code}, a task held by a different captain.`,
        expected: '404 — the route is scoped to tasks the captain holds or held.',
        actual: `HTTP ${res.status} with a task payload.`,
        impact: 'Full horizontal privilege escalation across captains.',
        evidence: `taskId=${otherTask._id}`,
      });
    }
  }

  // ---------- Party cannot fetch another party's task ----------
  const partyBTask = await Task.findOne({ partyId: partyB.id }).lean();
  if (partyBTask) {
    const res = await GET(sessionPartyA, `/party/tasks/${partyBTask._id}`);
    const denied = res.status === 404 || res.status === 403;
    if (!record(AREA, "party cannot open another party's task by id", denied, `status ${res.status}`)) {
      report({
        severity: 'P0', area: AREA, roles: ['Party'],
        title: "A party can fetch another party's task by guessing its id",
        reproduction: `GET ${P}/party/tasks/${partyBTask._id} as ${partyA.code}; the task belongs to ${partyB.code}.`,
        expected: '404 — party routes are scoped by partyId.',
        actual: `HTTP ${res.status} with a task payload.`,
        impact: 'One customer of the platform can read another customer\'s order book.',
        evidence: `taskId=${partyBTask._id}`,
      });
    }
  }

  // ---------- Party list never names a captain ----------
  const listRes = await GET(sessionPartyA, '/party/tasks?page=1&limit=50');
  const allCaptains = await Captain.find().lean();
  const captainNeedles = allCaptains.flatMap((c) => [
    { what: `captain id ${c.captainCode}`, value: String(c._id) },
    { what: `captain code ${c.captainCode}`, value: c.captainCode },
    { what: `captain name ${c.captainCode}`, value: c.displayName },
  ]);
  const partyLeaks = scanForLeaks(listRes.body, captainNeedles);
  if (!record(AREA, 'party task list names no captain', partyLeaks.length === 0, partyLeaks.slice(0, 3).join(', '))) {
    report({
      severity: 'P1', area: AREA, roles: ['Party'],
      title: 'Party task list exposes captain identity',
      reproduction: `GET ${P}/party/tasks?page=1&limit=50 as ${partyA.code}.`,
      expected: 'A party never learns which captain is working its task.',
      actual: `Response contains: ${partyLeaks.slice(0, 5).join(', ')}.`,
      impact: 'Parties can build a picture of individual captains and approach them directly.',
    });
  }

  // ---------- Role boundaries on admin routes ----------
  const adminOnly = ['/admin/tasks?page=1&limit=5', '/admin/parties?page=1&limit=5', '/admin/captains?page=1&limit=5', '/admin/wallet', '/admin/dmc-topups?page=1&limit=5'];
  for (const path of adminOnly) {
    const asParty = await GET(sessionPartyA, path);
    const asCaptain = await GET(sessionCapA, path);
    const blocked = [asParty.status, asCaptain.status].every((s) => s === 401 || s === 403);
    if (!record(AREA, `admin route is closed to other roles: ${path.split('?')[0]}`, blocked, `party ${asParty.status}, captain ${asCaptain.status}`)) {
      report({
        severity: 'P0', area: AREA, roles: ['Party', 'Captain'],
        title: `Non-admin role can call ${path.split('?')[0]}`,
        reproduction: `GET ${P}${path} with a party token and with a captain token.`,
        expected: '401 or 403 for both.',
        actual: `party ${asParty.status}, captain ${asCaptain.status}.`,
        impact: 'System-wide data is readable by any signed-in user.',
      });
    }
  }

  // ---------- Captain routes closed to parties, and vice versa ----------
  const captainOnly = ['/captain/tasks?page=1&limit=5', '/captain/queue?page=1&limit=5', '/captain/wallet'];
  for (const path of captainOnly) {
    const res = await GET(sessionPartyA, path);
    record(AREA, `captain route is closed to a party: ${path.split('?')[0]}`, res.status === 401 || res.status === 403 || res.status === 404, `status ${res.status}`);
  }
  const partyOnly = ['/party/tasks?page=1&limit=5', '/party/wallet', '/party/withdrawal-portions?page=1&limit=5'];
  for (const path of partyOnly) {
    const res = await GET(sessionCapA, path);
    record(AREA, `party route is closed to a captain: ${path.split('?')[0]}`, res.status === 401 || res.status === 403 || res.status === 404, `status ${res.status}`);
  }

  // ---------- Top-up isolation ----------
  const topUpOfB = await PartyTopUpRequest.findOne({ partyId: partyB.id }).lean();
  if (topUpOfB) {
    const res = await GET(sessionPartyA, `/party/dmc/purchases?page=1&limit=50`);
    const leaked = JSON.stringify(res.body).includes(String(topUpOfB._id));
    if (!record(AREA, "party top-up list contains only that party's own requests", !leaked)) {
      report({
        severity: 'P0', area: AREA, roles: ['Party'],
        title: "A party's top-up list includes another party's top-up requests",
        reproduction: `GET ${P}/party/dmc/purchases as ${partyA.code}; look for a request belonging to ${partyB.code}.`,
        expected: 'Scoped to the calling party.',
        actual: `Response contains top-up ${topUpOfB._id} owned by ${partyB.code}.`,
        impact: 'Financial records leak between tenants.',
      });
    }
  }

  // ---------- Released captain sees nothing of the new captain ----------
  const reassigned =
    (await Task.findOne({ 'previousCaptainIds.0': { $exists: true }, captainId: { $ne: null } }).lean()) ??
    (await Task.findOne({ 'previousCaptainIds.0': { $exists: true } }).lean());
  if (reassigned) {
    const previous = reassigned.previousCaptainIds[0];
    const prevCaptain = data.captains.find((c) => String(c.id) === String(previous));
    const nowCaptain = await Captain.findById(reassigned.captainId).lean();
    if (prevCaptain && nowCaptain) {
      const session = await signIn(app, prevCaptain.email, data.password);
      const res = await GET(session, `/captain/tasks/${reassigned._id}`);
      const leaks = scanForLeaks(res.body, [
        { what: 'new captain id', value: String(nowCaptain._id) },
        { what: 'new captain code', value: nowCaptain.captainCode },
        { what: 'new captain name', value: nowCaptain.displayName },
        { what: 'live provider reference', value: reassigned.providerReference ?? '' },
      ]);
      if (!record(AREA, 'released captain sees nothing of the captain who replaced them', leaks.length === 0, leaks.join(', '))) {
        report({
          severity: 'P1', area: AREA, roles: ['Captain'],
          title: `Released captain can see ${leaks.join(', ')}`,
          reproduction: `GET ${P}/captain/tasks/${reassigned._id} as ${prevCaptain.code}, who was reassigned off it.`,
          expected: 'The row is frozen at their release; nothing about the replacement is present.',
          actual: `Response contains: ${leaks.join(', ')}.`,
          impact: 'Captains can identify each other and infer who is taking over their rejected work.',
          evidence: `taskId=${reassigned._id}`,
        });
      }
    }
  } else {
    record(AREA, 'a reassigned task exists to test released-captain isolation', false, 'none in dataset');
  }

  // ---------- One captain cannot act on another captain's task ----------
  {
    const capATask = await Task.findOne({ captainId: capA.id, status: { $in: ['ASSIGNED', 'IN_PROGRESS'] } }).lean();
    if (capATask) {
      const res = await POST(sessionCapB, `/captain/tasks/${capATask._id}/start`).send({});
      if (!record(AREA, "a captain cannot start a task held by another captain", res.status >= 400, `status ${res.status}`)) {
        report({
          severity: 'P0', area: AREA, roles: ['Captain'],
          title: "A captain can drive another captain's task through the workflow",
          reproduction: `POST ${P}/captain/tasks/${capATask._id}/start as ${capB.code}; the task is held by ${capA.code}.`,
          expected: 'Rejected — workflow actions are scoped to the holding captain.',
          actual: `HTTP ${res.status}.`,
          impact: "Any captain can move, complete or sabotage another captain's work.",
          evidence: `taskId=${capATask._id}`,
        });
      }
    } else {
      record(AREA, 'a live task exists for the cross-captain action test', false, 'none in dataset');
    }
  }

  // ---------- Unauthenticated access ----------
  const noAuth = await request(app).get(`${P}/admin/tasks?page=1&limit=5`);
  if (!record(AREA, 'admin routes reject an unauthenticated caller', noAuth.status === 401, `status ${noAuth.status}`)) {
    report({
      severity: 'P0', area: AREA, roles: ['Anonymous'],
      title: 'Admin route reachable without authentication',
      reproduction: `GET ${P}/admin/tasks with no Authorization header.`,
      expected: '401.',
      actual: `HTTP ${noAuth.status}.`,
      impact: 'Unauthenticated data exposure.',
    });
  }

  // ---------- A forged/expired token ----------
  const badCookie = await request(app).get(`${P}/party/tasks`).set('Cookie', 'accessToken=not.a.real.token');
  record(AREA, 'a forged session cookie is rejected', badCookie.status === 401, `status ${badCookie.status}`);
}

/**
 * The identifier a captain is actually shown.
 *
 * The stored `taskCode` is built as TASK-<partyCode>-<year>-<sequence> and
 * stays that way for party and admin, who own that information. What matters
 * is the value that reaches a captain, so this asks the captain's own endpoint
 * rather than reading the database.
 */
async function auditTaskCodeComposition(session: Session, captainId: unknown): Promise<void> {
  const task = await Task.findOne({
    $or: [{ captainId }, { previousCaptainIds: captainId }],
  })
    .select('taskCode partyId')
    .lean();
  const owner = task ? await Party.findById(task.partyId).select('partyCode companyName').lean() : null;
  if (!task || !owner) {
    record(AREA, 'the captain has a task to check the shown code against', false, 'none in dataset');
    return;
  }

  const res = await GET(session, `/captain/tasks/${task._id}`);
  const shown = String((res.body?.data as { taskCode?: string } | undefined)?.taskCode ?? '');
  const namesParty = shown.includes(owner.partyCode);

  if (!record(AREA, 'the code shown to a captain does not name the party', !namesParty,
    `shown "${shown}" for a task owned by ${owner.partyCode}`)) {
    report({
      severity: 'P2', area: AREA, roles: ['Captain'],
      title: 'The identifier shown to a captain names the owning party',
      reproduction: `GET ${P}/captain/tasks/${task._id} and read taskCode; the owner is ${owner.partyCode}.`,
      expected: 'An opaque code, unrelated to the party — the stored TASK-<partyCode>-... form is for party and admin only.',
      actual: `The captain is shown "${shown}".`,
      impact: 'Captains can group their work by party, measure each party volume, and correlate customers to a party.',
      evidence: `stored=${task.taskCode}, shown=${shown}, party=${owner.partyCode}`,
    });
  }
}
