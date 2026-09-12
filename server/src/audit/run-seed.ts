import { buildDataset } from './seed';
import { startMiniRedis } from './mini-redis';
import { disconnectMongo } from '../config/db';
import { Task, Party, Captain, PartyTopUpRequest } from '../models';

async function main(): Promise<void> {
  const t0 = Date.now();
  await startMiniRedis();
  await buildDataset();

  const byStatus = await Task.aggregate<{ _id: string; n: number }>([
    { $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]);
  console.log('\nTasks by state:');
  for (const row of byStatus) console.log(`  ${row._id.padEnd(18)} ${row.n}`);

  const reassigned = await Task.countDocuments({ reassignmentCount: { $gt: 0 } });
  const topups = await PartyTopUpRequest.aggregate<{ _id: string; n: number }>([
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  console.log(`\nReassigned tasks: ${reassigned}`);
  console.log(`Top-ups: ${topups.map((p) => `${p._id}=${p.n}`).join(', ') || 'none'}`);
  console.log(`Parties: ${await Party.countDocuments({})}, Captains: ${await Captain.countDocuments({})}`);
  console.log(`\nBuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await disconnectMongo();
}
main().then(() => process.exit(0)).catch((e: unknown) => { console.error(e); process.exit(1); });
