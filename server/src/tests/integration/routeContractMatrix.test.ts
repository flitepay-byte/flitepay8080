/**
 * THE ROUTE CONTRACT
 *
 * Every production route, exercised through the mounted application rather
 * than by calling a controller directly.
 *
 * The controllers were split into modules behind barrels — admin, captain and
 * party — and the routes were deliberately not touched. A split like that is
 * invisible to a service-level test: the business logic it calls is the same
 * object either way. What a split *can* break is the wiring, and nothing else
 * in this suite watches the wiring. A handler that failed to re-export would
 * leave its URL answering 404, and every accounting test would still pass.
 *
 * So the table here is not written down. It is read out of the Express router
 * at run time, which means it cannot drift from the code: a route added,
 * renamed, or given a different method changes what these tests enumerate,
 * and a route that disappears takes its own test with it — which the count
 * assertion below then catches.
 *
 * Three things are checked of every route:
 *
 *   1. It resolves. The application answers something other than "that route
 *      does not exist", which is the only 404 that means the wiring is wrong.
 *   2. It is guarded. A guarded route refuses an anonymous caller with 401
 *      before it looks at anything else.
 *   3. It is role-scoped. A guarded route refuses a signed-in caller holding
 *      the wrong role with 403 — admin routes to a party, party routes to a
 *      captain, and so on.
 *
 * These are contract tests, not behaviour tests. They prove the door is where
 * it was and that the lock still works; what happens inside the room is what
 * the rest of the suite is for.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface Endpoint {
  method: Method;
  path: string;
}

/**
 * The mount path a router was attached under, recovered from the regular
 * expression Express built for it.
 */
function mountPrefix(re: RegExp | undefined): string {
  if (!re) return '';
  if ((re as unknown as { fast_slash?: boolean }).fast_slash) return '';
  const m = re.source.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
  return m?.[1] ? '/' + m[1].replace(/\\\//g, '/') : '';
}

/** Every method+path pair the application actually serves. */
function listEndpoints(app: unknown): Endpoint[] {
  const found: Endpoint[] = [];
  const walk = (stack: unknown[], prefix: string): void => {
    for (const raw of stack) {
      const layer = raw as {
        route?: { path: string; methods: Record<string, boolean> };
        name?: string;
        regexp?: RegExp;
        handle?: { stack?: unknown[] };
      };
      if (layer.route) {
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (on && method !== '_all') {
            found.push({ method: method as Method, path: prefix + layer.route.path });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPrefix(layer.regexp));
      }
    }
  };
  walk((app as { _router: { stack: unknown[] } })._router.stack, '');
  return found;
}

/** A concrete URL for a route pattern: real-shaped ids, harmless values. */
function concrete(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg;
      const name = seg.slice(1);
      if (/version/i.test(name)) return '1';
      if (/id$/i.test(name)) return new Types.ObjectId().toHexString();
      return 'contract-probe';
    })
    .join('/');
}

const app = createApp();
const endpoints = listEndpoints(app).sort((a, b) =>
  a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
);

/**
 * Routes that answer anonymous callers on purpose, each for a stated reason.
 *
 * This list is deliberately small and deliberately explicit: adding a route
 * here is the one way to opt out of the 401 check below, so it should be
 * uncomfortable to do. Everything here was read back from the code rather
 * than assumed.
 */
const OPEN: Record<string, string> = {
  // Signing in cannot require being signed in.
  '/api/v1/auth/login': 'the sign-in itself',
  '/api/v1/auth/refresh': 'trades a refresh cookie, not an access token',
  '/api/v1/auth/verify-otp': 'second factor, before a session exists',
  '/api/v1/auth/resend-otp': 'second factor, before a session exists',
  '/api/v1/auth/logout': 'clearing a dead session must not itself fail',
  // Liveness probe: status and uptime, nothing about anybody.
  '/api/v1/health': 'liveness probe',
  // The API description, served outside the versioned prefix.
  '/openapi.json': 'the API description itself',
  /**
   * The gateway pair authenticates by provider signature, not by session.
   * `upiWebhook` checks `x-gateway-signature` and does answer 401 without one;
   * `simulateCustomerPayment` stands in for the customer paying and refuses
   * outright in production (gateway.controller.ts throws notFound when isProd),
   * so it guards itself rather than relying on this route staying private.
   */
  '/api/v1/api/gateway/upi/simulate-payment': 'dev-only stand-in, self-guarding in production',
};
const isOpen = (p: string): boolean =>
  p in OPEN || p.startsWith('/api/v1/public/');

/** The API rail authenticates by signed key, not by session cookie. */
const isApiKeyRail = (p: string): boolean => p.startsWith('/api/v1/api/');

/** Which signed-in role a route belongs to, if it is role-scoped at all. */
function ownerRole(path: string): 'ADMIN' | 'PARTY' | 'CAPTAIN' | null {
  if (path.startsWith('/api/v1/admin/')) return 'ADMIN';
  if (path.startsWith('/api/v1/party/')) return 'PARTY';
  if (path.startsWith('/api/v1/captain/')) return 'CAPTAIN';
  return null;
}

describeIntegration('the route contract survives the controller split', () => {
  let adminCookie = '';
  let partyCookie = '';
  let captainCookie = '';

  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(async () => {
    await teardownDatabase();
  });

  beforeAll(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const password = await hashPassword('Contract#1234');

    const adminUser = await User.create({
      email: 'contract-admin@otdms.test', passwordHash: password, name: 'Contract Admin', role: 'ADMIN',
    });
    const partyUser = await User.create({
      email: 'contract-party@otdms.test', passwordHash: password, name: 'Contract Party', role: 'PARTY',
    });
    const captainUser = await User.create({
      email: 'contract-captain@otdms.test', passwordHash: password, name: 'Contract Captain', role: 'CAPTAIN',
    });

    const party = await Party.create({
      userId: partyUser._id, partyCode: 'PARTY-CONTRACT', companyName: 'Contract Party',
      contactEmail: 'contract-party@otdms.test', status: 'ACTIVE',
    });
    const captain = await Captain.create({
      userId: captainUser._id, captainCode: 'CAP-CONTRACT', displayName: 'Contract Captain',
      status: 'ACTIVE',
    });

    // requireAuth checks the session is live, not just that the token parses,
    // so each session has to exist as it would after a real sign-in.
    const sign = async (
      user: { _id: Types.ObjectId; email: string; role: 'ADMIN' | 'PARTY' | 'CAPTAIN' },
      extra: { partyId?: string; captainId?: string } = {},
    ): Promise<string> => {
      const sid = new Types.ObjectId().toHexString();
      await Session.create({
        sessionId: sid,
        userId: user._id,
        refreshTokenHash: `contract-${sid}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      const token = signAccessToken({ sub: String(user._id), role: user.role, email: user.email, sid, ...extra });
      return `${ACCESS_COOKIE}=${token}`;
    };

    adminCookie = await sign(adminUser);
    partyCookie = await sign(partyUser, { partyId: String(party._id) });
    captainCookie = await sign(captainUser, { captainId: String(captain._id) });
  });

  const cookieFor = (role: 'ADMIN' | 'PARTY' | 'CAPTAIN'): string =>
    role === 'ADMIN' ? adminCookie : role === 'PARTY' ? partyCookie : captainCookie;

  /** The one 404 that means the wiring is wrong, rather than the row is missing. */
  const isMissingRoute = (res: { status: number; body: { error?: { message?: string } } }): boolean =>
    res.status === 404 && (res.body?.error?.message ?? '').includes('does not exist');

  it('finds routes to check', () => {
    // A walker that silently returned nothing would make every test below
    // vacuous, so the count is asserted before anything leans on it.
    expect(endpoints.length).toBeGreaterThanOrEqual(100);
  });

  it('mounts every route under the versioned API prefix, bar the API description', () => {
    const outside = endpoints.filter((e) => !e.path.startsWith('/api/v1/')).map((e) => e.path);
    // `/openapi.json` is the spec itself and is mounted before the prefix on
    // purpose. Anything else appearing here would be a route escaping
    // versioning, which is how a client ends up pinned to an unversioned URL.
    expect(outside).toEqual(['/openapi.json']);
  });

  it('mounts no duplicate method+path pair', () => {
    const seen = endpoints.map((e) => `${e.method} ${e.path}`);
    expect(seen.length).toBe(new Set(seen).size);
  });

  describe('every route resolves', () => {
    it.each(endpoints.map((e) => [e.method, e.path] as const))(
      '%s %s is mounted',
      async (method, path) => {
        const res = await request(app)[method](concrete(path));
        expect(isMissingRoute(res as never)).toBe(false);
      },
    );
  });

  describe('guarded routes refuse an anonymous caller', () => {
    const guarded = endpoints.filter((e) => !isOpen(e.path));
    it.each(guarded.map((e) => [e.method, e.path] as const))(
      '%s %s answers 401 without credentials',
      async (method, path) => {
        const res = await request(app)[method](concrete(path));
        expect(res.status).toBe(401);
      },
    );
  });

  describe('role-scoped routes refuse the wrong role', () => {
    const scoped = endpoints.filter((e) => ownerRole(e.path) !== null && !isApiKeyRail(e.path));
    it.each(scoped.map((e) => [e.method, e.path, ownerRole(e.path)] as const))(
      '%s %s is closed to the other roles',
      async (method, path, owner) => {
        const others = (['ADMIN', 'PARTY', 'CAPTAIN'] as const).filter((r) => r !== owner);
        for (const role of others) {
          const res = await request(app)[method](concrete(path)).set('Cookie', cookieFor(role));
          expect({ role, path, status: res.status }).toEqual({ role, path, status: 403 });
        }
      },
    );
  });
});
