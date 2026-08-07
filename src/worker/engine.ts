import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { envBoolean, envNumber } from "../shared/config.js";
import { readdir, rm, stat } from "node:fs/promises";
import type {
  ActiveSlot,
  AppliedDayOverride,
  AdmiralConfig,
  AdmiralState,
  CourseConfig,
  DayOverrideOps,
  HistoryEvent,
  OverrideAction,
  ParticipantSample,
  ParticipantSnapshot,
  SessionStanddown,
  StatusResponse
} from "../shared/types.js";
import { istDateKey } from "../shared/istTime.js";
import { BbbSession, runtimePrefixForSlot } from "./bbbSession.js";
import { HeartbeatTracker } from "./heartbeat.js";
import type { WorkerPersistence } from "./persistence.js";
import { NotificationCenter } from "./notifications.js";
import {
  getActiveSlot,
  getCurrentIstDay,
  getCurrentIstIso,
  getDaySlots,
  getMostRecentEndedSlot,
  getUpcomingSlot,
  type DayOverrideIssue
} from "./schedule.js";
import { ScheduleLoader, type ScheduleLoaderResult } from "./scheduleSource.js";
import { resolveJoinUrl } from "./resolveJoinUrl.js";
import { decide, type World } from "../presence/decider.js";
import { computeOvertimeHold } from "../presence/overtime.js";
import { decideOverrideDrain, originStillEmpty } from "../presence/overrideDecide.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  private participantSnapshot: ParticipantSnapshot = { count: 0, names: [], nameExactMatchCount: 0, scrapeOk: false };
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

  // ── Room watch (empty-room detection + room sweep) ───────────────────────
  // Admiral now watches the
  // headcount of whatever room it is in; if it stays below
  // ROOM_MIN_PARTICIPANTS past a grace+confirm window, it leaves and probes
  // the other configured course rooms ("sweep"), adopting the first one with
  // enough people — mirroring what the user does by hand. If no room
  // qualifies, it rejoins the scheduled room (attendance-safe) and re-sweeps
  // on a timer until the slot ends.
  private static readonly ROOM_WATCH_ENABLED = envBoolean(process.env.EMPTY_ROOM_DETECTION_ENABLED, true);
  // Headcount includes Admiral itself: alone in a room reads 1.
  private static readonly ROOM_MIN_PARTICIPANTS = envNumber(process.env.EMPTY_ROOM_MIN_PARTICIPANTS, 3);
  private static readonly ROOM_EMPTY_GRACE_MS = envNumber(process.env.EMPTY_ROOM_GRACE_SECONDS, 300) * 1000;
  private static readonly ROOM_EMPTY_CONFIRM_MS = envNumber(process.env.EMPTY_ROOM_CONFIRM_SECONDS, 300) * 1000;
  private static readonly ROOM_SWEEP_RETRY_MS = envNumber(process.env.ROOM_SWEEP_RETRY_SECONDS, 900) * 1000;
  private static readonly ROOM_SWEEP_MAX_PER_SLOT = envNumber(process.env.ROOM_SWEEP_MAX_PER_SLOT, 6);
  private static readonly ROOM_SWEEP_PROBE_SETTLE_MS = envNumber(process.env.ROOM_SWEEP_PROBE_SETTLE_SECONDS, 25) * 1000;
  private static readonly SCRAPE_FAIL_LEAVE_THRESHOLD = 3;

  // The bot used to leave the instant the slot ended, but teachers often run a
  // few minutes over and take attendance in the overrun window -> absent. When
  // the meeting is still clearly alive (see presence/overtime.ts) Admiral now
  // stays past `endsAt` for up to SLOT_OVERTIME_MAX_SECONDS, leaving early if
  // the room empties, the user joins, or a new class is about to start (the
  // wrong-room guard) — a late-running class never delays the next one.
  private static readonly SLOT_OVERTIME_ENABLED = envBoolean(process.env.SLOT_OVERTIME_ENABLED, true);
  private static readonly SLOT_OVERTIME_MAX_MS = envNumber(process.env.SLOT_OVERTIME_MAX_SECONDS, 600) * 1000;
  private static readonly SLOT_OVERTIME_EMPTY_SCRAPES = envNumber(process.env.SLOT_OVERTIME_EMPTY_SCRAPES, 3);

  private roomEnteredAtMs = 0;
  private belowThresholdSinceMs: number | null = null;
  private scrapeFailStreak = 0;
  private scrapeFailRejoins = 0;
  private scrapeDeadRoomPending = false;
  private roomSweepPending = false;
  private sweepsThisSlot = 0;
  private sweepOriginSlotKey: string | null = null;
  private sweepHaltedForSlot = false;
  private nextRoomSweepAtMs: number | null = null;
  private adoptedFromSlotKey: string | null = null;
  private adoptedFromClassName: string | null = null;
  private lastEvaluatedScrapeAtMs = 0;

  // ── Slot overtime hold state ─────────────────────────────────────────────
  private overtimeActive = false;
  private overtimeSinceMs = 0;
  private overtimeBelowStreak = 0;
  private overtimeSlotKey: string | null = null;
  private overtimeEndCause: string | null = null;

  // ── Participant-count sampling (drives /participant-stats) ───────────────
  private static readonly PARTICIPANT_SAMPLE_MS = envNumber(process.env.PARTICIPANT_SAMPLE_SECONDS, 300) * 1000;
  private lastSampleAtMs = 0;

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
      const now = getActiveSlot(this.config, (d) => this.opsForDate(d));
      const upcoming = getUpcomingSlot(this.config, (d) => this.opsForDate(d));
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
    this.lastActiveSlotForSummary = getActiveSlot(this.config, (d) => this.opsForDate(d));

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
    const todayKey = istDateKey(Date.now());
    const todaySlots = getDaySlots(this.config, todayKey, this.opsForDate(todayKey)).slots;
    const todayOverrides = this.persistence.listDayOverrides(todayKey);
    const backoffRemaining = this.joinBackoffUntilMs > Date.now()
      ? Math.ceil((this.joinBackoffUntilMs - Date.now()) / 1000)
      : null;

    return {
      currentTime: getCurrentIstIso(),
      updatedAt: new Date().toISOString(),

      control: {
        state: this.state,
        reason: this.reason,
      },

      schedule: {
        config: this.config,
        source: this.scheduleSource,
        loadedAt: this.scheduleLoadedAt,
        url: this.scheduleUrl,
        activeSlot: this.activeSlot,
        upcomingSlot: this.upcomingSlot,
        todaySlots,
        todayOverrides,
      },

      presence: {
        currentRoom: this.currentRoomSlot
          ? {
              courseId: this.currentRoomSlot.courseId,
              className: this.currentRoomSlot.className,
              adopted: this.adoptedFromSlotKey != null,
              adoptedFromClassName: this.adoptedFromClassName,
              enteredAt: this.roomEnteredAtMs > 0 ? new Date(this.roomEnteredAtMs).toISOString() : null,
            }
          : null,
        participantCount: this.participantSnapshot.count,
        participantNames: this.participantSnapshot.names,
        duplicateConfirmed:
          this.duplicateStreak >= this.config.duplicateDetection.confirmConsecutiveScrapes,
        duplicateStreak: this.duplicateStreak,
        bbbJoinUrl: this.bbbJoinUrl,
        overtime: this.overtimeActive
          ? {
              active: true,
              since: this.overtimeSinceMs > 0 ? new Date(this.overtimeSinceMs).toISOString() : null,
              capSeconds: AdmiralEngine.SLOT_OVERTIME_MAX_MS / 1000
            }
          : null,
      },

      watch: {
        enabled: AdmiralEngine.ROOM_WATCH_ENABLED,
        minParticipants: AdmiralEngine.ROOM_MIN_PARTICIPANTS,
        scrapeOk: this.participantSnapshot.scrapeOk,
        belowThresholdSince: this.belowThresholdSinceMs != null
          ? new Date(this.belowThresholdSinceMs).toISOString()
          : null,
        sweepsThisSlot: this.sweepsThisSlot,
        maxSweepsPerSlot: AdmiralEngine.ROOM_SWEEP_MAX_PER_SLOT,
        nextSweepRetryAt: this.nextRoomSweepAtMs != null
          ? new Date(this.nextRoomSweepAtMs).toISOString()
          : null,
      },

      suppressions: {
        globalStanddown: this.standdown,
        sessionStanddown: this.sessionStanddownSlot
          ? {
              courseId: this.sessionStanddownSlot.courseId,
              className: this.sessionStanddownSlot.className,
              startedAt: this.sessionStanddownSlot.startedAt,
            }
          : null,
        joinBackoffActive: this.joinBackoffUntilMs > Date.now(),
        joinBackoffRemainingSeconds: backoffRemaining,
      },

      heartbeat: {
        fresh: heartbeatFresh,
        lastAgeSeconds: heartbeatAge,
      },

      email: this.center.getBudgetSnapshot(),
    };
  }

  subscribe(listener: (status: StatusResponse) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
  }

  getHistory(limit: number, beforeId?: number): HistoryEvent[] {
    return this.persistence.listEvents(limit, beforeId);
  }

  listDayOverrides(date?: string): AppliedDayOverride[] {
    return this.persistence.listDayOverrides(date ?? istDateKey(Date.now()));
  }

  addDayOverride(input: {
    date?: string;
    op: "cancel" | "swap" | "add";
    courseId?: string;
    a?: string;
    b?: string;
    start?: string;
    end?: string;
  }): { ok: true; id: number; issues: DayOverrideIssue[] } | { ok: false; error: string } {
    const date = input.date ?? istDateKey(Date.now());
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!dayRe.test(date)) {
      return { ok: false, error: "Invalid date format (expected YYYY-MM-DD)" };
    }

    let ops: DayOverrideOps;
    let summary: string;

    if (input.op === "cancel") {
      if (!input.courseId) return { ok: false, error: "courseId is required for cancel" };
      const course = this.config.courses.find((c) => c.courseId === input.courseId);
      if (!course) return { ok: false, error: `Unknown courseId: ${input.courseId}` };
      ops = { cancel: [input.courseId] };
      summary = `Cancelled ${course.courseId} ${course.className}`;
    } else if (input.op === "swap") {
      if (!input.a || !input.b) return { ok: false, error: "a and b are required for swap" };
      if (!hhmmRe.test(input.a) || !hhmmRe.test(input.b)) {
        return { ok: false, error: "a and b must be HH:MM" };
      }
      ops = { swap: [{ a: input.a, b: input.b }] };
      summary = `Swapped ${input.a} ↔ ${input.b}`;
    } else {
      if (!input.courseId) return { ok: false, error: "courseId is required for add" };
      if (!input.start || !input.end) return { ok: false, error: "start and end are required for add" };
      if (!hhmmRe.test(input.start) || !hhmmRe.test(input.end)) {
        return { ok: false, error: "start and end must be HH:MM" };
      }
      if (input.start >= input.end) {
        return { ok: false, error: "start must be earlier than end" };
      }
      const course = this.config.courses.find((c) => c.courseId === input.courseId);
      if (!course) return { ok: false, error: `Unknown courseId: ${input.courseId}` };
      ops = { add: [{ courseId: input.courseId, start: input.start, end: input.end }] };
      summary = `Added ${course.courseId} ${course.className} ${input.start}-${input.end}`;
    }

    const id = this.persistence.addDayOverride({ date, ops, source: "pwa" });
    const issues = getDaySlots(this.config, date, this.opsForDate(date)).issues;

    this.persistence.appendEvent({
      kind: "day_override_applied",
      payload: {
        id,
        date,
        op: input.op,
        courseId: input.courseId,
        a: input.a,
        b: input.b,
        start: input.start,
        end: input.end,
        issues
      }
    });

    const todayKey = istDateKey(Date.now());
    this.center.enqueue({
      kind: "day_override",
      payload: {
        date,
        summary: [summary],
        issues,
        ...(date === todayKey
          ? { todaySlots: getDaySlots(this.config, date, this.opsForDate(date)).slots }
          : {})
      }
    });
    this.emitStatus();
    return { ok: true, id, issues };
  }

  deleteDayOverride(id: number): boolean {
    const row = this.persistence.getDayOverride(id);
    const ok = this.persistence.deleteDayOverride(id);
    if (!ok) return false;

    const date = row?.date ?? istDateKey(Date.now());
    this.persistence.appendEvent({
      kind: "day_override_removed",
      payload: { id, date }
    });

    const todayKey = istDateKey(Date.now());
    this.center.enqueue({
      kind: "day_override",
      payload: {
        date,
        summary: [`Removed override #${id}`],
        issues: [],
        ...(date === todayKey
          ? { todaySlots: getDaySlots(this.config, date, this.opsForDate(date)).slots }
          : {})
      }
    });

    this.emitStatus();
    return true;
  }

  /** Participant-count time series for the /participant-stats dashboard. */
  getParticipantSamples(query: { fromMs?: number; toMs?: number; courseId?: string; limit?: number }): {
    samples: ParticipantSample[];
    minParticipants: number;
  } {
    const toMs = query.toMs ?? Date.now();
    const fromMs = query.fromMs ?? toMs - 24 * 60 * 60 * 1000;
    return {
      samples: this.persistence.listParticipantSamples({
        fromMs,
        toMs,
        courseId: query.courseId,
        limit: query.limit ?? 500
      }),
      minParticipants: AdmiralEngine.ROOM_MIN_PARTICIPANTS
    };
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

      this.activeSlot = getActiveSlot(this.config, (d) => this.opsForDate(d));
      this.upcomingSlot = getUpcomingSlot(this.config, (d) => this.opsForDate(d));

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

      // Room watch: evaluate the freshest scrape (empty-room + dead-scrape
      // handling), sample the headcount for /participant-stats, then run any
      // pending sweep/rejoin work before the state machine sees this tick.
      this.evaluateRoomOccupancy();
      this.maybeRecordParticipantSample();
      await this.maintainRoomCoverage();

      // ── SENSE: build World snapshot ─────────────────────────────────
      const now = Date.now();
      const heartbeatAge = this.heartbeat.getNewestAgeSeconds(now);
      const heartbeatFresh =
        heartbeatAge != null &&
        heartbeatAge <= this.config.heartbeat.freshThresholdSeconds;
      const heartbeatMissing =
        heartbeatAge == null ||
        heartbeatAge >= this.config.heartbeat.missingThresholdSeconds;

      // Detect slot transition: new class started.
      const currentSlotKey = this.activeSlot
        ? this.sessionKey(this.activeSlot)
        : null;
      const newSlotStarted =
        currentSlotKey != null &&
        this.lastActiveSlotKey != null &&
        currentSlotKey !== this.lastActiveSlotKey;
      this.lastActiveSlotKey = currentSlotKey;
      this.persistControlState();

      // Handoff grace: active within window for current slot.
      const joinGraceActive =
        this.handoffGraceSlotKey != null &&
        this.activeSlot != null &&
        this.sessionKey(this.activeSlot) === this.handoffGraceSlotKey &&
        now < this.handoffGraceUntilMs;

      // Session standdown: active when the schedule slot matches.
      const sessionSuppressed =
        this.activeSlot != null &&
        this.sessionStanddownSlot != null &&
        this.sessionKey(this.activeSlot) ===
          this.sessionKey(this.sessionStanddownSlot);

      const overtimeHold = this.computeOvertimeHold(now);

      const world: World = {
        state: this.state,
        hasActiveSlot: this.activeSlot != null,
        overtimeHold,
        activeSlot: this.activeSlot,
        heartbeatFresh: newSlotStarted ? false : heartbeatFresh,
        heartbeatMissing,
        newSlotStarted,
        duplicateConfirmed:
          this.duplicateStreak >=
          this.config.duplicateDetection.confirmConsecutiveScrapes,
        standdown: this.standdown,
        sessionSuppressed,
        joinBackoffActive: now < this.joinBackoffUntilMs,
        joinGraceActive,
        forceJoin: this.forceJoinPending,
        forceLeave: this.forceLeavePending,
        joinCompleted: false,
        leaveCompleted: false,
      };

      // ── DECIDE: pure target computation ─────────────────────────────
      const decision = decide(world);
      this.reason = decision.reason;

      // ── ACT: execute the primary decision ───────────────────────────
      if (decision.shouldAttemptJoin && this.state === "Out" && this.activeSlot) {
        await this.runJoinAction(world, now);
      } else if (decision.shouldAttemptLeave && this.state !== "Out") {
        await this.runLeaveAction({
          world,
          now,
          trigger: decision.reason,
          isHandoff: decision.reason.includes("Duplicate")
        });
      } else {
        this.state = decision.nextState;
      }

      // Re-drain (bounded to one extra action per tick): honor a force override
      // that arrived WHILE the primary action was in flight. A long join/leave
      // can run for minutes on flaky network (the train scenario), so an
      // override landing in that window must not be dropped — previously the
      // flags were unconditionally cleared at the end of the tick, silently
      // swallowing a Force Leave / Force Join tap. The pure decision keeps this
      // testable (presence/overrideDecide.ts).
      const drain = decideOverrideDrain({
        forceJoinPending: this.forceJoinPending,
        forceLeavePending: this.forceLeavePending,
        state: this.state,
        hasActiveSlot: this.activeSlot != null
      });
      if (drain.action === "leave") {
        await this.runLeaveAction({
          world: { ...world, state: this.state, forceJoin: false, forceLeave: true },
          now,
          trigger: "Manual force-leave override",
          isHandoff: false
        });
      } else if (drain.action === "join") {
        await this.runJoinAction({ ...world, state: this.state, forceJoin: true, forceLeave: false }, now);
      }

      // Drop any force override that is honored (already consumed inside the
      // action methods) or is NOT actionable this tick (e.g. force_join when no
      // class is active). Keeping a non-actionable flag around would fire it
      // unpredictably at a later slot.
      if (drain.consumeJoin) this.forceJoinPending = false;
      if (drain.consumeLeave) this.forceLeavePending = false;

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

  /**
   * Executes one join-to-room action and the resulting state transition.
   * Consumes `forceJoinPending` once the attempt is made (one-shot, matching the
   * original behaviour) so a force_join cannot spuriously re-fire, while still
   * being honored on the very tick it is set — even when set mid-flight.
   */
  private async runJoinAction(world: World, now: number): Promise<void> {
    this.state = "Joining";
    this.emitStatus();

    const joined = await this.performJoin(this.activeSlot!);
    const follow = decide({
      ...world,
      state: "Joining",
      forceJoin: false,
      joinCompleted: joined
    });
    this.state = follow.nextState;
    this.reason = joined ? "Join completed" : "Join failed";

    this.forceJoinPending = false;
  }

  /**
   * Executes one leave-room action and the resulting state transition
   * (leave_success / handoff grace / presence reset). Consumes `forceLeavePending`
   * once the attempt is made so a force_leave is honored even when set mid-flight
   * rather than silently dropped at the end of the tick.
   */
  private async runLeaveAction(opts: {
    world: World;
    now: number;
    trigger: string;
    isHandoff: boolean;
  }): Promise<void> {
    const { world, now, trigger, isHandoff } = opts;
    this.state = "Leaving";
    this.emitStatus();

    const left = await this.performLeave();
    const follow = decide({
      ...world,
      state: "Leaving",
      forceJoin: false,
      forceLeave: false,
      joinCompleted: false,
      leaveCompleted: left
    });
    this.state = follow.nextState;

    if (left) {
      const leavePayload: Record<string, unknown> = { trigger };
      if (this.overtimeEndCause) leavePayload.overtimeEndCause = this.overtimeEndCause;
      this.persistence.appendEvent({
        kind: "leave_success",
        slot: this.currentRoomSlot,
        payload: leavePayload
      });
      if (isHandoff) {
        this.center.enqueue({
          kind: "handoff",
          slot: this.currentRoomSlot,
          payload: { slot: this.currentRoomSlot }
        });
        if (this.currentRoomSlot) {
          this.handoffGraceSlotKey = this.sessionKey(this.currentRoomSlot);
          this.handoffGraceUntilMs = now + AdmiralEngine.HANDOFF_GRACE_MS;
        }
      }
      this.resetRoomPresence();
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

    this.forceLeavePending = false;
  }

  private async refreshParticipantsIfDue(force = false): Promise<void> {
    const now = Date.now();
    const intervalMs = this.config.duplicateDetection.scrapeIntervalSeconds * 1000;
    if (!force && now - this.lastScrapeAtMs < intervalMs) return;
    this.lastScrapeAtMs = now;

    // Scrape the room Admiral is actually in — after an empty-room sweep that
    // can be an adopted room rather than the scheduled slot's room.
    const room = this.currentRoomSlot ?? this.activeSlot;
    if (room == null) return;

    if (this.dryRun) {
      // Dry-run mode keeps participant state static while exercising transitions.
      return;
    }

    this.participantSnapshot = await this.bbb.scrapeParticipants(room.myDisplayName);
    if (this.participantSnapshot.nameExactMatchCount >= 2) {
      this.duplicateStreak += 1;
    } else {
      this.duplicateStreak = 0;
    }
  }

  // ── Room watch ────────────────────────────────────────────────────────────

  /**
   * Evaluates the freshest participant scrape while InRoom. Two failure modes:
   *  - the scrape keeps failing: the client fell out of the room → leave and
   *    rejoin once; if it keeps happening, treat the room like an empty one
   *    (a room Admiral can't observe is a room it can't cover in).
   *  - the headcount stays below ROOM_MIN_PARTICIPANTS past the grace+confirm
   *    windows → trigger a room sweep.
   * Runs at most once per fresh scrape (scrapes have their own interval), and
   * never in dry-run (whose static zero snapshot would look "empty").
   */
  private evaluateRoomOccupancy(): void {
    if (this.dryRun || !AdmiralEngine.ROOM_WATCH_ENABLED) return;
    if (this.state !== "InRoom" || this.currentRoomSlot == null) return;
    if (this.lastScrapeAtMs === 0 || this.lastScrapeAtMs === this.lastEvaluatedScrapeAtMs) return;
    this.lastEvaluatedScrapeAtMs = this.lastScrapeAtMs;

    const now = Date.now();
    const snapshot = this.participantSnapshot;

    if (!snapshot.scrapeOk) {
      this.scrapeFailStreak += 1;
      if (this.scrapeFailStreak >= AdmiralEngine.SCRAPE_FAIL_LEAVE_THRESHOLD) {
        this.scrapeFailStreak = 0;
        this.scrapeDeadRoomPending = true;
      }
      return;
    }
    this.scrapeFailStreak = 0;

    // While holding the room in overtime, the overtime logic owns empty-room
    // detection (it exits on the same headcount signal but on a faster cadence).
    // Keep dead-scrape handling above (a truly-ended meeting must still leave),
    // but skip the slower room-watch empty/sweep path.
    if (this.overtimeActive) return;

    // Grace period: people trickle in after the join, and classes start late.
    if (now - this.roomEnteredAtMs < AdmiralEngine.ROOM_EMPTY_GRACE_MS) return;

    if (snapshot.count < AdmiralEngine.ROOM_MIN_PARTICIPANTS) {
      if (this.belowThresholdSinceMs == null) this.belowThresholdSinceMs = now;
      const belowForMs = now - this.belowThresholdSinceMs;
      if (belowForMs >= AdmiralEngine.ROOM_EMPTY_CONFIRM_MS) {
        this.persistence.appendEvent({
          kind: "room_empty_detected",
          slot: this.currentRoomSlot,
          payload: {
            count: snapshot.count,
            minParticipants: AdmiralEngine.ROOM_MIN_PARTICIPANTS,
            belowThresholdForSeconds: Math.round(belowForMs / 1000),
            adopted: this.adoptedFromSlotKey != null
          }
        });
        this.belowThresholdSinceMs = null;
        this.roomSweepPending = true;
      }
    } else {
      this.belowThresholdSinceMs = null;
    }
  }

  /** Stores the headcount every PARTICIPANT_SAMPLE_MS while InRoom, fresh scrapes only. */
  private maybeRecordParticipantSample(): void {
    if (this.dryRun || this.state !== "InRoom" || this.currentRoomSlot == null) return;
    if (!this.participantSnapshot.scrapeOk) return; // never persist a fake zero
    if (this.lastScrapeAtMs === 0 || this.lastScrapeAtMs <= this.lastSampleAtMs) return;
    if (Date.now() - this.lastSampleAtMs < AdmiralEngine.PARTICIPANT_SAMPLE_MS) return;
    this.recordParticipantSample();
  }

  private recordParticipantSample(): void {
    if (this.dryRun || this.currentRoomSlot == null || !this.participantSnapshot.scrapeOk) return;
    this.lastSampleAtMs = Date.now();
    this.persistence.insertParticipantSample({
      tsMs: this.lastSampleAtMs,
      slotKey: this.sessionKey(this.currentRoomSlot),
      courseId: this.currentRoomSlot.courseId,
      className: this.currentRoomSlot.className,
      participantCount: this.participantSnapshot.count,
      adopted: this.adoptedFromSlotKey != null
    });
  }

  /** Resets room-watch state and records the baseline sample on room entry. */
  private onEnteredRoom(): void {
    this.roomEnteredAtMs = Date.now();
    this.belowThresholdSinceMs = null;
    this.scrapeFailStreak = 0;
    this.lastEvaluatedScrapeAtMs = 0;
    this.recordParticipantSample();
  }

  /** Clears all per-room state after leaving any room (scheduled or adopted). */
  private resetRoomPresence(): void {
    this.participantSnapshot = { count: 0, names: [], nameExactMatchCount: 0, scrapeOk: false };
    this.duplicateStreak = 0;
    this.bbbJoinUrl = null;
    this.currentRoomSlot = null;
    this.adoptedFromSlotKey = null;
    this.adoptedFromClassName = null;
    this.roomEnteredAtMs = 0;
    this.belowThresholdSinceMs = null;
    this.scrapeFailStreak = 0;
    this.lastEvaluatedScrapeAtMs = 0;
    this.clearOvertime();
  }

  /** Resets all overtime-hold bookkeeping (after any leave or a real slot resumes). */
  private clearOvertime(): void {
    this.overtimeActive = false;
    this.overtimeSinceMs = 0;
    this.overtimeBelowStreak = 0;
    this.overtimeSlotKey = null;
    // overtimeEndCause is intentionally NOT cleared here: it is set in sense()
    // right before a leave and consumed by the leave_success event in the same
    // tick (resetRoomPresence runs after that append). It self-resets each tick.
  }

  /**
   * Slot-overtime hold: whether to keep the scheduled room open past its end
   * (see presence/overtime.ts). Advances overtime bookkeeping and records the
   * hold start / end-cause for the audit log. Returns the `overtimeHold` signal
   * the decider consumes via World.
   */
  private computeOvertimeHold(nowMs: number): boolean {
    this.overtimeEndCause = null;
    if (!AdmiralEngine.SLOT_OVERTIME_ENABLED) {
      this.clearOvertime();
      return false;
    }
    // Overtime only while physically in the scheduled room.
    if (this.state !== "InRoom" || this.adoptedFromSlotKey != null || this.currentRoomSlot == null) {
      this.clearOvertime();
      return false;
    }

    // A real active slot always wins: stop holding so the wrong-room guard can
    // leave for the next class. Remember why we stopped for the leave event.
    if (this.activeSlot != null) {
      if (this.overtimeActive && this.overtimeSlotKey === this.sessionKey(this.currentRoomSlot)) {
        this.overtimeEndCause = "next_slot";
      }
      this.clearOvertime();
      return false;
    }

    const decision = computeOvertimeHold({
      nowMs,
      state: this.state,
      activeSlot: this.activeSlot,
      roomSlot: this.currentRoomSlot,
      adopted: false,
      snapshot: this.participantSnapshot,
      belowStreak: this.overtimeBelowStreak,
      config: {
        enabled: true, // gated by SLOT_OVERTIME_ENABLED above
        maxMs: AdmiralEngine.SLOT_OVERTIME_MAX_MS,
        minParticipants: AdmiralEngine.ROOM_MIN_PARTICIPANTS,
        emptyScrapes: AdmiralEngine.SLOT_OVERTIME_EMPTY_SCRAPES
      }
    });

    this.overtimeBelowStreak = decision.hold ? decision.belowStreak : 0;

    if (decision.hold) {
      if (!this.overtimeActive) {
        this.overtimeActive = true;
        this.overtimeSinceMs = nowMs;
        this.overtimeSlotKey = this.sessionKey(this.currentRoomSlot);
        // Overtime owns empty-exit now; a stale room-watch "below threshold"
        // marker from the slot's tail must not set off the empty-room pill.
        this.belowThresholdSinceMs = null;
        this.persistence.appendEvent({
          kind: "overtime_hold_start",
          slot: this.currentRoomSlot,
          payload: {
            slotEnd: this.currentRoomSlot.endsAt,
            capSeconds: AdmiralEngine.SLOT_OVERTIME_MAX_MS / 1000,
            participantCount: this.participantSnapshot.scrapeOk
              ? this.participantSnapshot.count
              : null
          }
        });
      }
      return true;
    }

    // Hold dropped: record why so the upcoming leave_success can say so.
    this.overtimeEndCause = decision.endCause ?? this.overtimeEndCause;
    this.overtimeActive = false;
    return false;
  }

  /**
   * Room-coverage maintenance, run each tick before the state machine
   * transition: ends adoptions whose origin slot passed, fires the re-sweep
   * timer, and executes pending scrape-dead rejoins / room sweeps. Kept out of
   * the pure state machine on purpose (conservative boundary): like
   * performJoin/performLeave, this is engine orchestration.
   */
  private async maintainRoomCoverage(): Promise<void> {
    if (this.dryRun) return;
    const now = Date.now();

    // (a) Leave an adopted room once its origin slot is over or the active
    // slot changed (back-to-back slots, or a schedule hot-reload — the normal
    // join logic then picks up the correct current slot).
    if (this.state === "InRoom" && this.adoptedFromSlotKey != null) {
      const currentKey = this.activeSlot ? this.sessionKey(this.activeSlot) : null;
      if (currentKey !== this.adoptedFromSlotKey) {
        await this.endAdoption("Origin slot ended");
      }
    }

    // (a2) A scheduled-room occupancy that no longer matches the active slot
    // (back-to-back / zero-gap slots, an override swap, or a new class starting
    // during overtime) must leave so the normal join logic picks up the correct
    // current slot. Adopted rooms are handled by (a) above.
    if (
      this.state === "InRoom" &&
      this.adoptedFromSlotKey == null &&
      this.currentRoomSlot != null &&
      this.activeSlot != null &&
      this.sessionKey(this.activeSlot) !== this.sessionKey(this.currentRoomSlot)
    ) {
      this.persistence.appendEvent({
        kind: "leave_success",
        slot: this.currentRoomSlot,
        payload: {
          trigger: "Next class starting",
          ...(this.overtimeActive ? { overtimeEndCause: "next_slot" } : {})
        }
      });
      await this.performLeave();
      this.state = "Out";
      this.reason = "Next class starting";
      this.resetRoomPresence();
      this.persistControlState();
      this.emitStatus();
    }

    // (b) Drop the re-sweep timer once its origin slot has passed.
    if (this.nextRoomSweepAtMs != null) {
      const currentKey = this.activeSlot ? this.sessionKey(this.activeSlot) : null;
      if (currentKey == null || currentKey !== this.sweepOriginSlotKey) {
        this.nextRoomSweepAtMs = null;
      }
    }

    // (c) Re-sweep timer fired while sitting in the empty scheduled room.
    if (
      this.nextRoomSweepAtMs != null &&
      now >= this.nextRoomSweepAtMs &&
      this.state === "InRoom" &&
      this.adoptedFromSlotKey == null &&
      this.activeSlot != null &&
      this.sessionKey(this.activeSlot) === this.sweepOriginSlotKey
    ) {
      this.roomSweepPending = true;
    }

    // (d) Scrape-dead room: leave + rejoin once; on repeat (or when an adopted
    // room died), treat the room like an empty one and sweep instead.
    if (this.scrapeDeadRoomPending) {
      this.scrapeDeadRoomPending = false;
      await this.handleScrapeDeadRoom();
    }

    // (e) Run a pending sweep. Sweep initiation is NOT gated on the heartbeat:
    // a genuinely moved class is still hunted even while the dashboard is open.
    // The per-probe abort in performRoomSweep (fresh heartbeat) plus the origin
    // re-verification (Part B) are what keep us from abandoning a user who
    // joined their class late — not gating the start itself.
    if (this.roomSweepPending) {
      this.roomSweepPending = false;
      if (
        AdmiralEngine.ROOM_WATCH_ENABLED &&
        (this.state === "InRoom" || this.state === "Out") &&
        this.activeSlot != null &&
        !this.sweepHaltedForSlot
      ) {
        await this.performRoomSweep();
      }
    }
  }

  private async handleScrapeDeadRoom(): Promise<void> {
    const room = this.currentRoomSlot;
    if (room == null) return;

    this.persistence.appendEvent({
      kind: "room_scrape_failed",
      slot: room,
      payload: {
        consecutiveFailures: AdmiralEngine.SCRAPE_FAIL_LEAVE_THRESHOLD,
        rejoinAttempts: this.scrapeFailRejoins
      }
    });

    if (this.state === "InRoom") {
      await this.performLeave();
      this.state = "Out";
    }
    const wasAdopted = this.adoptedFromSlotKey != null;
    this.resetRoomPresence();
    this.persistControlState();
    this.emitStatus();

    if (wasAdopted || this.scrapeFailRejoins >= 1) {
      // Repeatedly unobservable (or an adopted room died): same handling as an
      // empty room — probe the other course rooms instead of flapping here.
      if (!this.sweepHaltedForSlot) this.roomSweepPending = true;
      return;
    }

    this.scrapeFailRejoins += 1;
    if (this.activeSlot != null) {
      const joined = await this.performJoin(this.activeSlot, {
        suppressCoverEmail: true,
        rejoinReason: "scrape_dead_rejoin"
      });
      this.state = joined ? "InRoom" : "Out";
    }
  }

  /** Leaves an adopted room and resets presence so normal logic resumes. */
  private async endAdoption(reason: string): Promise<void> {
    const room = this.currentRoomSlot;
    this.persistence.appendEvent({ kind: "room_adopted_end", slot: room, payload: { reason } });
    await this.performLeave();
    this.state = "Out";
    this.resetRoomPresence();
    this.persistControlState();
    this.reason = reason;
    this.emitStatus();
  }

  private async performJoin(
    slot: ActiveSlot,
    opts?: { suppressCoverEmail?: boolean; rejoinReason?: string }
  ): Promise<boolean> {
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
      this.lastTickMs = Date.now();
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
        displayNameOverride: slot.myDisplayName
      });
      this.lastTickMs = Date.now();

      this.currentRoomSlot = slot;
      // Force a fresh scrape so duplicate detection and the baseline sample
      // start from the room just entered, not a stale snapshot.
      await this.refreshParticipantsIfDue(true);
      this.onEnteredRoom();

      // Successful join — clear failure tracking.
      this.joinFailureStreak = 0;
      this.lastFailedSlotKey = null;
      this.persistControlState();
      this.persistence.appendEvent({
        kind: "join_success",
        slot,
        payload: opts?.rejoinReason ? { reason: opts.rejoinReason } : undefined
      });

      // Sweep-driven rejoins of the scheduled room skip the cover email: the
      // 15-min retry cycle would otherwise burn the per-session email caps.
      if (!opts?.suppressCoverEmail) {
        const coverKind = this.center.wasCoverStarted(this.sessionKey(slot))
          ? "cover_resume"
          : "cover_start";
        this.center.enqueue({
          kind: coverKind,
          slot,
          payload: { slot, joinUrl: resolved.joinUrl }
        });
      }

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
      this.lastTickMs = Date.now();
      await this.bbb.saveProof(".runtime/worker/leave");
      await this.bbb.leave();
      this.lastTickMs = Date.now();
      return true;
    } catch (error) {
      this.reason = `Leave failed: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  // ── Room sweep ────────────────────────────────────────────────────────────

  /**
   * Courses to probe during a sweep: every configured course except the origin
   * (a moved class could have landed in any of them), courses with a slot on
   * today's IST date first, the rest in config order.
   */
  private sweepCandidates(originSlot: ActiveSlot): CourseConfig[] {
    const today = getCurrentIstDay();
    const others = this.config.courses.filter((c) => c.courseId !== originSlot.courseId);
    const hasSlotToday = (c: CourseConfig): boolean => c.weeklySlots.some((s) => s.days.includes(today));
    return [...others.filter(hasSlotToday), ...others.filter((c) => !hasSlotToday(c))];
  }

  /**
   * Joins a candidate room and counts heads after a short settle. When the
   * room qualifies the browser session is LEFT IN PLACE so adoption keeps the
   * very same room; otherwise the room is left quietly before the next probe.
   * Debug artifacts land in their own .runtime dir like the normal join path.
   */
  private async probeRoom(course: CourseConfig): Promise<{
    count: number;
    scrapeOk: boolean;
    joinUrl: string | null;
    authStatePath: string | null;
    snapshot: ParticipantSnapshot | null;
    error?: string;
  }> {
    const safeCourse = course.courseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runtimeDir = `.runtime/worker/probe-${safeCourse}-${timestamp}`;
    try {
      const resolved = await resolveJoinUrl({
        lmsUrl: process.env.LMS_URL ?? "",
        username: process.env.MOODLE_USERNAME,
        password: process.env.MOODLE_PASSWORD,
        classPageUrl: course.classPageUrl,
        joinLinkText: course.joinLinkText,
        headless: this.headless,
        postClickWaitMs: this.postClickWaitMs,
        runtimeDir
      });

      await this.bbb.join({
        joinUrl: resolved.joinUrl,
        authStatePath: resolved.authStatePath,
        headless: this.headless,
        moodleUsername: process.env.MOODLE_USERNAME,
        moodlePassword: process.env.MOODLE_PASSWORD,
        displayNameOverride: course.myDisplayName
      });

      // Participants render asynchronously; settle, then take the better of
      // two scrapes so a half-rendered list can't read as "empty".
      await sleep(AdmiralEngine.ROOM_SWEEP_PROBE_SETTLE_MS);
      const first = await this.bbb.scrapeParticipants(course.myDisplayName);
      await sleep(5_000);
      const second = await this.bbb.scrapeParticipants(course.myDisplayName);
      const best = !first.scrapeOk
        ? second
        : !second.scrapeOk
          ? first
          : second.count >= first.count
            ? second
            : first;

      if (best.scrapeOk && best.count >= AdmiralEngine.ROOM_MIN_PARTICIPANTS) {
        return { count: best.count, scrapeOk: true, joinUrl: resolved.joinUrl, authStatePath: resolved.authStatePath, snapshot: best };
      }

      await this.bbb.leave().catch(() => undefined);
      return { count: best.count, scrapeOk: best.scrapeOk, joinUrl: null, authStatePath: null, snapshot: best };
    } catch (error) {
      return {
        count: 0,
        scrapeOk: false,
        joinUrl: null,
        authStatePath: null,
        snapshot: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Leaves the current (empty or scrape-dead) room and probes the other
   * configured course rooms, adopting the first one with enough people — what
   * the user does by hand when their class is empty. If no room qualifies, it
   * rejoins the scheduled room (attendance-safe, the user's chosen behaviour)
   * and arms the re-sweep timer. Capped per slot so a bad day can't roam forever.
   */
  private async performRoomSweep(): Promise<void> {
    const originSlot = this.activeSlot;
    if (originSlot == null) return;

    const originKey = this.sessionKey(originSlot);
    if (this.sweepOriginSlotKey !== originKey) {
      this.sweepOriginSlotKey = originKey;
      this.sweepsThisSlot = 0;
      this.scrapeFailRejoins = 0;
      this.sweepHaltedForSlot = false;
    }
    this.sweepsThisSlot += 1;

    this.persistence.appendEvent({
      kind: "room_sweep_start",
      slot: originSlot,
      payload: {
        sweep: this.sweepsThisSlot,
        maxSweeps: AdmiralEngine.ROOM_SWEEP_MAX_PER_SLOT,
        fromClassName: this.currentRoomSlot?.className ?? originSlot.className
      }
    });

    if (this.sweepsThisSlot > AdmiralEngine.ROOM_SWEEP_MAX_PER_SLOT) {
      // Safety cap: stop roaming for this slot; sit in the scheduled room.
      this.sweepHaltedForSlot = true;
      this.nextRoomSweepAtMs = null;
      this.persistence.appendEvent({
        kind: "room_sweep_stopped",
        slot: originSlot,
        payload: { sweeps: this.sweepsThisSlot - 1 }
      });
      if (this.state === "InRoom" && this.adoptedFromSlotKey != null) {
        await this.performLeave();
        this.state = "Out";
        this.resetRoomPresence();
      }
      if (this.state !== "InRoom") {
        const joined = await this.performJoin(originSlot, {
          suppressCoverEmail: true,
          rejoinReason: "sweep_cap_reached"
        });
        this.state = joined ? "InRoom" : "Out";
      }
      this.emitStatus();
      return;
    }

    // Leave whatever room we're in (the empty scheduled one or a dead adopted one).
    if (this.state === "InRoom") {
      const left = await this.performLeave();
      this.state = "Out";
      if (!left) {
        this.persistence.appendEvent({ kind: "room_sweep_abort", slot: originSlot, payload: { reason: "leave failed" } });
        // Don't roam with a possibly-wedged browser; normal logic retries later.
        this.emitStatus();
        return;
      }
    }
    this.resetRoomPresence();
    this.persistControlState();
    this.emitStatus();

    const candidates = this.sweepCandidates(originSlot);
    const probed: { courseId: string; count: number | null; error?: string }[] = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const course = candidates[i]!;
      // Liveness pulse: a multi-room sweep runs for minutes, past the 180s
      // health threshold — without this, Docker autoheal would restart the
      // worker mid-sweep.
      this.lastTickMs = Date.now();
      this.reason = `Room sweep #${this.sweepsThisSlot}: probing ${course.className} (${i + 1}/${candidates.length})`;
      this.emitStatus();

      // Abort between probes if the world changed, the user intervened, or the
      // heartbeat went fresh (the user is now actively engaged — do not roam).
      const currentKey = this.activeSlot ? this.sessionKey(this.activeSlot) : null;
      if (currentKey !== originKey || this.standdown || this.forceLeavePending || this.heartbeatFreshNow()) {
        this.persistence.appendEvent({
          kind: "room_sweep_abort",
          slot: originSlot,
          payload: {
            reason: currentKey !== originKey
              ? "origin slot ended or changed"
              : this.heartbeatFreshNow()
                ? "user active on PWA (heartbeat fresh)"
                : "user override",
            probed
          }
        });
        this.emitStatus();
        return;
      }

      const probe = await this.probeRoom(course);
      probed.push({
        courseId: course.courseId,
        count: probe.scrapeOk ? probe.count : null,
        ...(probe.error ? { error: probe.error } : {})
      });
      this.persistence.appendEvent({
        kind: "room_sweep_probe",
        slot: originSlot,
        payload: {
          courseId: course.courseId,
          className: course.className,
          count: probe.scrapeOk ? probe.count : null,
          scrapeOk: probe.scrapeOk,
          ...(probe.error ? { error: probe.error } : {})
        }
      });
      this.emitStatus();

      if (probe.scrapeOk && probe.snapshot != null && probe.count >= AdmiralEngine.ROOM_MIN_PARTICIPANTS) {
        // Part B (sweep safety): before committing to a DIFFERENT room,
        // re-verify the origin scheduled room is still empty. The class may not
        // have moved — the user may have just joined it late (train, flaky
        // signal). verifyOriginStillEmpty leaves the browser inside the origin
        // room when it is live again (caller keeps covering it); otherwise we
        // switch back to the qualifying probed room and adopt it.
        const originStillEmpty = await this.verifyOriginStillEmpty(originSlot);
        if (!originStillEmpty || !probe.joinUrl) {
          this.backToOriginAfterFailedVerify(originSlot, originKey, probed);
          return;
        }
        await this.rejoinForAdoption(course, probe);
        this.adoptProbedRoom(
          course,
          { count: probe.count, joinUrl: probe.joinUrl, snapshot: probe.snapshot },
          originSlot,
          originKey,
          probed
        );
        return;
      }
    }

    await this.finishSweepFallback(originSlot, originKey, probed);
  }

  /**
   * Adopts a qualifying probed room. The browser session is already inside it
   * (probeRoom leaves it in place). Coverage stays capped by the origin slot's
   * end — the conservative "leave when the slot ends" contract — enforced by
   * the adoption guard in maintainRoomCoverage.
   */
  private adoptProbedRoom(
    course: CourseConfig,
    probe: { count: number; joinUrl: string | null; snapshot: ParticipantSnapshot },
    originSlot: ActiveSlot,
    originKey: string,
    probed: { courseId: string; count: number | null; error?: string }[]
  ): void {
    const adoptedSlot: ActiveSlot = {
      courseId: course.courseId,
      className: course.className,
      classPageUrl: course.classPageUrl,
      joinLinkText: course.joinLinkText,
      myDisplayName: course.myDisplayName,
      startedAt: new Date().toISOString(),
      endsAt: originSlot.endsAt
    };
    this.currentRoomSlot = adoptedSlot;
    this.adoptedFromSlotKey = originKey;
    this.adoptedFromClassName = originSlot.className;
    this.participantSnapshot = probe.snapshot;
    this.bbbJoinUrl = probe.joinUrl;
    this.state = "InRoom";
    this.nextRoomSweepAtMs = null;
    this.lastScrapeAtMs = Date.now();
    this.persistControlState();
    this.onEnteredRoom();
    this.persistence.appendEvent({
      kind: "room_adopted",
      slot: adoptedSlot,
      payload: {
        count: probe.count,
        originCourseId: originSlot.courseId,
        originClassName: originSlot.className,
        probed
      }
    });
    this.center.enqueue({
      kind: "cover_resume",
      slot: adoptedSlot,
      payload: { slot: adoptedSlot, joinUrl: probe.joinUrl, movedFrom: originSlot.className }
    });
    this.reason = `Covering ${course.className} (moved from empty ${originSlot.className})`;
    this.emitStatus();
  }

  /**
   * Part B (sweep safety): re-verify the origin scheduled room is still empty
   * before adopting a *different* room. The sweep exists because the schedule
   * can drift, but the class may simply have started late — the user could be
   * in the origin room right now (train, flaky signal). We leave the probed
   * room, re-join the origin room, and count heads. Returns true when the origin
   * is truly empty; when false the browser is LEFT INSIDE the now-live origin
   * room (the caller should keep covering it). On any failure we are
   * conservative and return false so we never adopt a wrong room while unable
   * to confirm the origin.
   */
  private async verifyOriginStillEmpty(originSlot: ActiveSlot): Promise<boolean> {
    try {
      await this.bbb.leave().catch(() => undefined);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const runtimeDir = `.runtime/worker/sweep-origin-recheck-${timestamp}`;
      const resolved = await resolveJoinUrl({
        lmsUrl: process.env.LMS_URL ?? "",
        username: process.env.MOODLE_USERNAME,
        password: process.env.MOODLE_PASSWORD,
        classPageUrl: originSlot.classPageUrl,
        joinLinkText: originSlot.joinLinkText,
        headless: this.headless,
        postClickWaitMs: this.postClickWaitMs,
        runtimeDir
      });

      await this.bbb.join({
        joinUrl: resolved.joinUrl,
        authStatePath: resolved.authStatePath,
        headless: this.headless,
        moodleUsername: process.env.MOODLE_USERNAME,
        moodlePassword: process.env.MOODLE_PASSWORD,
        displayNameOverride: originSlot.myDisplayName
      });

      // Participants render asynchronously; settle, then take the better of two
      // scrapes so a half-rendered list can't read as "empty".
      await sleep(AdmiralEngine.ROOM_SWEEP_PROBE_SETTLE_MS);
      const first = await this.bbb.scrapeParticipants(originSlot.myDisplayName);
      await sleep(5_000);
      const second = await this.bbb.scrapeParticipants(originSlot.myDisplayName);
      const best = !first.scrapeOk
        ? second
        : !second.scrapeOk
          ? first
          : second.count >= first.count
            ? second
            : first;

      // The bot itself joins under originSlot.myDisplayName, so a count of 2+
      // exact matches means the user is also present (the handoff signal).
      const userPresent = best.scrapeOk && best.nameExactMatchCount >= 2;
      const stillEmpty = originStillEmpty(best, AdmiralEngine.ROOM_MIN_PARTICIPANTS);

      this.persistence.appendEvent({
        kind: "room_sweep_origin_recheck",
        slot: originSlot,
        payload: {
          count: best.scrapeOk ? best.count : null,
          scrapeOk: best.scrapeOk,
          userPresent,
          stillEmpty
        }
      });
      return stillEmpty;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.persistence.appendEvent({
        kind: "room_sweep_origin_recheck",
        slot: originSlot,
        payload: { error: message, stillEmpty: false }
      });
      // Cannot confirm the origin is empty — do not adopt a different room.
      await this.bbb.leave().catch(() => undefined);
      return false;
    }
  }

  /**
   * Part B: switch the browser from the (verified-empty) origin room back to the
   * qualifying probed room so it can be adopted. `bbb.join` closes the current
   * context first, so leaving the origin room is implicit.
   */
  private async rejoinForAdoption(
    course: CourseConfig,
    probe: { joinUrl: string | null; authStatePath: string | null }
  ): Promise<void> {
    if (!probe.joinUrl) return;
    await this.bbb.join({
      joinUrl: probe.joinUrl,
      authStatePath: probe.authStatePath ?? undefined,
      headless: this.headless,
      moodleUsername: process.env.MOODLE_USERNAME,
      moodlePassword: process.env.MOODLE_PASSWORD,
      displayNameOverride: course.myDisplayName
    });
  }

  /**
   * Part B: the origin room turned out to be live (or couldn't be confirmed
   * empty), so the class did NOT move — the user is in the scheduled room. Keep
   * the browser there and let the normal room/duplicate handoff logic take over
   * instead of covering the wrong room. Halts roaming for this slot.
   */
  private backToOriginAfterFailedVerify(
    originSlot: ActiveSlot,
    originKey: string,
    probed: { courseId: string; count: number | null; error?: string }[]
  ): void {
    this.currentRoomSlot = originSlot;
    this.adoptedFromSlotKey = null;
    this.adoptedFromClassName = null;
    this.bbbJoinUrl = null;
    this.state = "InRoom";
    this.nextRoomSweepAtMs = null;
    this.sweepHaltedForSlot = true;
    this.lastScrapeAtMs = Date.now();
    this.persistControlState();
    this.onEnteredRoom();
    this.persistence.appendEvent({
      kind: "room_sweep_abort",
      slot: originSlot,
      payload: { reason: "origin recheck found the class live", probed }
    });
    this.reason = `Staying in ${originSlot.className}; class is live (user joined late)`;
    this.emitStatus();
  }

  /**
   * No probed room qualified: alert once per slot, rejoin the scheduled room
   * (attendance-safe — the user's chosen behaviour) and arm the re-sweep timer.
   */
  private async finishSweepFallback(
    originSlot: ActiveSlot,
    originKey: string,
    probed: { courseId: string; count: number | null; error?: string }[]
  ): Promise<void> {
    this.persistence.appendEvent({ kind: "room_sweep_exhausted", slot: originSlot, payload: { probed } });
    this.center.enqueue({
      kind: "action_needed",
      slot: originSlot,
      payload: {
        reason: "room_empty_everywhere",
        probed,
        minParticipants: AdmiralEngine.ROOM_MIN_PARTICIPANTS,
        retryMinutes: Math.round(AdmiralEngine.ROOM_SWEEP_RETRY_MS / 60_000)
      }
    });

    const currentKey = this.activeSlot ? this.sessionKey(this.activeSlot) : null;
    if (currentKey === originKey) {
      const joined = await this.performJoin(originSlot, {
        suppressCoverEmail: true,
        rejoinReason: "room_sweep_fallback"
      });
      this.state = joined ? "InRoom" : "Out";
      if (joined) {
        this.nextRoomSweepAtMs = Date.now() + AdmiralEngine.ROOM_SWEEP_RETRY_MS;
        this.reason =
          `${originSlot.className} is empty; sitting in it anyway — ` +
          `rechecking other rooms in ${Math.round(AdmiralEngine.ROOM_SWEEP_RETRY_MS / 60_000)}m`;
      }
    }
    this.emitStatus();
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

  /** True when the newest PWA heartbeat is within the fresh threshold. */
  private heartbeatFreshNow(): boolean {
    const age = this.heartbeat.getNewestAgeSeconds();
    return age != null && age <= this.config.heartbeat.freshThresholdSeconds;
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
    const recent = getMostRecentEndedSlot(this.config, (d) => this.opsForDate(d));
    if (!recent) return;
    if (this.center.wasSummarySent(this.sessionKey(recent))) return;
    this.center.enqueue({ kind: "session_summary", slot: recent });
  }

  private opsForDate(dateKey: string): DayOverrideOps[] {
    const fromSchedule = (this.config.overrides ?? [])
      .filter((override) => override.date === dateKey)
      .map(({ date: _date, ...ops }) => ops);
    const fromDb = this.persistence.listDayOverrides(dateKey).map((row) => row.ops);
    return [...fromSchedule, ...fromDb];
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

      if ("unchanged" in result) {
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

    const todayKey = istDateKey(Date.now());
    const issues = getDaySlots(this.config, todayKey, this.opsForDate(todayKey)).issues;
    for (const issue of issues) {
      this.persistence.appendEvent({
        kind: "override_unmatched",
        payload: { date: todayKey, op: issue.op, detail: issue.detail }
      });
    }
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
