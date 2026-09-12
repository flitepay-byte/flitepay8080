import { env } from './env';

/**
 * Hand-written OpenAPI document. Preferred over annotation scanning because
 * the spec stays valid even when a handler is refactored, and it can be diffed
 * in review.
 */
export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'OTDMS API',
    version: '1.0.0',
    description:
      'Operational Task & Disbursement Management System — an EDUCATIONAL SIMULATION. ' +
      'No endpoint moves real money. The payout step is served by MockPayoutProvider, ' +
      'which fabricates references and outcomes and performs no network I/O. ' +
      'All amounts in requests and responses are in RUPEES; they are stored internally as integer paise.',
  },
  servers: [{ url: env.API_PREFIX, description: 'API root' }],
  tags: [
    { name: 'Auth', description: 'Two-step authentication (password, then OTP)' },
    { name: 'Party', description: 'Task creation and bulk import' },
    { name: 'Captain', description: 'Queue, claim, simulated payout, proof' },
    { name: 'Admin', description: 'Audit desk, settings, users, reconciliation' },
    { name: 'Public', description: 'Unauthenticated customer tracking' },
    {
      name: 'Party API',
      description:
        'What a party integrates into their own site. Signed with an API key rather than a session — ' +
        'the caller is a server, so there is no browser and nobody to log in. See the securityScheme ' +
        'notes for exactly what to sign.',
    },
  ],
  components: {
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'otdms_at' },
      /**
       * Three headers, not one. The secret never travels — only a proof that
       * the holder of it produced this exact request.
       */
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-otdms-key',
        description:
          'Send three headers on every call:\n\n' +
          '- `x-otdms-key` — your key id\n' +
          '- `x-otdms-timestamp` — seconds since the epoch\n' +
          '- `x-otdms-signature` — HMAC-SHA256, hex, of the payload below\n\n' +
          'The signed payload is four lines joined with a newline:\n\n' +
          '```\n<timestamp>\n<METHOD>\n<full path, e.g. /api/v1/api/payin>\n<the exact body bytes, or "" for a GET>\n```\n\n' +
          'Sign the exact bytes you send. Re-serialising the object first is the commonest way this ' +
          'goes wrong: key order and spacing are free to differ, and the signature is then over ' +
          'something you did not send. Requests more than five minutes old are refused.\n\n' +
          'Callbacks we send you are signed the same way, with the same secret, over your own ' +
          'callback path. Verify them — an unverified callback endpoint is a public ' +
          '"mark my order paid" button.',
      },
    },
    schemas: {
      Transaction: {
        type: 'object',
        description: 'A payment, as the party who asked for it sees it. The captain is never named.',
        properties: {
          id: { type: 'string', example: 'PIN-2026-000001', description: 'Our code for it.' },
          reference: { type: 'string', example: 'ORDER-1183', description: 'The reference you sent.' },
          direction: { type: 'string', enum: ['PAY_IN', 'PAY_OUT'] },
          status: {
            type: 'string',
            enum: ['CREATED', 'ASSIGNED', 'AWAITING_CUSTOMER', 'CONFIRMED', 'SETTLED', 'EXPIRED', 'CANCELLED', 'DISPUTED'],
          },
          amount: { type: 'number', example: 1890, description: 'Rupees. Nothing is deducted from this.' },
          settlementReference: { type: 'string', nullable: true, description: 'The UTR or gateway reference, once it exists.' },
          qr: {
            type: 'object',
            nullable: true,
            description: 'Pay-ins only. Show `payload` to your customer.',
            properties: {
              payload: { type: 'string', example: 'upi://pay?pa=...' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
          failureReason: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          settledAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      ApiFailure: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string' },
          errorCode: { type: 'string', example: 'TASK_ALREADY_CLAIMED' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      Task: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          taskCode: { type: 'string', example: 'TASK-2026-000125' },
          customerName: { type: 'string' },
          identifier: { type: 'string', example: 'DEMO-UPI-001', description: 'Fictional label, not a payment address' },
          amount: { type: 'number', example: 10000, description: 'DMC (fictional Demo Currency)' },
          externalRef: { type: 'string' },
          status: {
            type: 'string',
            enum: [
              'CREATED', 'ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING',
              'COMPLETED', 'REJECTED', 'REASSIGNED', 'EXPIRED', 'CANCELLED',
            ],
          },
          providerReference: { type: 'string', nullable: true, example: 'SIM472910335821' },
          commission: { type: 'number', nullable: true },
        },
      },
      CustomerTracking: {
        type: 'object',
        description: 'Strict allow-list. Never includes captain, commission, or internal identifiers.',
        properties: {
          reference: { type: 'string' },
          amount: { type: 'number' },
          status: { type: 'string' },
          statusLabel: { type: 'string' },
          timeline: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                complete: { type: 'boolean' },
                at: { type: 'string', nullable: true, format: 'date-time' },
              },
            },
          },
          lastUpdated: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: { tags: ['Public'], summary: 'Liveness probe', responses: { '200': { description: 'OK' } } },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Step 1 — verify password and issue an OTP challenge',
        description: 'Never returns a session. On success it returns a challengeId for step 2.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', example: 'admin@otdms.demo' },
                  password: { type: 'string', example: 'Demo@12345' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'OTP challenge issued' },
          '401': { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiFailure' } } } },
          '423': { description: 'Account locked' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/auth/verify-otp': {
      post: {
        tags: ['Auth'],
        summary: 'Step 2 — verify the OTP and issue the session cookies',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['challengeId', 'otp'],
                properties: { challengeId: { type: 'string' }, otp: { type: 'string', example: '123456' } },
              },
            },
          },
        },
        responses: { '200': { description: 'Signed in; auth cookies set' }, '400': { description: 'Invalid or expired code' } },
      },
    },
    '/auth/resend-otp': { post: { tags: ['Auth'], summary: 'Resend the code, subject to cooldown', responses: { '200': { description: 'Sent' }, '429': { description: 'Cooldown active' } } } },
    '/auth/refresh': { post: { tags: ['Auth'], summary: 'Rotate the access token', responses: { '200': { description: 'Refreshed' } } } },
    '/auth/logout': { post: { tags: ['Auth'], summary: 'Revoke the session', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Signed out' } } } },
    '/auth/me': { get: { tags: ['Auth'], summary: 'Current principal', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Profile' }, '401': { description: 'Not signed in' } } } },

    '/party/tasks': {
      post: {
        tags: ['Party'],
        summary: 'Create a task',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customerName', 'identifier', 'amount'],
                properties: {
                  customerName: { type: 'string', example: 'Demo Customer 01' },
                  identifier: { type: 'string', example: 'DEMO-UPI-001' },
                  amount: { type: 'number', example: 10000, description: 'DMC (fictional Demo Currency)' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } } },
          '422': { description: 'Limit or amount-bound violation' },
        },
      },
      get: { tags: ['Party'], summary: 'List own tasks', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Paginated tasks' } } },
    },
    '/party/dashboard': { get: { tags: ['Party'], summary: 'Party metrics', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Metrics' } } } },
    '/party/imports/preview': {
      post: {
        tags: ['Party'],
        summary: 'Validate a CSV without creating anything',
        security: [{ cookieAuth: [] }],
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
        responses: { '200': { description: 'Validation summary with valid/invalid/duplicate counts' } },
      },
    },
    '/party/imports/confirm': { post: { tags: ['Party'], summary: 'Create tasks from a staged batch', security: [{ cookieAuth: [] }], responses: { '201': { description: 'Imported' } } } },

    '/captain/queue': { get: { tags: ['Captain'], summary: 'Claimable tasks within the available limit', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Queue' } } } },
    '/captain/tasks/{taskId}/claim': {
      post: {
        tags: ['Captain'],
        summary: 'Claim a task and lock collateral',
        description: 'Concurrency-safe. Exactly one of N simultaneous claims succeeds; the rest receive 409 TASK_ALREADY_CLAIMED.',
        security: [{ cookieAuth: [] }],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Claimed; collateral locked' },
          '409': { description: 'Already claimed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiFailure' } } } },
          '422': { description: 'Insufficient available limit' },
        },
      },
    },
    '/captain/tasks/{taskId}/start': { post: { tags: ['Captain'], summary: 'ASSIGNED to IN_PROGRESS', security: [{ cookieAuth: [] }], parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Started' } } } },
    '/api/payin': {
      post: {
        tags: ['Party API'],
        summary: 'Take a payment from your customer',
        description:
          'Returns a QR for your customer to scan. A captain is found and the QR issued before this ' +
          'responds, because your checkout has nothing to show them until both exist — so a 422 here ' +
          'means no captain could take it, and is worth retrying shortly.\n\n' +
          'Sending the same `reference` twice returns the first payment with a 200 rather than making ' +
          'a second one. That is what makes retrying a timed-out call safe.\n\n' +
          'Your customer pays exactly `amount` and you are credited exactly `amount`. The captain\'s ' +
          'fee is paid by the platform, never taken off the top.',
        security: [{ apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reference', 'amount'],
                properties: {
                  reference: { type: 'string', maxLength: 120, example: 'ORDER-1183', description: 'Your own id for this payment. Unique per party.' },
                  amount: { type: 'number', example: 1890, description: 'Rupees.' },
                  callbackUrl: { type: 'string', format: 'uri', description: 'Overrides the key\'s default.' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created — show the QR', content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } } },
          200: { description: 'This reference was already accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } } },
          401: { description: 'Missing, stale or wrong signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiFailure' } } } },
          422: { description: 'No captain available — retry shortly', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiFailure' } } } },
        },
      },
    },
    '/api/payout': {
      post: {
        tags: ['Party API'],
        summary: 'Send money to your customer',
        description:
          'Your DMC is held the moment this is accepted, so money promised to somebody else is not also ' +
          'spendable. The beneficiary comes from you in this call — we hold no account of who your ' +
          'customers are.\n\n' +
          'Unlike a pay-in there is nothing for your customer to do, so a captain not being free this ' +
          'second is not a failure: the payout waits and is placed automatically. You are told the ' +
          'outcome by callback either way.',
        security: [{ apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reference', 'amount', 'beneficiary'],
                properties: {
                  reference: { type: 'string', maxLength: 120, example: 'REFUND-1183' },
                  amount: { type: 'number', example: 1890 },
                  callbackUrl: { type: 'string', format: 'uri' },
                  beneficiary: {
                    type: 'object',
                    description: 'Either a UPI ID, or an account number with its IFSC.',
                    properties: {
                      name: { type: 'string' },
                      upiId: { type: 'string', example: 'customer@bank' },
                      accountNumber: { type: 'string' },
                      ifsc: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } } },
          200: { description: 'This reference was already accepted' },
          400: { description: 'No destination, or your balance does not cover it', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiFailure' } } } },
          401: { description: 'Missing, stale or wrong signature' },
        },
      },
    },
    '/api/transactions': {
      get: {
        tags: ['Party API'],
        summary: 'List your payments',
        description:
          'Cursored on creation time rather than page numbers, because rows are being added while you ' +
          'page and an offset would skip or repeat whatever crossed the boundary. Pass the ' +
          '`nextCursor` you get back as `before`.',
        security: [{ apiKeyAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['PAY_IN', 'PAY_OUT'] } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'The previous page\'s nextCursor.' },
        ],
        responses: {
          200: {
            description: 'A page of payments',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } },
                    hasMore: { type: 'boolean' },
                    nextCursor: { type: 'string', format: 'date-time', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/transactions/{reference}': {
      get: {
        tags: ['Party API'],
        summary: 'Get one payment by your own reference',
        security: [{ apiKeyAuth: [] }],
        parameters: [{ name: 'reference', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The payment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } } },
          404: { description: 'No transaction of yours with that reference' },
        },
      },
    },
    '/api/transactions/{reference}/dispute': {
      post: {
        tags: ['Party API'],
        summary: 'Say the money never arrived',
        description:
          'Stops the payment and puts it in front of a human. Nothing moves and nothing is released: ' +
          'the hold stays exactly where it is until the platform decides, because an argument about ' +
          'money is the worst possible moment to let either side spend it.',
        security: [{ apiKeyAuth: [] }],
        parameters: [{ name: 'reference', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 4, maxLength: 500 } } },
            },
          },
        },
        responses: {
          200: { description: 'Raised', content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } } },
          409: { description: 'Already settled or otherwise finished' },
        },
      },
    },
    '/api/transactions/{reference}/replay-callback': {
      post: {
        tags: ['Party API'],
        summary: 'Ask for the callback again',
        description: 'For when your endpoint was down. Polling every transaction is worse for both of us.',
        security: [{ apiKeyAuth: [] }],
        parameters: [{ name: 'reference', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Whether it was delivered this time' } },
      },
    },
    '/api/balance': {
      get: {
        tags: ['Party API'],
        summary: 'What you can spend on payouts',
        description:
          'Held money is reported separately rather than netted off, so "why is my balance lower than ' +
          'I expect" has an answer without opening the dashboard.',
        security: [{ apiKeyAuth: [] }],
        responses: {
          200: {
            description: 'Your balance',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    available: { type: 'number', example: 94550 },
                    heldForPayouts: { type: 'number', example: 5000 },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/captain/tasks/{taskId}/payout': {
      post: {
        tags: ['Captain'],
        summary: 'Execute the SIMULATED payout',
        description:
          'Calls MockPayoutProvider. No money moves and no payment rail is contacted. ' +
          'Returns a fictional SIM-prefixed reference and one of SUCCESS, FAILED, or PENDING.',
        security: [{ cookieAuth: [] }],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Simulated result' }, '409': { description: 'Wrong state or already executed' } },
      },
    },
    '/captain/tasks/{taskId}/proof': {
      post: {
        tags: ['Captain'],
        summary: 'Submit proof; moves the task to AUDIT_PENDING',
        security: [{ cookieAuth: [] }],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['providerReference'],
                properties: {
                  providerReference: { type: 'string', example: 'SIM472910335821' },
                  notes: { type: 'string' },
                  receipt: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Queued for audit' }, '400': { description: 'Reference mismatch or bad file' } },
      },
    },
    '/captain/earnings': { get: { tags: ['Captain'], summary: 'Commission ledger for this captain', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Earnings' } } } },
    '/captain/profile': { get: { tags: ['Captain'], summary: 'Collateral, limits and usage', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Profile' } } } },

    '/admin/dashboard': { get: { tags: ['Admin'], summary: 'System metrics', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Metrics' } } } },
    '/admin/audit-queue': { get: { tags: ['Admin'], summary: 'Tasks awaiting audit, oldest first', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Queue' } } } },
    '/admin/audit/{taskId}': { get: { tags: ['Admin'], summary: 'Dual-pane audit view', security: [{ cookieAuth: [] }], parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Task beside proof' } } } },
    '/admin/audit/{taskId}/approve': { post: { tags: ['Admin'], summary: 'Approve, release collateral and credit commission', security: [{ cookieAuth: [] }], parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Approved' }, '409': { description: 'Not awaiting audit' } } } },
    '/admin/audit/{taskId}/reject': {
      post: {
        tags: ['Admin'],
        summary: 'Reject with a reason and return the task to the pool',
        security: [{ cookieAuth: [] }],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 5 } } } } } },
        responses: { '200': { description: 'Rejected and reassigned' } },
      },
    },
    '/admin/settings': {
      get: { tags: ['Admin'], summary: 'Read configuration', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Settings' } } },
      patch: { tags: ['Admin'], summary: 'Update configuration; bumps the version', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Updated with a from/to diff' } } },
    },
    '/admin/captains/{captainId}/collateral': { post: { tags: ['Admin'], summary: 'Adjust simulated collateral', security: [{ cookieAuth: [] }], parameters: [{ name: 'captainId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Adjusted' }, '422': { description: 'Would go below the locked amount' } } } },
    '/admin/audit-logs': { get: { tags: ['Admin'], summary: 'Filterable append-only audit trail', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Logs' } } } },
    '/admin/commissions': { get: { tags: ['Admin'], summary: 'Immutable commission ledger', security: [{ cookieAuth: [] }], responses: { '200': { description: 'Ledger' } } } },
    '/admin/reconciliation': {
      post: { tags: ['Admin'], summary: 'Reconcile a mock statement against completed tasks', security: [{ cookieAuth: [] }], requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } }, responses: { '201': { description: 'MATCHED / DISCREPANCY / UNMATCHED breakdown' } } },
      get: { tags: ['Admin'], summary: 'Previous runs', security: [{ cookieAuth: [] }], responses: { '200': { description: 'History' } } },
    },

    '/public/track/{referenceId}': {
      get: {
        tags: ['Public'],
        summary: 'Customer tracking (unauthenticated, rate limited)',
        parameters: [{ name: 'referenceId', in: 'path', required: true, schema: { type: 'string' }, example: 'DEMO-REF-013' }],
        responses: {
          '200': { description: 'Allow-listed status view', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomerTracking' } } } },
          '404': { description: 'No record for this reference' },
          '429': { description: 'Rate limited' },
        },
      },
    },
  },
} as const;
