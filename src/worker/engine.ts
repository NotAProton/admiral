import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { envBoolean, envNumber, loadConfig } from "../shared/config.js";
import type {
  ActiveSlot,
  AdmiralConfig,
  AdmiralState,
  OverrideAction,
  ParticipantSnapshot,
  SessionStanddown,
  StatusResponse
} from "../shared/types.js";
import { BbbSession, runtimePrefixForSlot } from "./bbbSession.js";
import { HeartbeatTracker } from "./heartbeat.js";
import {
  sendJoinFailureEmail,
  sendJoinRetriesExhaustedEmail,
  sendJoinSuccessEmail,
  sendLeaveSuccessEmail,
  sendSessionStanddownEmail,
  sendStanddownEmail
} from "./notifications.js";
import { getActiveSlot, getCurrentIstIso, getUpcomingSlot } from "./schedule.js";
import { resolveJoinUrl } from "./resolveJoinUrl.js";
import { nextTransition } from "./stateMachine.js";

export class AdmiralEngine {
  private readonly events = new EventEmitter();
  private readonly heartbeat = new HeartbeatTracker();
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
    private readonly tickIntervalMs: number
  ) {
    this.dryRun = envBoolean(process.env.DRY_RUN, false);
    this.headless = envBoolean(process.env.HEADLESS, true);
    this.postClickWaitMs = envNumber(process.env.POST_CLICK_WAIT_MS, 20_000);
  }

  async start(): Promise<void> {
    this.config = await loadConfig(resolve(this.configPath));
    this.reason = this.dryRun ? "Dry run mode enabled" : "Ready";
    this.emitStatus();

    this.ticker = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    await this.bbb.leave().catch(() => undefined);
  }

  recordHeartbeat(deviceId: string): void {
    this.heartbeat.record(deviceId);
    this.emitStatus();
  }

  applyOverride(action: OverrideAction): void {
    if (action === "standdown_on") {
      this.standdown = true;
      this.reason = "Standdown enabled by override";
      sendStanddownEmail(true).catch((e) => {
        console.warn(`Standdown-on email failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    if (action === "standdown_off") {
      this.standdown = false;
      this.reason = "Standdown disabled by override";
      sendStanddownEmail(false).catch((e) => {
        console.warn(`Standdown-off email failed: ${e instanceof Error ? e.message : String(e)}`);
      });
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
      sendSessionStanddownEmail(target, false).catch((e) => {
        console.warn(`Session-standdown email failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    if (action === "standdown_session_cancel") {
      const slot = this.sessionStanddownSlot;
      this.sessionStanddownSlot = null;
      this.reason = "Session stand-down cancelled";
      if (slot) {
        sendSessionStanddownEmail(slot, true).catch((e) => {
          console.warn(`Session-standdown-cancel email failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }

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
      joinBackoffRemainingSeconds: backoffRemaining
    };
  }

  subscribe(listener: (status: StatusResponse) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
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

      // Garbage-collect session stand-down once the targeted slot is no longer
      // active or upcoming (the class window has fully passed).
      if (this.sessionStanddownSlot) {
        const key = this.sessionKey(this.sessionStanddownSlot);
        const stillRelevant =
          (this.activeSlot && this.sessionKey(this.activeSlot) === key) ||
          (this.upcomingSlot && this.sessionKey(this.upcomingSlot) === key);
        if (!stillRelevant) {
          this.sessionStanddownSlot = null;
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

      // Suppress the active slot signal when the session stand-down targets it.
      const sessionSuppressed =
        this.activeSlot != null &&
        this.sessionStanddownSlot != null &&
        this.sessionKey(this.activeSlot) === this.sessionKey(this.sessionStanddownSlot);

      const transition = nextTransition(this.state, {
        hasActiveSlot: this.activeSlot != null && !sessionSuppressed,
        heartbeatFresh,
        heartbeatMissing,
        duplicateConfirmed,
        standdown: this.standdown,
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
          hasActiveSlot: this.activeSlot != null && !sessionSuppressed,
          heartbeatFresh,
          heartbeatMissing,
          duplicateConfirmed,
          standdown: this.standdown,
          forceJoin: false,
          forceLeave: this.forceLeavePending,
          joinCompleted: joined,
          leaveCompleted: false,
          joinBackoffActive
        });

        this.state = follow.nextState;
        this.reason = joined ? "Join completed" : "Join failed";
      } else if (transition.shouldAttemptLeave && (this.state === "InRoom" || this.state === "Joining")) {
        this.state = "Leaving";
        this.emitStatus();

        const left = await this.performLeave();
        const follow = nextTransition("Leaving", {
          hasActiveSlot: this.activeSlot != null && !sessionSuppressed,
          heartbeatFresh,
          heartbeatMissing,
          duplicateConfirmed,
          standdown: this.standdown,
          forceJoin: false,
          forceLeave: false,
          joinCompleted: false,
          leaveCompleted: left,
          joinBackoffActive
        });

        this.state = follow.nextState;
        if (left) {
          await sendLeaveSuccessEmail(this.currentRoomSlot).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Leave-success email failed: ${message}`);
          });

          this.participantSnapshot = { count: 0, names: [], nameExactMatchCount: 0 };
          this.duplicateStreak = 0;
          this.bbbJoinUrl = null;
          this.currentRoomSlot = null;
          this.reason = "Left room";
        } else {
          this.reason = "Leave failed";
        }
      } else {
        this.state = transition.nextState;
      }

      this.forceJoinPending = false;
      this.forceLeavePending = false;
      this.emitStatus();
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

      await sendJoinSuccessEmail(slot, resolved.joinUrl).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Join-success email failed: ${message}`);
      });

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reason = `Join failed: ${message}`;

      // Track consecutive failures per slot and back off after the cap.
      const slotKey = this.sessionKey(slot);
      if (this.lastFailedSlotKey !== slotKey) {
        this.joinFailureStreak = 1;
        this.lastFailedSlotKey = slotKey;
      } else {
        this.joinFailureStreak += 1;
      }

      if (this.joinFailureStreak >= AdmiralEngine.MAX_CONSECUTIVE_JOIN_FAILURES) {
        this.joinBackoffUntilMs = Date.now() + AdmiralEngine.JOIN_BACKOFF_MS;
        this.joinFailureStreak = 0;
        this.lastFailedSlotKey = null;
        const backoffMinutes = AdmiralEngine.JOIN_BACKOFF_MS / 60_000;
        await sendJoinRetriesExhaustedEmail(
          slot,
          AdmiralEngine.MAX_CONSECUTIVE_JOIN_FAILURES,
          backoffMinutes
        ).catch((e) => {
          console.warn(`Join-retries-exhausted email failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } else {
        await sendJoinFailureEmail(slot, message).catch((notifyError) => {
          const notifyMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
          console.warn(`Join-failure email failed: ${notifyMessage}`);
        });
      }

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
}
