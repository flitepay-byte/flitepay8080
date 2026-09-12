import type { Request, Response } from 'express';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { adminActor } from './actor';
import {
  listRegistrations,
  approveRegistration,
  rejectRegistration,
} from '../../services/captainRegistration.service';
import type {
  ListRegistrationsQuery,
  RejectRegistrationBody,
} from '../../validators/captainRegistration.validators';

/**
 * The administrator's side of registration: see who has applied, and decide.
 *
 * Approving is the only thing in this system that creates a captain, so it is
 * the one place a new sign-in comes into existence. Rejecting creates nothing
 * and leaves no account behind — the applicant may apply again.
 */

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, status } = req.query as unknown as ListRegistrationsQuery;
  const result = await listRegistrations({ status, page, limit });
  return ok(res, paginate(result.items, result.page, result.limit, result.total));
});

export const approve = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const registration = await approveRegistration(req.params['registrationId'] as string, actor);
  return ok(res, registration, `Approved — ${registration.captainCode ?? 'captain'} can now sign in`);
});

export const reject = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { reason } = req.body as RejectRegistrationBody;
  const registration = await rejectRegistration(req.params['registrationId'] as string, reason, actor);
  return ok(res, registration, 'Registration rejected');
});
