import type {
  ActiveSlot,
  DayName,
  EmailBudgetSnapshot,
  HistoryEvent,
  StatusResponse
} from "../shared/types.js";
import type { WorkerPersistence, OutboxRow } from "./persistence.js";
import {
  istDateKey,
  istDayStartMs,
  istMonthStartMs,
  istParts,
  minutesFromNow,
  minutesSince,
  shortIstTime,
  slotDurationMinutes
} from "../shared/istTime.js";

//
// Notification center
//
// Emails are not sent fire-and-forget. Intents are enqueued into a SQLite
// outbox, coalesced (a join -> handoff -> rejoin flap inside the settle
// window becomes one email), budget-gated against Resend's 100/day and
// 3000/month limits (counted in IST days), and retried with backoff.
// Per-session caps survive worker restarts via the email_dedupe ledger.
//

export type NotificationKind =
  | "cover_start"
  | "cover_resume"
  | "handoff"
  | "action_needed"
  | "session_summary"
  | "standdown"
  | "session_standdown"
  | "morning_plan"
  | "daily_wrapup";

export type NotificationIntent = {
  kind: NotificationKind;
  slot?: ActiveSlot | null;
  payload?: Record<string, unknown>;
};

type Caps = {
  hardDaily: number;
  hardMonthly: number;
  p1Daily: number;
  p2Daily: number;
  settleMs: number;
  ackSettleMs: number;
  maxAttempts: number;
  resumeCap: number;
  handoffCap: number;
  flushBatch: number;
  morningHour: number;
  morningMinute: number;
  morningWindowEndHour: number;
  wrapupHour: number;
  wrapupMinute: number;
  wrapupWindowEndHour: number;
};

const DEFAULT_CAPS: Caps = {
  hardDaily: Number(process.env.EMAIL_DAILY_CAP ?? 85),
  hardMonthly: Number(process.env.EMAIL_MONTHLY_CAP ?? 2800),
  p1Daily: Number(process.env.EMAIL_P1_DAILY_CAP ?? 60),
  p2Daily: Number(process.env.EMAIL_P2_DAILY_CAP ?? 40),
  settleMs: Number(process.env.EMAIL_SETTLE_SECONDS ?? 120) * 1000,
  ackSettleMs: 60 * 1000,
  maxAttempts: 5,
  resumeCap: 2,
  handoffCap: 2,
  flushBatch: 12,
  morningHour: Number(process.env.EMAIL_MORNING_PLAN_HOUR ?? 8),
  morningMinute: Number(process.env.EMAIL_MORNING_PLAN_MINUTE ?? 30),
  morningWindowEndHour: 12,
  wrapupHour: Number(process.env.EMAIL_WRAPUP_HOUR ?? 16),
  wrapupMinute: Number(process.env.EMAIL_WRAPUP_MINUTE ?? 0),
  wrapupWindowEndHour: 20
};

const COALESCE_KINDS: ReadonlySet<NotificationKind> = new Set([
  "cover_start",
  "cover_resume",
  "handoff"
]);

type SendFn = (payload: {
  from: string;
  to: string[];
  subject: string;
  text: string;
}) => Promise<void>;

export type NotificationCenterOptions = {
  persistence: WorkerPersistence;
  statusProvider: () => StatusResponse;
  sendFn?: SendFn;
  nowFn?: () => number;
  caps?: Partial<Caps>;
};

export class NotificationCenter {
  private readonly p: WorkerPersistence;
  private readonly statusProvider: () => StatusResponse;
  private readonly sendFn: SendFn;
  private readonly now: () => number;
  private readonly caps: Caps;
  private flushLock: Promise<void> = Promise.resolve();

  constructor(opts: NotificationCenterOptions) {
    this.p = opts.persistence;
    this.statusProvider = opts.statusProvider;
    this.sendFn = opts.sendFn ?? defaultResendSend;
    this.now = opts.nowFn ?? (() => Date.now());
    this.caps = { ...DEFAULT_CAPS, ...opts.caps };
  }

  // ── Enqueue ──────────────────────────────────────────────────────────────

  enqueue(intent: NotificationIntent): void {
    const nowMs = this.now();
    const slotKey = intent.slot ? slotKeyFor(intent.slot) : null;
    let spec = specForKind(intent.kind, slotKey, intent.payload ?? {}, nowMs, this.caps);

    if (spec.supersedeKind) {
      this.p.cancelPendingByKind(spec.supersedeKind);
    }

    // Multi-occurrence kinds (cover_resume, handoff) get a monotonically-indexed
    // dedupe key so each real occurrence has a distinct key while the per-session
    // cap still counts actual sends accurately.
    if ((intent.kind === "cover_resume" || intent.kind === "handoff") && slotKey) {
      const prefix = `${intent.kind}:${slotKey}:`;
      const used = this.p.countDedupeByPrefix(prefix) + this.p.countPendingOutboxByPrefix(prefix);
      spec = { ...spec, dedupeKey: `${prefix}${used + 1}` };
    }

    if (spec.dedupeKey && this.capExceeded(intent.kind, spec.dedupeKey, slotKey)) {
      this.p.appendEvent({
        kind: "email_suppressed",
        payload: {
          emailKind: intent.kind,
          dedupeKey: spec.dedupeKey,
          reason: "per-session cap reached"
        }
      });
      return;
    }

    this.p.enqueueOutbox({
      createdMs: nowMs,
      notBeforeMs: nowMs + spec.settleMs,
      priority: spec.priority,
      kind: intent.kind,
      slotKey,
      dedupeKey: spec.dedupeKey,
      payload: { ...(intent.payload ?? {}), ...(intent.slot ? { slot: intent.slot } : {}) }
    });
  }
  /** True once a cover_start for this session has been sent or is pending. */
  wasCoverStarted(slotKey: string): boolean {
    return (
      this.p.dedupeExists(`cover_start:${slotKey}`) ||
      this.p.pendingOutboxExists(`cover_start:${slotKey}`)
    );
  }

  /** True once a session summary for this slot has been sent or is pending. */
  wasSummarySent(slotKey: string): boolean {
    return (
      this.p.dedupeExists(`summary:${slotKey}`) ||
      this.p.pendingOutboxExists(`summary:${slotKey}`)
    );
  }

  // ── Daily scheduled emails (morning plan + 4pm wrap-up) ───────────────────

  /** Fires the morning plan and daily wrap-up by the IST clock. Call per tick. */
  maybeFireScheduledDaily(): void {
    const nowMs = this.now();
    const { hour, minute } = istParts(nowMs);
    const dateKey = istDateKey(nowMs);

    const morningReady =
      (hour > this.caps.morningHour ||
        (hour === this.caps.morningHour && minute >= this.caps.morningMinute)) &&
      hour < this.caps.morningWindowEndHour;
    if (morningReady && !this.p.dedupeExists(`morning:${dateKey}`)) {
      this.enqueue({ kind: "morning_plan", payload: { istDate: dateKey } });
    }

    const wrapupReady =
      (hour > this.caps.wrapupHour ||
        (hour === this.caps.wrapupHour && minute >= this.caps.wrapupMinute)) &&
      hour < this.caps.wrapupWindowEndHour;
    if (wrapupReady && !this.p.dedupeExists(`wrapup:${dateKey}`)) {
      this.enqueue({ kind: "daily_wrapup", payload: { istDate: dateKey } });
    }
  }

  getBudgetSnapshot(): EmailBudgetSnapshot {
    const nowMs = this.now();
    const dayStart = istDayStartMs(nowMs);
    return {
      emailsToday: this.p.countEmailsSince(dayStart),
      emailDailyCap: this.caps.hardDaily,
      suppressedToday: this.p.countEventsByKindSince("email_suppressed", dayStart)
    };
  }

  // ── Flush ────────────────────────────────────────────────────────────────

  async flushDue(): Promise<void> {
    await this.withLock(async () => {
      const nowMs = this.now();
      const due = this.p.listOutboxDue(nowMs, this.caps.flushBatch);
      const processed = new Set<number>();

      for (const row of due) {
        if (processed.has(row.id)) continue;

        if (COALESCE_KINDS.has(row.kind as NotificationKind) && row.slotKey) {
          const group = this.p.listOutboxPendingForSlot(row.slotKey, [...COALESCE_KINDS]);
          if (group.length === 0) continue;
          if (group.some((g) => g.notBeforeMs > nowMs)) continue; // wait for settle
          for (const g of group) processed.add(g.id);
          await this.sendGroup(group, nowMs);
        } else {
          processed.add(row.id);
          await this.sendGroup([row], nowMs);
        }
      }
    });
  }

  /** Best-effort final flush before shutdown. */
  async stop(): Promise<void> {
    await this.flushDue().catch(() => undefined);
  }

  // ── Send pipeline ─────────────────────────────────────────────────────────

  private capExceeded(kind: NotificationKind, dedupeKey: string, slotKey: string | null): boolean {
    const single = new Set<NotificationKind>([
      "cover_start",
      "action_needed",
      "session_summary",
      "morning_plan",
      "daily_wrapup"
    ]);
    if (single.has(kind)) {
      return this.p.dedupeExists(dedupeKey) || this.p.pendingOutboxExists(dedupeKey);
    }
    if (kind === "cover_resume" && slotKey) {
      const prefix = `cover_resume:${slotKey}:`;
      return (
        this.p.countDedupeByPrefix(prefix) + this.p.countPendingOutboxByPrefix(prefix) >=
        this.caps.resumeCap
      );
    }
    if (kind === "handoff" && slotKey) {
      const prefix = `handoff:${slotKey}:`;
      return (
        this.p.countDedupeByPrefix(prefix) + this.p.countPendingOutboxByPrefix(prefix) >=
        this.caps.handoffCap
      );
    }
    return false;
  }

  private async sendGroup(rows: OutboxRow[], nowMs: number): Promise<void> {
    if (rows.length === 0) return;
    const priority = rows.reduce((min, r) => Math.min(min, r.priority), 2);

    if (!resendConfigured()) {
      for (const r of rows) this.p.setOutboxStatus(r.id, "suppressed");
      this.p.appendEvent({
        kind: "email_suppressed",
        payload: { emailKind: rows[0].kind, reason: "RESEND_* env vars missing" }
      });
      return;
    }

    const budget = this.checkBudget(priority, nowMs);
    if (!budget.allowed) {
      for (const r of rows) this.p.setOutboxStatus(r.id, "suppressed");
      this.p.appendEvent({
        kind: "email_suppressed",
        payload: {
          emailKind: rows[0].kind,
          dedupeKeys: rows.map((r) => r.dedupeKey),
          reason: budget.reason
        }
      });
      return;
    }

    const coalesced =
      rows.length > 1 && rows.every((r) => COALESCE_KINDS.has(r.kind as NotificationKind));
    const body = coalesced ? this.renderCombined(rows, nowMs) : this.renderOne(rows[0], nowMs);
    const dedupeKeys = rows.map((r) => r.dedupeKey).filter((k): k is string => k != null);
    const logKind = coalesced ? "session_update" : rows[0].kind;
    const lines = [...body.lines, "", statusBlock(this.statusProvider(), nowMs), footer()];

    try {
      await this.sendFn({
        from: process.env.RESEND_FROM ?? "",
        to: [process.env.RESEND_TO ?? ""],
        subject: body.subject,
        text: lines.join("\n")
      });
      for (const r of rows) this.p.setOutboxStatus(r.id, "sent");
      for (const k of dedupeKeys) this.p.recordDedupe(k, nowMs);
      this.p.recordEmailWithDedupe(logKind, body.subject, nowMs, dedupeKeys[0] ?? null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const maxed = rows.some((r) => r.attempts + 1 >= this.caps.maxAttempts);
      for (const r of rows) {
        if (maxed) {
          this.p.setOutboxStatus(r.id, "failed", { lastError: msg, attempts: r.attempts + 1 });
        } else {
          const backoff = Math.min(2 ** (r.attempts + 1) * 60_000, 30 * 60_000);
          this.p.setOutboxStatus(r.id, "pending", {
            lastError: msg,
            attempts: r.attempts + 1,
            notBeforeMs: nowMs + backoff
          });
        }
      }
      if (maxed) {
        this.p.appendEvent({
          kind: "email_send_failed",
          payload: { emailKind: logKind, dedupeKeys, error: msg }
        });
      }
    }
  }

  private checkBudget(priority: number, nowMs: number): { allowed: boolean; reason?: string } {
    const dayStart = istDayStartMs(nowMs);
    const monthStart = istMonthStartMs(nowMs);
    const today = this.p.countEmailsSince(dayStart);
    const month = this.p.countEmailsSince(monthStart);
    if (month >= this.caps.hardMonthly)
      return { allowed: false, reason: "monthly cap reached (P0-only mode)" };
    if (today >= this.caps.hardDaily) return { allowed: false, reason: "daily hard cap reached" };
    if (priority >= 1 && today >= this.caps.p1Daily)
      return { allowed: false, reason: "P1 daily cap reached" };
    if (priority >= 2 && today >= this.caps.p2Daily)
      return { allowed: false, reason: "P2 daily cap reached" };
    return { allowed: true };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.flushLock;
    let release!: () => void;
    this.flushLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private renderOne(row: OutboxRow, nowMs: number): { subject: string; lines: string[] } {
    const slot = parseSlot(row.payload.slot);
    switch (row.kind) {
      case "cover_start":
        return renderCoverStart(slot, row.payload.joinUrl ?? null, nowMs);
      case "cover_resume":
        return renderCoverResume(slot, nowMs);
      case "handoff":
        return renderHandoff(slot, nowMs);
      case "action_needed":
        return renderActionNeeded(slot, row.payload, nowMs);
      case "session_summary":
        return renderSessionSummary(this.p, slot, nowMs);
      case "standdown":
        return renderStanddown(Boolean(row.payload.active));
      case "session_standdown":
        return renderSessionStanddown(slot, Boolean(row.payload.cancelled));
      case "morning_plan":
        return renderMorningPlan(this.statusProvider(), nowMs);
      case "daily_wrapup":
        return renderDailyWrapup(this.statusProvider(), nowMs);
      default:
        return { subject: "Admiral notification", lines: ["(unknown notification kind)"] };
    }
  }

  private renderCombined(rows: OutboxRow[], nowMs: number): { subject: string; lines: string[] } {
    const slot = rows.map((r) => parseSlot(r.payload.slot)).find((s) => s != null) ?? null;
    const className = slot?.className ?? "session";
    const lines: string[] = ["Admiral session update (multiple events coalesced):", ""];
    for (const row of rows) lines.push(milestoneLine(row));
    return { subject: `↔ Admiral session update — ${className}`, lines };
  }
}

// ── Free helpers ────────────────────────────────────────────────────────────

function slotKeyFor(slot: ActiveSlot): string {
  return `${slot.courseId}@${slot.startedAt}`;
}

function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM && process.env.RESEND_TO);
}

async function defaultResendSend(payload: {
  from: string;
  to: string[];
  subject: string;
  text: string;
}): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ""}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no-body>");
    throw new Error(`Resend email failed: ${res.status} ${body}`);
  }
}

type KindSpec = {
  priority: number;
  settleMs: number;
  dedupeKey: string | null;
  supersedeKind?: string;
};

function specForKind(
  kind: NotificationKind,
  slotKey: string | null,
  payload: Record<string, unknown>,
  nowMs: number,
  caps: Caps
): KindSpec {
  switch (kind) {
    case "cover_start":
      return { priority: 1, settleMs: caps.settleMs, dedupeKey: slotKey ? `cover_start:${slotKey}` : null };
    case "cover_resume":
      return {
        priority: 1,
        settleMs: caps.settleMs,
        dedupeKey: slotKey ? `cover_resume:${slotKey}:${nowMs}` : null
      };
    case "handoff":
      return {
        priority: 1,
        settleMs: caps.settleMs,
        dedupeKey: slotKey ? `handoff:${slotKey}:${nowMs}` : null
      };
    case "action_needed":
      return {
        priority: 0,
        settleMs: 0,
        dedupeKey: slotKey ? `action_needed:${slotKey}:${String(payload.reason ?? "alert")}` : null
      };
    case "session_summary":
      return { priority: 1, settleMs: 0, dedupeKey: slotKey ? `summary:${slotKey}` : null };
    case "standdown":
      return { priority: 2, settleMs: caps.ackSettleMs, dedupeKey: null, supersedeKind: "standdown" };
    case "session_standdown":
      return { priority: 2, settleMs: caps.ackSettleMs, dedupeKey: null, supersedeKind: "session_standdown" };
    case "morning_plan":
      return { priority: 2, settleMs: 0, dedupeKey: `morning:${istDateKey(nowMs)}` };
    case "daily_wrapup":
      return { priority: 2, settleMs: 0, dedupeKey: `wrapup:${istDateKey(nowMs)}` };
    default:
      return { priority: 2, settleMs: 0, dedupeKey: null };
  }
}

function parseSlot(raw: unknown): ActiveSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ActiveSlot>;
  if (
    typeof s.courseId === "string" &&
    typeof s.startedAt === "string" &&
    typeof s.endsAt === "string"
  ) {
    return s as ActiveSlot;
  }
  return null;
}

function milestoneLine(row: OutboxRow): string {
  const slot = parseSlot(row.payload.slot);
  const time = shortIstTime(row.createdMs);
  switch (row.kind) {
    case "cover_start":
      return `• ${time}  Admiral joined and is holding your seat.${row.payload.joinUrl ? ` Join URL: ${row.payload.joinUrl}` : ""}`;
    case "cover_resume":
      return `• ${time}  You dropped — Admiral is covering again.`;
    case "handoff":
      return `• ${time}  You joined — Admiral handed off and left.`;
    default:
      return `• ${time}  ${row.kind}${slot ? ` (${slot.className})` : ""}`;
  }
}

// ── Renderers ───────────────────────────────────────────────────────────────

function slotLines(slot: ActiveSlot, nowMs: number): string[] {
  const duration = slotDurationMinutes(slot);
  const joinedAgo = minutesSince(slot.startedAt, nowMs);
  const endsIn = minutesFromNow(slot.endsAt, nowMs);
  const joinedNote = joinedAgo > 0 ? `${joinedAgo} min into the slot` : "right at the start";
  const leftNote = endsIn > 0 ? `~${endsIn} min remaining` : "slot has ended";
  return [
    `Class:       ${slot.className}`,
    `Course ID:   ${slot.courseId}`,
    `Slot:        ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${duration} min)`,
    `Joined:      ${joinedNote}`,
    `Time left:   ${leftNote}`
  ];
}

function renderCoverStart(slot: ActiveSlot | null, joinUrl: unknown, nowMs: number) {
  const lines = ["Admiral joined the class and is holding your seat.", ""];
  if (slot) lines.push(...slotLines(slot, nowMs));
  if (typeof joinUrl === "string" && joinUrl) {
    lines.push("", `Join URL: ${joinUrl}`);
  }
  lines.push("", "Admiral leaves automatically when the slot ends or when it detects you joined.");
  return { subject: `✓ Admiral in room — ${slot?.className ?? "class"}`, lines };
}

function renderCoverResume(slot: ActiveSlot | null, nowMs: number) {
  const lines = ["You dropped — Admiral is back in the room covering for you.", ""];
  if (slot) lines.push(...slotLines(slot, nowMs));
  lines.push("", "Rejoin when you can; Admiral will hand off automatically.");
  return { subject: `↩ Covering again — ${slot?.className ?? "class"}`, lines };
}

function renderHandoff(slot: ActiveSlot | null, nowMs: number) {
  const lines = ["Admiral detected you in the room and has left. You have control.", ""];
  if (slot) lines.push(...slotLines(slot, nowMs));
  return { subject: `✓ You're in — Admiral left (${slot?.className ?? "class"})`, lines };
}

function renderActionNeeded(slot: ActiveSlot | null, payload: Record<string, unknown>, nowMs: number) {
  const failureCount = Number(payload.failureCount ?? 0);
  const backoffMinutes = Number(payload.backoffMinutes ?? 0);
  const reason = String(payload.reason ?? "alert");
  const lines = [
    `Admiral cannot join this class right now (${reason}).`,
    "",
    failureCount > 0
      ? `${failureCount} consecutive join failures — backing off ${backoffMinutes} min.`
      : "Join attempts have been unsuccessful.",
    ""
  ];
  if (slot) {
    const endsIn = minutesFromNow(slot.endsAt, nowMs);
    lines.push(
      `Class:     ${slot.className}`,
      `Course ID: ${slot.courseId}`,
      `Slot:      ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${slotDurationMinutes(slot)} min)`,
      endsIn > 0 ? `~${endsIn} min left in the slot.` : "The slot has ended.",
      ""
    );
  }
  lines.push('Tap "Force Join" in the dashboard to retry immediately, or join yourself via the class page.');
  return { subject: `🔴 ACTION: Admiral can't join — ${slot?.className ?? "class"}`, lines };
}

function renderSessionSummary(
  p: WorkerPersistence,
  slot: ActiveSlot | null,
  nowMs: number
) {
  if (!slot) {
    return { subject: "📝 Admiral class summary", lines: ["Session summary (slot details unavailable)."] };
  }
  const slotKey = `${slot.courseId}@${slot.startedAt}`;
  const events = p.listEventsForSlot(slotKey, 500);
  const className = slot.className;
  if (events.length === 0) {
    return {
      subject: `📝 Class summary — ${className}`,
      lines: [
        "All quiet — you attended the whole session; Admiral never needed to join.",
        "",
        `Class:     ${slot.className}`,
        `Course ID: ${slot.courseId}`,
        `Slot:      ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${slotDurationMinutes(slot)} min)`
      ]
    };
  }
  const counts: Record<string, number> = {};
  const timeline: string[] = [];
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    timeline.push(`• ${shortIstTime(e.tsMs)}  ${summarizeEvent(e)}`);
  }
  const joins = counts["join_success"] ?? 0;
  const handoffs = countByTrigger(events, "Duplicate");
  const failures = counts["join_failure"] ?? 0;
  const alerts = counts["join_backoff_start"] ?? 0;
  const suppressed = counts["email_suppressed"] ?? 0;
  const lines = [
    `Session summary for ${className}`,
    "",
    `Class:     ${slot.className}`,
    `Course ID: ${slot.courseId}`,
    `Slot:      ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${slotDurationMinutes(slot)} min)`,
    "",
    "Timeline:",
    ...timeline,
    "",
    "Totals:",
    `  joins: ${joins}  •  handoffs: ${handoffs}  •  join failures: ${failures}`,
    `  backoff alerts: ${alerts}  •  updates suppressed: ${suppressed}`
  ];
  return { subject: `📝 Class summary — ${className}`, lines };
}

function countByTrigger(events: HistoryEvent[], needle: string): number {
  let n = 0;
  for (const e of events) {
    if (e.kind !== "leave_success") continue;
    if (String(e.payload?.trigger ?? "").includes(needle)) n += 1;
  }
  return n;
}

function summarizeEvent(e: HistoryEvent): string {
  switch (e.kind) {
    case "join_success":
      return "Admiral joined";
    case "join_failure":
      return `join failed (${String(e.payload?.error ?? "?")})`;
    case "leave_success":
      return `Admiral left (${String(e.payload?.trigger ?? "")})`;
    case "join_backoff_start":
      return `backoff after ${e.payload?.backoffMinutes ?? "?"}m`;
    case "session_standdown_cleared":
      return "session stand-down cleared";
    case "email_suppressed":
      return `email suppressed (${String(e.payload?.emailKind ?? "")})`;
    default:
      return e.kind;
  }
}

function renderStanddown(active: boolean) {
  if (active) {
    return {
      subject: "⏸ Standdown ON — Admiral will not auto-join",
      lines: [
        "Global standdown is enabled. Admiral will not join any class until you turn it off.",
        "",
        "To resume: use the dashboard or send standdown_off."
      ]
    };
  }
  return {
    subject: "▶ Standdown OFF — auto-join resumed",
    lines: ["Global standdown is disabled. Admiral will resume joining classes on schedule."]
  };
}

function renderSessionStanddown(slot: ActiveSlot | null, cancelled: boolean) {
  if (cancelled) {
    const lines = ["Per-session stand-down cancelled — Admiral will auto-join this session normally.", ""];
    if (slot) lines.push(slotBrief(slot));
    return { subject: `↩ Stand-down cancelled — ${slot?.className ?? "session"}`, lines };
  }
  const lines = ["Admiral will sit out this session. Auto-join resumes from the next class onwards.", ""];
  if (slot) lines.push(slotBrief(slot));
  lines.push("", 'To undo: tap "Cancel Session Stand-Down" in the dashboard.');
  return { subject: `⏭ Skipping this session — ${slot?.className ?? "session"}`, lines };
}

function slotBrief(slot: ActiveSlot): string {
  return `Class:  ${slot.className}\nCourse: ${slot.courseId}\nSlot:   ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${slotDurationMinutes(slot)} min)`;
}

function todaySlots(status: StatusResponse, nowMs: number): { time: string; label: string }[] {
  const weekday = istParts(nowMs).weekday as DayName;
  const out: { time: string; label: string }[] = [];
  for (const course of status.schedule.courses) {
    for (const ws of course.weeklySlots) {
      if (!ws.days.includes(weekday)) continue;
      out.push({ time: `${ws.start}–${ws.end}`, label: `${course.className} (${course.courseId})` });
    }
  }
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}

function renderMorningPlan(status: StatusResponse, nowMs: number) {
  const date = istDateKey(nowMs);
  const lines = [
    `Admiral morning plan — ${date}`,
    "",
    `System: ${status.state} — ${status.reason}`,
    `Standdown: ${status.standdown ? "ON" : "off"}`,
    "",
    "Today's classes:"
  ];
  const slots = todaySlots(status, nowMs);
  if (slots.length === 0) lines.push("  (none scheduled today)");
  for (const s of slots) lines.push(`  • ${s.time}  ${s.label}`);
  if (status.upcomingSlot) {
    const inMin = minutesFromNow(status.upcomingSlot.startedAt, nowMs);
    lines.push(
      "",
      `Next class: ${status.upcomingSlot.className} at ${shortIstTime(status.upcomingSlot.startedAt)}${inMin > 0 ? ` (in ~${inMin} min)` : ""}`
    );
  }
  return { subject: `☕ Admiral morning plan — ${date}`, lines };
}

function renderDailyWrapup(status: StatusResponse, nowMs: number) {
  const date = istDateKey(nowMs);
  const budget = status.emailBudget;
  const lines = [
    `Admiral daily wrap-up — ${date}`,
    "",
    `Today's email activity: ${budget?.emailsToday ?? 0} sent / ${budget?.emailDailyCap ?? 0} daily cap, ${budget?.suppressedToday ?? 0} suppressed.`,
    `Standdown: ${status.standdown ? "ON" : "off"}`,
    "",
    "Today's classes:"
  ];
  const slots = todaySlots(status, nowMs);
  if (slots.length === 0) lines.push("  (none scheduled today)");
  for (const s of slots) lines.push(`  • ${s.time}  ${s.label}`);
  if (status.upcomingSlot) {
    lines.push("", `Next class: ${status.upcomingSlot.className} at ${shortIstTime(status.upcomingSlot.startedAt)}`);
  }
  return { subject: `🧾 Admiral daily wrap-up — ${date}`, lines };
}

function statusBlock(status: StatusResponse, nowMs: number): string {
  const lines = [
    `STATUS (as of ${shortIstTime(nowMs)})`,
    `State: ${status.state} — ${status.reason}`
  ];
  if (status.activeSlot) {
    lines.push(
      `Active: ${status.activeSlot.className} (${shortIstTime(status.activeSlot.startedAt)}–${shortIstTime(status.activeSlot.endsAt)})`
    );
  } else {
    lines.push("Active: no class active right now");
  }
  if (status.upcomingSlot) {
    lines.push(`Next: ${status.upcomingSlot.className} at ${shortIstTime(status.upcomingSlot.startedAt)}`);
  } else {
    lines.push("Next: none scheduled");
  }
  lines.push(
    `Standdown: ${status.standdown ? "ON" : "off"}${status.sessionStanddown ? ` (session: ${status.sessionStanddown.className})` : ""}`
  );
  const domain = process.env.ADMIRAL_DOMAIN ?? "admiral";
  lines.push(`Dashboard: https://${domain}`);
  return lines.join("\n");
}

function footer(): string {
  const domain = process.env.ADMIRAL_DOMAIN ?? "admiral";
  return `\n-- \nAdmiral · ${domain}`;
}

