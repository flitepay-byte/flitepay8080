import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../config/db';
import { disconnectRedis } from '../config/redis';
import { invalidateConfigCache } from '../services/systemConfig.service';

/**
 * Integration tests require a real MongoDB. When MONGO_URI is absent the
 * suites skip rather than fail, so the unit suite still runs anywhere while
 * the full suite runs under Docker Compose.
 */
export const MONGO_AVAILABLE = Boolean(process.env['MONGO_URI']);

export const describeIntegration = MONGO_AVAILABLE ? describe : describe.skip;

/**
 * Integration tests wipe collections before every case and drop the database
 * at teardown. `MONGO_URI` in `.env` is the same connection string the dev
 * server uses, so running the suite unmodified against it would destroy
 * whatever real/demo data a developer has been working with. The database
 * name is force-suffixed with `_test` here so the suite always runs against
 * its own database, no matter what `.env` points at.
 */
function resolveTestMongoUri(raw: string, suffixSlug: string): string {
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/([^/?]*)(.*)$/);
  if (!match) return raw;
  const [, prefix, dbName, query] = match;
  const base = dbName?.endsWith('_test') ? dbName : `${dbName || 'otdms'}_test`;
  // The slug goes on the database name, never after the query string.
  return `${prefix}/${base}_${suffixSlug}${query}`;
}

/**
 * A slug unique to the running test file.
 *
 * Integration suites run in parallel workers and each wipes collections before
 * every case, so sharing one database means one suite deleting another's
 * fixtures mid-test — which shows up as failures that wander between runs and
 * look like flaky product code. Giving every file its own database removes the
 * interference without giving up the parallelism.
 */
function suiteSlug(): string {
  const testPath = expect.getState().testPath ?? 'suite';
  const file = testPath.split(/[\\/]/).pop() ?? 'suite';
  return file.replace(/\.test\.ts$/, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 40);
}

export async function setupDatabase(): Promise<void> {
  await connectMongo(resolveTestMongoUri(process.env['MONGO_URI'] as string, suiteSlug()));
}

export async function teardownDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (db) await db.dropDatabase();
  await disconnectMongo();
  await disconnectRedis();
}

export async function clearCollections(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const collections = await db.collections();
  // Bypasses the immutability hooks on Commission and AuditLog, which is
  // correct for test teardown but never available to application code.
  await Promise.all(collections.map((c) => c.deleteMany({})));

  // The settings cache mirrors a collection this just emptied, so leaving it
  // alone points it at rows that no longer exist. Left unhandled, one suite's
  // settings reach the next one and the failure surfaces somewhere unrelated
  // — as a confirmation window of the wrong length, or a commission
  // percentage that reads back undefined.
  await invalidateConfigCache();
}
