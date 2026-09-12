import type { Request } from 'express';
import { Types } from 'mongoose';
import { AuditLog } from '../models';
import { logger } from '../config/logger';
import { clientIp } from '../utils/http';
import type { AuditAction, Role } from '../types';

export interface AuditInput {
  action: AuditAction;
  targetCollection: string;
  targetId?: string | Types.ObjectId | null;
  userId?: string | Types.ObjectId | null;
  role?: Role | null;
  ip?: string;
  userAgent?: string;
  oldState?: unknown;
  newState?: unknown;
  metadata?: Record<string, unknown>;
}

function toObjectId(value?: string | Types.ObjectId | null): Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value;
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
}

/**
 * Append an audit record. Deliberately non-throwing: a logging failure must
 * never roll back or fail a business operation that already succeeded. The
 * failure is itself logged loudly so it is not silent.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      action: input.action,
      targetCollection: input.targetCollection,
      targetId: input.targetId ? String(input.targetId) : null,
      userId: toObjectId(input.userId),
      role: input.role ?? null,
      ip: input.ip,
      userAgent: input.userAgent,
      oldState: input.oldState ?? null,
      newState: input.newState ?? null,
      metadata: input.metadata ?? {},
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit log');
  }
}

/** Convenience wrapper that lifts actor and IP straight off the request. */
export async function auditFromRequest(
  req: Request,
  input: Omit<AuditInput, 'userId' | 'role' | 'ip' | 'userAgent'>,
): Promise<void> {
  await recordAudit({
    ...input,
    userId: req.user?.userId ?? null,
    role: req.user?.role ?? null,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
  });
}
