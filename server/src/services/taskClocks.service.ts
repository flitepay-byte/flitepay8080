import type { IParty, ITask } from '../models';

/**
 * TASK CLOCKS
 * -----------
 * The four deadlines a task lives by, and whose decision each one is.
 *
 * They belong to the party. A party knows what its own customers will wait
 * for — a food order and a bank transfer are not the same promise — so the
 * windows are agreed with them and every task they create runs on them. The
 * SystemConfig figures stay as the fallback for a party that has not asked for
 * anything different.
 *
 * They are deliberately *not* the captain's. A captain used to be able to hold
 * a longer completion window than the task's party had agreed with its own
 * customer, which meant the promise shown to the customer and the deadline the
 * captain was actually held to were two different numbers, and which one
 * applied depended on who picked the work up. The party makes the promise, so
 * the party sets the clock.
 *
 * Resolved once, when the task is created, and written onto the task. Reading
 * them back off the party later would let a settings change reach into work
 * already in flight — a captain who accepted a job with fifteen minutes on it
 * would find the clock had moved under them.
 */
export interface TaskClocks {
  /** How long the captain it is offered to has to accept, before it passes on. */
  acceptanceMinutes: number;
  /** How long the captain who claimed it has to finish. */
  completionMinutes: number;
  /** The hard ceiling from creation: past it an unclaimed task is given up on. */
  maxAgeMinutes: number;
  /** Grace for a captain whose task expired to say why, before it is reclaimed. */
  expiryAckMinutes: number;
  /**
   * How long the party has, after proof is submitted, to relay their
   * customer's answer before the payout approves itself.
   *
   * Counted from the proof, not from creation — but the *length* is settled at
   * creation with the rest, so a settings change cannot shorten a window
   * somebody is already waiting inside.
   *
   * Unlike the four above, this one is **global**. The others are each party's
   * promise to their own customers and differ by what they are selling; this
   * is how long the platform waits before deciding for itself, and a captain
   * who has already sent real money should wait the same time whoever they
   * happened to be working for. Admin sets it once, in Settings, and there is
   * deliberately no per-party or per-captain override.
   */
  confirmationMinutes: number;
}

/** The settings defaults, as SystemConfig stores them. */
export interface ClockConfig {
  taskAcceptanceMinutes: number;
  taskCompletionMinutes: number;
  taskMaxAgeMinutes: number;
  taskExpiryAckMinutes: number;
  customerConfirmationMinutes: number;
}

type PartyClocks = Pick<
  IParty,
  | 'acceptanceMinutes'
  | 'completionMinutes'
  | 'maxAgeMinutes'
  | 'expiryAckMinutes'
>;

/**
 * What this party's tasks run on: their own windows where they have set them,
 * the system defaults for the rest.
 *
 * Each of the four falls back on its own. A party that has set only a shorter
 * completion window keeps the default everywhere else, rather than having one
 * decision drag the other three along with it.
 */
export function clocksFor(config: ClockConfig, party?: Partial<PartyClocks> | null): TaskClocks {
  return {
    acceptanceMinutes: party?.acceptanceMinutes ?? config.taskAcceptanceMinutes,
    completionMinutes: party?.completionMinutes ?? config.taskCompletionMinutes,
    maxAgeMinutes: party?.maxAgeMinutes ?? config.taskMaxAgeMinutes,
    expiryAckMinutes: party?.expiryAckMinutes ?? config.taskExpiryAckMinutes,
    // Global, never the party's — see the field's note above.
    confirmationMinutes: config.customerConfirmationMinutes,
  };
}

/**
 * The clocks a task is actually running on.
 *
 * Off the task itself, because that is where they were settled when it was
 * created. The fallback to config is for rows written before tasks carried
 * their own clocks: those keep behaving exactly as they did, rather than
 * failing or silently running to zero.
 */
type StoredClocks = { [K in keyof TaskClocks]?: number | null };

export function clocksOf(task: StoredClocks, config: ClockConfig): TaskClocks {
  return {
    acceptanceMinutes: task.acceptanceMinutes ?? config.taskAcceptanceMinutes,
    completionMinutes: task.completionMinutes ?? config.taskCompletionMinutes,
    maxAgeMinutes: task.maxAgeMinutes ?? config.taskMaxAgeMinutes,
    expiryAckMinutes: task.expiryAckMinutes ?? config.taskExpiryAckMinutes,
    confirmationMinutes: task.confirmationMinutes ?? config.customerConfirmationMinutes,
  };
}

/** Narrow helper for the places that hold a whole task document. */
export const clocksOfTask = (task: ITask, config: ClockConfig): TaskClocks =>
  clocksOf(task as StoredClocks, config);
