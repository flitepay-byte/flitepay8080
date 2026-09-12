/**
 * ADMIN CONTROLLERS
 * -----------------
 * One file per responsibility, re-exported here under the names the routes
 * already use. `admin.routes.ts` imports this module as a namespace, so the
 * split is invisible to it and to every URL it serves.
 *
 * Nothing here decides anything: each handler was moved verbatim from the
 * single file this replaces.
 */
export * from './admin/dashboard.controller';
export * from './admin/settings.controller';
export * from './admin/captains.controller';
export * from './admin/parties.controller';
export * from './admin/users.controller';
export * from './admin/commissions.controller';
export * from './admin/wallet.controller';
export * from './admin/funds.controller';
export * from './admin/reconciliation.controller';
export * from './admin/transactions.controller';
