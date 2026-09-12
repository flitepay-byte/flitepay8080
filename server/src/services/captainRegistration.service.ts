/**
 * CAPTAIN REGISTRATION
 * --------------------
 * A captain applies for themselves, proves the email address is theirs, and
 * then waits for an administrator. Nothing they can do on their own creates an
 * account: the application is a request, and approval is what turns it into a
 * `User` and a `Captain`.
 *
 * Two properties are worth stating up front, because everything here follows
 * from them.
 *
 * The first is that an unapproved applicant has no account at all — not an
 * inactive one. So there is no state in which a half-made captain could be
 * scored by routing, listed among captains, or counted by reconciliation, and no
 * query elsewhere needs a clause to exclude them.
 *
 * The second is that approval creates capacity for exactly nothing. The captain
 * arrives with every figure at zero and no collateral, which means an approved
 * captain who has posted no security still cannot claim work. Approval is
 * permission to take part; the security deposit is what makes taking part
 * possible. Getting the first slightly wrong is therefore not expensive, which
 * is the point of separating them.
 */
import mongoose, { Types } from 'mongoose';
import {
  CaptainRegistration,
  Captain,
  User,
  hashPassword,
  nextSequence,
  type ICaptainRegistration,
} from '../models';
import { issueOtpChallenge, verifyOtpChallenge, resendOtp, type OtpChallenge } from './otp.service';
import { formatCaptainCode } from '../utils/ids';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import { supportsTransactions } from '../config/db';
import type { Role } from '../types';

export interface RegisterCaptainInput {
  name: string;
  fullName: string;
  mobile: string;
  email: string;
  upiId: string;
  password: string;
}

export interface ActorRef {
  userId: string;
  role: Role;
  ip?: string;
}

/** Mongo's duplicate-key error, which is how both unique indexes here report a race. */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * The next captain code that is genuinely free.
 *
 * Drawing from the counter is not enough on its own. Databases seeded before the
 * counter existed have captains whose codes were written as literals, so the
 * counter can sit behind what has actually been handed out — and the first
 * registration against such a database draws CAP-001, collides with the seeded
 * captain on a unique index, and fails halfway through creating an account.
 *
 * So the drawn code is checked, and a taken one is skipped. This walks the
 * counter forward until it has caught up with reality, after which it is the
 * only thing consulted again.
 */
async function allocateCaptainCode(): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = formatCaptainCode(await nextSequence('captain'));
    if (!(await Captain.exists({ captainCode: code }))) return code;
  }
  throw AppError.internal('Could not allocate a free captain code');
}

/**
 * Step one: take the application and mail a code.
 *
 * The address is checked against existing accounts as well as live applications.
 * Both checks are also enforced by indexes, and both are re-checked here only to
 * produce a sentence a person can act on rather than a duplicate-key error.
 */
export async function registerCaptain(
  input: RegisterCaptainInput,
  ip?: string,
): Promise<{ registrationId: string; challenge: OtpChallenge }> {
  const email = input.email.trim().toLowerCase();

  const existingUser = await User.findOne({ email }).select('_id').lean();
  if (existingUser) {
    throw AppError.conflict(ErrorCodes.CONFLICT, 'An account with this email already exists', {
      field: 'email',
    });
  }

  const live = await CaptainRegistration.findOne({
    email,
    status: { $in: ['PENDING_EMAIL', 'PENDING_APPROVAL'] },
  })
    .select('_id status')
    .lean();
  if (live) {
    throw AppError.conflict(
      ErrorCodes.CONFLICT,
      live.status === 'PENDING_EMAIL'
        ? 'You have already registered with this email. Check your inbox for the code.'
        : 'You have already registered with this email and it is waiting for an administrator.',
      { field: 'email' },
    );
  }

  const passwordHash = await hashPassword(input.password);

  let registration: ICaptainRegistration;
  try {
    registration = await CaptainRegistration.create({
      name: input.name.trim(),
      fullName: input.fullName.trim(),
      mobile: input.mobile.trim(),
      email,
      upiId: input.upiId.trim().toLowerCase(),
      passwordHash,
      status: 'PENDING_EMAIL',
      ip: ip ?? null,
    });
  } catch (err) {
    // Two applications for the same address, submitted at once. The partial
    // unique index is what actually decides; this only translates it.
    if (isDuplicateKey(err)) {
      throw AppError.conflict(ErrorCodes.CONFLICT, 'An application for this email is already open', {
        field: 'email',
      });
    }
    throw err;
  }

  const challenge = await issueOtpChallenge({
    email,
    purpose: 'CAPTAIN_REGISTRATION',
    ip,
  });

  registration.challengeId = challenge.challengeId;
  await registration.save();

  await recordAudit({
    action: 'CAPTAIN_REGISTRATION_SUBMITTED',
    targetCollection: 'CaptainRegistration',
    targetId: registration._id,
    role: 'CAPTAIN',
    ip,
    // Deliberately no password, no code, and no UPI id: audit rows are stored
    // and read by people, and none of those three help anybody read this one.
    newState: { email, name: registration.name },
  });

  return { registrationId: String(registration._id), challenge };
}

/**
 * Step two: the code proves the address, and the application goes to admin.
 *
 * Verifying is not approval and does not create anything. It moves the
 * application into the state an administrator sees.
 */
export async function verifyRegistrationEmail(
  challengeId: string,
  otp: string,
  ip?: string,
): Promise<{ status: 'PENDING_APPROVAL' }> {
  const registration = await CaptainRegistration.findOne({ challengeId });
  if (!registration) {
    throw AppError.notFound('No registration matches this code', ErrorCodes.REGISTRATION_NOT_FOUND);
  }
  if (registration.status === 'PENDING_APPROVAL') {
    // Verifying twice is not an error worth showing; the address is confirmed
    // either way and the applicant is where they should be.
    return { status: 'PENDING_APPROVAL' };
  }
  if (registration.status !== 'PENDING_EMAIL') {
    throw AppError.badRequest(
      ErrorCodes.REGISTRATION_ALREADY_DECIDED,
      'This registration has already been decided',
    );
  }

  // Throws on a wrong, expired, exhausted or already-used code, and will not
  // accept one issued for signing in or for a password reset.
  await verifyOtpChallenge(challengeId, otp, 'CAPTAIN_REGISTRATION');

  // Conditional, so two submissions of the same correct code cannot both move
  // it. The OTP is consumed atomically as well, but this keeps the application's
  // own transition honest on its own terms.
  const moved = await CaptainRegistration.findOneAndUpdate(
    { _id: registration._id, status: 'PENDING_EMAIL' },
    { $set: { status: 'PENDING_APPROVAL', emailVerifiedAt: new Date(), challengeId: null } },
    { new: true },
  );
  if (!moved) return { status: 'PENDING_APPROVAL' };

  await recordAudit({
    action: 'CAPTAIN_REGISTRATION_EMAIL_VERIFIED',
    targetCollection: 'CaptainRegistration',
    targetId: registration._id,
    role: 'CAPTAIN',
    ip,
    newState: { email: registration.email },
  });

  return { status: 'PENDING_APPROVAL' };
}

/** Send the registration code again, to the address the challenge already names. */
export async function resendRegistrationOtp(challengeId: string): Promise<OtpChallenge> {
  const registration = await CaptainRegistration.findOne({ challengeId }).select('status').lean();
  if (!registration) {
    throw AppError.notFound('No registration matches this code', ErrorCodes.REGISTRATION_NOT_FOUND);
  }
  if (registration.status !== 'PENDING_EMAIL') {
    throw AppError.badRequest(
      ErrorCodes.REGISTRATION_ALREADY_DECIDED,
      'This email has already been confirmed',
    );
  }
  return resendOtp(challengeId);
}

export interface RegistrationDto {
  id: string;
  name: string;
  fullName: string;
  mobile: string;
  email: string;
  upiId: string;
  status: ICaptainRegistration['status'];
  emailVerifiedAt: Date | null;
  rejectionReason: string | null;
  captainCode: string | null;
  createdCaptainId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export function toRegistrationDto(r: ICaptainRegistration): RegistrationDto {
  return {
    id: String(r._id),
    name: r.name,
    fullName: r.fullName,
    mobile: r.mobile,
    email: r.email,
    upiId: r.upiId,
    status: r.status,
    emailVerifiedAt: r.emailVerifiedAt ?? null,
    rejectionReason: r.rejectionReason ?? null,
    captainCode: r.captainCode ?? null,
    createdCaptainId: r.createdCaptainId ? String(r.createdCaptainId) : null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt ?? null,
  };
}

export async function listRegistrations(options: {
  status?: ICaptainRegistration['status'] | 'ALL';
  page: number;
  limit: number;
}): Promise<{ items: RegistrationDto[]; total: number; page: number; limit: number }> {
  const { status = 'PENDING_APPROVAL', page, limit } = options;
  const filter = status === 'ALL' ? {} : { status };

  const [rows, total] = await Promise.all([
    CaptainRegistration.find(filter)
      .sort({ createdAt: status === 'ALL' ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CaptainRegistration.countDocuments(filter),
  ]);

  return { items: rows.map(toRegistrationDto), total, page, limit };
}

/**
 * Approve: the application becomes a sign-in and a captain profile.
 *
 * Both documents are written together where the deployment supports
 * transactions, because a `User` with no `Captain` behind it is an account that
 * can sign in and find nothing of its own.
 *
 * The order is not a choice: `Captain.userId` is required, so the account has to
 * exist before the profile can point at it. That makes the dangerous half the one
 * written first, and a deployment without transactions — a standalone mongod,
 * rather than a replica set — therefore has to undo it by hand. If the profile
 * cannot be written, the account just created is deleted again before the error
 * is reported. Leaving it behind is not a cosmetic untidiness: it is a sign-in
 * that works, for a captain who does not exist.
 */
export async function approveRegistration(
  registrationId: string,
  actor: ActorRef,
): Promise<RegistrationDto> {
  const registration = await CaptainRegistration.findById(registrationId).select('+passwordHash');
  if (!registration) {
    throw AppError.notFound('Registration not found', ErrorCodes.REGISTRATION_NOT_FOUND);
  }
  if (registration.status === 'PENDING_EMAIL') {
    throw AppError.badRequest(
      ErrorCodes.REGISTRATION_EMAIL_NOT_VERIFIED,
      'This applicant has not confirmed their email address yet',
    );
  }
  if (registration.status !== 'PENDING_APPROVAL') {
    throw AppError.conflict(
      ErrorCodes.REGISTRATION_ALREADY_DECIDED,
      `This registration is already ${registration.status.toLowerCase()}`,
    );
  }

  // Nothing stops an administrator creating an account with the same address in
  // the meantime, so this is checked again at the moment of approval.
  const clash = await User.findOne({ email: registration.email }).select('_id').lean();
  if (clash) {
    throw AppError.conflict(
      ErrorCodes.CONFLICT,
      'An account with this email now exists, so this application cannot be approved',
      { field: 'email' },
    );
  }

  // Claim the decision before doing any of the work, so two administrators
  // clicking at once produce one captain rather than two.
  const claimed = await CaptainRegistration.findOneAndUpdate(
    { _id: registration._id, status: 'PENDING_APPROVAL' },
    { $set: { status: 'APPROVED', decidedBy: new Types.ObjectId(actor.userId), decidedAt: new Date() } },
    { new: true },
  );
  if (!claimed) {
    throw AppError.conflict(ErrorCodes.REGISTRATION_ALREADY_DECIDED, 'This registration was just decided');
  }

  const passwordHash = registration.passwordHash;

  const create = async (
    session?: mongoose.ClientSession,
  ): Promise<{ userId: Types.ObjectId; captainId: Types.ObjectId }> => {
    const opts = session ? { session } : {};
    const [user] = await User.create(
      [
        {
          email: registration.email,
          passwordHash,
          name: registration.fullName,
          phone: registration.mobile,
          role: 'CAPTAIN',
          status: 'ACTIVE',
        },
      ],
      opts,
    );
    if (!user) throw AppError.internal('Account creation returned no document');

    try {
      const [captain] = await Captain.create(
        [
          {
            userId: user._id,
            captainCode,
            displayName: registration.name,
            // Every figure at zero. A captain funds themselves through the
            // security-deposit handshake, exactly as the seeded one does.
            collateralBalancePaise: 0,
            lockedAmountPaise: 0,
            dmcBalancePaise: 0,
            commissionEarnedTotalPaise: 0,
            creditLimitPaise: null,
            isOnline: false,
            status: 'ACTIVE',
          },
        ],
        opts,
      );
      if (!captain) throw AppError.internal('Captain creation returned no document');
      return { userId: user._id, captainId: captain._id };
    } catch (err) {
      // Inside a transaction the abort takes care of this. Outside one, the
      // account has really been written and would otherwise survive as a
      // sign-in belonging to a captain who was never created.
      if (!session) await User.deleteOne({ _id: user._id });
      throw err;
    }
  };

  let ids: { userId: Types.ObjectId; captainId: Types.ObjectId };
  let captainCode = '';
  try {
    // Inside the try, because this can fail on its own and everything after the
    // claim above has to be undone together.
    captainCode = await allocateCaptainCode();

    if (await supportsTransactions()) {
      const session = await mongoose.startSession();
      try {
        let inner: typeof ids | undefined;
        await session.withTransaction(async () => {
          inner = await create(session);
        });
        if (!inner) throw AppError.internal('Approval produced no account');
        ids = inner;
      } finally {
        await session.endSession();
      }
    } else {
      ids = await create(undefined);
    }
  } catch (err) {
    // Hand the application back so it can be decided again, rather than leaving
    // it approved with nothing behind it.
    await CaptainRegistration.updateOne(
      { _id: registration._id, status: 'APPROVED' },
      { $set: { status: 'PENDING_APPROVAL', decidedBy: null, decidedAt: null } },
    );
    if (isDuplicateKey(err)) {
      throw AppError.conflict(ErrorCodes.CONFLICT, 'An account with this email already exists', {
        field: 'email',
      });
    }
    throw err;
  }

  const finalDoc = await CaptainRegistration.findByIdAndUpdate(
    registration._id,
    { $set: { createdUserId: ids.userId, createdCaptainId: ids.captainId, captainCode } },
    { new: true },
  );

  await recordAudit({
    action: 'CAPTAIN_REGISTRATION_APPROVED',
    targetCollection: 'CaptainRegistration',
    targetId: registration._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { email: registration.email, captainCode, captainId: String(ids.captainId) },
  });
  await recordAudit({
    action: 'USER_CREATED',
    targetCollection: 'Captain',
    targetId: ids.captainId,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { captainCode, displayName: registration.name, email: registration.email },
  });

  return toRegistrationDto(finalDoc ?? registration);
}

/**
 * Reject: no account is created and nothing is left behind that could sign in.
 *
 * The applicant is free to apply again — the uniqueness index covers only live
 * applications precisely so that a rejection is not a permanent ban on an
 * address.
 */
export async function rejectRegistration(
  registrationId: string,
  reason: string,
  actor: ActorRef,
): Promise<RegistrationDto> {
  const rejected = await CaptainRegistration.findOneAndUpdate(
    { _id: registrationId, status: { $in: ['PENDING_EMAIL', 'PENDING_APPROVAL'] } },
    {
      $set: {
        status: 'REJECTED',
        rejectionReason: reason,
        decidedBy: new Types.ObjectId(actor.userId),
        decidedAt: new Date(),
        challengeId: null,
      },
    },
    { new: true },
  );

  if (!rejected) {
    const exists = await CaptainRegistration.findById(registrationId).select('status').lean();
    if (!exists) throw AppError.notFound('Registration not found', ErrorCodes.REGISTRATION_NOT_FOUND);
    throw AppError.conflict(
      ErrorCodes.REGISTRATION_ALREADY_DECIDED,
      `This registration is already ${exists.status.toLowerCase()}`,
    );
  }

  await recordAudit({
    action: 'CAPTAIN_REGISTRATION_REJECTED',
    targetCollection: 'CaptainRegistration',
    targetId: rejected._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { email: rejected.email, reason },
  });

  return toRegistrationDto(rejected);
}

/** What the applicant may see about their own application, by challenge or id. */
export async function registrationStatus(registrationId: string): Promise<{
  status: ICaptainRegistration['status'];
  rejectionReason: string | null;
}> {
  const r = await CaptainRegistration.findById(registrationId).select('status rejectionReason').lean();
  if (!r) throw AppError.notFound('Registration not found', ErrorCodes.REGISTRATION_NOT_FOUND);
  return { status: r.status, rejectionReason: r.rejectionReason ?? null };
}
