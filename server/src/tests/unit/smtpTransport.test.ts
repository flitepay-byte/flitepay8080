/**
 * THE SMTP TRANSPORT, RECONCILED — focused tests.
 *
 * The defect: SMTP_PORT and SMTP_SECURE were taken independently, and one of
 * their combinations does not fail helpfully. Port 465 with secure=false opens a
 * plain-text connection to a server speaking TLS, waits for a greeting that never
 * comes, and after many seconds reports "Connection closed" with no error code.
 * Inside a sign-in request that looked exactly like a network fault. Separately,
 * `SMTP_SECURE` was read as `v === 'true'`, so `TRUE` or ` true` silently meant
 * false and produced that same combination from a value that looked right.
 *
 * No network is used. What is asserted is the configuration handed to
 * nodemailer, and that nothing secret reaches the log.
 */
const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;
let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

async function load() {
  jest.resetModules();
  return import('../../services/mailer');
}

describe('the SMTP transport', () => {
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    // Set, never deleted: config/env.ts runs dotenv on every reload, and a
    // deleted key would be refilled from the real .env — live credentials and a
    // real send, from a test that meant "nothing configured".
    //
    // Each gets a value its schema accepts. An empty string is not "unset" to
    // zod: SMTP_PORT must be a positive number, so '' fails validation and the
    // env module calls process.exit before any test runs.
    process.env['SMTP_HOST'] = '';
    process.env['SMTP_USER'] = '';
    process.env['SMTP_PASS'] = '';
    process.env['SMTP_FROM'] = 'OTDMS <no-reply@otdms.test>';
    process.env['SMTP_PORT'] = '587';
    process.env['SMTP_SECURE'] = 'false';
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  /**
   * Load the mailer with nodemailer stubbed.
   *
   * The stub has to be installed after `jest.resetModules()`, on the nodemailer
   * module the reloaded mailer will import. A spy placed before the reset sits on
   * the previous module instance, the mailer never sees it, and the real library
   * tries to reach the test host — which made a failure test pass for the wrong
   * reason while every success test failed.
   */
  async function loadStubbed(send: jest.Mock = jest.fn().mockResolvedValue({
    messageId: 'm1', accepted: ['x'], rejected: [], response: '250 OK',
  })) {
    jest.resetModules();
    const nm = (await import('nodemailer')).default;
    const create = jest
      .spyOn(nm, 'createTransport')
      .mockReturnValue({ sendMail: send } as unknown as ReturnType<typeof nm.createTransport>);
    const mailer = await import('../../services/mailer');
    return { mailer, create, send };
  }

  const optsOf = (create: jest.SpyInstance) => create.mock.calls[0]?.[0] as Record<string, unknown>;

  // ---------------------------------------------------------------------------
  describe('port and secure are reconciled', () => {
    it('forces implicit TLS on 465 when secure was configured false', async () => {
      const { effectiveSecure } = await load();
      expect(effectiveSecure(465, false)).toEqual({ secure: true, corrected: true });
    });

    it('forces STARTTLS on 587 when secure was configured true', async () => {
      const { effectiveSecure } = await load();
      expect(effectiveSecure(587, true)).toEqual({ secure: false, corrected: true });
    });

    it('leaves the two correct pairings alone', async () => {
      const { effectiveSecure } = await load();
      expect(effectiveSecure(465, true)).toEqual({ secure: true, corrected: false });
      expect(effectiveSecure(587, false)).toEqual({ secure: false, corrected: false });
    });

    it('takes any other port exactly as configured', async () => {
      const { effectiveSecure } = await load();
      expect(effectiveSecure(2525, false)).toEqual({ secure: false, corrected: false });
      expect(effectiveSecure(2525, true)).toEqual({ secure: true, corrected: false });
    });

    it('builds the real transport with the reconciled value', async () => {
      process.env['SMTP_HOST'] = 'smtp.example.test';
      process.env['SMTP_PORT'] = '465';
      process.env['SMTP_SECURE'] = 'false';
      const { mailer, create } = await loadStubbed();
      await mailer.sendMail('a@b.test', 'S', 'B');

      expect(optsOf(create)).toMatchObject({ host: 'smtp.example.test', port: 465, secure: true });
    });
  });

  // ---------------------------------------------------------------------------
  describe('SMTP_SECURE is read leniently', () => {
    it.each(['true', 'TRUE', 'True', ' true ', '1', 'yes'])('treats %p as true', async (raw) => {
      process.env['SMTP_SECURE'] = raw;
      jest.resetModules();
      const { env } = await import('../../config/env');
      expect(env.SMTP_SECURE).toBe(true);
    });

    it.each(['false', 'FALSE', '0', ''])('treats %p as false', async (raw) => {
      process.env['SMTP_SECURE'] = raw;
      jest.resetModules();
      const { env } = await import('../../config/env');
      expect(env.SMTP_SECURE).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('a bad connection fails in seconds', () => {
    it('passes explicit connection, greeting and socket timeouts', async () => {
      process.env['SMTP_HOST'] = 'smtp.example.test';
      process.env['SMTP_PORT'] = '587';
      const { mailer, create } = await loadStubbed();
      const { SMTP_TIMEOUTS } = mailer;
      await mailer.sendMail('a@b.test', 'S', 'B');

      const opts = optsOf(create);
      expect(opts['connectionTimeout']).toBe(SMTP_TIMEOUTS.connectionTimeout);
      expect(opts['greetingTimeout']).toBe(SMTP_TIMEOUTS.greetingTimeout);
      expect(opts['socketTimeout']).toBe(SMTP_TIMEOUTS.socketTimeout);
      // Far below nodemailer's own defaults of two minutes and ten minutes.
      expect(SMTP_TIMEOUTS.connectionTimeout).toBeLessThanOrEqual(30_000);
    });
  });

  // ---------------------------------------------------------------------------
  describe('success and failure behave as before', () => {
    it('resolves when the server accepts the message', async () => {
      process.env['SMTP_HOST'] = 'smtp.example.test';
      const { mailer, send } = await loadStubbed();
      await expect(mailer.sendMail('a@b.test', 'S', 'B')).resolves.toMatchObject({ to: 'a@b.test' });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('still raises 502 EMAIL_SEND_FAILED when the server refuses', async () => {
      process.env['SMTP_HOST'] = 'smtp.example.test';
      const refusing = jest.fn().mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
      const { mailer, send } = await loadStubbed(refusing);

      await expect(mailer.sendMail('a@b.test', 'S', 'B')).rejects.toMatchObject({
        statusCode: 502,
        errorCode: 'EMAIL_SEND_FAILED',
      });
      // The stub, not a real connection, is what refused.
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('still uses the mock transport when SMTP_HOST is not set', async () => {
      const { mailer, create } = await loadStubbed();
      const { sendMail, getOutbox, clearOutbox } = mailer;
      clearOutbox();
      await sendMail('a@b.test', 'Subject', 'Body');
      expect(create).not.toHaveBeenCalled();
      expect(getOutbox(1)[0]?.subject).toBe('Subject');
    });
  });

  // ---------------------------------------------------------------------------
  describe('the diagnostics', () => {
    it('never write the password, the one-time code or the body', async () => {
      process.env['SMTP_HOST'] = 'smtp.example.test';
      process.env['SMTP_PORT'] = '465';
      process.env['SMTP_SECURE'] = 'false';
      process.env['SMTP_USER'] = 'sender@example.test';
      process.env['SMTP_PASS'] = 'super-secret-app-password';

      // Both stubs installed after the reset, on the instances the mailer will use.
      jest.resetModules();
      const nm = (await import('nodemailer')).default;
      jest.spyOn(nm, 'createTransport').mockReturnValue({
        sendMail: jest.fn().mockResolvedValue({ messageId: 'm1', accepted: ['a@b.test'], rejected: [], response: '250 OK' }),
      } as unknown as ReturnType<typeof nm.createTransport>);
      const { logger } = await import('../../config/logger');
      const lines: string[] = [];
      for (const level of ['info', 'warn', 'error'] as const) {
        jest.spyOn(logger, level).mockImplementation(((obj: unknown, msg?: string) => {
          lines.push(JSON.stringify(obj) + ' ' + (msg ?? ''));
        }) as never);
      }

      const { sendMail } = await import('../../services/mailer');
      await sendMail('a@b.test', 'Your OTDMS verification code', 'Your one-time code is 482913.');

      const all = lines.join('\n');
      expect(all).toContain('[MAILER DIAG]');
      expect(all).not.toContain('super-secret-app-password');
      expect(all).not.toContain('482913');
      expect(all).toContain('"smtpPassPresent":true');
    });
  });
});
