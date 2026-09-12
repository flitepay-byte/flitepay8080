import type { Request, Response } from 'express';
import { asyncHandler, ok, created, paginate } from '../../utils/http';
import { paiseToRupees, usdtMicrosToAmount } from '../../utils/money';
import { AppError } from '../../utils/AppError';
import { quote, USDT_NETWORK, USDT_ASSET } from '../../services/usdtDeposit.service';
import { ErrorCodes } from '../../utils/errorCodes';
import { AdminWithdrawalPortion, PartyTopUpRequest } from '../../models';
import { notifyPlatformPaymentSubmitted, notifyPartyTopUpRequested } from '../../services/notification.service';
import { submitPlatformPortionPaymentProof } from '../../services/adminWithdrawal.service';
import { requestTopUp as requestPartyTopUp, markTopUpPaid } from '../../services/partyTopUp.service';
import { toAdminWithdrawalPortionDto, toPartyTopUpDto } from '../../utils/serializers';
import { verifyFileSignature } from '../../middleware/upload.middleware';
import { uploadFile, deleteFile } from '../../services/storage.service';
import { partyContext } from './context';
/**
 * A party topping up its DMC balance beyond the registration grant. Unlike a
 * captain's self-service purchase, this is real security money the party
 * sends to the platform directly — so it's a request with proof, sitting
 * pending until admin confirms actually receiving it. See partyTopUp.service.ts.
 */
export const requestTopUp = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const body = req.body as { amount: number; providerReference: string; notes?: string };
  const file = req.file;

  let receipt: { url: string; publicId: string; fileName: string; mimeType: string } | undefined;
  if (file) {
    if (!verifyFileSignature(file.buffer, file.mimetype)) {
      throw AppError.badRequest(
        ErrorCodes.UNSUPPORTED_FILE_TYPE,
        'The uploaded file contents do not match its declared type',
      );
    }
    const uploaded = await uploadFile(file.buffer, file.mimetype);
    receipt = { url: uploaded.url, publicId: uploaded.publicId, fileName: file.originalname, mimeType: file.mimetype };
  }

  try {
    const request = await requestPartyTopUp(partyId, body.amount, actor);
    notifyPartyTopUpRequested(request);
    return created(res, toPartyTopUpDto(request), 'Top-up submitted — awaiting admin to confirm');
  } catch (err) {
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

export const listOwnTopUps = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const query = req.query as unknown as { page: number; limit: number };

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    PartyTopUpRequest.find({ partyId }).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    PartyTopUpRequest.countDocuments({ partyId }),
  ]);

  return ok(res, paginate(items.map(toPartyTopUpDto), query.page, query.limit, total));
});

/** Admin's withdrawal portions directed at this party — same shape as the captain Pay In portions above. */
export const listAdminWithdrawalPool = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const query = req.query as unknown as { page: number; limit: number; status?: string };
  const status = query.status ?? 'PENDING';
  const filter: Record<string, unknown> = { partyId, status };
  const sort: Record<string, 1 | -1> = status === 'PENDING' ? { createdAt: 1 } : { createdAt: -1 };

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    AdminWithdrawalPortion.find(filter).sort(sort).skip(skip).limit(query.limit),
    AdminWithdrawalPortion.countDocuments(filter),
  ]);

  return ok(res, paginate(items.map(toAdminWithdrawalPortionDto), query.page, query.limit, total));
});

/** Party's half of the handshake with admin for one portion: attest payment was sent and attach proof. */
export const submitAdminPayInProof = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const portionId = req.params['portionId'] as string;
  const body = req.body as { providerReference: string; notes?: string };
  const file = req.file;

  let receipt: { url: string; publicId: string; fileName: string; mimeType: string } | undefined;
  if (file) {
    if (!verifyFileSignature(file.buffer, file.mimetype)) {
      throw AppError.badRequest(
        ErrorCodes.UNSUPPORTED_FILE_TYPE,
        'The uploaded file contents do not match its declared type',
      );
    }
    const uploaded = await uploadFile(file.buffer, file.mimetype);
    receipt = { url: uploaded.url, publicId: uploaded.publicId, fileName: file.originalname, mimeType: file.mimetype };
  }

  try {
    const portion = await submitPlatformPortionPaymentProof(
      portionId,
      partyId,
      { providerReference: body.providerReference, notes: body.notes, receipt },
      actor,
    );
    notifyPlatformPaymentSubmitted(portion);
    return ok(res, toAdminWithdrawalPortionDto(portion), 'Payment proof submitted — awaiting admin to confirm');
  } catch (err) {
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// API credentials
// ---------------------------------------------------------------------------

/** The party's "I have paid", with the transaction reference. Credits nothing. */
export const markTopUpPaidRequest = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const body = req.body as { providerReference: string; notes?: string };
  const file = req.file;

  let receipt: { url: string; publicId: string; fileName: string; mimeType: string } | null = null;
  if (file) {
    const uploaded = await uploadFile(file.buffer, file.mimetype);
    receipt = {
      url: uploaded.url,
      publicId: uploaded.publicId,
      fileName: file.originalname,
      mimeType: file.mimetype,
    };
  }

  try {
    const request = await markTopUpPaid(
      req.params['topUpId'] as string,
      partyId,
      { providerReference: body.providerReference, notes: body.notes, receipt },
      actor,
    );
    return ok(res, toPartyTopUpDto(request), 'Marked as paid — an administrator will verify it');
  } catch (err) {
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

/**
 * What a given amount of DMC costs a party, at the PARTY rate.
 *
 * A separate endpoint from the captain's rather than one with a role switch: the
 * two rates must never be substituted for one another, and the surest way to
 * guarantee that is for neither side to have a code path that could reach the
 * other's.
 */
export const partyPaymentQuote = asyncHandler(async (req: Request, res: Response) => {
  const amountPaise = Number(req.query['amountPaise'] ?? 0);
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Enter an amount greater than zero');
  }
  const q = await quote('PARTY', amountPaise);
  return ok(res, {
    dmc: paiseToRupees(q.dmcPaise),
    dmcPerUsdt: paiseToRupees(q.dmcPaisePerUsdt),
    usdtAmount: usdtMicrosToAmount(q.usdtAmountMicros),
    network: USDT_NETWORK,
    asset: USDT_ASSET,
  });
});
