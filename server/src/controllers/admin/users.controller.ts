/**
 * ADMIN — USER ACCOUNTS
 *
 * Accounts rather than roles: listing, enabling and disabling, clearing a
 * lock-out, and reading the audit trail.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Captain, Party, User, AuditLog } from '../../models';
import { recordAudit } from '../../services/audit.service';
import { unlockAccount } from '../../services/auth.service';
import { adminActor } from './actor';
export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    User.find().select('-passwordHash').sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
    User.countDocuments(),
  ]);

  return ok(
    res,
    paginate(
      items.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        locked: Boolean(u.lockedUntil && u.lockedUntil.getTime() > Date.now()),
        lastLoginAt: u.lastLoginAt,
      })),
      query.page,
      query.limit,
      total,
    ),
  );
});

export const setUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const userId = req.params['userId'] as string;
  const { status } = req.body as { status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' };

  if (userId === actor.userId) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'You cannot change your own account status');
  }

  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  const before = user.status;
  user.status = status;
  await user.save();

  // Keep the role profile consistent with the account.
  if (user.role === 'CAPTAIN') {
    await Captain.updateOne(
      { userId: user._id },
      { $set: { status: status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED', ...(status !== 'ACTIVE' ? { isOnline: false } : {}) } },
    );
  }
  if (user.role === 'PARTY') {
    await Party.updateOne({ userId: user._id }, { $set: { status: status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED' } });
  }

  await recordAudit({
    action: 'USER_STATUS_CHANGED',
    targetCollection: 'User',
    targetId: user._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    oldState: { status: before },
    newState: { status },
  });

  return ok(res, { id: String(user._id), status }, 'Account status updated');
});

export const unlock = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  await unlockAccount(req.params['userId'] as string, actor.userId);
  return ok(res, { unlocked: true }, 'Account unlocked');
});

export const auditLogs = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number;
    limit: number;
    action?: string;
    role?: string;
    userId?: string;
    targetId?: string;
    from?: Date;
    to?: Date;
  };

  const filter: Record<string, unknown> = {};
  if (query.action) filter['action'] = query.action;
  if (query.role) filter['role'] = query.role;
  if (query.userId) filter['userId'] = new Types.ObjectId(query.userId);
  if (query.targetId) filter['targetId'] = query.targetId;
  if (query.from || query.to) {
    filter['timestamp'] = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(query.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  return ok(
    res,
    paginate(
      items.map((log) => ({
        id: String(log._id),
        action: log.action,
        role: log.role,
        userId: log.userId ? String(log.userId) : null,
        targetCollection: log.targetCollection,
        targetId: log.targetId,
        ip: log.ip,
        oldState: log.oldState,
        newState: log.newState,
        metadata: log.metadata,
        timestamp: log.timestamp.toISOString(),
      })),
      query.page,
      query.limit,
      total,
    ),
  );
});
