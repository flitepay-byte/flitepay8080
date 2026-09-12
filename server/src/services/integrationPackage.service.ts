/**
 * THE HANDOVER DOCUMENT
 * ---------------------
 * Everything a party's developer needs to call this API, in one place an
 * administrator can send them.
 *
 * It exists because the administrator doing the onboarding is not a developer.
 * Asking them to explain HMAC signing, or to remember which headers matter, is
 * asking them to relay something they cannot check — so the explanation is
 * generated from the same constants the server actually enforces, and they only
 * have to forward it.
 *
 * **The secret is passed in, never looked up.** It exists in memory for one
 * request, at the moment a key is created, and is not stored anywhere this
 * function can reach. A package built later carries the key id and the
 * instructions but no credential, which is exactly the intended behaviour: a
 * lost secret is replaced, not recovered.
 */
import PDFDocument from 'pdfkit';
import { SIGNATURE_WINDOW_SECONDS } from './apiKey.service';
import {
  API_KEY_HEADER,
  API_TIMESTAMP_HEADER,
  API_SIGNATURE_HEADER,
} from '../middleware/apiAuth.middleware';
import { env } from '../config/env';

export interface IntegrationPackageInput {
  partyName: string;
  partyCode: string;
  keyId: string;
  /** Present only when the package is built as part of creating the key. */
  secret?: string | null;
  callbackUrl?: string | null;
  baseUrl: string;
}

export interface IntegrationPackage {
  party: { name: string; code: string };
  api: {
    baseUrl: string;
    docsUrl: string;
    openApiUrl: string;
  };
  credentials: {
    keyId: string;
    secret: string | null;
    /** Says plainly why the secret may be absent, so nobody reports it as a fault. */
    secretNote: string;
  };
  authentication: {
    headers: { name: string; value: string }[];
    signingPayload: string;
    algorithm: string;
    timestampWindowSeconds: number;
    example: string;
  };
  webhooks: {
    callbackUrl: string | null;
    verification: string;
    events: { event: string; meaning: string }[];
    retries: string;
  };
  notes: string[];
  generatedAt: string;
}

const EVENTS: { event: string; meaning: string }[] = [
  { event: 'transaction.settled', meaning: 'A pay-in completed. The customer paid.' },
  { event: 'transaction.expired', meaning: 'A pay-in ran out of time. No money moved.' },
  { event: 'transaction.cancelled', meaning: 'A pay-in was cancelled. No money moved.' },
  { event: 'transaction.completed', meaning: 'A pay-out reached the customer.' },
  {
    event: 'payout.confirmation_required',
    meaning:
      'Ask your customer whether they received the money, then answer with POST /payouts/{reference}/confirm.',
  },
];

const NOTES = [
  'Amounts are in rupees, not paise. Send 1890 for ₹1,890.00.',
  'Your own "reference" is the idempotency key. Sending the same reference twice returns the first result rather than creating a second payment, so a retry after a timeout is safe.',
  'A pay-in response carries a QR payload. Show it to your customer; it is what they scan.',
  'A pay-out needs a beneficiary: either a UPI ID, or an account number with its IFSC.',
  'We hold no record of who your customers are. Send the beneficiary on the call itself.',
  'Answer every webhook with HTTP 200. Anything else is treated as a failed delivery and retried.',
  'If you miss a webhook, call POST /transactions/{reference}/replay-callback to have it sent again.',
  'Keep the secret on your server. It is never sent over the network — it signs requests and stays on both ends.',
];

export function buildIntegrationPackage(input: IntegrationPackageInput): IntegrationPackage {
  const root = input.baseUrl.replace(/\/+$/, '');

  return {
    party: { name: input.partyName, code: input.partyCode },
    api: {
      baseUrl: `${root}${env.API_PREFIX}/api`,
      docsUrl: `${root}/docs`,
      openApiUrl: `${root}/openapi.json`,
    },
    credentials: {
      keyId: input.keyId,
      secret: input.secret ?? null,
      secretNote: input.secret
        ? 'Shown once, here. It cannot be displayed again — store it now.'
        : 'Not included. A secret is shown only when its key is created; if it was not saved, issue a new key.',
    },
    authentication: {
      headers: [
        { name: API_KEY_HEADER, value: 'your key id' },
        { name: API_TIMESTAMP_HEADER, value: 'current unix time, in seconds' },
        { name: API_SIGNATURE_HEADER, value: 'the signature, described below' },
      ],
      algorithm: 'HMAC-SHA256, hex encoded',
      signingPayload: 'timestamp + "\\n" + METHOD + "\\n" + path + "\\n" + rawBody',
      timestampWindowSeconds: SIGNATURE_WINDOW_SECONDS,
      example: [
        'timestamp = 1737100000',
        'method    = POST',
        'path      = ' + `${env.API_PREFIX}/api/payin`,
        'rawBody   = {"reference":"ORD-1","amount":1890}',
        '',
        'payload   = "1737100000\\nPOST\\n' + `${env.API_PREFIX}/api/payin` + '\\n{\\"reference\\":\\"ORD-1\\",\\"amount\\":1890}"',
        'signature = HMAC_SHA256(secret, payload) as hex',
      ].join('\n'),
    },
    webhooks: {
      callbackUrl: input.callbackUrl ?? null,
      verification:
        'Webhooks are signed the same way, with the same secret, over the path of your own callback URL. ' +
        'Rebuild the payload from the request you received and compare it with the signature header. ' +
        'Sign the raw body bytes, not a re-serialisation of the parsed JSON.',
      events: EVENTS,
      retries:
        'A delivery that does not answer 200 is retried up to five times. Retries are signed with the same key ' +
        'that made the original call, so a staging key and a live key never receive each other’s callbacks.',
    },
    notes: NOTES,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The same package as a PDF, for an administrator to attach to an email.
 *
 * Deliberately plain: headings, key-value lines and monospaced blocks for the
 * things that must be copied exactly. The one piece of visual emphasis is on the
 * secret, because that is the part which cannot be recovered if it is skimmed
 * past.
 */
export function renderIntegrationPdf(pkg: IntegrationPackage): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  const h1 = (text: string): void => {
    doc.moveDown(0.8).fillColor('#111111').font('Helvetica-Bold').fontSize(15).text(text);
    doc.moveDown(0.3);
  };
  const h2 = (text: string): void => {
    doc.moveDown(0.6).fillColor('#111111').font('Helvetica-Bold').fontSize(11).text(text);
    doc.moveDown(0.2);
  };
  const body = (text: string): void => {
    doc.fillColor('#333333').font('Helvetica').fontSize(9.5).text(text, { align: 'left' });
  };
  const mono = (text: string): void => {
    doc.fillColor('#111111').font('Courier').fontSize(9).text(text);
  };
  const kv = (label: string, value: string): void => {
    doc.fillColor('#666666').font('Helvetica').fontSize(8.5).text(label.toUpperCase());
    doc.fillColor('#111111').font('Courier').fontSize(10).text(value);
    doc.moveDown(0.4);
  };

  doc.fillColor('#111111').font('Helvetica-Bold').fontSize(20).text('API Integration Details');
  doc.moveDown(0.2);
  doc
    .fillColor('#666666')
    .font('Helvetica')
    .fontSize(10)
    .text(`${pkg.party.name} (${pkg.party.code})`);
  doc.fillColor('#999999').fontSize(8).text(`Generated ${new Date(pkg.generatedAt).toUTCString()}`);

  h1('1. Where to send requests');
  kv('Base URL', pkg.api.baseUrl);
  kv('Interactive documentation', pkg.api.docsUrl);
  kv('OpenAPI specification', pkg.api.openApiUrl);

  h1('2. Your credentials');
  kv('Key ID', pkg.credentials.keyId);
  if (pkg.credentials.secret) {
    doc.fillColor('#666666').font('Helvetica').fontSize(8.5).text('SECRET');
    doc.fillColor('#B00020').font('Courier-Bold').fontSize(10).text(pkg.credentials.secret);
    doc.moveDown(0.2);
    doc
      .fillColor('#B00020')
      .font('Helvetica-Bold')
      .fontSize(9)
      .text('This is the only time the secret appears. Store it on your server now — it cannot be shown again.');
  } else {
    body(pkg.credentials.secretNote);
  }

  h1('3. How to sign a request');
  body(`Every request carries three headers. The signature is ${pkg.authentication.algorithm}.`);
  doc.moveDown(0.3);
  for (const header of pkg.authentication.headers) {
    mono(`${header.name}: ${header.value}`);
  }
  h2('The signed payload');
  mono(pkg.authentication.signingPayload);
  doc.moveDown(0.3);
  body(
    `The timestamp is inside the signature and is checked against a ${pkg.authentication.timestampWindowSeconds}-second ` +
      'window, so a captured request cannot be replayed later. Sign the raw body bytes you actually send — ' +
      'a re-serialised object may order keys differently and will not match.',
  );
  h2('Worked example');
  mono(pkg.authentication.example);

  doc.addPage();

  h1('4. Webhooks');
  kv('Your callback URL', pkg.webhooks.callbackUrl ?? 'not set — tell us where to send these');
  body(pkg.webhooks.verification);
  h2('Events you will receive');
  for (const e of pkg.webhooks.events) {
    doc.fillColor('#111111').font('Courier-Bold').fontSize(9).text(e.event);
    doc.fillColor('#333333').font('Helvetica').fontSize(9).text(e.meaning, { indent: 12 });
    doc.moveDown(0.25);
  }
  h2('Retries');
  body(pkg.webhooks.retries);

  h1('5. Things worth knowing before you start');
  for (const note of pkg.notes) {
    doc.fillColor('#333333').font('Helvetica').fontSize(9.5).text(`•  ${note}`, { indent: 6 });
    doc.moveDown(0.25);
  }

  doc
    .moveDown(1.5)
    .fillColor('#999999')
    .font('Helvetica-Oblique')
    .fontSize(8)
    .text(
      'OTDMS is an educational simulation. DMC is a fictional demo currency and no real money moves through this system.',
    );

  return doc;
}
