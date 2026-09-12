/**
 * The fixed vocabulary a party rejects a proof with.
 *
 * A rejection carries two audiences with very different rights. The party
 * writes free text and admin reads it verbatim, because admin arbitrates the
 * dispute and needs every word. The next captain must not read that text: it
 * is an accusation about a different captain's work, it can name the party or
 * customer in ways the captain is not meant to learn, and it teaches whoever
 * picks the task up next exactly what the audit looked for last time.
 *
 * So the party also picks a category, and the category — not their sentence —
 * is what a later captain sees, rephrased as instruction rather than
 * complaint. The guidance says what to do differently; it never says who did
 * what wrong.
 */
export const REJECTION_CATEGORIES = {
  NOT_RECEIVED: {
    partyLabel: 'The money never reached the customer',
    captainGuidance:
      'An earlier attempt was reported as never arriving. Confirm the payout has actually landed before you submit proof.',
  },
  WRONG_DESTINATION: {
    partyLabel: 'Sent to the wrong account or UPI id',
    captainGuidance:
      'An earlier attempt went to the wrong destination. Check the payout details on this task character by character before paying.',
  },
  WRONG_AMOUNT: {
    partyLabel: 'The amount was wrong',
    captainGuidance:
      'An earlier attempt was for the wrong amount. Pay exactly the amount shown on this task — do not round it.',
  },
  PROOF_MISMATCH: {
    partyLabel: 'The proof or reference did not match',
    captainGuidance:
      'An earlier attempt’s proof did not match the payout on record. Submit the reference exactly as the payout returns it, with a legible receipt.',
  },
  OTHER: {
    partyLabel: 'Something else',
    captainGuidance:
      'An earlier attempt on this task was rejected. Work through it carefully and make sure your proof is complete before submitting.',
  },
} as const;

export type RejectionCategory = keyof typeof REJECTION_CATEGORIES;

export const REJECTION_CATEGORY_KEYS = Object.keys(REJECTION_CATEGORIES) as [
  RejectionCategory,
  ...RejectionCategory[],
];

/**
 * What a captain who did not do the rejected work is allowed to be told.
 * Null when there is nothing to warn them about.
 */
export function captainGuidanceFor(category: RejectionCategory | null | undefined): string | null {
  if (!category) return null;
  return REJECTION_CATEGORIES[category]?.captainGuidance ?? REJECTION_CATEGORIES.OTHER.captainGuidance;
}
