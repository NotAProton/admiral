import type { ActiveSlot } from "../shared/types.js";
import type { DayOverrideIssue } from "./schedule.js";
import type { NotificationCenter, NotificationKind } from "./notifications.js";

/**
 * ── Notification façade ─────────────────────────────────────────────
 *
 * Typed, discoverable wrappers over NotificationCenter.enqueue().
 * Every notification kind gets a named function instead of the current
 * ~13 inline `this.center.enqueue({ kind: ..., payload: ... })` call sites
 * scattered across the engine.
 */

export class Notify {
  constructor(private readonly center: NotificationCenter) {}

  /** Admiral auto-joined and started covering a class. */
  coverStart(slot: ActiveSlot, joinUrl: string, isResume = false): void {
    this.center.enqueue({
      kind: isResume ? "cover_resume" : "cover_start",
      slot,
      payload: { slot, joinUrl }
    });
  }

  /** Duplicate-name handoff: Admiral exited because the user joined manually. */
  handoff(slot: ActiveSlot): void {
    this.center.enqueue({ kind: "handoff", slot, payload: { slot } });
  }

  /** Action needed: user must act (e.g. room empty everywhere). */
  actionNeeded(
    slot: ActiveSlot,
    reason: string,
    details: Record<string, unknown>
  ): void {
    this.center.enqueue({
      kind: "action_needed",
      slot,
      payload: { reason, ...details }
    });
  }

  /** Session summary for a slot that just ended. */
  sessionSummary(slot: ActiveSlot): void {
    this.center.enqueue({ kind: "session_summary", slot });
  }

  /** Same-day schedule override applied or removed. */
  dayOverride(
    date: string,
    summaries: string[],
    issues: DayOverrideIssue[],
    todaySlots?: ActiveSlot[]
  ): void {
    this.center.enqueue({
      kind: "day_override",
      payload: {
        date,
        summary: summaries,
        issues,
        ...(todaySlots ? { todaySlots } : {})
      }
    });
  }

  /** Global standdown toggled. */
  standdown(toggledOn: boolean): void {
    this.center.enqueue({
      kind: "standdown",
      payload: { toggledOn }
    });
  }

  /** Per-session standdown: user told Admiral to skip a specific class. */
  sessionStanddown(slot: ActiveSlot): void {
    this.center.enqueue({
      kind: "session_standdown",
      slot,
      payload: { slot }
    });
  }

  /** Morning plan: today's timetable snapshot. */
  morningPlan(istDate: string): void {
    this.center.enqueue({ kind: "morning_plan", payload: { istDate } });
  }

  /** Daily wrap-up at 4pm. */
  dailyWrapup(istDate: string): void {
    this.center.enqueue({ kind: "daily_wrapup", payload: { istDate } });
  }

  // Passthroughs for methods the engine uses directly
  maybeFireScheduledDaily(): void {
    this.center.maybeFireScheduledDaily();
  }

  wasCoverStarted(slotKey: string): boolean {
    return this.center.wasCoverStarted(slotKey);
  }

  wasSummarySent(slotKey: string): boolean {
    return this.center.wasSummarySent(slotKey);
  }

  async flushDue(): Promise<void> {
    await this.center.flushDue();
  }

  getBudgetSnapshot(): ReturnType<NotificationCenter["getBudgetSnapshot"]> {
    return this.center.getBudgetSnapshot();
  }

  pruneStaleOutbox(): void {
    this.center.pruneStaleOutbox();
  }
}
