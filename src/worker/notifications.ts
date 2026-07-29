import type { ActiveSlot } from "../shared/types.js";
import type { WorkerPersistence } from "./persistence.js";

const RATE_LIMIT_MAX_PER_MINUTE = 1;
const RATE_LIMIT_MAX_PER_15_MINUTES = 5;
const ONE_MINUTE_MS = 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Sends are recorded in the SQLite email_log ledger, which keeps rate
 * limiting accurate across worker restarts. The ledger is wired up via
 * configureNotifications() at worker boot; until then an in-memory list is
 * used so sending still works (and stays rate-limited) in tests and scripts.
 */
let persistence: WorkerPersistence | null = null;
const fallbackSentAtMs: number[] = [];

export function configureNotifications(store: WorkerPersistence): void {
  persistence = store;
}

let rateLimitLock: Promise<void> = Promise.resolve();

async function withRateLimitLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = rateLimitLock;
  let release!: () => void;
  rateLimitLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function canSendAndRecordNow(
  kind: string,
  subject: string,
  nowMs: number
): Promise<{ allowed: boolean; reason?: string }> {
  return withRateLimitLock(async () => {
    if (persistence) {
      const inLastMinute = persistence.countEmailsSince(nowMs - ONE_MINUTE_MS);
      if (inLastMinute >= RATE_LIMIT_MAX_PER_MINUTE) {
        return { allowed: false, reason: "per-minute limit reached" };
      }

      const inLast15Minutes = persistence.countEmailsSince(nowMs - FIFTEEN_MINUTES_MS);
      if (inLast15Minutes >= RATE_LIMIT_MAX_PER_15_MINUTES) {
        return { allowed: false, reason: "15-minute limit reached" };
      }

      persistence.recordEmail(kind, subject, nowMs);
      return { allowed: true };
    }

    // In-memory fallback until configureNotifications() runs (tests, scripts).
    const recent = fallbackSentAtMs.filter((ts) => nowMs - ts <= FIFTEEN_MINUTES_MS);
    fallbackSentAtMs.length = 0;
    fallbackSentAtMs.push(...recent);

    if (recent.filter((ts) => nowMs - ts <= ONE_MINUTE_MS).length >= RATE_LIMIT_MAX_PER_MINUTE) {
      return { allowed: false, reason: "per-minute limit reached" };
    }
    if (fallbackSentAtMs.length >= RATE_LIMIT_MAX_PER_15_MINUTES) {
      return { allowed: false, reason: "15-minute limit reached" };
    }

    fallbackSentAtMs.push(nowMs);
    return { allowed: true };
  });
}

function nowIstLabel(): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "long"
  }).format(new Date());
}

/** Compact IST timestamp: "Wed 29 Jul, 10:30 AM" */
function shortIstTime(isoString: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(new Date(isoString));
}

function slotDurationMinutes(slot: ActiveSlot): number {
  return Math.round(
    (new Date(slot.endsAt).getTime() - new Date(slot.startedAt).getTime()) / 60_000
  );
}

/** Positive = in the future, negative = in the past */
function minutesFromNow(isoString: string): number {
  return Math.round((new Date(isoString).getTime() - Date.now()) / 60_000);
}

function minutesSince(isoString: string): number {
  return Math.round((Date.now() - new Date(isoString).getTime()) / 60_000);
}

function footer(): string {
  const domain = process.env.ADMIRAL_DOMAIN ?? "admiral";
  return `\n-- \nAdmiral · ${domain}`;
}

async function sendResendEmail(kind: string, subject: string, lines: string[]): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY ?? "";
  const resendFrom = process.env.RESEND_FROM ?? "";
  const resendTo = process.env.RESEND_TO ?? "";

  if (!resendKey || !resendFrom || !resendTo) {
    console.warn("Notification email skipped: RESEND_* env vars are missing.");
    return;
  }

  const nowMs = Date.now();
  const limit = await canSendAndRecordNow(kind, subject, nowMs);
  if (!limit.allowed) {
    console.warn(
      `Notification email rate-limited (${limit.reason}). Limits: ${RATE_LIMIT_MAX_PER_MINUTE}/min and ${RATE_LIMIT_MAX_PER_15_MINUTES}/15min.`
    );
    persistence?.appendEvent({
      kind: "email_suppressed",
      payload: { emailKind: kind, subject, reason: limit.reason ?? "rate limited" }
    });
    return;
  }

  const payload = {
    from: resendFrom,
    to: [resendTo],
    subject,
    text: lines.join("\n")
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<no-body>");
    throw new Error(`Resend email failed: ${res.status} ${body}`);
  }
}

export async function sendJoinSuccessEmail(slot: ActiveSlot, joinUrl: string): Promise<void> {
  const joinedMinutesIn = minutesSince(slot.startedAt);
  const endsInMinutes = minutesFromNow(slot.endsAt);
  const duration = slotDurationMinutes(slot);

  const joinedNote = joinedMinutesIn > 0
    ? `${joinedMinutesIn} min into the slot`
    : "right at the start";

  const timeLeftNote = endsInMinutes > 0
    ? `~${endsInMinutes} min remaining`
    : "slot has ended";

  return sendResendEmail("join_success", `✓ Admiral in room — ${slot.className}`, [
    `Admiral has joined the class and is holding your seat.`,
    "",
    `Class:       ${slot.className}`,
    `Course ID:   ${slot.courseId}`,
    `Slot:        ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${duration} min)`,
    `Joined:      ${joinedNote}`,
    `Time left:   ${timeLeftNote}`,
    "",
    `Join URL: ${joinUrl}`,
    "",
    `Admiral will leave automatically when the slot ends or when it detects you joined in.`,
    footer()
  ]);
}

export async function sendJoinFailureEmail(slot: ActiveSlot, errorMessage: string): Promise<void> {
  const endsInMinutes = minutesFromNow(slot.endsAt);
  const duration = slotDurationMinutes(slot);
  const urgencyNote = endsInMinutes > 0
    ? `~${endsInMinutes} min left in the slot — retrying automatically.`
    : `The slot has ended; no further retries for this session.`;

  return sendResendEmail("join_failure", `✗ Failed to join — ${slot.className} (${endsInMinutes > 0 ? `${endsInMinutes}m left` : "slot ended"})`, [
    `Admiral could not join the class.`,
    "",
    `Class:     ${slot.className}`,
    `Course ID: ${slot.courseId}`,
    `Slot:      ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${duration} min)`,
    `Status:    ${urgencyNote}`,
    "",
    `Error: ${errorMessage}`,
    "",
    `If failures keep happening you will receive a separate backoff alert.`,
    footer()
  ]);
}

export async function sendLeaveSuccessEmail(slot: ActiveSlot | null): Promise<void> {
  const lines: string[] = [`Admiral has left the meeting room.`, ""];

  if (slot) {
    const slotActiveMinutes = minutesSince(slot.startedAt);
    lines.push(
      `Class:    ${slot.className}`,
      `Course:   ${slot.courseId}`,
      `Slot:     ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${slotDurationMinutes(slot)} min)`,
      `Left at:  ${nowIstLabel()}`,
      `Slot had been running for ~${Math.max(0, slotActiveMinutes)} min`
    );
  } else {
    lines.push(`Left at: ${nowIstLabel()}`);
  }

  lines.push(footer());

  const subject = slot ? `← Admiral left — ${slot.className}` : "← Admiral left the meeting room";
  return sendResendEmail("leave_success", subject, lines);
}

export async function sendStanddownEmail(active: boolean): Promise<void> {
  if (active) {
    return sendResendEmail("standdown", `⏸ Standdown ON — Admiral will not auto-join`, [
      `Global standdown has been enabled. Admiral will not join any class until you turn it off.`,
      "",
      `All scheduled sessions will be skipped until standdown is lifted.`,
      `To resume: use the dashboard or send standdown_off.`,
      "",
      `Enabled at: ${nowIstLabel()}`,
      footer()
    ]);
  }

  return sendResendEmail("standdown", `▶ Standdown OFF — auto-join resumed`, [
    `Global standdown has been disabled. Admiral will resume joining classes on schedule.`,
    "",
    `Disabled at: ${nowIstLabel()}`,
    footer()
  ]);
}

export async function sendSessionStanddownEmail(slot: ActiveSlot, cancelled: boolean): Promise<void> {
  const duration = slotDurationMinutes(slot);
  const slotStart = shortIstTime(slot.startedAt);
  const slotEnd = shortIstTime(slot.endsAt);

  if (cancelled) {
    const startsInMinutes = minutesFromNow(slot.startedAt);
    const timeNote = startsInMinutes > 0
      ? `Slot starts in ~${startsInMinutes} min.`
      : `Slot is currently active.`;

    return sendResendEmail("session_standdown", `↩ Stand-down cancelled — ${slot.className}`, [
      `The per-session stand-down has been cancelled. Admiral will auto-join this session normally.`,
      "",
      `Class:   ${slot.className}`,
      `Course:  ${slot.courseId}`,
      `Slot:    ${slotStart} – ${slotEnd} (${duration} min)`,
      `Note:    ${timeNote}`,
      "",
      `Cancelled at: ${nowIstLabel()}`,
      footer()
    ]);
  }

  const startsInMinutes = minutesFromNow(slot.startedAt);
  const timeNote = startsInMinutes > 0
    ? `Slot starts in ~${startsInMinutes} min.`
    : `Slot is currently active — Admiral is leaving the room now.`;

  return sendResendEmail("session_standdown", `⏭ Skipping this session — ${slot.className} at ${slotStart}`, [
    `Admiral will sit out this session. Auto-join resumes from the next class onwards.`,
    "",
    `Class:  ${slot.className}`,
    `Course: ${slot.courseId}`,
    `Slot:   ${slotStart} – ${slotEnd} (${duration} min)`,
    `Note:   ${timeNote}`,
    "",
    `To undo: tap "Cancel Session Stand-Down" in the dashboard.`,
    `Requested at: ${nowIstLabel()}`,
    footer()
  ]);
}

export async function sendJoinRetriesExhaustedEmail(
  slot: ActiveSlot,
  failureCount: number,
  backoffMinutes: number
): Promise<void> {
  const duration = slotDurationMinutes(slot);
  const endsInMinutes = minutesFromNow(slot.endsAt);
  const resumeAt = new Date(Date.now() + backoffMinutes * 60_000).toISOString();

  const slotNote = endsInMinutes > 0
    ? `Slot ends in ~${endsInMinutes} min — Admiral will retry if it is still running after the backoff.`
    : `The slot has already ended; no further auto-join attempts for this session.`;

  return sendResendEmail(
    "join_retries_exhausted",
    `⚠ ${failureCount} join failures — backing off ${backoffMinutes}m (${slot.className})`,
    [
      `Admiral hit ${failureCount} consecutive join failures and has entered a ${backoffMinutes}-minute backoff.`,
      "",
      `Class:       ${slot.className}`,
      `Course ID:   ${slot.courseId}`,
      `Slot:        ${shortIstTime(slot.startedAt)} – ${shortIstTime(slot.endsAt)} (${duration} min)`,
      `Backoff:     ${backoffMinutes} min (auto-retries resume at ~${shortIstTime(resumeAt)})`,
      `Slot status: ${slotNote}`,
      "",
      `You can bypass the backoff immediately using "Force Join" in the dashboard.`,
      "",
      `Failed at: ${nowIstLabel()}`,
      footer()
    ]
  );
}
