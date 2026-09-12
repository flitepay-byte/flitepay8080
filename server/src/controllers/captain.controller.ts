/**
 * CAPTAIN CONTROLLERS
 * -------------------
 * One file per responsibility, re-exported here under the names the routes
 * already use. `captain.routes.ts` imports this module as a namespace, so
 * the split is invisible to it and to every URL it serves.
 *
 * Nothing here decides anything: each handler was moved verbatim from the
 * single file this replaces.
 */
export * from './captain/tasks.controller';
export * from './captain/profile.controller';
export * from './captain/wallet.controller';
export * from './captain/payments.controller';
