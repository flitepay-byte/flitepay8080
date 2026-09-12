/**
 * The deposit rule, stated once for the audit's own use.
 *
 * The harness must never ask the application what a deposit did — that would
 * make the check circular. It applies the rule itself: the configured
 * percentage is locked as security and the *remainder* becomes usable working
 * capital. The remainder is a subtraction rather than a second percentage, so
 * the two halves always add back to exactly what was posted and no paise can
 * be lost between them.
 */
import { getConfig } from '../../services/systemConfig.service';
import { percentOfPaise } from '../../utils/money';

export interface DepositSplit {
  lockedPaise: number;
  usablePaise: number;
}

export async function depositSplit(depositPaise: number): Promise<DepositSplit> {
  const config = await getConfig();
  const lockedPaise = percentOfPaise(depositPaise, config.collateralLockPercentage);
  return { lockedPaise, usablePaise: depositPaise - lockedPaise };
}
