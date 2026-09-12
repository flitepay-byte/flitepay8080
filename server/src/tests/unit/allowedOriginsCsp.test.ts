/**
 * CLIENT_ORIGIN IS A LIST, AND BOTH READERS MUST TREAT IT AS ONE
 *
 * `corsPolicy()` has always split this variable on commas, so configuring two
 * allowed origins is a supported thing to do. `securityHeaders()` passed the
 * same raw string into the CSP `connect-src` directive, where a comma is not a
 * separator but an invalid character: helmet validates directive values while
 * it builds the middleware and throws.
 *
 * The failure that caused is worth naming precisely, because it is the opposite
 * of what the symptom suggests. Nothing was "blocked by CSP" — the throw
 * happened while the application was being constructed, the process exited, and
 * every request returned a 502 from the proxy in front of it. Adding a second
 * origin did not restrict the app; it stopped the app from starting.
 *
 * So the assertions below are on `securityHeaders()` being constructible, which
 * is where the throw actually was, and on the header it then serves.
 */
import express from 'express';
import request from 'supertest';
import { securityHeaders, corsPolicy } from '../../middleware/security.middleware';
import { env } from '../../config/env';

describe('CLIENT_ORIGIN with more than one entry', () => {
  const original = env.CLIENT_ORIGIN;
  afterEach(() => {
    (env as { CLIENT_ORIGIN: string }).CLIENT_ORIGIN = original;
  });

  const withOrigin = (value: string): void => {
    (env as { CLIENT_ORIGIN: string }).CLIENT_ORIGIN = value;
  };

  it('builds the security headers when a single origin is configured', () => {
    withOrigin('http://localhost:5173');
    expect(() => securityHeaders()).not.toThrow();
  });

  it('builds them when two origins are configured', () => {
    // The exact shape a public deployment needs: the tunnel and localhost.
    withOrigin('https://example.trycloudflare.com,http://localhost:5173');
    expect(() => securityHeaders()).not.toThrow();
  });

  it('builds them when the list carries spaces around the commas', () => {
    withOrigin('https://a.example.com , https://b.example.com ,http://localhost:5173');
    expect(() => securityHeaders()).not.toThrow();
  });

  it('builds them when the list has a trailing comma', () => {
    // An empty entry must be dropped rather than reaching the directive, where
    // it would be an invalid value in its own right.
    withOrigin('https://a.example.com,');
    expect(() => securityHeaders()).not.toThrow();
  });

  it('builds the CORS policy from the same list', () => {
    withOrigin('https://a.example.com,https://b.example.com');
    expect(() => corsPolicy()).not.toThrow();
  });

  it('serves a connect-src naming every configured origin separately', async () => {
    withOrigin('https://a.example.com,https://b.example.com');

    const app = express();
    app.use(securityHeaders());
    app.get('/probe', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/probe').expect(200);
    const csp = res.headers['content-security-policy'] ?? '';
    const connectSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src'));

    expect(connectSrc).toContain('https://a.example.com');
    expect(connectSrc).toContain('https://b.example.com');
    // Both present as separate sources, so neither is half of a comma-joined
    // token — which is the exact shape helmet rejected.
    expect(connectSrc).not.toContain(',');
  });

  it('allows a request from either configured origin', async () => {
    withOrigin('https://a.example.com,https://b.example.com');

    const app = express();
    app.use(corsPolicy());
    app.get('/probe', (_req, res) => {
      res.json({ ok: true });
    });

    for (const origin of ['https://a.example.com', 'https://b.example.com']) {
      const res = await request(app).get('/probe').set('Origin', origin);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });
});
