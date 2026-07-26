import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { envBoolean, envNumber, loadConfig } from "../shared/config.js";
import type {
  ActiveSlot,
  AdmiralConfig,
  AdmiralState,
  OverrideAction,
  ParticipantSnapshot,
  StatusResponse
} from "../shared/types.js";
import { BbbSession, runtimePrefixForSlot } from "./bbbSession.js";
import { HeartbeatTracker } from "./heartbeat.js";
import { sendJoinSuccessEmail } from "./notifications.js";
import { getActiveSlot } from "./schedule.js";
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
  private participantSnapshot: ParticipantSnapshot = { count: 0, names: [], nameExactMatchCount: 0 };
  private duplicateStreak = 0;
  private lastScrapeAtMs = 0;
  private bbbJoinUrl: string | null = null;

  private forceJoinPending = false;
  private forceLeavePending = false;

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
    }

    if (action === "standdown_off") {
      this.standdown = false;
      this.reason = "Standdown disabled by override";
    }

    if (action === "force_join") {
      this.forceJoinPending = true;
      this.reason = "Force-join requested";
    }

    if (action === "force_leave") {
      this.forceLeavePending = true;
      this.reason = "Force-leave requested";
    }

    this.emitStatus();
  }

  getStatus(): StatusResponse {
    const heartbeatAge = this.heartbeat.getNewestAgeSeconds();
    const heartbeatFresh = heartbeatAge != null && heartbeatAge <= this.config.heartbeat.freshThresholdSeconds;

    return {
      state: this.state,
      standdown: this.standdown,
      reason: this.reason,
      activeSlot: this.activeSlot,
      participantCount: this.participantSnapshot.count,
      participantNames: this.participantSnapshot.names,
      duplicateConfirmed: this.duplicateStreak >= this.config.duplicateDetection.confirmConsecutiveScrapes,
      duplicateStreak: this.duplicateStreak,
      lastHeartbeatAgeSeconds: heartbeatAge,
      heartbeatFresh,
      updatedAt: new Date().toISOString(),
      bbbJoinUrl: this.bbbJoinUrl
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

      if (this.state === "InRoom") {
        await this.refreshParticipantsIfDue();
      }

      const heartbeatAge = this.heartbeat.getNewestAgeSeconds();
      const heartbeatFresh = heartbeatAge != null && heartbeatAge <= this.config.heartbeat.freshThresholdSeconds;
      const heartbeatMissing = heartbeatAge == null || heartbeatAge >= this.config.heartbeat.missingThresholdSeconds;
      const duplicateConfirmed = this.duplicateStreak >= this.config.duplicateDetection.confirmConsecutiveScrapes;

      const transition = nextTransition(this.state, {
        hasActiveSlot: this.activeSlot != null,
        heartbeatFresh,
        heartbeatMissing,
        duplicateConfirmed,
        standdown: this.standdown,
        forceJoin: this.forceJoinPending,
        forceLeave: this.forceLeavePending,
        joinCompleted: false,
        leaveCompleted: false
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
          forceJoin: false,
          forceLeave: this.forceLeavePending,
          joinCompleted: joined,
          leaveCompleted: false
        });

        this.state = follow.nextState;
        this.reason = joined ? "Join completed" : "Join failed";
      } else if (transition.shouldAttemptLeave && (this.state === "InRoom" || this.state === "Joining")) {
        this.state = "Leaving";
        this.emitStatus();

        const left = await this.performLeave();
        const follow = nextTransition("Leaving", {
          hasActiveSlot: this.activeSlot != null,
          heartbeatFresh,
          heartbeatMissing,
          duplicateConfirmed,
          standdown: this.standdown,
          forceJoin: false,
          forceLeave: false,
          joinCompleted: false,
          leaveCompleted: left
        });

        this.state = follow.nextState;
        if (left) {
          this.participantSnapshot = { count: 0, names: [], nameExactMatchCount: 0 };
          this.duplicateStreak = 0;
          this.bbbJoinUrl = null;
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

      await sendJoinSuccessEmail(slot, resolved.joinUrl).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Join-success email failed: ${message}`);
      });

      return true;
    } catch (error) {
      this.reason = `Join failed: ${error instanceof Error ? error.message : String(error)}`;
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
}
