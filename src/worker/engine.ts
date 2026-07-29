import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { envBoolean, envNumber, loadConfig } from "../shared/config.js";
import type {
  ActiveSlot,
  AdmiralConfig,
  AdmiralState,
  HistoryEvent,
  OverrideAction,
  ParticipantSnapshot,
  SessionStanddown,
  StatusResponse
} from "../shared/types.js";
import { BbbSession, runtimePrefixForSlot } from "./bbbSession.js";
import { HeartbeatTracker } from "./heartbeat.js";
import type { WorkerPersistence } from "./persistence.js";
import { NotificationCenter } from "./notifications.js";
import { getActiveSlot, getCurrentIstIso, getMostRecentEndedSlot, getUpcomingSlot } from "./schedule.js";
import { resolveJoinUrl } from "./resolveJoinUrl.js";
import { nextTransition } from "./stateMachine.js";

export class AdmiralEngine {
  private readonly events = new EventEmitter();
  private readonly heartbeat: HeartbeatTracker;
  private readonly bbb = new BbbSession();

  private config!: AdmiralConfig;
  private state: AdmiralState = "Out";
  private standdown = false;
  private reason = "Booting";

  private activeSlot: ActiveSlot | null = null;
  private upcomingSlot: ActiveSlot | null = null;
  private participantSnapshot: ParticipantSnapshot = { count: 0, names: [], nameExactMatchCount: 0 };
  private duplicateStreak = 0;
  private lastScrapeAtMs = 0;
  private bbbJoinUrl: string | null = null;
  private currentRoomSlot: ActiveSlot | null = null;
  private lastActiveSlotForSummary: ActiveSlot | null = null;
  private center!: NotificationCenter;

  private forceJoinPending = false;
  private forceLeavePending = false;

  // Per-session stand-down: suppress auto-join only for this specific slot.
  private sessionStanddownSlot: ActiveSlot | null = null;

  // Join-failure backoff cap.
  private static readonly MAX_CONSECUTIVE_JOIN_FAILURES = 3;
  private static readonly JOIN_BACKOFF_MS = 2 * 60_000;
  private joinFailureStreak = 0;
  private joinBackoffUntilMs = 0;
  private lastFailedSlotKey: string | null = null;

  private ticker: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  private readonly dryRun: boolean;
  private readonly headless: boolean;
  private readonly postClickWaitMs: number;

  constructor(
    private readonly configPath: string,
    private readonly tickIntervalMs: number,
    private readonly persistence: WorkerPersistence
  ) {
    this.dryRun = envBoolean(process.env.DRY_RUN, false);
    this.headless = envBoolean(process.env.HEADLESS, true);
    this.postClickWaitMs = envNumber(process.env.POST_CLICK_WAIT_MS, 20_000);
    // Hydrates the in-memory cache from SQLite; heartbeats stay fresh across restarts.
    this.heartbeat = new HeartbeatTracker(persistence);
  }

  async start(): Promise<void> {
    this.config = await loadConfig(resolve(this.configPath));

    // Restore durable control state (standdowns, join backoff) from the database.
    const persisted = this.persistence.loadWorkerState();
    this.standdown = persisted.standdown;
    this.sessionStanddownSlot = persisted.sessionStanddownSlot;
    this.joinFailureStreak = persisted.joinFailureStreak;
    this.joinBackoffUntilMs = persisted.joinBackoffUntilMs;
    this.lastFailedSlotKey = persisted.lastFailedSlotKey;

    // A room marker surviving to boot means the previous process died while
    // in-room: the browser is gone, so reset to Out and record the recovery.
    if (persisted.currentRoomSlot) {
      this.persistence.appendEvent({
        kind: "recovered_after_restart",
        slot: persisted.currentRoomSlot,
        payload: { note: "Process restarted while marked in-room; browser session lost. State reset to Out." }
      });
      this.currentRoomSlot = null;
      this.persistControlState();
    }

    // If the persisted session stand-down targets a slot that is no longer
    // active or upcoming, clear it immediately so the UI does not show a
    // stale stand-down until the first tick runs the regular GC.
    if (this.sessionStanddownSlot) {
      const key = this.sessionKey(this.sessionStanddownSlot);
      const now = getActiveSlot(this.config);
      const upcoming = getUpcomingSlot(this.config);
      const stillRelevant =
        (now && this.sessionKey(now) === key) ||
        (upcoming && this.sessionKey(upcoming) === key);
      if (!stillRelevant) {
        this.persistence.appendEvent({
          kind: "session_standdown_cleared",
          slot: this.sessionStanddownSlot,
          payload: { reason: "targeted slot already passed at boot" }
        });
        this.sessionStanddownSlot = null;
        this.persistControlState();
      }
    }

    // Recover a session summary that may have been missed if the worker
    // restarted right at a slot boundary, and seed slot-end tracking.
    this.recoverMissedSummary();
    this.lastActiveSlotForSummary = getActiveSlot(this.config);

    this.reason = this.dryRun
      ? "Dry run mode enabled"
      : this.standdown
        ? "Standdown enabled (restored)"
        : "Ready";
    this.emitStatus();

    this.ticker = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    await this.center.stop().catch(() => undefined);
    await this.bbb.leave().catch(() => undefined);
    // Clean shutdown: the room session is over, so clear the durable marker to
    // avoid a spurious recovered_after_restart event on next boot.
    if (this.currentRoomSlot) {
      this.currentRoomSlot = null;
      this.persistControlState();
    }
  }

  recordHeartbeat(deviceId: string): void {
    this.heartbeat.record(deviceId);
    this.emitStatus();
  }

  applyOverride(action: OverrideAction): void {
    if (action === "standdown_on") {
      this.standdown = true;
      this.reason = "Standdown enabled by override";
      this.center.enqueue({ kind: "standdown", payload: { active: true } });
    }

    if (action === "standdown_off") {
      this.standdown = false;
      this.reason = "Standdown disabled by override";
      this.center.enqueue({ kind: "standdown", payload: { active: false } });
    }

    if (action === "force_join") {
      this.forceJoinPending = true;
      this.reason = "Force-join requested";
    }

    if (action === "force_leave") {
      this.forceLeavePending = true;
      this.reason = "Force-leave requested";
    }

    if (action === "standdown_session") {
      const target = this.activeSlot ?? this.upcomingSlot;
      if (!target) {
        this.reason = "No active or upcoming session to stand down for";
        this.persistence.appendEvent({
          kind: "override",
          payload: { action, rejected: "no active or upcoming session" }
        });
        this.persistControlState();
        this.emitStatus();
        return;
      }
      this.sessionStanddownSlot = target;
      this.reason = `Stood down for ${target.className} at ${target.startedAt}`;
      // If we're currently in this specific slot, force-leave immediately.
      if (this.activeSlot && this.sessionKey(this.activeSlot) === this.sessionKey(target)) {
        if (this.state === "InRoom" || this.state === "Joining") {
          this.forceLeavePending = true;
        }
      }
      this.center.enqueue({ kind: "session_standdown", slot: target, payload: { slot: target, cancelled: false } });
    }

    if (action === "standdown_session_cancel") {
      const slot = this.sessionStanddownSlot;
      this.sessionStanddownSlot = null;
      this.reason = "Session stand-down cancelled";
      if (slot) {
        this.center.enqueue({ kind: "session_standdown", slot, payload: { slot, cancelled: true } });
      }
    }

    this.persistence.appendEvent({ kind: "override", payload: { action } });
    this.persistControlState();
    this.emitStatus();
  }

  getStatus(): StatusResponse {
    const heartbeatAge = this.heartbeat.getNewestAgeSeconds();
    const heartbeatFresh = heartbeatAge != null && heartbeatAge <= this.config.heartbeat.freshThresholdSeconds;
    const backoffRemaining = this.joinBackoffUntilMs > Date.now()
      ? Math.ceil((this.joinBackoffUntilMs - Date.now()) / 1000)
      : null;

    return {
      state: this.state,
      standdown: this.standdown,
      sessionStanddown: this.sessionStanddownSlot
        ? {
            courseId: this.sessionStanddownSlot.courseId,
            className: this.sessionStanddownSlot.className,
            startedAt: this.sessionStanddownSlot.startedAt
          }
        : null,
      reason: this.reason,
      activeSlot: this.activeSlot,
      upcomingSlot: this.upcomingSlot,
      currentIstTime: getCurrentIstIso(),
      schedule: this.config,
      participantCount: this.participantSnapshot.count,
      participantNames: this.participantSnapshot.names,
      duplicateConfirmed: this.duplicateStreak >= this.config.duplicateDetection.confirmConsecutiveScrapes,
      duplicateStreak: this.duplicateStreak,
      lastHeartbeatAgeSeconds: heartbeatAge,
      heartbeatFresh,
      updatedAt: new Date().toISOString(),
      bbbJoinUrl: this.bbbJoinUrl,
      joinBackoffActive: this.joinBackoffUntilMs > Date.now(),
      joinBackoffRemainingSeconds: backoffRemaining,
      emailBudget: this.center.getBudgetSnapshot()
    };
  }

  subscribe(listener: (status: StatusResponse) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
  }

  getHistory(limit: number, beforeId?: number): HistoryEvent[] {
    return this.persistence.listEvents(limit, beforeId);
  }

  private emitStatus(): void {
    this.events.emit("status", this.getStatus());
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      this.heartbeat.pruneOlderThan(this.config.heartbeat.missingThresholdSeconds * 12);

      this.activeSlot = getActiveSlot(this.config);
      this.upcomingSlot = getUpcomingSlot(this.config);

      // Scheduled daily emails (morning plan, 4pm wrap-up) and per-session
      // summary detection run on the same heartbeat as the rest of the tick.
      this.center.maybeFireScheduledDaily();
      this.detectSlotEndForSummary();

      // Garbage-collect session stand-down once the targeted slot is no longer
      // active or upcoming (the class window has fully passed).
      if (this.sessionStanddownSlot) {
        const key = this.sessionKey(this.sessionStanddownSlot);
        const stillRelevant =
          (this.activeSlot && this.sessionKey(this.activeSlot) === key) ||
          (this.upcomingSlot && this.sessionKey(this.upcomingSlot) === key);
        if (!stillRelevant) {
          this.persistence.appendEvent({
            kind: "session_standdown_cleared",
            slot: this.sessionStanddownSlot,
            payload: { reason: "targeted slot has passed" }
          });
          this.sessionStanddownSlot = null;
          this.persistControlState();
        }
      }

      if (this.state === "InRoom") {
        await this.refreshParticipantsIfDue();
      }

      const heartbeatAge = this.heartbeat.getNewestAgeSeconds();
      const heartbeatFresh = heartbeatAge != null && heartbeatAge <= this.config.heartbeat.freshThresholdSeconds;
      const heartbeatMissing = heartbeatAge == null || heartbeatAge >= this.config.heartbeat.missingThresholdSeconds;
      const duplicateConfirmed = this.duplicateStreak >= this.config.duplicateDetection.confirmConsecutiveScrapes;
      const joinBackoffActive = Date.now() < this.joinBackoffUntilMs;

      // Session stand-down suppresses auto-join for a specific slot. It is
      // passed as a separate gate signal (like backoff/duplicate) rather than
      // by falsifying hasActiveSlot, so the state machine keeps a truthful
      // picture of the schedule.
      const sessionSuppressed =
        this.activeSlot != null &&
        this.sessionStanddownSlot != null &&
        this.sessionKey(this.activeSlot) === this.sessionKey(this.sessionStanddownSlot);

      const transition = nextTransition(this.state, {
        hasActiveSlot: this.activeSlot != null,
        heartbeatFresh,
        heartbeatMissing,
        duplicateConfirmed,
        standdown: this.standdown,
        sessionSuppressed,
        forceJoin: this.forceJoinPending,
        forceLeave: this.forceLeavePending,
        joinCompleted: false,
        leaveCompleted: false,
        joinBackoffActive
      });

      this.reason = transition.reason;

      if (transition.shouldAttemptJoin && this.state === "Out" && this.activeSlot) {
        this.state = "Joining";
        this.emitStatus();

        const joined = await this.performJoin(this.activeSlot);
        const follow = nextTransition("Joining", {
          hasActiveSlot: this.activeSlot != null,
          heartbeatFresh,
          heartbeatMissing,
          duplicateConfirmed,
          standdown: this.standdown,
          sessionSuppressed,
          forceJoin: false,
          forceLeave: this.forceLeavePending,
          joinCompleted: joined,
          leaveCompleted: false,
          joinBackoffActive
        });

        this.state = follow.nextState;
        this.reason = joined ? "Join completed" : "Join failed";
      } else if (transition.shouldAttemptLeave && this.state !== "Out") {
        this.state = "Leaving";
        this.emitStatus();

        const left = await this.performLeave();
        const follow = nextTransition("Leaving", {
          hasActiveSlot: this.activeSlot != null,
          heartbeatFresh,
          heartbeatMissing,
          duplicateConfirmed,
          standdown: this.standdown,
          sessionSuppressed,
          forceJoin: false,
          forceLeave: false,
          joinCompleted: false,
          leaveCompleted: left,
          joinBackoffActive
        });

        this.state = follow.nextState;
        if (left) {
          this.persistence.appendEvent({
            kind: "leave_success",
            slot: this.currentRoomSlot,
            payload: { trigger: transition.reason }
          });
          // Only the handoff case gets its own email; other leave causes
          // are covered by the session summary or the standdown ack.
          if (transition.reason.includes("Duplicate")) {
            this.center.enqueue({
              kind: "handoff",
              slot: this.currentRoomSlot,
              payload: { slot: this.currentRoomSlot }
            });
          }

          this.participantSnapshot = { count: 0, names: [], nameExactMatchCount: 0 };
          this.duplicateStreak = 0;
          this.bbbJoinUrl = null;
          this.currentRoomSlot = null;
          this.persistControlState();
          this.reason = "Left room";
        } else {
          this.persistence.appendEvent({
            kind: "leave_failed",
            slot: this.currentRoomSlot,
            payload: { reason: this.reason }
          });
          this.reason = "Leave failed";
        }
      } else {
        this.state = transition.nextState;
      }

      this.forceJoinPending = false;
      this.forceLeavePending = false;
      this.emitStatus();

      await this.center.flushDue().catch((e) => {
        console.warn(`Notification flush failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    } catch (error) {
      this.reason = `Engine tick error: ${error instanceof Error ? error.message : String(error)}`;
      this.emitStatus();
    } finally {
      this.tickInFlight = false;
    }
  }

  private async refreshParticipantsIfDue(): Promise<void> {
    const now = Date.now();
    const intervalMs = this.config.duplicateDetection.scrapeIntervalSeconds * 1000;
    if (now - this.lastScrapeAtMs < intervalMs) return;
    this.lastScrapeAtMs = now;

    if (this.activeSlot == null) return;

    if (this.dryRun) {
      // Dry-run mode keeps participant state static while exercising transitions.
      return;
    }

    this.participantSnapshot = await this.bbb.scrapeParticipants(this.activeSlot.myDisplayName);
    if (this.participantSnapshot.nameExactMatchCount >= 2) {
      this.duplicateStreak += 1;
    } else {
      this.duplicateStreak = 0;
    }
  }

  private async performJoin(slot: ActiveSlot): Promise<boolean> {
    if (this.dryRun) {
      this.reason = `Dry-run: would join ${slot.courseId}`;
      // Reset failure tracking on a successful (dry-run) join.
      this.joinFailureStreak = 0;
      this.lastFailedSlotKey = null;
      this.persistControlState();
      this.persistence.appendEvent({ kind: "join_success", slot, payload: { dryRun: true } });
      return true;
    }

    try {
      const runtimeDir = runtimePrefixForSlot(slot);
      const resolved = await resolveJoinUrl({
        lmsUrl: process.env.LMS_URL ?? "",
        username: process.env.MOODLE_USERNAME,
        password: process.env.MOODLE_PASSWORD,
        classPageUrl: slot.classPageUrl,
        joinLinkText: slot.joinLinkText,
        headless: this.headless,
        postClickWaitMs: this.postClickWaitMs,
        runtimeDir
      });

      this.bbbJoinUrl = resolved.joinUrl;

      await this.bbb.join({
        joinUrl: resolved.joinUrl,
        authStatePath: resolved.authStatePath,
        headless: this.headless,
        moodleUsername: process.env.MOODLE_USERNAME,
        moodlePassword: process.env.MOODLE_PASSWORD,
        displayNameOverride: process.env.DISPLAY_NAME
      });

      await this.refreshParticipantsIfDue();
      this.currentRoomSlot = slot;

      // Successful join — clear failure tracking.
      this.joinFailureStreak = 0;
      this.lastFailedSlotKey = null;
      this.persistControlState();
      this.persistence.appendEvent({ kind: "join_success", slot });

      const coverKind = this.center.wasCoverStarted(this.sessionKey(slot))
        ? "cover_resume"
        : "cover_start";
      this.center.enqueue({
        kind: coverKind,
        slot,
        payload: { slot, joinUrl: resolved.joinUrl }
      });

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reason = `Join failed: ${message}`;

      // Clear the stale join URL — the join did not complete.
      this.bbbJoinUrl = null;

      // Track consecutive failures per slot and back off after the cap.
      const slotKey = this.sessionKey(slot);
      if (this.lastFailedSlotKey !== slotKey) {
        this.joinFailureStreak = 1;
        this.lastFailedSlotKey = slotKey;
      } else {
        this.joinFailureStreak += 1;
      }

      this.persistence.appendEvent({
        kind: "join_failure",
        slot,
        payload: { error: message, streak: this.joinFailureStreak }
      });

      if (this.joinFailureStreak >= AdmiralEngine.MAX_CONSECUTIVE_JOIN_FAILURES) {
        this.joinBackoffUntilMs = Date.now() + AdmiralEngine.JOIN_BACKOFF_MS;
        this.joinFailureStreak = 0;
        this.lastFailedSlotKey = null;
        const backoffMinutes = AdmiralEngine.JOIN_BACKOFF_MS / 60_000;
        this.persistence.appendEvent({
          kind: "join_backoff_start",
          slot,
          payload: { backoffMinutes, untilMs: this.joinBackoffUntilMs }
        });
        this.center.enqueue({
          kind: "action_needed",
          slot,
          payload: {
            reason: "retries_exhausted",
            failureCount: AdmiralEngine.MAX_CONSECUTIVE_JOIN_FAILURES,
            backoffMinutes
          }
        });
      }
      // Per-attempt join-failure emails are intentionally omitted: transient
      // failures are counted and surfaced in the session summary instead of
      // flooding the inbox (and burning the daily email budget).

      this.persistControlState();
      return false;
    }
  }

  private async performLeave(): Promise<boolean> {
    if (this.dryRun) {
      this.reason = "Dry-run: would leave room";
      return true;
    }

    try {
      await this.bbb.saveProof(".runtime/worker/leave");
      await this.bbb.leave();
      return true;
    } catch (error) {
      this.reason = `Leave failed: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  private sessionKey(slot: ActiveSlot): string {
    return `${slot.courseId}@${slot.startedAt}`;
  }

  /** Wires the notification center. Call once after construction, before start(). */
  attachNotificationCenter(center: NotificationCenter): void {
    this.center = center;
  }

  /** Enqueues a session summary when the active slot changes or ends. */
  private detectSlotEndForSummary(): void {
    const currentKey = this.activeSlot ? this.sessionKey(this.activeSlot) : null;
    if (this.lastActiveSlotForSummary) {
      const lastKey = this.sessionKey(this.lastActiveSlotForSummary);
      if (lastKey !== currentKey) {
        this.center.enqueue({ kind: "session_summary", slot: this.lastActiveSlotForSummary });
      }
    }
    this.lastActiveSlotForSummary = this.activeSlot;
  }

  /** Recovers a missed summary if the worker restarted at a slot boundary. */
  private recoverMissedSummary(): void {
    const recent = getMostRecentEndedSlot(this.config);
    if (!recent) return;
    if (this.center.wasSummarySent(this.sessionKey(recent))) return;
    this.center.enqueue({ kind: "session_summary", slot: recent });
  }

  /** Snapshots durable control state to SQLite so it survives restarts. */
  private persistControlState(): void {
    this.persistence.saveWorkerState({
      standdown: this.standdown,
      sessionStanddownSlot: this.sessionStanddownSlot,
      joinFailureStreak: this.joinFailureStreak,
      joinBackoffUntilMs: this.joinBackoffUntilMs,
      lastFailedSlotKey: this.lastFailedSlotKey,
      currentRoomSlot: this.currentRoomSlot
    });
  }
}
