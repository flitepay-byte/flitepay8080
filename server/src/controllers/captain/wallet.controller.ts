import type { Request, Response } from 'express';
import { asyncHandler, ok, created, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { DmcPurchase, WalletEntry, DmcRedemption } from '../../models';
import {
  notifyCollateralDepositRequested,
  notifyRedemptionRequested,
  notifyLimitPurchaseRequested,
} from '../../services/notification.service';
import { requestDeposit, markDepositPaid } from '../../services/dmcPurchase.service';
import {
  requestLimitPurchase,
  limitPurchaseAllowance,
  listForCaptain as listLimitPurchasesForCaptain, markLimitPurchasePaid } from '../../services/captainLimitPurchase.service';
import { requestRedemption } from '../../services/captainBalance.service';
import {
  activeMerchantUpi,
  listMerchantUpiIds,
  addMerchantUpiId,
  activateMerchantUpiId,
  deactivateMerchantUpiId,
  MERCHANT_UPI_NOTICE,
} from '../../services/captainUpi.service';
import { toDmcPurchaseDto, toWalletEntryDto, toRedemptionDto, toLimitPurchaseDto } from '../../utils/serializers';
import {
  activeDepositAddresses,
  depositAddressView,
  quote,
  USDT_NETWORK,
  USDT_ASSET,
} from '../../services/usdtDeposit.service';
import { paiseToRupees, usdtMicrosToAmount } from '../../utils/money';
import { verifyFileSignature } from '../../middleware/upload.middleware';
import { uploadFile, deleteFile } from '../../services/storage.service';
import { captainContext } from './context';

/**
 * A captain posting more security money to raise their collateral.
 *
 * Nothing is credited here. The captain says what they sent and attaches
 * proof; admin confirms the money actually arrived before any collateral
 * moves — the same handshake a party top-up goes through, and for the same
 * reason. See dmcPurchase.service.ts.
 */
export const requestCollateralDeposit = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const body = req.body as { amount: number; providerReference: string; notes?: string };
  const file = req.file;

  let receipt: { url: string; publicId: string; fileName: string; mimeType: string } | undefined;
  if (file) {
    // A declared MIME type is attacker-controlled, so the bytes are checked
    // before anything is uploaded.
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
    const request = await requestDeposit(
      captainId,
      body.amount,
      actor,
    );
    notifyCollateralDepositRequested(request);
    return created(res, toDmcPurchaseDto(request), 'Deposit submitted — awaiting admin to confirm receipt');
  } catch (err) {
    // Do not leave an orphaned upload behind if the request is rejected.
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

/**
 * What this captain may buy right now, for the form on their own screen.
 *
 * Served rather than computed client-side so the ceiling shown is the ceiling
 * the request will actually be judged against.
 */
export const limitPurchaseOptions = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const allowance = await limitPurchaseAllowance(captainId);
  return ok(res, {
    collateral: paiseToRupees(allowance.collateralPaise),
    maxPurchase: paiseToRupees(allowance.maxPurchasePaise),
    hasPending: allowance.hasPending,
  });
});

/**
 * A captain buying more room to work with.
 *
 * Not a security deposit: no collateral is posted, and on approval the whole
 * amount becomes DMC while the approved ceiling rises by the same figure. As
 * with every other real-money inflow here, nothing moves until admin has
 * confirmed the payment. See captainLimitPurchase.service.ts.
 */
export const requestCapacityPurchase = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
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
    const request = await requestLimitPurchase(
      captainId,
      // Already paise: rupeeAmountSchema transforms at the boundary, exactly as
      // it does for a security deposit and a party top-up. Converting again
      // multiplied every request by a hundred.
      body.amount,
      actor,
    );
    notifyLimitPurchaseRequested(request);
    return created(res, toLimitPurchaseDto(request), 'Request submitted — awaiting admin to confirm receipt');
  } catch (err) {
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

export const listCapacityPurchases = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number };
  const { items, total } = await listLimitPurchasesForCaptain(captainId, query.page, query.limit);
  return ok(res, paginate(items.map(toLimitPurchaseDto), query.page, query.limit, total));
});

export const listDmcPurchases = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number };

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    DmcPurchase.find({ captainId }).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    DmcPurchase.countDocuments({ captainId }),
  ]);

  return ok(res, paginate(items.map(toDmcPurchaseDto), query.page, query.limit, total));
});

/**
 * The captain's decision on a cancellation someone else (party or admin)
 * requested for a task they hold. Approving finalises it; rejecting escalates
 * to admin rather than reverting it unilaterally.
 */

export const listWalletEntries = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number };

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    WalletEntry.find({ captainId }).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    WalletEntry.countDocuments({ captainId }),
  ]);

  return ok(res, paginate(items.map(toWalletEntryDto), query.page, query.limit, total));
});

/**
 * Ask to be paid real rupees for DMC. The DMC is held out of the balance
 * immediately — see DmcRedemption.ts for why that cannot wait for admin.
 */
export const requestCashOut = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const body = req.body as {
    amount: number;
  };

  /**
   * Where the money goes is not taken from the request.
   *
   * It is whichever merchant UPI the captain has made active on their profile.
   * Accepting a destination per withdrawal meant the figure on the screen and
   * the account being paid could disagree, and it made "which account am I paid
   * into?" a question with a different answer every time.
   *
   * The id is copied onto the record here, so a withdrawal keeps the account it
   * was actually sent to even after the captain switches to another one.
   */
  const active = await activeMerchantUpi(captainId);
  if (!active) {
    throw AppError.badRequest(
      ErrorCodes.VALIDATION_ERROR,
      'Add a merchant UPI ID to your profile and make it active before cashing out.',
    );
  }

  const request = await requestRedemption(
    captainId,
    body.amount,
    { method: 'UPI', upiId: active.upiId },
    actor,
  );
  notifyRedemptionRequested(request);

  return created(res, toRedemptionDto(request), 'Cash-out requested — awaiting admin to send the transfer');
});

export const listCashOuts = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number };

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    DmcRedemption.find({ captainId }).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    DmcRedemption.countDocuments({ captainId }),
  ]);

  return ok(res, paginate(items.map(toRedemptionDto), query.page, query.limit, total));
});

// ---------------------------------------------------------------------------
// Pay-ins and pay-outs the captain is carrying
// ---------------------------------------------------------------------------

/**
 * The QR image for an address, generated on demand.
 *
 * Kept off the list DTOs deliberately: a base64 PNG per row would make a page of
 * requests many times larger for an image only one of them is ever showing.
 *
 * Only addresses actually in the configured pool are rendered, so this cannot be
 * turned into a service that draws a QR code for any string a caller sends.
 */
export const depositAddressQrImage = asyncHandler(async (req: Request, res: Response) => {
  const address = String(req.query['address'] ?? '').trim();
  if (!address || !(await activeDepositAddresses()).includes(address)) {
    throw AppError.notFound('Unknown deposit address', ErrorCodes.NOT_FOUND);
  }
  return ok(res, await depositAddressView(address));
});

/**
 * Where to send USDT, for a captain who has not made a request yet.
 *
 * Lets the deposit and limit-purchase forms show the network and an address
 * before anything is submitted, so the captain can pay first and then report the
 * transaction reference — which is the order these actually happen in.
 */
/**
 * What a given amount of DMC will cost, before anything is submitted.
 *
 * The captain never types a USDT figure — they say how much DMC they want and
 * this is the answer, at the captain rate. No address is assigned here: an
 * address is committed only when a request is actually created, so idly changing
 * the amount on a form does not consume one.
 */
export const captainPaymentQuote = asyncHandler(async (req: Request, res: Response) => {
  const amountPaise = Number(req.query['amountPaise'] ?? 0);
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Enter an amount greater than zero');
  }
  const q = await quote('CAPTAIN', amountPaise);
  return ok(res, {
    dmc: paiseToRupees(q.dmcPaise),
    dmcPerUsdt: paiseToRupees(q.dmcPaisePerUsdt),
    usdtAmount: usdtMicrosToAmount(q.usdtAmountMicros),
    network: USDT_NETWORK,
    asset: USDT_ASSET,
  });
});

/**
 * "I have paid" — for a security deposit.
 *
 * Attaches the transaction reference and, if given, a screenshot. Nothing is
 * credited: the request stays PENDING and an administrator still decides.
 */
export const markDepositPaidRequest = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
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
    const request = await markDepositPaid(
      req.params['depositId'] as string,
      captainId,
      { providerReference: body.providerReference, notes: body.notes, receipt: receipt ?? undefined },
      actor,
    );
    return ok(res, toDmcPurchaseDto(request), 'Marked as paid — an administrator will verify it');
  } catch (err) {
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

/** The same, for a current-limit purchase. */
export const markLimitPurchasePaidRequest = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
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
    const request = await markLimitPurchasePaid(
      req.params['purchaseId'] as string,
      captainId,
      { providerReference: body.providerReference, notes: body.notes, receipt: receipt ?? undefined },
      actor,
    );
    return ok(res, toLimitPurchaseDto(request), 'Marked as paid — an administrator will verify it');
  } catch (err) {
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

/**
 * THE CAPTAIN'S MERCHANT UPI IDS
 *
 * Their own list, on their own profile. Exactly one is active and that is where
 * every new withdrawal is sent; see captainUpi.service.ts for how the
 * single-active rule is enforced.
 */
export const listUpiIds = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  return ok(res, { upiIds: await listMerchantUpiIds(captainId), notice: MERCHANT_UPI_NOTICE });
});

export const addUpiId = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const body = req.body as { upiId: string; label?: string };
  const upiIds = await addMerchantUpiId(captainId, body.upiId, body.label, actor);
  return created(res, { upiIds, notice: MERCHANT_UPI_NOTICE }, 'UPI ID added');
});

export const activateUpiId = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const body = req.body as { active: boolean };
  const upiId = decodeURIComponent(req.params['upiId'] as string);

  const upiIds = body.active
    ? await activateMerchantUpiId(captainId, upiId, actor)
    : await deactivateMerchantUpiId(captainId, upiId, actor);

  return ok(
    res,
    { upiIds, notice: MERCHANT_UPI_NOTICE },
    body.active
      ? 'This is now where your withdrawals are sent'
      : 'Deactivated — choose another before cashing out',
  );
});
