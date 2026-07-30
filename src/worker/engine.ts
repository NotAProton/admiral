import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { envBoolean, envNumber } from "../shared/config.js";
import { readdir, rm, stat } from "node:fs/promises";
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
import { ScheduleLoader, type ScheduleLoaderResult } from "./scheduleSource.js";
import { resolveJoinUrl } from "./resolveJoinUrl.js";
import { nextTransition } from "./stateMachine.js";

export class AdmiralEngine {
  private readonly events = new EventEmitter();
  private readonly heartbeat: HeartbeatTracker;
  private readonly bbb = new BbbSession();

  private config!: AdmiralConfig;
  private scheduleSource: import("../shared/types.js").ScheduleSource = "file";
  private scheduleLoadedAt = new Date().toISOString();
  private scheduleUrl: string | null = null;
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

  // Handoff re-join grace: after handing off to the user, block auto-rejoin
  // for this slot until the grace window expires. Stops the 90s flap loop.
  private handoffGraceUntilMs = 0;
  private handoffGraceSlotKey: string | null = null;
  private static readonly HANDOFF_GRACE_MS = envNumber("HANDOFF_GRACE_SECONDS", 240) * 1000;

  // Last active slot key (from the previous tick). When the active slot
  // changes, Admiral auto-joins the new class regardless of heartbeat status —
  // the heartbeat may still be "fresh" from the previous session (the user
  // clicked "Join Myself" and the PWA kept sending heartbeats).
  private lastActiveSlotKey: string | null = null;

  // Resolved BBB join URL cache: reuses the Moodle-resolved URL for the same
  // slot so repeated join attempts during a flap don't each do a full LMS login.
  private readonly resolvedJoinCache = new Map<string, { joinUrl: string; authStatePath: string }>();

  // Last-completed-tick timestamp for health/liveness checks (Fix 4).
  private lastTickMs = 0;
  private static readonly LIVENESS_THRESHOLD_MS = 180 * 1000;

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
  private scheduleLoader: ScheduleLoader | null = null;
  private schedulePoller: NodeJS.Timeout | null = null;

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
    this.scheduleLoader = new ScheduleLoader(resolve(this.configPath));
    const initial = await this.scheduleLoader.loadInitial();
    this.applyScheduleResult(initial);
    this.scheduleUrl = process.env.SCHEDULE_URL?.trim() ?? null;

    // Restore durable control state (standdowns, join backoff) from the database.
    const persisted = this.persistence.loadWorkerState();
    this.standdown = persisted.standdown;
    this.sessionStanddownSlot = persisted.sessionStanddownSlot;
    this.joinFailureStreak = persisted.joinFailureStreak;
    this.joinBackoffUntilMs = persisted.joinBackoffUntilMs;
    this.lastFailedSlotKey = persisted.lastFailedSlotKey;
    this.handoffGraceUntilMs = persisted.handoffGraceUntilMs;
    this.handoffGraceSlotKey = persisted.handoffGraceSlotKey;
    this.lastActiveSlotKey = persisted.lastActiveSlotKey;

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

    // Boot-time housekeeping: prune stale outbox rows (a multi-hour outage
    // should not flush yesterday's morning plan) and old debug artifacts
    // (a week of screenshots should not fill the VPS disk).
    this.center.pruneStaleOutbox();
    void this.pruneRuntimeArtifacts();

    this.reason = this.dryRun
      ? "Dry run mode enabled"
      : this.standdown
        ? "Standdown enabled (restored)"
        : "Ready";
    this.lastTickMs = Date.now();
    this.emitStatus();

    this.ticker = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    // Non-blocking first tick: start the interval and let the first tick run
    // in the background so the internal API can listen immediately. Otherwise
    // heartbeats and health checks are dead for up to ~2 min during a first join.
    void this.tick();

    // If a remote schedule URL is configured, upgrade to it as soon as possible
    // and poll for changes. This lets the user edit the schedule from a phone
    // browser (e.g. a GitHub gist) without SSH.
    if (this.scheduleLoader?.hasRemoteUrl()) {
      void this.reloadScheduleFromUrl();
      const pollSeconds = this.scheduleLoader.getPollIntervalSeconds();
      if (pollSeconds > 0) {
        this.schedulePoller = setInterval(() => {
          void this.reloadScheduleFromUrl();
        }, pollSeconds * 1000);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.schedulePoller) clearInterval(this.schedulePoller);
    this.schedulePoller = null;
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
      scheduleSource: this.scheduleSource,
      scheduleLoadedAt: this.scheduleLoadedAt,
      scheduleUrl: this.scheduleUrl,
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
    this.lastTickMs = Date.now();

    try {
      this.heartbeat.pruneOlderThan(this.config.heartbeat.missingThresholdSeconds * 12);

      this.activeSlot = getActiveSlot(this.config);
      this.upcomingSlot = getUpcomingSlot(this.config);

      // Evict stale join-URL cache entries when the active slot changes so an
      // expired URL from a previous class does not get reused.
      this.evictStaleJoinCache();

      // Clear handoff grace when the user's heartbeat is fresh (they're back
      // on the PWA, so the flap risk is gone) or when the grace slot has ended.
      if (this.handoffGraceSlotKey) {
        const heartbeatAge = this.heartbeat.getNewestAgeSeconds();
        const heartbeatFresh = heartbeatAge != null && heartbeatAge <= this.config.heartbeat.freshThresholdSeconds;
        const graceSlotEnded =
          !this.activeSlot || this.sessionKey(this.activeSlot) !== this.handoffGraceSlotKey;
        if (heartbeatFresh || graceSlotEnded || Date.now() >= this.handoffGraceUntilMs) {
          this.handoffGraceUntilMs = 0;
          this.handoffGraceSlotKey = null;
          this.persistControlState();
        }
      }

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
      const joinGraceActive =
        this.handoffGraceSlotKey != null &&
        this.activeSlot != null &&
        this.sessionKey(this.activeSlot) === this.handoffGraceSlotKey &&
        Date.now() < this.handoffGraceUntilMs;

      // Detect slot transition: a new class has started. When this is true,
      // Admiral auto-joins regardless of heartbeat status — the heartbeat may
      // still be "fresh" from the previous session (the user clicked "Join
      // Myself" and the PWA kept sending heartbeats). We override
      // heartbeatFresh to false so the state machine's fresh-heartbeat gate
      // doesn't block the new-slot join.
      const currentSlotKey = this.activeSlot ? this.sessionKey(this.activeSlot) : null;
      const newSlotStarted = currentSlotKey != null && currentSlotKey !== this.lastActiveSlotKey;
      this.lastActiveSlotKey = currentSlotKey;
      this.persistControlState();

      const effectiveHeartbeatFresh = newSlotStarted ? false : heartbeatFresh;

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
        heartbeatFresh: effectiveHeartbeatFresh,
        heartbeatMissing,
        duplicateConfirmed,
        standdown: this.standdown,
        sessionSuppressed,
        forceJoin: this.forceJoinPending,
        forceLeave: this.forceLeavePending,
        joinCompleted: false,
        leaveCompleted: false,
        joinBackoffActive,
        joinGraceActive,
        newSlotStarted
      });

      this.reason = transition.reason;

      if (transition.shouldAttemptJoin && this.state === "Out" && this.activeSlot) {
        this.state = "Joining";
        this.emitStatus();

        const joined = await this.performJoin(this.activeSlot);
        const follow = nextTransition("Joining", {
          hasActiveSlot: this.activeSlot != null,
          heartbeatFresh: effectiveHeartbeatFresh,
          heartbeatMissing,
          duplicateConfirmed,
          standdown: this.standdown,
          sessionSuppressed,
          forceJoin: false,
          forceLeave: this.forceLeavePending,
          joinCompleted: joined,
          leaveCompleted: false,
          joinBackoffActive,
          joinGraceActive,
          newSlotStarted
        });

        this.state = follow.nextState;
        this.reason = joined ? "Join completed" : "Join failed";
      } else if (transition.shouldAttemptLeave && this.state !== "Out") {
        this.state = "Leaving";
        this.emitStatus();

        const left = await this.performLeave();
        const follow = nextTransition("Leaving", {
          hasActiveSlot: this.activeSlot != null,
          heartbeatFresh: effectiveHeartbeatFresh,
          heartbeatMissing,
          duplicateConfirmed,
          standdown: this.standdown,
          sessionSuppressed,
          forceJoin: false,
          forceLeave: false,
          joinCompleted: false,
          leaveCompleted: left,
          joinBackoffActive,
          joinGraceActive,
          newSlotStarted
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
            // Set handoff re-join grace: block auto-rejoin for this slot for a
            // grace window so Admiral doesn't flap join/leave every ~90s while
            // the user is in the BBB app with the PWA backgrounded.
            if (this.currentRoomSlot) {
              this.handoffGraceSlotKey = this.sessionKey(this.currentRoomSlot);
              this.handoffGraceUntilMs = Date.now() + AdmiralEngine.HANDOFF_GRACE_MS;
            }
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

      // Non-blocking email flush: a slow/hung Resend API must never stall the
      // engine tick (which would block all future joins/leaves). The center's
      // own fetch has a 10s timeout; running it fire-and-forget keeps the tick
      // responsive even if that timeout triggers.
      void this.center.flushDue().catch((e) => {
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
      const slotKey = this.sessionKey(slot);
      const runtimeDir = runtimePrefixForSlot(slot);

      // Reuse the cached resolved join URL for this slot so repeated join
      // attempts during a flap don't each do a full Moodle login (~40/hour
      // without this). On failure the entry is evicted so an expired URL
      // self-heals on the next tick.
      let resolved = this.resolvedJoinCache.get(slotKey);
      if (!resolved) {
        resolved = await resolveJoinUrl({
          lmsUrl: process.env.LMS_URL ?? "",
          username: process.env.MOODLE_USERNAME,
          password: process.env.MOODLE_PASSWORD,
          classPageUrl: slot.classPageUrl,
          joinLinkText: slot.joinLinkText,
          headless: this.headless,
          postClickWaitMs: this.postClickWaitMs,
          runtimeDir
        });
        this.resolvedJoinCache.set(slotKey, resolved);
      }

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
      // Evict the cached resolved URL for this slot: a stale/expired URL is the
      // most likely cause of a join failure, so force a fresh resolve next time.
      this.resolvedJoinCache.delete(this.sessionKey(slot));

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

  /** Last time a tick completed (for health/liveness checks). */
  getLastTickMs(): number {
    return this.lastTickMs;
  }

  /** True if the engine has ticked recently enough to be considered alive. */
  isAlive(): boolean {
    return Date.now() - this.lastTickMs < AdmiralEngine.LIVENESS_THRESHOLD_MS;
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

  /** Drops join-URL cache entries that no longer match the active slot. */
  private evictStaleJoinCache(): void {
    const activeKey = this.activeSlot ? this.sessionKey(this.activeSlot) : null;
    for (const key of this.resolvedJoinCache.keys()) {
      if (key !== activeKey) this.resolvedJoinCache.delete(key);
    }
  }

  /**
   * Removes .runtime/worker/ files older than 7 days on boot so a week of
   * screenshots and debug logs cannot fill the VPS disk while you're away.
   */
  private async pruneRuntimeArtifacts(): Promise<void> {
    const dir = ".runtime/worker";
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // directory does not exist yet — nothing to prune
    }
    for (const name of entries) {
      try {
        const s = await stat(`${dir}/${name}`);
        if (s.mtimeMs < cutoff) await rm(`${dir}/${name}`, { recursive: true, force: true });
      } catch {
        // ignore individual file errors — pruning is best-effort
      }
    }
  }

  private async reloadScheduleFromUrl(): Promise<void> {
    if (!this.scheduleLoader) return;
    try {
      const result = await this.scheduleLoader.pollFromUrl();
      if ("keepCurrent" in result) {
        this.reason = `Schedule URL fetch failed: ${result.error}`;
        this.persistence.appendEvent({
          kind: "schedule_reload_failed",
          payload: { error: result.error, url: this.scheduleUrl }
        });
        this.emitStatus();
        return;
      }

      if (result.config === this.config || JSON.stringify(result.config) === JSON.stringify(this.config)) {
        this.scheduleLoadedAt = result.loadedAt.toISOString();
        this.scheduleSource = result.source;
        return;
      }

      this.applyScheduleResult(result);
      this.reason = "Schedule reloaded from URL";
      this.persistence.appendEvent({
        kind: "schedule_reloaded",
        payload: {
          source: result.source,
          url: this.scheduleUrl,
          courses: result.config.courses.map((c) => ({ courseId: c.courseId, className: c.className }))
        }
      });
      this.emitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reason = `Schedule reload error: ${message}`;
      this.persistence.appendEvent({
        kind: "schedule_reload_failed",
        payload: { error: message, url: this.scheduleUrl }
      });
      this.emitStatus();
    }
  }

  private applyScheduleResult(result: ScheduleLoaderResult): void {
    this.config = result.config;
    this.scheduleSource = result.source;
    this.scheduleLoadedAt = result.loadedAt.toISOString();
  }

  /** Snapshots durable control state to SQLite so it survives restarts. */
  private persistControlState(): void {
    this.persistence.saveWorkerState({
      standdown: this.standdown,
      sessionStanddownSlot: this.sessionStanddownSlot,
      joinFailureStreak: this.joinFailureStreak,
      joinBackoffUntilMs: this.joinBackoffUntilMs,
      lastFailedSlotKey: this.lastFailedSlotKey,
      currentRoomSlot: this.currentRoomSlot,
      handoffGraceUntilMs: this.handoffGraceUntilMs,
      handoffGraceSlotKey: this.handoffGraceSlotKey,
      lastActiveSlotKey: this.lastActiveSlotKey
    });
  }
}
