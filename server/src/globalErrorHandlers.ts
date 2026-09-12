/**
 * Imported first in index.ts, before any other module (including ./app,
 * whose transitive imports construct Redis-backed rate limiters at module
 * load time). Those can reject before bootstrap() gets around to registering
 * its own handlers, which would otherwise crash the process on an unhandled
 * rejection during startup rather than merely logging it.
 */
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception:', err);
});
