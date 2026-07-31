import type { ActiveSlot } from "../shared/types.js";

// ── Room Watch -----------------------------------------------------------
//
// Pure evaluation: given a participant snapshot and timing info, decide
// whether the room looks empty and whether a sweep should trigger.
// All timing is in epoch ms; side-effects (sending emails, running sweeps)
// stay in the engine.

export type RoomWatchConfig = {
  enabled: boolean;
  /** Headcount below this (including Admiral) is "empty". */
  minParticipants: number;
  /** Ignore first N ms after room entry (people trickle in). */
  graceMs: number;
  /** Confirm below-threshold for N ms before triggering. */
  confirmMs: number;
  /** Retry interval between sweeps. */
  sweepRetryMs: number;
  /** Maximum sweeps per slot. */
  sweepMaxPerSlot: number;
  /** How many consecutive scrape failures before treating room as dead. */
  scrapeFailLeaveThreshold: number;
};

export type RoomWatchInput = {
  config: RoomWatchConfig;
  /** True when we are currently InRoom. */
  inRoom: boolean;
  /** True when in dry-run mode. */
  dryRun: boolean;
  /** Current time. */
  nowMs: number;
  /** When we entered this room (0 if not in room). */
  roomEnteredAtMs: number;
  /** When we first noticed headcount below threshold (null if above). */
  belowThresholdSinceMs: number | null;
  /** Consecutive scrape failures streak. */
  scrapeFailStreak: number;
  /** Whether the active room is an adopted one. */
  isAdopted: boolean;
  /** Current sweep count for this slot. */
  sweepsThisSlot: number;
  /** When the next re-sweep should fire (null if not waiting). */
  nextSweepRetryAtMs: number | null;
  /** Whether the sweep was halted for this slot (e.g. capped out). */
  sweepHalted: boolean;
};

export type ParticipantScrape = {
  /** Total headcount from the scrape. */
  count: number;
  /** True when the scrape itself succeeded. */
  scrapeOk: boolean;
};

export type RoomWatchDecision = {
  /** True when a room sweep should be queued. */
  doSweep: boolean;
  /** True when the room should be considered "dead" (leave + rejoin needed). */
  doScrapeDeadRejoin: boolean;
  /** Updated below-threshold timestamp. */
  belowThresholdSinceMs: number | null;
  /** Updated scrape fail streak. */
  scrapeFailStreak: number;
};

/**
 * Evaluate the latest participant scrape against the room-watch config.
 * Pure function — call it once per fresh scrape.
 */
export function evaluateRoomOccupancy(
  input: RoomWatchInput,
  scrape: ParticipantScrape
): RoomWatchDecision {
  if (!input.config.enabled || input.dryRun || !input.inRoom) {
    return {
      doSweep: false,
      doScrapeDeadRejoin: false,
      belowThresholdSinceMs: input.belowThresholdSinceMs,
      scrapeFailStreak: input.scrapeFailStreak
    };
  }

  let scrapeFailStreak = input.scrapeFailStreak;
  let doScrapeDeadRejoin = false;
  let belowThresholdSinceMs = input.belowThresholdSinceMs;

  if (!scrape.scrapeOk) {
    scrapeFailStreak += 1;
    if (scrapeFailStreak >= input.config.scrapeFailLeaveThreshold) {
      doScrapeDeadRejoin = true;
      scrapeFailStreak = 0;
    }
    return {
      doSweep: false,
      doScrapeDeadRejoin,
      belowThresholdSinceMs,
      scrapeFailStreak
    };
  }

  scrapeFailStreak = 0;

  // Still in grace period after entry.
  if (input.nowMs - input.roomEnteredAtMs < input.config.graceMs) {
    return {
      doSweep: false,
      doScrapeDeadRejoin: false,
      belowThresholdSinceMs,
      scrapeFailStreak
    };
  }

  let doSweep = false;

  if (scrape.count < input.config.minParticipants) {
    if (belowThresholdSinceMs == null) {
      belowThresholdSinceMs = input.nowMs;
    } else if (
      input.nowMs - belowThresholdSinceMs >= input.config.confirmMs &&
      !input.sweepHalted
    ) {
      doSweep = true;
      belowThresholdSinceMs = null; // reset after triggering
    }
  } else {
    belowThresholdSinceMs = null; // above threshold, reset
  }

  return {
    doSweep,
    doScrapeDeadRejoin: false,
    belowThresholdSinceMs,
    scrapeFailStreak
  };
}
