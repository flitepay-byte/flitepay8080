/**
 * PHASE: boundaries and hostile input, through the real HTTP stack.
 *
 * Everything here is something a careless or malicious client would actually
 * send: zero, negative, absurdly large, empty, oversized, the wrong type, the
 * same request twice. The question in each case is whether the API refuses
 * cleanly — a 4xx with nothing written — rather than accepting it or falling
 * over with a 500.
 */
import type { Express } from 'express';
import { Task, Party } from '../models';
import { env } from '../config/env';
import { getConfig } from '../services/systemConfig.service';
import { paiseToRupees } from '../utils/money';
import { record, report } from './harness';
import { signIn, GET, POST, type Session } from './auth';
import type { Dataset } from './seed';

const AREA = 'Boundaries';
const P = env.API_PREFIX;

export async function auditEdges(app: Express, data: Dataset): Promise<void> {
  console.log('\n=== PHASE: boundaries and hostile input ===');

  const party = data.parties[0];
  if (!party) throw new Error('no party');
  const session: Session = await signIn(app, party.email, data.password);
  const config = await getConfig();

  const post = (path: string, body: Record<string, unknown>) => POST(session, path).send(body);

  // The API takes the payout method flattened, chosen by a `payoutType`
  // discriminant — not a nested object. Getting this wrong makes every case
  // fail validation for the wrong reason.
  const baseTask = {
    customerName: 'Edge Case',
    amount: 100,
    payoutType: 'UPI',
    upiId: 'edge@upi',
  };

  // ---------- Amounts at and beyond the boundaries ----------
  const min = paiseToRupees(config.minimumTaskAmountPaise);
  const max = paiseToRupees(config.maximumTaskAmountPaise);

  const amountCases: Array<{ label: string; amount: unknown; shouldAccept: boolean }> = [
    { label: 'zero', amount: 0, shouldAccept: false },
    { label: 'negative', amount: -500, shouldAccept: false },
    { label: 'exactly the minimum', amount: min, shouldAccept: true },
    { label: 'one below the minimum', amount: Math.max(0, min - 1), shouldAccept: false },
    { label: 'exactly the maximum', amount: max, shouldAccept: true },
    { label: 'one above the maximum', amount: max + 1, shouldAccept: false },
    { label: 'absurdly large', amount: 9_999_999_999_999, shouldAccept: false },
    { label: 'fractional paise', amount: 10.555, shouldAccept: false },
    // Multipart form fields arrive as strings, so a numeric string is
    // coerced on purpose - see rupeeAmountSchema.
    { label: 'a numeric string', amount: '100', shouldAccept: true },
    { label: 'null', amount: null, shouldAccept: false },
    { label: 'NaN', amount: 'NaN', shouldAccept: false },
    { label: 'Infinity', amount: 'Infinity', shouldAccept: false },
    { label: 'scientific notation', amount: 1e15, shouldAccept: false },
  ];

  for (const testCase of amountCases) {
    const res = await post('/party/tasks', { ...baseTask, amount: testCase.amount });
    const accepted = res.status >= 200 && res.status < 300;
    const crashed = res.status >= 500;
    const asExpected = accepted === testCase.shouldAccept && !crashed;

    if (!record(AREA, `task amount — ${testCase.label}`, asExpected, `HTTP ${res.status}`)) {
      report({
        severity: crashed ? 'P1' : accepted ? 'P1' : 'P2',
        area: AREA, roles: ['Party'],
        title: crashed
          ? `Task creation returns ${res.status} for a ${testCase.label} amount`
          : accepted
            ? `Task creation accepts a ${testCase.label} amount`
            : `Task creation rejects a ${testCase.label} amount that should be valid`,
        reproduction: `POST ${P}/party/tasks with amount = ${JSON.stringify(testCase.amount)} as ${party.code}.`,
        expected: testCase.shouldAccept ? 'Accepted (201).' : 'Rejected with a 4xx and nothing written.',
        actual: `HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 160)}`,
        impact: crashed
          ? 'An unhandled error path is reachable from untrusted input.'
          : accepted
            ? 'An out-of-range amount enters the ledger and is debited from the party.'
            : 'A legitimate amount at the configured boundary is refused.',
      });
    }
  }

  // ---------- Field-length and content boundaries ----------
  const fieldCases: Array<{ label: string; patch: Record<string, unknown>; shouldAccept: boolean }> = [
    { label: 'empty customer name', patch: { customerName: '' }, shouldAccept: false },
    { label: 'whitespace-only customer name', patch: { customerName: '    ' }, shouldAccept: false },
    { label: 'single character customer name', patch: { customerName: 'A' }, shouldAccept: true },
    { label: 'very long customer name (10k)', patch: { customerName: 'x'.repeat(10_000) }, shouldAccept: false },
    { label: 'missing customer name', patch: { customerName: undefined }, shouldAccept: false },
    { label: 'customer name as a number', patch: { customerName: 12345 }, shouldAccept: false },
    { label: 'customer name as an object', patch: { customerName: { $ne: null } }, shouldAccept: false },
    { label: 'unicode and emoji customer name', patch: { customerName: 'Müller 🚚 Ltd' }, shouldAccept: true },
    { label: 'HTML in the customer name', patch: { customerName: '<script>alert(1)</script>' }, shouldAccept: true },
    { label: 'missing payout type', patch: { payoutType: undefined }, shouldAccept: false },
    { label: 'payout type with no identifier', patch: { upiId: undefined }, shouldAccept: false },
    { label: 'unknown payout type', patch: { payoutType: 'CRYPTO_MAGIC' }, shouldAccept: false },
    { label: 'malformed UPI id', patch: { upiId: 'not-a-upi-id' }, shouldAccept: false },
    { label: 'UPI id with a leading dot', patch: { upiId: '.x@bank' }, shouldAccept: true },
  ];

  for (const testCase of fieldCases) {
    const body: Record<string, unknown> = { ...baseTask, ...testCase.patch };
    for (const key of Object.keys(testCase.patch)) {
      if (testCase.patch[key] === undefined) delete body[key];
    }
    const res = await post('/party/tasks', body);
    const accepted = res.status >= 200 && res.status < 300;
    const crashed = res.status >= 500;
    const asExpected = accepted === testCase.shouldAccept && !crashed;

    if (!record(AREA, `task field — ${testCase.label}`, asExpected, `HTTP ${res.status}`)) {
      report({
        severity: crashed ? 'P1' : 'P2',
        area: AREA, roles: ['Party'],
        title: crashed
          ? `Task creation returns ${res.status} for ${testCase.label}`
          : accepted
            ? `Task creation accepts ${testCase.label}`
            : `Task creation rejects ${testCase.label}, which should be allowed`,
        reproduction: `POST ${P}/party/tasks with ${JSON.stringify(testCase.patch).slice(0, 120)} as ${party.code}.`,
        expected: testCase.shouldAccept ? 'Accepted.' : 'Rejected with a 4xx.',
        actual: `HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 160)}`,
        impact: crashed ? 'Unhandled error reachable from untrusted input.' : 'Input validation does not match the documented rules.',
      });
    }
  }

  // ---------- Injection-shaped input in query parameters ----------
  const injections = ['{"$ne":null}', '$where', "'; drop database;", '../../etc/passwd', '%00', 'x'.repeat(5000)];
  for (const term of injections) {
    const res = await GET(session, `/party/tasks?page=1&limit=10&search=${encodeURIComponent(term)}`);
    const safe = res.status < 500;
    if (!record(AREA, `search survives hostile input: ${term.slice(0, 20)}`, safe, `HTTP ${res.status}`)) {
      report({
        severity: 'P1', area: AREA, roles: ['Party', 'Captain', 'Admin'],
        title: 'Hostile search input produces a server error',
        reproduction: `GET ${P}/party/tasks?search=${encodeURIComponent(term).slice(0, 60)}`,
        expected: 'Treated as text; a 200 with zero or more matches.',
        actual: `HTTP ${res.status}.`,
        impact: 'Untrusted query input reaches an unhandled path.',
      });
    }
  }

  // ---------- Pagination boundaries ----------
  const pageCases = ['page=0&limit=10', 'page=-1&limit=10', 'page=1&limit=0', 'page=1&limit=100000', 'page=abc&limit=xyz', 'page=1e10&limit=10'];
  for (const query of pageCases) {
    const res = await GET(session, `/party/tasks?${query}`);
    const safe = res.status < 500;
    if (!record(AREA, `pagination — ${query}`, safe, `HTTP ${res.status}`)) {
      report({
        severity: 'P2', area: AREA, roles: ['Party'],
        title: `Pagination parameters "${query}" cause a server error`,
        reproduction: `GET ${P}/party/tasks?${query}`,
        expected: 'Clamped or rejected with a 4xx.',
        actual: `HTTP ${res.status}.`,
        impact: 'A crafted page size can exhaust memory or crash the request.',
      });
    }
  }

  // ---------- Malformed ids ----------
  const badIds = ['not-an-id', '000000000000000000000000', '../admin', '%2e%2e', '1'];
  for (const id of badIds) {
    const res = await GET(session, `/party/tasks/${encodeURIComponent(id)}`);
    const safe = res.status === 400 || res.status === 404;
    if (!record(AREA, `malformed task id — ${id}`, safe, `HTTP ${res.status}`)) {
      report({
        severity: 'P2', area: AREA, roles: ['Party'],
        title: `A malformed task id (${id}) returns ${res.status}`,
        reproduction: `GET ${P}/party/tasks/${id}`,
        expected: '400 or 404.',
        actual: `HTTP ${res.status}.`,
        impact: 'Error handling leaks internal detail or crashes on bad input.',
      });
    }
  }

  // ---------- Double submission of the same create (the double-click) ----------
  {
    const before = await Party.findById(party.id).lean();
    const body: Record<string, unknown> = { ...baseTask, customerName: 'Double Click', externalRef: `DOUBLE-${Date.now()}` };
    const [first, second] = await Promise.all([post('/party/tasks', body), post('/party/tasks', body)]);
    const created = [first, second].filter((r) => r.status >= 200 && r.status < 300).length;
    const after = await Party.findById(party.id).lean();
    const debited = (before?.dmcBalancePaise ?? 0) - (after?.dmcBalancePaise ?? 0);

    const duplicated = await Task.countDocuments({ partyId: party.id, customerName: 'Double Click' });
    if (!record(AREA, 'double-submitting the same task does not create two of them', duplicated <= 1,
      `${created} accepted, ${duplicated} tasks written, debited ${paiseToRupees(debited)}`)) {
      report({
        severity: 'P2', area: AREA, roles: ['Party'],
        title: 'Task creation has no idempotency guard, so a double-click bills twice',
        reproduction: `POST ${P}/party/tasks twice simultaneously with an identical body.`,
        expected: 'One task. A repeated create should be recognised as the same request.',
        actual: `${created} requests accepted, ${duplicated} tasks created, ${paiseToRupees(debited)} DMC debited. The endpoint ignores any client-supplied externalRef and generates its own, so the unique (partyId, externalRef) index can never match the two.`,
        impact: 'A double-clicked New Task button, or a client retry after a timeout, silently bills the party twice and pays the customer twice.',
        evidence: `tasks named Double Click = ${duplicated}`,
      });
    }
  }

  // ---------- An action replayed after it has already been applied ----------
  {
    const completed = await Task.findOne({ status: 'COMPLETED', partyId: party.id }).lean();
    if (completed) {
      const res = await POST(session, `/party/audit/${completed._id}/approve`).send({});
      if (!record(AREA, 'approving an already-completed task is refused', res.status >= 400, `HTTP ${res.status}`)) {
        report({
          severity: 'P0', area: AREA, roles: ['Party', 'Captain'],
          title: 'A completed task can be approved again',
          reproduction: `POST ${P}/party/audit/${completed._id}/approve for a task already in COMPLETED.`,
          expected: 'Rejected — the transition is not legal from COMPLETED.',
          actual: `HTTP ${res.status}.`,
          impact: 'Commission is credited a second time for work paid for once.',
          evidence: `taskId=${completed._id}`,
        });
      }
    }
  }

  // ---------- A stale client acting on a task that has moved on ----------
  {
    const pooled = await Task.findOne({ status: { $in: ['CREATED', 'REASSIGNED'] } }).lean();
    if (pooled) {
      const res = await POST(session, `/party/audit/${pooled._id}/reject`)
        .send({ reason: 'Rejecting something not under audit', category: 'OTHER' });
      record(AREA, 'rejecting a task that is not awaiting audit is refused', res.status >= 400, `HTTP ${res.status}`);
    }
  }

  // ---------- Oversized JSON body ----------
  {
    const res = await post('/party/tasks', { ...baseTask, notes: 'x'.repeat(2_000_000) });
    const safe = res.status >= 400 && res.status < 500;
    if (!record(AREA, 'a 2MB request body is rejected cleanly', safe, `HTTP ${res.status}`)) {
      report({
        severity: 'P2', area: AREA, roles: ['Party'],
        title: `A 2MB JSON body returns ${res.status}`,
        reproduction: `POST ${P}/party/tasks with a 2,000,000-character field.`,
        expected: '413 or 400.',
        actual: `HTTP ${res.status}.`,
        impact: 'Unbounded request bodies are a denial-of-service vector.',
      });
    }
  }
}
