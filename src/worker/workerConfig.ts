import { envBoolean, envNumber } from "../shared/config.js";

/**
 * All worker config knobs parsed once at construction time and injected.
 * Modules receive slices — no class-load-time `process.env` reads.
 */
export type WorkerConfig = {
  /** Path to the schedule JSON config file. */
  configPath: string;
  /** Engine tick interval in ms (default 5s). */
  tickIntervalMs: number;
  /** Timezone for schedule evaluation. */
  timezone: string;

  heartbeat: {
    intervalSeconds: number;
    freshThresholdSeconds: number;
    missingThresholdSeconds: number;
  };

  duplicateDetection: {
    confirmConsecutiveScrapes: number;
    scrapeIntervalSeconds: number;
  };

  /** Join-failure backoff cap. */
  joinBackoff: {
    maxConsecutiveFailures: number;
    backoffMs: number;
  };

  /** Handoff re-join grace: after handing off to user, block auto-rejoin for this long. */
  handoffGraceMs: number;

  /** Room watch (empty-room detection + sweep). */
  roomWatch: {
    enabled: boolean;
    minParticipants: number;
    graceMs: number;
    confirmMs: number;
    sweepRetryMs: number;
    sweepMaxPerSlot: number;
    probeSettleMs: number;
    scrapeFailLeaveThreshold: number;
  };

  /** Participant-count sampling interval. */
  participantSampleMs: number;

  /** Misc flags. */
  dryRun: boolean;
  headless: boolean;
  postClickWaitMs: number;

  /** Internal API port. */
  internalPort: number;
};

export function loadWorkerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    configPath: overrides?.configPath ?? process.env.SCHEDULE_CONFIG_PATH ?? "config/schedule.json",
    tickIntervalMs: overrides?.tickIntervalMs ?? Number(process.env.ENGINE_TICK_MS ?? 5_000),
    timezone: overrides?.timezone ?? "Asia/Kolkata",

    heartbeat: {
      intervalSeconds: overrides?.heartbeat?.intervalSeconds ?? 15,
      freshThresholdSeconds: overrides?.heartbeat?.freshThresholdSeconds ?? 20,
      missingThresholdSeconds: overrides?.heartbeat?.missingThresholdSeconds ?? 60
    },

    duplicateDetection: {
      confirmConsecutiveScrapes: overrides?.duplicateDetection?.confirmConsecutiveScrapes ?? 2,
      scrapeIntervalSeconds: overrides?.duplicateDetection?.scrapeIntervalSeconds ?? 10
    },

    joinBackoff: {
      maxConsecutiveFailures: overrides?.joinBackoff?.maxConsecutiveFailures ?? 3,
      backoffMs: overrides?.joinBackoff?.backoffMs ?? 2 * 60_000
    },

    handoffGraceMs:
      overrides?.handoffGraceMs ?? envNumber(process.env.HANDOFF_GRACE_SECONDS, 240) * 1000,

    roomWatch: {
      enabled:
        overrides?.roomWatch?.enabled ?? envBoolean(process.env.EMPTY_ROOM_DETECTION_ENABLED, true),
      minParticipants:
        overrides?.roomWatch?.minParticipants ?? envNumber(process.env.EMPTY_ROOM_MIN_PARTICIPANTS, 3),
      graceMs:
        overrides?.roomWatch?.graceMs ?? envNumber(process.env.EMPTY_ROOM_GRACE_SECONDS, 300) * 1000,
      confirmMs:
        overrides?.roomWatch?.confirmMs ?? envNumber(process.env.EMPTY_ROOM_CONFIRM_SECONDS, 300) * 1000,
      sweepRetryMs:
        overrides?.roomWatch?.sweepRetryMs ?? envNumber(process.env.ROOM_SWEEP_RETRY_SECONDS, 900) * 1000,
      sweepMaxPerSlot:
        overrides?.roomWatch?.sweepMaxPerSlot ?? envNumber(process.env.ROOM_SWEEP_MAX_PER_SLOT, 6),
      probeSettleMs:
        overrides?.roomWatch?.probeSettleMs ??
        envNumber(process.env.ROOM_SWEEP_PROBE_SETTLE_SECONDS, 25) * 1000,
      scrapeFailLeaveThreshold: overrides?.roomWatch?.scrapeFailLeaveThreshold ?? 3
    },

    participantSampleMs:
      overrides?.participantSampleMs ?? envNumber(process.env.PARTICIPANT_SAMPLE_SECONDS, 300) * 1000,

    dryRun: overrides?.dryRun ?? envBoolean(process.env.DRY_RUN, false),
    headless: overrides?.headless ?? envBoolean(process.env.HEADLESS, true),
    postClickWaitMs: overrides?.postClickWaitMs ?? envNumber(process.env.POST_CLICK_WAIT_MS, 20_000),

    internalPort: overrides?.internalPort ?? Number(process.env.INTERNAL_API_PORT ?? 8787)
  };
}
