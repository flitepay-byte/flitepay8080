import type { Request, Response } from 'express';
import { asyncHandler, ok } from '../utils/http';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { Task, type ITask } from '../models';
import { toCustomerTrackingDto } from '../utils/serializers';
import { getUsdtInrRate } from '../services/exchangeRate.service';
import { getConfig } from '../services/systemConfig.service';
import { clocksOf } from '../services/taskClocks.service';

/**
 * PUBLIC CUSTOMER TRACKING — unauthenticated.
 *
 * Returns a strict allow-listed projection built by toCustomerTrackingDto.
 * Operational detail (captain identity, commission, collateral, audit notes,
 * provider references, internal ids) is never included.
 *
 * The endpoint is rate limited by IP, because an unauthenticated lookup keyed
 * on a reference is otherwise enumerable.
 */
export const track = asyncHandler(async (req: Request, res: Response) => {
  const referenceId = req.params['referenceId'] as string;

  const task = await Task.findOne({ externalRef: referenceId });
  if (!task) {
    // Deliberately identical whether the reference never existed or is simply
    // not visible, so the endpoint cannot be used to confirm which references
    // are real.
    throw AppError.notFound('No record found for this reference', ErrorCodes.NOT_FOUND);
  }

  return ok(res, toCustomerTrackingDto(task, await expectedPaymentTime(task)));
});

/**
 * When this payment should reach the customer.
 *
 * Once a captain is holding it, the answer is already recorded — `expiresAt`
 * is their deadline to submit proof, so it is the deadline for the money too.
 * Before that, nobody has taken it yet, so the estimate is the two windows a
 * task passes through: the time a captain has to accept it, plus the time they
 * then have to finish.
 *
 * Read from settings rather than fixed at an hour, because an operator who
 * shortens the windows has shortened this promise with them — a customer told
 * an hour by a screen that no longer means it is worse than not being told.
 */
async function expectedPaymentTime(task: ITask): Promise<Date | null> {
  if (task.expiresAt) return task.expiresAt;

  const config = await getConfig();
  // This task's own windows, which its party set. A promise made to a
  // customer should be the promise their party actually agreed to, not the
  // system default some other party is running on.
  const clocks = clocksOf(task, config);
  const minutes = clocks.acceptanceMinutes + clocks.completionMinutes;
  return new Date(task.createdAt.getTime() + minutes * 60_000);
}

/**
 * Live USDT/INR rate, so every DMC figure in the UI can show what it would
 * be worth in real USDT. See exchangeRate.service.ts — this is the one call
 * in the whole app that touches a real external source; DMC itself stays
 * entirely fictional.
 */
export const usdtRate = asyncHandler(async (_req: Request, res: Response) => {
  const rate = await getUsdtInrRate();
  return ok(res, rate);
});
