/**
 * Drives every audit phase against the freshly built dataset and writes the
 * findings out as JSON for the report.
 */
import fs from 'node:fs';
import { createApp } from '../app';
import { disconnectMongo } from '../config/db';
import { disconnectRedis } from '../config/redis';
import { startMiniRedis } from './mini-redis';
import { buildDataset } from './seed';
import { auditAccounting } from './phase-accounting';
import { auditPrivacy } from './phase-privacy';
import { auditConcurrency } from './phase-concurrency';
import { auditIntegrity } from './phase-integrity';
import { auditEdges } from './phase-edges';
import { results, summarise, report } from './harness';

async function safely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.log(`  !! phase "${label}" aborted: ${(error as Error).message}`);
    report({
      severity: 'P2', area: 'Audit harness', roles: ['—'],
      title: `The ${label} phase could not run to completion`,
      reproduction: `Run the ${label} phase against the audit dataset.`,
      expected: 'The phase runs end to end.',
      actual: (error as Error).message,
      impact: 'That area is only partially covered by this report.',
    });
  }
}

async function main(): Promise<void> {
  await startMiniRedis();
  const started = Date.now();

  console.log('Building the audit dataset...');
  const data = await buildDataset();

  const app = createApp();

  // Accounting runs first, before the race phase perturbs balances.
  await safely('accounting', () => auditAccounting(data.partyCreditsPaise));
  await safely('integrity', () => auditIntegrity());
  await safely('privacy', () => auditPrivacy(app, data));
  await safely('edge cases', () => auditEdges(app, data));
  // Races are destructive by design, so they go last.
  await safely('concurrency', () => auditConcurrency(data));
  // Re-run the money checks afterwards: a race that corrupts the ledger only
  // shows up once you recount.
  console.log('\n=== PHASE: money, re-checked after the races ===');
  await safely('accounting (post-race)', () => auditAccounting(data.partyCreditsPaise));

  summarise();
  const payload = { ...results(), seconds: Math.round((Date.now() - started) / 1000) };
  fs.writeFileSync('audit-findings.json', JSON.stringify(payload, null, 2));
  console.log(`\nWritten to audit-findings.json (${payload.seconds}s)`);

  await disconnectMongo();
  await disconnectRedis();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
