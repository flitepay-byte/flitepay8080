import mongoose from 'mongoose';
import { env } from './env';
import { logger } from './logger';

let connected = false;

export async function connectMongo(uri: string = env.MONGO_URI): Promise<typeof mongoose> {
  if (connected) return mongoose;
  mongoose.set('strictQuery', true);
  // Surfaces accidental unindexed queries during development.
  mongoose.set('autoIndex', env.NODE_ENV !== 'production');

  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 50,
    minPoolSize: 5,
  });
  connected = true;
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

/**
 * Transactions require a replica set. A standalone mongod (common in local
 * dev) will throw IllegalOperation / 20. Callers use this to decide whether
 * to run the transactional path or the compare-and-swap fallback, both of
 * which are safe against double-claim.
 */
export async function supportsTransactions(): Promise<boolean> {
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) return false;
    const info = await admin.command({ hello: 1 });
    return Boolean(info['setName'] || info['msg'] === 'isdbgrid');
  } catch {
    return false;
  }
}
