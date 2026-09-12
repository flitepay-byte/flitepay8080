/**
 * USDT-TRC20 PAYMENTS
 * -------------------
 * One place that answers three questions for every flow that takes money:
 * how much USDT, to which address, and on what network.
 *
 * Three flows use it — a captain posting security, a captain buying current
 * limit, and a party topping up — and they differ only in which conversion rate
 * applies. Everything else about receiving a payment is identical, which is why
 * it is written once.
 *
 * **Two rates, never mixed.** A captain's rate and a party's rate are separate
 * settings and separate arguments here; there is no default and no fallback from
 * one to the other, so a caller that forgets to say which side it is on does not
 * compile rather than quietly charging the wrong price.
 *
 * **Nothing here credits anything.** No chain is watched and no balance moves. A
 * payer sends USDT, marks the request as paid with a transaction reference, and
 * an administrator approves it — approval is the only thing in the system that
 * moves money, exactly as before.
 *
 * **Everything is snapshotted onto the request.** The address and the rate are
 * written onto the row when it is created, so an administrator changing either
 * afterwards cannot alter what somebody was already told to pay.
 */
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { getConfig } from './systemConfig.service';
import { AppError } from '../utils/AppError';
import { dmcPaiseToUsdtMicros } from '../utils/money';

/**
 * The only network these addresses are on.
 *
 * Stated on every screen that shows an address, because USDT exists on several
 * chains, the addresses look similar enough to paste confidently, and a transfer
 * sent over the wrong one is simply gone.
 */
export const USDT_NETWORK = 'TRON (TRC20)' as const;
export const USDT_ASSET = 'USDT' as const;

/** Which rate applies. There is no third option and no default. */
export type PayerSide = 'CAPTAIN' | 'PARTY';

export interface DepositAddressRecord {
  address: string;
  label?: string | null;
  active: boolean;
  addedAt: Date;
}

/** Every address an administrator has configured, retired ones included. */
export async function listDepositAddresses(): Promise<DepositAddressRecord[]> {
  const config = await getConfig();
  return (config.usdtDepositAddresses ?? []) as DepositAddressRecord[];
}

/** Only those a new request may be assigned to. */
export async function activeDepositAddresses(): Promise<string[]> {
  return (await listDepositAddresses()).filter((a) => a.active).map((a) => a.address);
}

/**
 * The rate for one side, in paise of DMC per USDT.
 *
 * Reading it through this function rather than off the config object is what
 * keeps the two apart: there is one expression in the codebase that resolves a
 * side to a rate, so a mix-up has one place to happen and is visible there.
 */
export async function conversionRatePaise(side: PayerSide): Promise<number> {
  const config = await getConfig();
  return side === 'CAPTAIN' ? config.captainDmcPaisePerUsdt : config.partyDmcPaisePerUsdt;
}

export interface PaymentQuote {
  side: PayerSide;
  dmcPaise: number;
  /** Paise of DMC per USDT, as applied. Snapshotted onto the request. */
  dmcPaisePerUsdt: number;
  usdtAmountMicros: number;
}

/**
 * What this much DMC costs, at the rate applying to this side right now.
 *
 * The payer never types a USDT figure: they say how much DMC they want and this
 * is what they owe. Returning the rate alongside the amount is deliberate — the
 * caller is expected to store both, so the request records not just what was
 * charged but why.
 */
export async function quote(side: PayerSide, dmcPaise: number): Promise<PaymentQuote> {
  const dmcPaisePerUsdt = await conversionRatePaise(side);
  return {
    side,
    dmcPaise,
    dmcPaisePerUsdt,
    usdtAmountMicros: dmcPaiseToUsdtMicros(dmcPaise, dmcPaisePerUsdt),
  };
}

export interface AssignedDepositAddress {
  address: string;
  network: typeof USDT_NETWORK;
  asset: typeof USDT_ASSET;
}

/**
 * Pick an address for a new request, at random from the active ones.
 *
 * Random rather than round-robin because the alternative leaks volume: an
 * address handed out in strict rotation tells anybody watching the chain how
 * many payments the platform took between two of their own.
 *
 * Uses the cryptographic generator, not `Math.random`, since this is the kind of
 * choice that should not be predictable from previous ones.
 */
export async function assignDepositAddress(): Promise<AssignedDepositAddress> {
  const active = await activeDepositAddresses();
  if (active.length === 0) {
    throw AppError.internal(
      'No USDT deposit address is configured. An administrator must add one in Settings before payments can be taken.',
    );
  }
  const address = active[crypto.randomInt(0, active.length)] as string;
  return { address, network: USDT_NETWORK, asset: USDT_ASSET };
}

/**
 * The address as a QR code, as a data URI so it goes straight into an `<img src>`.
 *
 * The payload is the bare address rather than a URI scheme: TRON wallets read a
 * plain address reliably, whereas the scheme-prefixed forms are inconsistently
 * supported and a wallet that cannot parse one shows nothing at all.
 */
export async function depositAddressQr(address: string): Promise<string> {
  return QRCode.toDataURL(address, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}

/** Everything a pay screen needs, for an address already assigned to a request. */
export interface DepositAddressView extends AssignedDepositAddress {
  qrDataUrl: string;
}

export async function depositAddressView(address: string): Promise<DepositAddressView> {
  return {
    address,
    network: USDT_NETWORK,
    asset: USDT_ASSET,
    qrDataUrl: await depositAddressQr(address),
  };
}

/**
 * The snapshot fields every payment request carries.
 *
 * One shape for all three flows, so a new one cannot accidentally record less
 * than the others.
 */
export interface PaymentSnapshot {
  depositAddress: string;
  depositNetwork: string;
  dmcPaisePerUsdt: number;
  usdtAmountMicros: number;
}

/** Quote and assign together — what every request-creating service calls. */
export async function openPayment(side: PayerSide, dmcPaise: number): Promise<PaymentSnapshot> {
  // Sequential rather than parallel: both halves read the same configuration,
  // and asking for it twice at once gains nothing while doubling the work on a
  // cache miss.
  const q = await quote(side, dmcPaise);
  const assigned = await assignDepositAddress();
  return {
    depositAddress: assigned.address,
    depositNetwork: assigned.network,
    dmcPaisePerUsdt: q.dmcPaisePerUsdt,
    usdtAmountMicros: q.usdtAmountMicros,
  };
}
